import { describe, expect, it } from "vitest";
import type { Context } from "@earendil-works/pi-ai";
import { sanitizeContextForBedrockMantle } from "../src/index";

describe("sanitizeContextForBedrockMantle", () => {
  it("replaces images in tool result outputs with text placeholders", () => {
    const context: Context = {
      systemPrompt: "test",
      messages: [
        {
          role: "toolResult",
          toolCallId: "call_1",
          toolName: "screenshot",
          content: [
            { type: "text", text: "Screenshot captured" },
            { type: "image", mimeType: "image/png", data: "abc123" },
          ],
          isError: false,
          timestamp: 1,
        },
      ],
    };

    const sanitized = sanitizeContextForBedrockMantle(context);

    expect(sanitized).not.toBe(context);
    expect(sanitized.messages[0]).not.toBe(context.messages[0]);
    expect(sanitized.messages[0].role).toBe("toolResult");
    if (sanitized.messages[0].role === "toolResult") {
      expect(sanitized.messages[0].content).toEqual([
        { type: "text", text: "Screenshot captured" },
        {
          type: "text",
          text: "[Image output omitted: image/png, 6 base64 chars. bedrock-mantle does not support images in tool result outputs.]",
        },
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
