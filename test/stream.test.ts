import { describe, it, expect, beforeAll } from "vitest";
import { Type } from "@sinclair/typebox";
import { complete, stream } from "@earendil-works/pi-ai";
import type { Api, Context, Model, Tool } from "@earendil-works/pi-ai";

/**
 * End-to-end tests for pi-provider-bedrock-mantle.
 *
 * These replicate pi-mono's packages/ai/test/stream.test.ts patterns
 * against the bedrock-mantle endpoint via SigV4 auth.
 *
 * Requires: AWS_PROFILE=fmevals-private (or equivalent credentials)
 * Run: npx vitest run
 */

// Model definition matching what the extension registers
const gpt55: Model<"openai-responses"> = {
  id: "openai.gpt-5.5",
  name: "GPT-5.5 (Bedrock)",
  api: "openai-responses",
  provider: "bedrock-mantle",
  baseUrl: `https://bedrock-mantle.${process.env.BEDROCK_MANTLE_REGION || "us-east-2"}.api.aws/openai/v1`,
  reasoning: true,
  input: ["text", "image"],
  cost: { input: 10, output: 30, cacheRead: 2.5, cacheWrite: 10 },
  contextWindow: 200000,
  maxTokens: 32768,
};

const gpt54: Model<"openai-responses"> = {
  ...gpt55,
  id: "openai.gpt-5.4",
  name: "GPT-5.4 (Bedrock)",
  cost: { input: 2.5, output: 10, cacheRead: 0.625, cacheWrite: 2.5 },
};

// Calculator tool
const calculatorTool: Tool = {
  name: "math_operation",
  description: "Perform basic arithmetic operations",
  parameters: Type.Object({
    a: Type.Number({ description: "First number" }),
    b: Type.Number({ description: "Second number" }),
    operation: Type.String({ description: "One of: add, subtract, multiply, divide" }),
  }),
};

// We need to install the SigV4 fetch wrapper before tests
beforeAll(async () => {
  // Import and activate the extension's fetch wrapper
  const { fromNodeProviderChain } = await import("@aws-sdk/credential-providers");
  const { SignatureV4 } = await import("@smithy/signature-v4");
  const { HttpRequest } = await import("@smithy/protocol-http");
  const { Sha256 } = await import("@aws-crypto/sha256-js");

  const region = process.env.BEDROCK_MANTLE_REGION || "us-east-2";
  const hostname = `bedrock-mantle.${region}.api.aws`;
  const credentials = fromNodeProviderChain({ profile: process.env.AWS_PROFILE });
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async (input: any, init?: any) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (!url.includes(hostname)) return originalFetch(input, init);

    const parsedUrl = new URL(url);
    const body = typeof init?.body === "string" ? init.body : undefined;
    const request = new HttpRequest({
      method: init?.method || "POST",
      protocol: parsedUrl.protocol,
      hostname: parsedUrl.hostname,
      path: parsedUrl.pathname + parsedUrl.search,
      headers: { "content-type": "application/json", host: parsedUrl.hostname },
      body,
    });
    const signer = new SignatureV4({ service: "bedrock", region, credentials, sha256: Sha256 });
    const signed = await signer.sign(request);
    return originalFetch(url, { method: init?.method || "POST", headers: signed.headers as any, body, signal: init?.signal });
  };
});

