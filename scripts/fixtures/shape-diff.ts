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

export function shapeOf(value: unknown): Shape {
  if (value === null) {
    return { kind: "null" };
  }
  if (Array.isArray(value)) {
    return { kind: "array", item: value.length > 0 ? shapeOf(value[0]) : null };
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
