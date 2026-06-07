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
import type { AwsCredentialIdentityProvider } from "@aws-sdk/types";
import { SignatureV4 } from "@smithy/signature-v4";
import { type Context } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
type FetchLike = typeof globalThis.fetch;
type SigV4Signer = Pick<SignatureV4, "sign">;
interface SigV4FetchOptions {
    region?: string;
    service?: string;
    credentials?: AwsCredentialIdentityProvider;
    signer?: SigV4Signer;
}
export declare function createSigV4Fetch(baseFetch?: FetchLike, options?: SigV4FetchOptions): FetchLike;
export declare function sanitizeContextForBedrockMantle(context: Context): Context;
export default function (pi: ExtensionAPI): void;
export {};
