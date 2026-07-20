import { describe, expect, it } from "vitest";
import { OpenDataApiError } from "../src/services/errors.js";
import { fetchMoenvRecords } from "../src/services/moenv-client.js";
import { jsonFetch } from "./helpers.js";

describe("fetchMoenvRecords", () => {
  it("accepts a bare JSON array response (the real MOENV v2 shape)", async () => {
    const records = await fetchMoenvRecords(
      "aqx_p_432",
      "test-key",
      {},
      jsonFetch([{ sitename: "士林" }, { sitename: "板橋" }])
    );
    expect(records).toEqual([{ sitename: "士林" }, { sitename: "板橋" }]);
  });

  it("still accepts a { records: [...] } wrapped response for backward compatibility", async () => {
    const records = await fetchMoenvRecords(
      "aqx_p_432",
      "test-key",
      {},
      jsonFetch({ resource_id: "aqx_p_432", records: [{ sitename: "士林" }] })
    );
    expect(records).toEqual([{ sitename: "士林" }]);
  });

  it("falls back to any array-of-objects property when there's no top-level array or `records` field", async () => {
    const records = await fetchMoenvRecords(
      "aqx_p_432",
      "test-key",
      {},
      jsonFetch({ resource_id: "aqx_p_432", data: [{ sitename: "士林" }] })
    );
    expect(records).toEqual([{ sitename: "士林" }]);
  });

  it("throws an actionable error when the object response has no message and no array field", async () => {
    await expect(fetchMoenvRecords("aqx_p_432", "test-key", {}, jsonFetch({ resource_id: "aqx_p_432" }))).rejects.toThrow(
      /格式不符|找不到記錄陣列/
    );
  });

  it("throws an actionable invalid-key error when the object response is an error envelope", async () => {
    await expect(
      fetchMoenvRecords("aqx_p_432", "test-key", {}, jsonFetch({ message: "api_key is not valid" }))
    ).rejects.toThrow(/data\.moenv\.gov\.tw/);
  });

  it("throws an actionable error on HTTP 401", async () => {
    const fetchImpl = jsonFetch({ message: "unauthorized" }, { status: 401 });
    await expect(fetchMoenvRecords("aqx_p_432", "bad-key", {}, fetchImpl)).rejects.toThrow(OpenDataApiError);
    await expect(fetchMoenvRecords("aqx_p_432", "bad-key", {}, fetchImpl)).rejects.toThrow(/data\.moenv\.gov\.tw/);
  });

  it("propagates the missing-API-key error", async () => {
    await expect(fetchMoenvRecords("aqx_p_432", undefined, {})).rejects.toThrow(/MOENV_API_KEY/);
  });
});
