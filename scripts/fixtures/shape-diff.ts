/**
 * Structural ("shape") diffing for the fixtures-refresh pipeline: compares
 * two JSON values by their *type structure* — which keys exist, what type
 * each holds, array item shape — not their actual data values. A dataset's
 * numbers/dates/station names changing every refresh is expected and not
 * schema drift; a field disappearing or changing from a string to a number
 * is.
 */

export type Shape =
  | { kind: "null" }
  | { kind: "primitive"; type: string }
  | { kind: "array"; item: Shape | null } // null = empty array, item shape unknown
  | { kind: "object"; fields: Record<string, Shape> };

/**
 * Combines two shapes into one that describes both.
 *
 * Used to derive an array's item shape from *every* element rather than
 * just the first (see `shapeOf`). The union semantics matter:
 *
 * - **Object fields are unioned.** A field present on only some elements
 *   still appears in the merged shape, because "this array's records may
 *   carry this field" is the true structure. Only when a field is present
 *   on *no* element does it disappear from the shape — which is exactly
 *   when a real removal has happened.
 * - **`null` yields to a concrete shape.** JSON `null` carries no type
 *   information, so one element being null must not erase the type another
 *   element demonstrates. Without this, a nullable field would flip shape
 *   depending on which elements happened to be null in a given capture —
 *   the same class of false positive this whole function exists to remove.
 *
 * Genuinely conflicting concrete types within one array (e.g. `string` on
 * one element, `number` on another) keep the first-seen shape. That's a
 * pathological upstream payload this pipeline has never observed; picking
 * the first keeps the result deterministic for a given response rather
 * than inventing a union type the `Shape` model can't express.
 */
function mergeShapes(a: Shape, b: Shape): Shape {
  if (a.kind === "null") return b;
  if (b.kind === "null") return a;

  if (a.kind === "object" && b.kind === "object") {
    const fields: Record<string, Shape> = { ...a.fields };
    for (const [key, shape] of Object.entries(b.fields)) {
      const existing = fields[key];
      fields[key] = existing === undefined ? shape : mergeShapes(existing, shape);
    }
    return { kind: "object", fields };
  }

  if (a.kind === "array" && b.kind === "array") {
    // An empty array tells us nothing about its item shape, same reasoning
    // as `null` above.
    if (a.item === null) return b;
    if (b.item === null) return a;
    return { kind: "array", item: mergeShapes(a.item, b.item) };
  }

  return a;
}

/**
 * `shapeOf` walks an array's **every** element and merges their shapes,
 * rather than sampling `array[0]`.
 *
 * Sampling only the first element produced a recurring false positive: real
 * upstream payloads carry genuinely optional per-record fields whose
 * presence depends on live conditions, not on schema. Three independently
 * observed cases (all documented in AGENTS.md §6): TDX bus-eta's
 * `EstimateTime` (present only while buses are actually running), CWA
 * typhoon `AnalysisData.Fix[].MovingPrediction`, and that same dataset's
 * `ForecastData.Fix[].Circle15ms`/`StateTransfer`. Each flipped
 * "added"/"removed" between refreshes purely because element 0 happened to
 * carry the field that time, opening a schema-drift PR with nothing
 * actually wrong behind it.
 *
 * **Cost**: linear in total JSON size. Each element is walked once
 * (`shapeOf`) and merged once, and each merge touches at most the number of
 * distinct keys at that level — so an 874-station observation array or a
 * few hundred bus records costs a few tens of thousands of cheap
 * operations, not the O(n²) that pairwise element comparison would.
 *
 * **What this deliberately does NOT fix**: a field absent from *every*
 * element of a capture is indistinguishable from a genuine removal, and
 * still reports as drift. That is the correct call — the shape really did
 * change — but it means an optional field can still trigger a notification
 * when real-world conditions blank it out across a whole response (bus-eta
 * with no buses running is the live example). Suppressing that would need
 * a per-dataset known-optional allowlist, which is a separate decision.
 */
export function shapeOf(value: unknown): Shape {
  if (value === null) {
    return { kind: "null" };
  }
  if (Array.isArray(value)) {
    if (value.length === 0) {
      return { kind: "array", item: null };
    }
    let item = shapeOf(value[0]);
    for (let i = 1; i < value.length; i++) {
      item = mergeShapes(item, shapeOf(value[i]));
    }
    return { kind: "array", item };
  }
  if (typeof value === "object") {
    const fields: Record<string, Shape> = {};
    for (const [key, fieldValue] of Object.entries(value as Record<string, unknown>)) {
      fields[key] = shapeOf(fieldValue);
    }
    return { kind: "object", fields };
  }
  return { kind: "primitive", type: typeof value };
}

export interface ShapeDiffEntry {
  path: string;
  kind: "added" | "removed" | "type-changed";
  detail?: string;
}

function describeShape(shape: Shape): string {
  return shape.kind === "primitive" ? shape.type : shape.kind;
}

export function diffShapes(oldShape: Shape, newShape: Shape, path = "$"): ShapeDiffEntry[] {
  if (oldShape.kind !== newShape.kind) {
    return [{ path, kind: "type-changed", detail: `${describeShape(oldShape)} -> ${describeShape(newShape)}` }];
  }

  if (oldShape.kind === "object" && newShape.kind === "object") {
    const diffs: ShapeDiffEntry[] = [];
    const oldKeys = new Set(Object.keys(oldShape.fields));
    const newKeys = new Set(Object.keys(newShape.fields));

    for (const key of newKeys) {
      if (!oldKeys.has(key)) {
        diffs.push({ path: `${path}.${key}`, kind: "added" });
      }
    }
    for (const key of oldKeys) {
      if (!newKeys.has(key)) {
        diffs.push({ path: `${path}.${key}`, kind: "removed" });
      }
    }
    for (const key of oldKeys) {
      if (newKeys.has(key)) {
        diffs.push(...diffShapes(oldShape.fields[key], newShape.fields[key], `${path}.${key}`));
      }
    }
    return diffs;
  }

  if (oldShape.kind === "array" && newShape.kind === "array") {
    // If either side was an empty array we don't know its item shape, so
    // there's nothing meaningful to compare there — not a diff by itself.
    if (oldShape.item && newShape.item) {
      return diffShapes(oldShape.item, newShape.item, `${path}[]`);
    }
    return [];
  }

  if (oldShape.kind === "primitive" && newShape.kind === "primitive" && oldShape.type !== newShape.type) {
    return [{ path, kind: "type-changed", detail: `${oldShape.type} -> ${newShape.type}` }];
  }

  return [];
}

export function diffShapesFromValues(oldValue: unknown, newValue: unknown): ShapeDiffEntry[] {
  return diffShapes(shapeOf(oldValue), shapeOf(newValue));
}

export function formatShapeDiff(entries: ShapeDiffEntry[]): string {
  if (entries.length === 0) {
    return "（無結構性差異）";
  }
  return entries
    .map(entry => {
      if (entry.kind === "added") return `+ 新增欄位 ${entry.path}`;
      if (entry.kind === "removed") return `- 移除欄位 ${entry.path}`;
      return `~ 型別改變 ${entry.path}（${entry.detail}）`;
    })
    .join("\n");
}
