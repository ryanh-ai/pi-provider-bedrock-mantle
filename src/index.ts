/**
 * pi-provider-bedrock-mantle
 *
 * Pi extension for OpenAI GPT-5.5/5.4 on Amazon Bedrock (bedrock-mantle endpoint).
 *
 * Architecture:
 *   Uses pi's built-in `streamSimpleOpenAIResponses` (publicly exported from
 *   @earendil-works/pi-ai/openai-responses) for ALL streaming, message conversion,
 *   tool call handling, etc. This ensures 100% compatibility with pi's built-in
 *   openai-responses implementation.
 *
 *   Auth is handled by wrapping globalThis.fetch with SigV4 signing for requests
 *   to the bedrock-mantle endpoint. This is a scoped, per-request interception that
 *   doesn't affect other providers.
 *
 * Auth priority:
 *   1. AWS_BEARER_TOKEN_BEDROCK → simple apiKey passthrough (no fetch override)
 *   2. AWS SDK credential chain → SigV4 fetch wrapper
 *
 * Config:
 *   AWS_BEARER_TOKEN_BEDROCK  - Bedrock API key (preferred, simplest)
 *   AWS_PROFILE               - AWS profile for SigV4
 *   BEDROCK_MANTLE_REGION     - Region (default: us-east-2)
 */

