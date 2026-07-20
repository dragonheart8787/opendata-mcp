import { describe, expect, it } from "vitest";
import { httpGet, isTimeoutError } from "../../src/infra/http.js";

describe("httpGet", () => {
  it("returns the response on a normal successful call, without retrying", async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      return new Response("ok", { status: 200 });
    }) as unknown as typeof fetch;

    const response = await httpGet("https://example.com", {}, fetchImpl);

    expect(await response.text()).toBe("ok");
    expect(calls).toBe(1);
  });

  it("passes method: GET, the given headers, and an AbortSignal through to fetchImpl", async () => {
    let capturedInit: RequestInit | undefined;
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      capturedInit = init;
      return new Response("ok");
    }) as unknown as typeof fetch;

    await httpGet("https://example.com", { headers: { accept: "application/json" } }, fetchImpl);

    expect(capturedInit?.method).toBe("GET");
    expect(capturedInit?.headers).toEqual({ accept: "application/json" });
    expect(capturedInit?.signal).toBeInstanceOf(AbortSignal);
  });

  it("retries once on a network failure and succeeds if the retry works", async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      if (calls === 1) {
        throw new Error("ECONNRESET");
      }
      return new Response("ok", { status: 200 });
    }) as unknown as typeof fetch;

    const response = await httpGet("https://example.com", {}, fetchImpl);

    expect(calls).toBe(2);
    expect(response.status).toBe(200);
  });

  it("throws the last error after exhausting the single retry", async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      throw new Error("always fails");
    }) as unknown as typeof fetch;

    await expect(httpGet("https://example.com", {}, fetchImpl)).rejects.toThrow("always fails");
    expect(calls).toBe(2);
  });

  it("does not retry when retries: 0 is explicitly configured", async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      throw new Error("nope");
    }) as unknown as typeof fetch;

    await expect(httpGet("https://example.com", { retries: 0 }, fetchImpl)).rejects.toThrow("nope");
    expect(calls).toBe(1);
  });

  it("aborts and retries when fetchImpl doesn't resolve within the timeout", async () => {
    let calls = 0;
    const fetchImpl = ((_url: string, init?: RequestInit) =>
      new Promise<Response>((resolve, reject) => {
        calls++;
        const thisCall = calls;
        init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
        // Second attempt resolves quickly so the test doesn't wait out a second timeout.
        if (thisCall === 2) {
          resolve(new Response("ok", { status: 200 }));
        }
        // First attempt: never resolves on its own — only the abort listener above settles it.
      })) as unknown as typeof fetch;

    const response = await httpGet("https://example.com", { timeoutMs: 20 }, fetchImpl);

    expect(calls).toBe(2);
    expect(response.status).toBe(200);
  });
});

describe("isTimeoutError", () => {
  it("recognizes an AbortError", () => {
    expect(isTimeoutError(new DOMException("aborted", "AbortError"))).toBe(true);
  });

  it("does not treat a generic Error as a timeout", () => {
    expect(isTimeoutError(new Error("network down"))).toBe(false);
  });

  it("does not treat a non-Error value as a timeout", () => {
    expect(isTimeoutError("aborted")).toBe(false);
  });
});
