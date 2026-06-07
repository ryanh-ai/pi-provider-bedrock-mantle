import { describe, expect, it, vi } from "vitest";
import { createSigV4Fetch } from "../src/index";

const mantleUrl = "https://bedrock-mantle.us-east-2.api.aws/openai/v1/responses?x=1";

function response() {
  return new Response("ok", { status: 200 });
}

describe("createSigV4Fetch", () => {
  it("passes non-mantle requests through untouched", async () => {
    const baseFetch = vi.fn(async () => response());
    const fetch = createSigV4Fetch(baseFetch as any, { region: "us-east-2" });
    const init = { method: "POST", body: "{}" };

    await fetch("https://example.com/proxy/bedrock-mantle.us-east-2.api.aws", init);

    expect(baseFetch).toHaveBeenCalledWith("https://example.com/proxy/bedrock-mantle.us-east-2.api.aws", init);
  });

  it("signs exact mantle hostname requests with stable minimal headers", async () => {
    const baseFetch = vi.fn(async () => response());
    const signer = {
      sign: vi.fn(async (request: any) => ({
        ...request,
        headers: {
          ...request.headers,
          authorization: "AWS4-HMAC-SHA256 signed",
          "x-amz-date": "20260606T000000Z",
        },
      })),
    };
    const fetch = createSigV4Fetch(baseFetch as any, { region: "us-east-2", signer });

    await fetch(mantleUrl, {
      method: "POST",
      body: "{\"input\":\"hi\"}",
      headers: {
        authorization: "Bearer sigv4-managed",
        accept: "text/event-stream",
        "x-custom": "kept",
      },
    });

    expect(signer.sign).toHaveBeenCalledOnce();
    const signedRequest = signer.sign.mock.calls[0][0] as any;
    expect(signedRequest.method).toBe("POST");
    expect(signedRequest.hostname).toBe("bedrock-mantle.us-east-2.api.aws");
    expect(signedRequest.path).toBe("/openai/v1/responses?x=1");
    expect(signedRequest.body).toBe("{\"input\":\"hi\"}");
    expect(signedRequest.headers.host).toBe("bedrock-mantle.us-east-2.api.aws");
    expect(signedRequest.headers["content-type"]).toBe("application/json");
    expect(signedRequest.headers.accept).toBeUndefined();
    expect(signedRequest.headers["x-custom"]).toBeUndefined();
    expect(signedRequest.headers.authorization).toBeUndefined();

    expect(baseFetch).toHaveBeenCalledOnce();
    const [url, init] = baseFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(mantleUrl);
    expect(init.method).toBe("POST");
    expect(init.body).toBe("{\"input\":\"hi\"}");
    expect((init.headers as Record<string, string>).authorization).toBe("AWS4-HMAC-SHA256 signed");
  });

  it("rejects unsupported non-string bodies instead of silently dropping them", async () => {
    const baseFetch = vi.fn(async () => response());
    const signer = { sign: vi.fn() };
    const fetch = createSigV4Fetch(baseFetch as any, { region: "us-east-2", signer: signer as any });

    await expect(
      fetch(mantleUrl, {
        method: "POST",
        body: new URLSearchParams({ input: "hi" }),
      }),
    ).rejects.toThrow("only supports string request bodies");

    expect(signer.sign).not.toHaveBeenCalled();
    expect(baseFetch).not.toHaveBeenCalled();
  });
});
