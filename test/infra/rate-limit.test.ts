import { describe, expect, it } from "vitest";
import { checkRateLimit, type RateLimiter } from "../../src/infra/rate-limit.js";

function fakeLimiter(success: boolean): RateLimiter {
  return { limit: async () => ({ success }) };
}

describe("checkRateLimit", () => {
  it("returns null (proceed) when no limiter is bound — fail-soft, matches CACHE's optional-binding treatment", async () => {
    const result = await checkRateLimit(undefined, "1.2.3.4");
    expect(result).toBeNull();
  });

  it("returns null (proceed) when the limiter allows the request", async () => {
    const result = await checkRateLimit(fakeLimiter(true), "1.2.3.4");
    expect(result).toBeNull();
  });

  it("returns a 429 JSON-RPC error response when the limiter denies the request", async () => {
    const result = await checkRateLimit(fakeLimiter(false), "1.2.3.4");
    expect(result).not.toBeNull();
    expect(result!.status).toBe(429);
    expect(result!.headers.get("content-type")).toContain("application/json");
    expect(result!.headers.get("retry-after")).toBe("60");

    const body = (await result!.json()) as { jsonrpc?: string; error?: { code?: number; message?: string }; id?: unknown };
    expect(body.jsonrpc).toBe("2.0");
    expect(body.id).toBeNull();
    expect(body.error?.message).toMatch(/Too many requests/);
    expect(body.error?.message).toMatch(/self-host/i);
  });

  it("returns null (proceed) if the limiter itself throws — a rate-limit-check failure must never block a real request", async () => {
    const throwingLimiter: RateLimiter = {
      limit: async () => {
        throw new Error("rate limiter backend unavailable");
      }
    };
    const result = await checkRateLimit(throwingLimiter, "1.2.3.4");
    expect(result).toBeNull();
  });

  it("passes the given key through to the limiter unchanged", async () => {
    let receivedKey: string | undefined;
    const limiter: RateLimiter = {
      limit: async options => {
        receivedKey = options.key;
        return { success: true };
      }
    };
    await checkRateLimit(limiter, "203.0.113.7");
    expect(receivedKey).toBe("203.0.113.7");
  });
});
