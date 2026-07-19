import { describe, expect, it } from "vitest";
import { CwaApiError, fetchCwaRecords } from "../src/services/cwa-client.js";
import { jsonFetch, rejectingFetch } from "./helpers.js";

describe("fetchCwaRecords", () => {
  it("throws an actionable error when no API key is configured", async () => {
    await expect(fetchCwaRecords("F-C0032-001", undefined, {})).rejects.toThrow(CwaApiError);
    await expect(fetchCwaRecords("F-C0032-001", undefined, {})).rejects.toThrow(
      /opendata\.cwa\.gov\.tw\/user\/authkey/
    );
  });

  it("throws an actionable error on HTTP 401", async () => {
    const fetchImpl = jsonFetch({ success: "false" }, { status: 401 });
    await expect(fetchCwaRecords("F-C0032-001", "bad-key", {}, fetchImpl)).rejects.toThrow(
      /opendata\.cwa\.gov\.tw\/user\/authkey/
    );
  });

  it("throws an actionable error when the API reports success:false with an auth-related message", async () => {
    const fetchImpl = jsonFetch({ success: "false", message: "Invalid Authorization key, please check." });
    await expect(fetchCwaRecords("F-C0032-001", "bad-key", {}, fetchImpl)).rejects.toThrow(
      /opendata\.cwa\.gov\.tw\/user\/authkey/
    );
  });

  it("throws a network error message when fetch rejects", async () => {
    const fetchImpl = rejectingFetch(new Error("boom"));
    await expect(fetchCwaRecords("F-C0032-001", "key", {}, fetchImpl)).rejects.toThrow(/無法連線/);
  });

  it("returns records on success", async () => {
    const fetchImpl = jsonFetch({ success: "true", records: { hello: "world" } });
    const records = await fetchCwaRecords<{ hello: string }>("F-C0032-001", "key", {}, fetchImpl);
    expect(records).toEqual({ hello: "world" });
  });

  it("throws when records is missing even though success is true", async () => {
    const fetchImpl = jsonFetch({ success: "true" });
    await expect(fetchCwaRecords("F-C0032-001", "key", {}, fetchImpl)).rejects.toThrow(/records/);
  });
});
