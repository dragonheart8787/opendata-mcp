import { describe, expect, it } from "vitest";

import { buildOpenMeteoUrl, openMeteoAdapter } from "../../src/adapters/open-meteo.js";
import { ToolError } from "../../src/infra/errors.js";
import { openMeteoForecastEntry, openMeteoGeocodingEntry } from "../../src/registry/open-meteo.js";
import type { Env } from "../../src/index.js";
import { jsonFetch, rejectingFetch } from "../helpers.js";

const env: Env = {};
const forecastParams = { latitude: 35.6785, longitude: 139.6823, forecastDays: 3 };

describe("buildOpenMeteoUrl", () => {
  it("routes the forecast entry to api.open-meteo.com", () => {
    const url = buildOpenMeteoUrl(openMeteoForecastEntry, forecastParams);
    expect(url.origin).toBe("https://api.open-meteo.com");
    expect(url.pathname).toBe("/v1/forecast");
    expect(url.searchParams.get("latitude")).toBe("35.6785");
    expect(url.searchParams.get("timezone")).toBe("auto");
  });

  it("routes the geocoding entry to the DIFFERENT geocoding host", () => {
    // The two endpoints genuinely live on different hosts — the adapter
    // picking the wrong one would 404 in production, so it's asserted here.
    const url = buildOpenMeteoUrl(openMeteoGeocodingEntry, { name: "Tokyo" });
    expect(url.origin).toBe("https://geocoding-api.open-meteo.com");
    expect(url.pathname).toBe("/v1/search");
    expect(url.searchParams.get("name")).toBe("Tokyo");
    expect(url.searchParams.get("format")).toBe("json");
  });

  it("fails loudly for an openmeteo entry with no host mapping, instead of building an `undefined/...` URL", () => {
    const orphan = { ...openMeteoForecastEntry, id: "openmeteo:not-registered" };
    expect(() => buildOpenMeteoUrl(orphan, forecastParams)).toThrow(ToolError);
  });
});

describe("openMeteoAdapter.fetchDataset", () => {
  it("returns the parsed JSON object on success", async () => {
    const body = { latitude: 35.7, current: { temperature_2m: 23.2 } };
    const raw = await openMeteoAdapter.fetchDataset(openMeteoForecastEntry, forecastParams, env, jsonFetch(body));
    expect(raw).toEqual(body);
  });

  it("needs no API key — this source has no auth step at all", async () => {
    // Deliberately an empty Env: every other adapter in this project throws
    // AUTH_MISSING here, and this one must not.
    await expect(
      openMeteoAdapter.fetchDataset(openMeteoForecastEntry, forecastParams, {}, jsonFetch({ latitude: 1 }))
    ).resolves.toBeDefined();
  });

  it("maps a network failure to UPSTREAM_ERROR", async () => {
    await expect(
      openMeteoAdapter.fetchDataset(openMeteoForecastEntry, forecastParams, env, rejectingFetch(new Error("boom")))
    ).rejects.toMatchObject({ code: "UPSTREAM_ERROR" });
  });

  it("maps a timeout to UPSTREAM_TIMEOUT", async () => {
    const abortError = new Error("aborted");
    abortError.name = "AbortError";
    await expect(
      openMeteoAdapter.fetchDataset(openMeteoForecastEntry, forecastParams, env, rejectingFetch(abortError))
    ).rejects.toMatchObject({ code: "UPSTREAM_TIMEOUT" });
  });

  it("relays upstream's own `reason` text from a 400, as INVALID_PARAMS", async () => {
    // Real observed body for an out-of-range latitude — the reason field is
    // the only thing telling a caller what to fix, so a status-only check
    // would throw away the useful half of the response.
    const body = { reason: "Latitude must be in range of -90 to 90°. Given: 999.0.", error: true };
    await expect(
      openMeteoAdapter.fetchDataset(openMeteoForecastEntry, forecastParams, env, jsonFetch(body, { status: 400 }))
    ).rejects.toMatchObject({ code: "INVALID_PARAMS", message: expect.stringContaining("Latitude must be in range") });
  });

  it("reads `reason` regardless of key order, since upstream varies it between responses", async () => {
    const errorFirst = { error: true, reason: "Parameter 'latitude' and 'longitude' must have the same number of elements" };
    await expect(
      openMeteoAdapter.fetchDataset(openMeteoForecastEntry, forecastParams, env, jsonFetch(errorFirst, { status: 400 }))
    ).rejects.toMatchObject({ message: expect.stringContaining("same number of elements") });
  });

  it("gives a 429 its own quota-specific message and hint, not a generic upstream error", async () => {
    let thrown: ToolError | undefined;
    try {
      await openMeteoAdapter.fetchDataset(openMeteoForecastEntry, forecastParams, env, jsonFetch({}, { status: 429 }));
    } catch (error) {
      thrown = error as ToolError;
    }
    expect(thrown?.code).toBe("UPSTREAM_ERROR");
    expect(thrown?.message).toContain("10,000");
    expect(thrown?.hint).toContain("付費方案");
  });

  it("maps a non-400 server error to UPSTREAM_ERROR", async () => {
    await expect(
      openMeteoAdapter.fetchDataset(openMeteoForecastEntry, forecastParams, env, jsonFetch({}, { status: 503 }))
    ).rejects.toMatchObject({ code: "UPSTREAM_ERROR" });
  });

  it("rejects a non-object payload as SCHEMA_MISMATCH", async () => {
    await expect(
      openMeteoAdapter.fetchDataset(openMeteoForecastEntry, forecastParams, env, jsonFetch([1, 2, 3]))
    ).rejects.toMatchObject({ code: "SCHEMA_MISMATCH" });
    await expect(
      openMeteoAdapter.fetchDataset(openMeteoForecastEntry, forecastParams, env, jsonFetch("not an object"))
    ).rejects.toMatchObject({ code: "SCHEMA_MISMATCH" });
  });

  it("treats an explicit `error: true` as a failure even when the status is 200", async () => {
    await expect(
      openMeteoAdapter.fetchDataset(
        openMeteoForecastEntry,
        forecastParams,
        env,
        jsonFetch({ error: true, reason: "something went wrong" })
      )
    ).rejects.toMatchObject({ code: "UPSTREAM_ERROR", message: expect.stringContaining("something went wrong") });
  });
});