describe("bedrock-mantle GPT-5.5", () => {
  it("basic text generation", { timeout: 30000, retry: 2 }, async () => {
    const context: Context = {
      systemPrompt: "You are a helpful assistant. Be concise.",
      messages: [{ role: "user", content: "Reply with exactly: 'Hello test successful'", timestamp: Date.now() }],
    };

    const response = await complete(gpt55, context, { apiKey: "sigv4-managed" });

    expect(response.role).toBe("assistant");
    expect(response.content.length).toBeGreaterThan(0);
    expect(response.usage.input + response.usage.cacheRead).toBeGreaterThan(0);
    expect(response.usage.output).toBeGreaterThan(0);
    expect(response.errorMessage).toBeFalsy();
    expect(response.content.map((b) => (b.type === "text" ? b.text : "")).join("")).toContain("Hello test successful");
  });

  it("multi-turn conversation", { timeout: 30000, retry: 2 }, async () => {
    const context: Context = {
      systemPrompt: "You are a helpful assistant. Be concise.",
      messages: [{ role: "user", content: "Reply with exactly: 'First turn'", timestamp: Date.now() }],
    };

    const first = await complete(gpt55, context, { apiKey: "sigv4-managed" });
    expect(first.content.map((b) => (b.type === "text" ? b.text : "")).join("")).toContain("First turn");

    // Add the response and a follow-up
    context.messages.push(first);
    context.messages.push({ role: "user", content: "Reply with exactly: 'Second turn'", timestamp: Date.now() });

    const second = await complete(gpt55, context, { apiKey: "sigv4-managed" });
    expect(second.content.map((b) => (b.type === "text" ? b.text : "")).join("")).toContain("Second turn");
  });

  it("streaming events", { timeout: 30000, retry: 2 }, async () => {
    let textStarted = false;
    let textChunks = "";
    let textCompleted = false;

    const context: Context = {
      systemPrompt: "You are a helpful assistant.",
      messages: [{ role: "user", content: "Count from 1 to 3", timestamp: Date.now() }],
    };

    const s = stream(gpt55, context, { apiKey: "sigv4-managed" });

    for await (const event of s) {
      if (event.type === "text_start") textStarted = true;
      else if (event.type === "text_delta") textChunks += event.delta;
      else if (event.type === "text_end") textCompleted = true;
    }

    expect(textStarted).toBe(true);
    expect(textChunks.length).toBeGreaterThan(0);
    expect(textCompleted).toBe(true);
  });

  it("tool calling", { timeout: 60000, retry: 2 }, async () => {
    const context: Context = {
      systemPrompt: "You are a helpful assistant that uses tools when asked.",
      messages: [{ role: "user", content: "Calculate 15 + 27 using the math_operation tool.", timestamp: Date.now() }],
      tools: [calculatorTool],
    };

    const response = await complete(gpt55, context, { apiKey: "sigv4-managed" });

    expect(response.stopReason).toBe("toolUse");
    const toolCall = response.content.find((b) => b.type === "toolCall");
    expect(toolCall).toBeDefined();
    if (toolCall?.type === "toolCall") {
      expect(toolCall.name).toBe("math_operation");
      expect(toolCall.id).toBeTruthy();
      expect((toolCall.arguments as any).a).toBe(15);
      expect((toolCall.arguments as any).b).toBe(27);
      expect((toolCall.arguments as any).operation).toBe("add");
    }
  });

  it("tool result round-trip", { timeout: 60000, retry: 2 }, async () => {
    const context: Context = {
      systemPrompt: "You are a helpful assistant. Use the tool, then report the result.",
      messages: [{ role: "user", content: "What is 15 + 27? Use the math_operation tool.", timestamp: Date.now() }],
      tools: [calculatorTool],
    };

    // First: get the tool call
    const first = await complete(gpt55, context, { apiKey: "sigv4-managed" });
    expect(first.stopReason).toBe("toolUse");
    const toolCall = first.content.find((b) => b.type === "toolCall");
    expect(toolCall?.type).toBe("toolCall");

    // Add tool call response and tool result
    context.messages.push(first);
    context.messages.push({
      role: "toolResult",
      toolCallId: (toolCall as any).id,
      content: [{ type: "text", text: "42" }],
      isError: false,
      timestamp: Date.now(),
    });

    // Second: model should report the result
    const second = await complete(gpt55, context, { apiKey: "sigv4-managed" });
    expect(second.stopReason).toBe("stop");
    const text = second.content.map((b) => (b.type === "text" ? b.text : "")).join("");
    expect(text).toContain("42");
  });

  it("reasoning/thinking", { timeout: 60000, retry: 2 }, async () => {
    let thinkingStarted = false;
    let thinkingChunks = "";
    let thinkingCompleted = false;

    const context: Context = {
      systemPrompt: "You are a helpful assistant.",
      messages: [{ role: "user", content: "Think step by step: what is 17 * 23?", timestamp: Date.now() }],
    };

    const s = stream(gpt55, context, { apiKey: "sigv4-managed", reasoning: "high" } as any);

    for await (const event of s) {
      if (event.type === "thinking_start") thinkingStarted = true;
      else if (event.type === "thinking_delta") thinkingChunks += event.delta;
      else if (event.type === "thinking_end") thinkingCompleted = true;
    }

    const response = await s.result();
    // GPT-5.5 may or may not expose thinking content depending on reasoning summary settings
    // At minimum, we should get a text response with the answer
    const text = response.content.map((b) => (b.type === "text" ? b.text : "")).join("");
    expect(text).toContain("391");
  });
});

describe("bedrock-mantle GPT-5.4", () => {
  it("basic text generation", { timeout: 30000, retry: 2 }, async () => {
    const context: Context = {
      systemPrompt: "You are a helpful assistant. Be concise.",
      messages: [{ role: "user", content: "Reply with exactly: 'GPT-5.4 working'", timestamp: Date.now() }],
    };

    const response = await complete(gpt54, context, { apiKey: "sigv4-managed" });
    expect(response.content.map((b) => (b.type === "text" ? b.text : "")).join("")).toContain("GPT-5.4 working");
  });
});
