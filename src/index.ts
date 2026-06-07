/**
 * pi-provider-bedrock-mantle
 *
 * Pi extension for OpenAI GPT-5.5/5.4 on Amazon Bedrock (bedrock-mantle endpoint).
 *
 * Architecture:
 *   Uses pi's built-in `streamSimpleOpenAIResponses` (publicly exported from
 *   @earendil-works/pi-ai/openai-responses) for ALL streaming, message conversion,
 *   tool call handling, etc. This ensures compatibility with pi's built-in
 *   openai-responses implementation.
 *
 *   SigV4 auth is handled by temporarily wrapping globalThis.fetch while Pi's
 *   OpenAI Responses provider constructs the OpenAI SDK client. The OpenAI SDK
 *   captures the fetch implementation in its constructor, so the wrapper remains
 *   scoped to that client after global fetch is restored.
 *
 *   If Pi's OpenAI Responses provider later exposes a custom fetch/client option,
 *   prefer that over global fetch patching.
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
import { Sha256 } from "@aws-crypto/sha256-js";
import { HttpRequest } from "@smithy/protocol-http";
import { SignatureV4 } from "@smithy/signature-v4";
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

type FetchLike = typeof globalThis.fetch;

type SigV4Signer = Pick<SignatureV4, "sign">;

interface SigV4FetchOptions {
  region?: string;
  service?: string;
  credentials?: AwsCredentialIdentityProvider;
  signer?: SigV4Signer;
}

function getRegion(): string {
  return process.env.BEDROCK_MANTLE_REGION || DEFAULT_REGION;
}

function getBaseUrl(): string {
  return `https://bedrock-mantle.${getRegion()}.api.aws/openai/v1`;
}

function getMantleHostname(region = getRegion()): string {
  return `bedrock-mantle.${region}.api.aws`;
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
// SigV4 credentials/signers (cached by effective config, auto-refreshing via SDK)
// =============================================================================

const credentialProviders = new Map<string, AwsCredentialIdentityProvider>();
const signers = new Map<string, SignatureV4>();

function getCredentialProvider(profile = process.env.AWS_PROFILE): AwsCredentialIdentityProvider {
  const key = profile || "<default>";
  let provider = credentialProviders.get(key);
  if (!provider) {
    provider = fromNodeProviderChain({ profile });
    credentialProviders.set(key, provider);
  }
  return provider;
}

function getSigner(region = getRegion(), service = SERVICE): SignatureV4 {
  const profile = process.env.AWS_PROFILE || "<default>";
  const key = `${service}:${region}:${profile}`;
  let signer = signers.get(key);
  if (!signer) {
    signer = new SignatureV4({
      service,
      region,
      credentials: getCredentialProvider(process.env.AWS_PROFILE),
      sha256: Sha256,
    });
    signers.set(key, signer);
  }
  return signer;
}

// =============================================================================
// SigV4 fetch wrapper — intercepts fetch calls to bedrock-mantle and signs them
// =============================================================================

function headersToRecord(headers?: HeadersInit): Record<string, string> {
  if (!headers) return {};
  return Object.fromEntries(new Headers(headers).entries());
}

function getRequestUrl(input: RequestInfo | URL): string {
  return typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
}

function getRequestMethod(input: RequestInfo | URL, init?: RequestInit): string {
  if (init?.method) return init.method;
  if (typeof Request !== "undefined" && input instanceof Request) return input.method;
  return "GET";
}

function getRequestHeaders(input: RequestInfo | URL, init?: RequestInit): Record<string, string> {
  return {
    ...(typeof Request !== "undefined" && input instanceof Request ? headersToRecord(input.headers) : {}),
    ...headersToRecord(init?.headers),
  };
}

function getRequestBody(input: RequestInfo | URL, init?: RequestInit): BodyInit | null | undefined {
  if (init && "body" in init) return init.body;
  if (typeof Request !== "undefined" && input instanceof Request) return input.body;
  return undefined;
}

function getRequestSignal(input: RequestInfo | URL, init?: RequestInit): AbortSignal | null | undefined {
  if (init?.signal) return init.signal;
  if (typeof Request !== "undefined" && input instanceof Request) return input.signal;
  return undefined;
}

function assertStringBody(body: BodyInit | null | undefined): string | undefined {
  if (body == null) return undefined;
  if (typeof body === "string") return body;
  throw new Error("bedrock-mantle SigV4 fetch wrapper only supports string request bodies");
}

export function createSigV4Fetch(baseFetch: FetchLike = globalThis.fetch, options: SigV4FetchOptions = {}): FetchLike {
  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = getRequestUrl(input);
    const parsedUrl = new URL(url);
    const region = options.region || getRegion();

    // Only intercept requests to the exact bedrock-mantle endpoint hostname.
    if (parsedUrl.hostname !== getMantleHostname(region)) {
      return baseFetch(input, init);
    }

    const method = getRequestMethod(input, init);
    const rawBody = getRequestBody(input, init);
    const body = assertStringBody(rawBody);
    const headers = getRequestHeaders(input, init);

    // The OpenAI SDK adds a dummy bearer token because it requires an apiKey.
    // SigV4 must own the Authorization header.
    delete headers.authorization;
    delete headers.Authorization;

    if (!headers["content-type"] && !headers["Content-Type"] && body !== undefined) {
      headers["content-type"] = "application/json";
    }
    headers.host = parsedUrl.host;

    const request = new HttpRequest({
      method,
      protocol: parsedUrl.protocol,
      hostname: parsedUrl.hostname,
      port: parsedUrl.port ? Number(parsedUrl.port) : undefined,
      path: parsedUrl.pathname + parsedUrl.search,
      headers,
      body,
    });

    const signer =
      options.signer ||
      (options.credentials
        ? new SignatureV4({
            service: options.service || SERVICE,
            region,
            credentials: options.credentials,
            sha256: Sha256,
          })
        : getSigner(region, options.service || SERVICE));
    const signed = await signer.sign(request);

    return baseFetch(url, {
      ...init,
      method,
      headers: signed.headers as Record<string, string>,
      body,
      signal: getRequestSignal(input, init),
    });
  };
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
  // streamSimpleOpenAIResponses) captures our SigV4 signer in its constructor.
  // The local createSigV4Fetch wrapper delegates to the fetch that was current
  // immediately before this call, avoiding stale module-load fetch capture.
  const prevFetch = globalThis.fetch;
  globalThis.fetch = createSigV4Fetch(prevFetch) as typeof globalThis.fetch;

  try {
    // Call pi's built-in openai-responses streaming with a dummy apiKey
    // (the real auth is handled by our fetch wrapper).
    const stream = streamSimpleOpenAIResponses(model as Model<"openai-responses">, context, {
      ...options,
      apiKey: "sigv4-managed",
    });

    // Restore fetch after client construction. This relies on the OpenAI SDK
    // capturing fetch synchronously in its constructor, which Pi's provider calls
    // before the first await. A future Pi custom-fetch hook would be preferable.
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
    // that patches fetch only while the OpenAI SDK client is constructed.
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
