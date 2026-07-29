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

  it("unions field sets across every array element, not just the first", () => {
    expect(shapeOf([{ a: 1 }, { b: 2 }])).toEqual({
      kind: "array",
      item: {
        kind: "object",
        fields: { a: { kind: "primitive", type: "number" }, b: { kind: "primitive", type: "number" } }
      }
    });
  });

  it("keeps a field contributed only by a later element", () => {
    const shape = shapeOf([{ a: 1 }, { a: 2, extra: "x" }]);
    expect(shape).toEqual({
      kind: "array",
      item: {
        kind: "object",
        fields: { a: { kind: "primitive", type: "number" }, extra: { kind: "primitive", type: "string" } }
      }
    });
  });

  it("lets a concrete type win over null, so a nullable field's shape doesn't depend on which elements were null", () => {
    expect(shapeOf([{ v: null }, { v: "text" }])).toEqual({
      kind: "array",
      item: { kind: "object", fields: { v: { kind: "primitive", type: "string" } } }
    });
    // ...and in the other order, so the result doesn't depend on position.
    expect(shapeOf([{ v: "text" }, { v: null }])).toEqual({
      kind: "array",
      item: { kind: "object", fields: { v: { kind: "primitive", type: "string" } } }
    });
  });

  it("merges nested arrays element-wise too", () => {
    expect(shapeOf([{ list: [{ a: 1 }] }, { list: [{ b: 2 }] }])).toEqual({
      kind: "array",
      item: {
        kind: "object",
        fields: {
          list: {
            kind: "array",
            item: {
              kind: "object",
              fields: { a: { kind: "primitive", type: "number" }, b: { kind: "primitive", type: "number" } }
            }
          }
        }
      }
    });
  });

  it("ignores an empty nested array when another element shows the real item shape", () => {
    expect(shapeOf([{ list: [] }, { list: [{ a: 1 }] }])).toEqual({
      kind: "array",
      item: {
        kind: "object",
        fields: { list: { kind: "array", item: { kind: "object", fields: { a: { kind: "primitive", type: "number" } } } } }
      }
    });
  });

  it("stays linear on a large array rather than degrading to O(n^2)", () => {
    // 874 elements matches the real station-observation dataset; the point
    // is that this completes instantly, not that the threshold is precise.
    const big = Array.from({ length: 874 }, (_, i) => ({ id: i, name: "s", ...(i % 3 === 0 ? { sometimes: 1 } : {}) }));
    const started = Date.now();
    const shape = shapeOf(big);
    expect(Date.now() - started).toBeLessThan(1000);
    expect(shape).toEqual({
      kind: "array",
      item: {
        kind: "object",
        fields: {
          id: { kind: "primitive", type: "number" },
          name: { kind: "primitive", type: "string" },
          sometimes: { kind: "primitive", type: "number" }
        }
      }
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

// --- Regression: the three real false positives this union behavior fixes ---
//
// Each is a simplified reproduction of an actual schema-drift PR that was
// opened with nothing wrong behind it. See AGENTS.md §6 for the full
// history; the shared cause is that `shapeOf` used to sample `array[0]`,
// so a genuinely optional per-record field flipped "added"/"removed"
// depending purely on which element happened to be first that capture.
describe("array field-presence false positives (real cases)", () => {
  it("cwa:W-C0034-005 — MovingPrediction moving from Fix[0] to Fix[1] is not drift", () => {
    // PR #98: upstream reported MovingSpeed/MovingDirection/MovingPrediction
    // as "removed". They were still there, just on the 08:00 fix rather
    // than the 02:00 one.
    const oldFixture = {
      AnalysisData: {
        Fix: [
          { DateTime: "t0", MaxWindSpeed: "15", MovingSpeed: "10", MovingDirection: "W", MovingPrediction: "..." },
          { DateTime: "t1", MaxWindSpeed: "18" }
        ]
      }
    };
    const newFixture = {
      AnalysisData: {
        Fix: [
          { DateTime: "t0", MaxWindSpeed: "15" },
          { DateTime: "t1", MaxWindSpeed: "18", MovingSpeed: "12", MovingDirection: "WNW", MovingPrediction: "..." }
        ]
      }
    };
    expect(diffShapesFromValues(oldFixture, newFixture)).toEqual([]);
  });

  it("cwa:W-C0034-005 — Circle15ms/StateTransfer appearing on a non-first element is not drift", () => {
    // PR #98's "added" half: StateTransfer only ever appeared on Fix[0],
    // Circle15ms on all of them.
    const oldFixture = {
      ForecastData: { Fix: [{ ForecastHour: "6" }, { ForecastHour: "12", Circle15ms: {}, StateTransfer: "x" }] }
    };
    const newFixture = {
      ForecastData: { Fix: [{ ForecastHour: "6", Circle15ms: {}, StateTransfer: "x" }, { ForecastHour: "12" }] }
    };
    expect(diffShapesFromValues(oldFixture, newFixture)).toEqual([]);
  });

  it("tdx:bus-eta — EstimateTime present on only some records, in both captures, is not drift", () => {
    // The original observation: 28,731 records, 4,113 without EstimateTime.
    // Which of them lands first is pure chance.
    const oldFixture = [{ StopID: "1", EstimateTime: 580 }, { StopID: "2" }];
    const newFixture = [{ StopID: "1" }, { StopID: "2", EstimateTime: 240 }];
    expect(diffShapesFromValues(oldFixture, newFixture)).toEqual([]);
  });
});

// --- Counter-examples: real field-set changes must STILL be reported ---
describe("genuine array schema changes still trigger drift", () => {
  it("reports a removal when a field vanishes from every element", () => {
    const oldFixture = [{ StopID: "1", EstimateTime: 580 }, { StopID: "2", EstimateTime: 240 }];
    const newFixture = [{ StopID: "1" }, { StopID: "2" }];
    expect(diffShapesFromValues(oldFixture, newFixture)).toEqual([{ path: "$[].EstimateTime", kind: "removed" }]);
  });

  it("reports an addition when a field appears on every element", () => {
    const oldFixture = [{ StopID: "1" }, { StopID: "2" }];
    const newFixture = [{ StopID: "1", Platform: "A" }, { StopID: "2", Platform: "B" }];
    expect(diffShapesFromValues(oldFixture, newFixture)).toEqual([{ path: "$[].Platform", kind: "added" }]);
  });

  it("reports a removal when a field vanishes from every element even though it was on only some before", () => {
    // The bus-eta case as it actually happened in PR #98: previously
    // present on some records, absent from all 78 in the new capture.
    const oldFixture = [{ StopID: "1", EstimateTime: 580 }, { StopID: "2" }];
    const newFixture = [{ StopID: "1" }, { StopID: "2" }];
    expect(diffShapesFromValues(oldFixture, newFixture)).toEqual([{ path: "$[].EstimateTime", kind: "removed" }]);
  });

  it("still reports a genuine type change inside array elements", () => {
    const oldFixture = [{ id: "1" }, { id: "2" }];
    const newFixture = [{ id: 1 }, { id: 2 }];
    expect(diffShapesFromValues(oldFixture, newFixture)).toEqual([
      { path: "$[].id", kind: "type-changed", detail: "string -> number" }
    ]);
  });

  it("a field that is null on every element in one capture and typed in the other is a type change, not silence", () => {
    // Guards the null-yields-to-concrete rule from over-reaching: it only
    // suppresses within-array noise, it does not hide an all-null column
    // turning into a typed one.
    expect(diffShapesFromValues([{ v: null }, { v: null }], [{ v: "x" }, { v: "y" }])).toEqual([
      { path: "$[].v", kind: "type-changed", detail: "null -> string" }
    ]);
  });
});