import { fromNodeProviderChain } from "@aws-sdk/credential-providers";
import type { AwsCredentialIdentityProvider } from "@aws-sdk/types";
import { SignatureV4 } from "@smithy/signature-v4";
import { HttpRequest } from "@smithy/protocol-http";
import { Sha256 } from "@aws-crypto/sha256-js";
import {
  type Api,
  type AssistantMessageEventStream,
  type Context,
  type Model,
  type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { streamSimpleOpenAIResponses } from "@earendil-works/pi-ai/openai-responses";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// =============================================================================
// Configuration
// =============================================================================

const DEFAULT_REGION = "us-east-2";
const SERVICE = "bedrock";

function getRegion(): string {
  return process.env.BEDROCK_MANTLE_REGION || DEFAULT_REGION;
}

function getBaseUrl(): string {
  return `https://bedrock-mantle.${getRegion()}.api.aws/openai/v1`;
}

function getMantleHostname(): string {
  return `bedrock-mantle.${getRegion()}.api.aws`;
}

// =============================================================================
// Models
// =============================================================================

const MODELS = [
  {
    id: "openai.gpt-5.5",
    name: "GPT-5.5 (Bedrock)",
    reasoning: true,
    input: ["text", "image"] as ("text" | "image")[],
    cost: { input: 10, output: 30, cacheRead: 2.5, cacheWrite: 10 },
    contextWindow: 200000,
    maxTokens: 32768,
  },
  {
    id: "openai.gpt-5.4",
    name: "GPT-5.4 (Bedrock)",
    reasoning: true,
    input: ["text", "image"] as ("text" | "image")[],
    cost: { input: 2.5, output: 10, cacheRead: 0.625, cacheWrite: 2.5 },
    contextWindow: 200000,
    maxTokens: 32768,
  },
  {
    id: "openai.gpt-oss-120b",
    name: "GPT-OSS 120B (Bedrock)",
    reasoning: false,
    input: ["text"] as ("text" | "image")[],
    cost: { input: 1, output: 4, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128000,
    maxTokens: 16384,
  },
  {
    id: "openai.gpt-oss-20b",
    name: "GPT-OSS 20B (Bedrock)",
    reasoning: false,
    input: ["text"] as ("text" | "image")[],
    cost: { input: 0.3, output: 1.2, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128000,
    maxTokens: 16384,
  },
];

// =============================================================================
// SigV4 credentials (cached, auto-refreshing via SDK)
// =============================================================================

let credentialProvider: AwsCredentialIdentityProvider | null = null;

function getCredentialProvider(): AwsCredentialIdentityProvider {
  if (!credentialProvider) {
    credentialProvider = fromNodeProviderChain({
      profile: process.env.AWS_PROFILE,
    });
  }
  return credentialProvider;
}

// =============================================================================
// SigV4 fetch wrapper — intercepts fetch calls to bedrock-mantle and signs them
// =============================================================================

const originalFetch = globalThis.fetch;

async function sigv4WrappedFetch(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;

  // Only intercept requests to our bedrock-mantle endpoint
  if (!url.includes(getMantleHostname())) {
    return originalFetch(input, init);
  }

  const parsedUrl = new URL(url);
  const region = getRegion();
  const body = typeof init?.body === "string" ? init.body : undefined;

  const request = new HttpRequest({
    method: init?.method || "POST",
    protocol: parsedUrl.protocol,
    hostname: parsedUrl.hostname,
    port: parsedUrl.port ? Number(parsedUrl.port) : undefined,
    path: parsedUrl.pathname + parsedUrl.search,
    headers: {
      "content-type": "application/json",
      host: parsedUrl.hostname,
    },
    body: body || undefined,
  });

  const signer = new SignatureV4({
    service: SERVICE,
    region,
    credentials: getCredentialProvider(),
    sha256: Sha256,
  });

  const signed = await signer.sign(request);

  return originalFetch(url, {
    method: init?.method || "POST",
    headers: signed.headers as Record<string, string>,
    body,
    signal: init?.signal,
  });
}

// =============================================================================
// Stream wrapper: calls pi's built-in streamSimpleOpenAIResponses with SigV4
// =============================================================================

function streamBedrockMantleSigV4(
  model: Model<Api>,
  context: Context,
  options?: SimpleStreamOptions,
): AssistantMessageEventStream {
  // Temporarily override globalThis.fetch so the OpenAI SDK (used internally by
  // streamSimpleOpenAIResponses) routes through our SigV4 signer.
  // This is scoped: only requests matching bedrock-mantle hostname are signed;
  // all other fetch calls pass through unmodified.
  const prevFetch = globalThis.fetch;
  globalThis.fetch = sigv4WrappedFetch as typeof globalThis.fetch;

  try {
    // Call pi's built-in openai-responses streaming with a dummy apiKey
    // (the real auth is handled by our fetch wrapper)
    const stream = streamSimpleOpenAIResponses(
      model as Model<"openai-responses">,
      context,
      {
        ...options,
        apiKey: "sigv4-managed",
      },
    );

    // Restore fetch after the stream setup completes.
    // The OpenAI SDK captures the fetch reference at client creation time,
    // so it continues using our wrapper for the duration of this stream.
    // We restore globalThis.fetch immediately so other concurrent requests
    // are unaffected.
    //
    // Note: The OpenAI SDK captures `fetch` in its constructor, which happens
    // synchronously inside streamSimpleOpenAIResponses. By the time we restore
    // here, the client already holds a reference to our sigv4WrappedFetch.
    globalThis.fetch = prevFetch;

    return stream;
  } catch (e) {
    globalThis.fetch = prevFetch;
    throw e;
  }
}

// =============================================================================
// Extension Entry Point
// =============================================================================

export default function (pi: ExtensionAPI) {
  const bearerToken = process.env.AWS_BEARER_TOKEN_BEDROCK;
  const baseUrl = getBaseUrl();

  if (bearerToken) {
    // Bearer token: use pi's built-in openai-responses directly.
    // No custom streaming, no fetch patching — just apiKey + baseUrl.
    pi.registerProvider("bedrock-mantle", {
      name: "Amazon Bedrock (OpenAI)",
      baseUrl,
      apiKey: bearerToken,
      api: "openai-responses",
      authHeader: true,
      models: MODELS,
    });
  } else {
    // SigV4: use pi's built-in openai-responses via streamSimple wrapper
    // that patches fetch to sign requests.
    pi.registerProvider("bedrock-mantle", {
      name: "Amazon Bedrock (OpenAI)",
      baseUrl,
      apiKey: "sigv4-managed",
      api: "openai-responses",
      models: MODELS,
      streamSimple: streamBedrockMantleSigV4,
    });
  }
}
