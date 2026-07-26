import { describe, expect, it } from "vitest";
import { httpGet, httpGetWithBody, httpPost, isTimeoutError, redactSecret } from "../../src/infra/http.js";

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

describe("httpGetWithBody", () => {
  it("returns both the response and readBody's result on a normal successful call", async () => {
    const fetchImpl = (async () => new Response("<a>hi</a>", { status: 200 })) as unknown as typeof fetch;

    const { response, body } = await httpGetWithBody("https://example.com", r => r.text(), {}, fetchImpl);

    expect(response.status).toBe(200);
    expect(body).toBe("<a>hi</a>");
  });

  it("passes method: GET, headers, and an AbortSignal through to fetchImpl, same as httpGet", async () => {
    let capturedInit: RequestInit | undefined;
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      capturedInit = init;
      return new Response("ok");
    }) as unknown as typeof fetch;

    await httpGetWithBody("https://example.com", r => r.text(), { headers: { accept: "application/xml" } }, fetchImpl);

    expect(capturedInit?.method).toBe("GET");
    expect(capturedInit?.headers).toEqual({ accept: "application/xml" });
    expect(capturedInit?.signal).toBeInstanceOf(AbortSignal);
  });

  it("retries once if fetchImpl itself fails, same as httpGet", async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      if (calls === 1) {
        throw new Error("ECONNRESET");
      }
      return new Response("ok", { status: 200 });
    }) as unknown as typeof fetch;

    const { body } = await httpGetWithBody("https://example.com", r => r.text(), {}, fetchImpl);

    expect(calls).toBe(2);
    expect(body).toBe("ok");
  });

  it("retries once if readBody itself throws, not just if fetchImpl throws", async () => {
    let readBodyCalls = 0;
    const fetchImpl = (async () => new Response("ok", { status: 200 })) as unknown as typeof fetch;
    const readBody = async () => {
      readBodyCalls++;
      if (readBodyCalls === 1) {
        throw new Error("body stream corrupted");
      }
      return "recovered";
    };

    const { body } = await httpGetWithBody("https://example.com", readBody, {}, fetchImpl);

    expect(readBodyCalls).toBe(2);
    expect(body).toBe("recovered");
  });

  it("this is the whole point of the function: a body that hangs mid-stream is aborted by the timeout, not just a fetchImpl that never resolves", async () => {
    // A plain `new Response("some string")` is never actually tied to the
    // AbortController passed into fetchImpl — real fetch() implementations
    // tie the *body stream* to the request's signal, so this constructs a
    // ReadableStream that does that explicitly, faithfully reproducing the
    // real mechanism httpGetWithBody depends on instead of asserting
    // against a shortcut that would pass even if the fix didn't work.
    const fetchImpl = ((_url: string, init?: RequestInit) => {
      const stream = new ReadableStream({
        start(controller) {
          init?.signal?.addEventListener("abort", () => {
            controller.error(new DOMException("aborted", "AbortError"));
          });
          // Deliberately never enqueue or close — simulates a body that
          // never finishes streaming on its own.
        }
      });
      return Promise.resolve(new Response(stream, { status: 200 }));
    }) as unknown as typeof fetch;

    await expect(
      httpGetWithBody("https://example.com", r => r.text(), { timeoutMs: 20, retries: 0 }, fetchImpl)
    ).rejects.toThrow();
  });

  it("succeeds when the body finishes streaming just before the timeout would fire", async () => {
    const fetchImpl = ((_url: string, init?: RequestInit) => {
      const stream = new ReadableStream({
        start(controller) {
          init?.signal?.addEventListener("abort", () => {
            controller.error(new DOMException("aborted", "AbortError"));
          });
          controller.enqueue(new TextEncoder().encode("real-body-content"));
          controller.close();
        }
      });
      return Promise.resolve(new Response(stream, { status: 200 }));
    }) as unknown as typeof fetch;

    const { body } = await httpGetWithBody("https://example.com", r => r.text(), { timeoutMs: 5000 }, fetchImpl);

    expect(body).toBe("real-body-content");
  });
});

describe("httpPost", () => {
  it("passes method: POST, headers, and body through to fetchImpl", async () => {
    let capturedInit: RequestInit | undefined;
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      capturedInit = init;
      return new Response("ok");
    }) as unknown as typeof fetch;

    await httpPost(
      "https://example.com/token",
      { headers: { "content-type": "application/x-www-form-urlencoded" }, body: "grant_type=client_credentials" },
      fetchImpl
    );

    expect(capturedInit?.method).toBe("POST");
    expect(capturedInit?.headers).toEqual({ "content-type": "application/x-www-form-urlencoded" });
    expect(capturedInit?.body).toBe("grant_type=client_credentials");
    expect(capturedInit?.signal).toBeInstanceOf(AbortSignal);
  });

  it("retries once on a network failure, same as httpGet", async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      if (calls === 1) {
        throw new Error("ECONNRESET");
      }
      return new Response("ok", { status: 200 });
    }) as unknown as typeof fetch;

    const response = await httpPost("https://example.com/token", {}, fetchImpl);

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

describe("redactSecret", () => {
  it("replaces every literal occurrence of the secret with [REDACTED]", () => {
    expect(redactSecret("error fetching https://x/?api_key=abc123&foo=bar", "abc123")).toBe(
      "error fetching https://x/?api_key=[REDACTED]&foo=bar"
    );
  });

  it("replaces multiple occurrences, not just the first", () => {
    expect(redactSecret("abc123 ... retried with abc123 again", "abc123")).toBe(
      "[REDACTED] ... retried with [REDACTED] again"
    );
  });

  it("returns the text unchanged when secret is undefined (no key configured)", () => {
    expect(redactSecret("some upstream error text", undefined)).toBe("some upstream error text");
  });

  it("returns the text unchanged when the secret doesn't appear in it", () => {
    expect(redactSecret("some upstream error text", "abc123")).toBe("some upstream error text");
  });
});
