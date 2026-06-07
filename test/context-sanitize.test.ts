import { describe, expect, it } from "vitest";
import type { Context } from "@earendil-works/pi-ai";
import { sanitizeContextForBedrockMantle } from "../src/index";

const usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

describe("sanitizeContextForBedrockMantle", () => {
  it("moves images in tool result outputs to an injected user message and includes the source name", () => {
    const context: Context = {
      systemPrompt: "test",
      messages: [
        {
          role: "assistant",
          api: "openai-responses",
          provider: "bedrock-mantle",
          model: "openai.gpt-5.5",
          content: [{ type: "toolCall", id: "call_1|fc_1", name: "read", arguments: { path: "/tmp/screenshot.png" } }],
          usage,
          stopReason: "toolUse",
          timestamp: 0,
        },
        {
          role: "toolResult",
          toolCallId: "call_1|fc_1",
          toolName: "read",
          content: [
            { type: "text", text: "Read image file [image/png]" },
            { type: "image", mimeType: "image/png", data: "abc123" },
          ],
          isError: false,
          timestamp: 1,
        },
      ],
    };

    const sanitized = sanitizeContextForBedrockMantle(context);

    expect(sanitized).not.toBe(context);
    expect(sanitized.messages).toHaveLength(3);
    expect(sanitized.messages[1].role).toBe("toolResult");
    if (sanitized.messages[1].role === "toolResult") {
      expect(sanitized.messages[1].content).toEqual([
        { type: "text", text: "Read image file [image/png]" },
        {
          type: "text",
          text: "[Image output (/tmp/screenshot.png) follows after the adjacent tool results in a user message due to provider compatibility: image/png, 6 base64 chars. Analyze that attached image as this tool's image output.]",
        },
      ]);
    }

    expect(sanitized.messages[2].role).toBe("user");
    if (sanitized.messages[2].role === "user" && Array.isArray(sanitized.messages[2].content)) {
      expect(sanitized.messages[2].content).toEqual([
        {
          type: "text",
          text: "SYSTEM-COMPATIBILITY NOTE: The immediately preceding adjacent tool result block contained 1 image, but this provider cannot place images directly inside function_call_output. The attached image is the image output from those immediately preceding tool calls. Image source names: 1. /tmp/screenshot.png. Analyze it as if it were returned by those tools. Do not say the image is missing or omitted. Reminder: use the attached image to answer the user's request.",
        },
        { type: "image", mimeType: "image/png", data: "abc123" },
      ]);
    }
  });

  it("injects one user image turn after all adjacent tool results", () => {
    const context: Context = {
      systemPrompt: "test",
      messages: [
        {
          role: "assistant",
          api: "openai-responses",
          provider: "bedrock-mantle",
          model: "openai.gpt-5.5",
          content: [
            { type: "toolCall", id: "call_1|fc_1", name: "read", arguments: { path: "/tmp/first.png" } },
            { type: "toolCall", id: "call_2|fc_2", name: "read", arguments: { path: "/tmp/second.png" } },
          ],
          usage,
          stopReason: "toolUse",
          timestamp: 0,
        },
        {
          role: "toolResult",
          toolCallId: "call_1|fc_1",
          toolName: "read",
          content: [{ type: "image", mimeType: "image/png", data: "first" }],
          isError: false,
          timestamp: 1,
        },
        {
          role: "toolResult",
          toolCallId: "call_2|fc_2",
          toolName: "read",
          content: [{ type: "image", mimeType: "image/png", data: "second" }],
          isError: false,
          timestamp: 2,
        },
      ],
    };

    const sanitized = sanitizeContextForBedrockMantle(context);

    expect(sanitized.messages.map((message) => message.role)).toEqual(["assistant", "toolResult", "toolResult", "user"]);
    expect(sanitized.messages).toHaveLength(4);
    expect(sanitized.messages[3].role).toBe("user");
    if (sanitized.messages[3].role === "user" && Array.isArray(sanitized.messages[3].content)) {
      expect(sanitized.messages[3].content[0]).toEqual({
        type: "text",
        text: "SYSTEM-COMPATIBILITY NOTE: The immediately preceding adjacent tool result block contained 2 images, but this provider cannot place images directly inside function_call_output. The attached images are the image output from those immediately preceding tool calls. Image source names: 1. /tmp/first.png; 2. /tmp/second.png. Analyze them as if they were returned by those tools. Do not say the image is missing or omitted. Reminder: use the attached images to answer the user's request.",
      });
      expect(sanitized.messages[3].content.slice(1)).toEqual([
        { type: "image", mimeType: "image/png", data: "first" },
        { type: "image", mimeType: "image/png", data: "second" },
      ]);
    }
  });

  it("leaves user image inputs untouched", () => {
    const context: Context = {
      systemPrompt: "test",
      messages: [
        {
          role: "user",
          content: [{ type: "image", mimeType: "image/png", data: "abc123" }],
          timestamp: 1,
        },
      ],
    };

    const sanitized = sanitizeContextForBedrockMantle(context);

    expect(sanitized).toBe(context);
    expect(sanitized.messages[0]).toBe(context.messages[0]);
  });
});
