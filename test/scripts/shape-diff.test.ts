import { describe, expect, it } from "vitest";
import { diffShapesFromValues, formatShapeDiff, shapeOf } from "../../scripts/fixtures/shape-diff.js";

describe("shapeOf", () => {
  it("classifies primitives, null, arrays, and objects", () => {
    expect(shapeOf("x")).toEqual({ kind: "primitive", type: "string" });
    expect(shapeOf(1)).toEqual({ kind: "primitive", type: "number" });
    expect(shapeOf(true)).toEqual({ kind: "primitive", type: "boolean" });
    expect(shapeOf(null)).toEqual({ kind: "null" });
    expect(shapeOf([])).toEqual({ kind: "array", item: null });
    expect(shapeOf([1, 2, 3])).toEqual({ kind: "array", item: { kind: "primitive", type: "number" } });
    expect(shapeOf({ a: 1 })).toEqual({ kind: "object", fields: { a: { kind: "primitive", type: "number" } } });
  });

  it("only looks at the first array element's shape", () => {
    // Real-world case: MOENV's records array is homogeneous, so this is a
    // deliberate simplification, not an oversight.
    expect(shapeOf([{ a: 1 }, { b: 2 }])).toEqual({
      kind: "array",
      item: { kind: "object", fields: { a: { kind: "primitive", type: "number" } } }
    });
  });
});

describe("diffShapesFromValues", () => {
  it("reports no diff when only data values changed, not structure", () => {
    const oldValue = { aqi: "30", county: "臺北市", stations: [{ name: "士林" }] };
    const newValue = { aqi: "45", county: "新北市", stations: [{ name: "板橋" }, { name: "新莊" }] };
    expect(diffShapesFromValues(oldValue, newValue)).toEqual([]);
  });

  it("detects an added field", () => {
    const diffs = diffShapesFromValues({ a: 1 }, { a: 1, b: 2 });
    expect(diffs).toEqual([{ path: "$.b", kind: "added" }]);
  });

  it("detects a removed field", () => {
    const diffs = diffShapesFromValues({ a: 1, b: 2 }, { a: 1 });
    expect(diffs).toEqual([{ path: "$.b", kind: "removed" }]);
  });

  it("detects a type change on a field", () => {
    const diffs = diffShapesFromValues({ aqi: "30" }, { aqi: 30 });
    expect(diffs).toEqual([{ path: "$.aqi", kind: "type-changed", detail: "string -> number" }]);
  });

  it("detects a type change at the top level (e.g. object -> array)", () => {
    const diffs = diffShapesFromValues({ records: [] }, [{ records: [] }]);
    expect(diffs).toEqual([{ path: "$", kind: "type-changed", detail: "object -> array" }]);
  });

  it("recurses into nested objects and arrays", () => {
    const oldValue = { records: [{ county: "臺北市", info: { aqi: "30" } }] };
    const newValue = { records: [{ county: "臺北市", info: { aqi: "30", pm25: "6" } }] };
    const diffs = diffShapesFromValues(oldValue, newValue);
    expect(diffs).toEqual([{ path: "$.records[].info.pm25", kind: "added" }]);
  });

  it("does not report a diff when comparing two empty arrays or mixing an empty array with a populated one", () => {
    expect(diffShapesFromValues([], [])).toEqual([]);
    expect(diffShapesFromValues([], [{ a: 1 }])).toEqual([]);
    expect(diffShapesFromValues([{ a: 1 }], [])).toEqual([]);
  });

  it("reproduces the real MOENV bare-array-vs-wrapped-object drift this pipeline exists to catch", () => {
    const oldFixtureShape = { records: [{ sitename: "士林" }] }; // what we assumed
    const realResponseShape = [{ sitename: "士林" }]; // what MOENV actually sent
    const diffs = diffShapesFromValues(oldFixtureShape, realResponseShape);
    expect(diffs).toEqual([{ path: "$", kind: "type-changed", detail: "object -> array" }]);
  });
});

describe("formatShapeDiff", () => {
  it("renders a no-diff message for an empty diff list", () => {
    expect(formatShapeDiff([])).toBe("（無結構性差異）");
  });

  it("renders each diff kind on its own line", () => {
    const text = formatShapeDiff([
      { path: "$.b", kind: "added" },
      { path: "$.c", kind: "removed" },
      { path: "$.aqi", kind: "type-changed", detail: "string -> number" }
    ]);
    expect(text).toContain("+ 新增欄位 $.b");
    expect(text).toContain("- 移除欄位 $.c");
    expect(text).toContain("~ 型別改變 $.aqi（string -> number）");
  });
});
