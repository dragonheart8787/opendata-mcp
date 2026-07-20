import { describe, expect, it } from "vitest";
import { ToolError, toToolError } from "../../src/infra/errors.js";

describe("ToolError", () => {
  it("defaults hint to message when no hint is given", () => {
    const error = new ToolError({ code: "AUTH_MISSING", message: "缺少金鑰" });
    expect(error.message).toBe("缺少金鑰");
    expect(error.hint).toBe("缺少金鑰");
    expect(error.code).toBe("AUTH_MISSING");
    expect(error.name).toBe("ToolError");
  });

  it("keeps a distinct hint when one is given", () => {
    const error = new ToolError({ code: "NOT_FOUND", message: "找不到資料", hint: "換個縣市試試" });
    expect(error.message).toBe("找不到資料");
    expect(error.hint).toBe("換個縣市試試");
  });

  it("is an instance of Error", () => {
    const error = new ToolError({ code: "UPSTREAM_ERROR", message: "x" });
    expect(error).toBeInstanceOf(Error);
  });
});

describe("toToolError", () => {
  it("passes an existing ToolError through unchanged", () => {
    const original = new ToolError({ code: "INVALID_PARAMS", message: "壞參數" });
    expect(toToolError(original)).toBe(original);
  });

  it("wraps a plain Error as an UPSTREAM_ERROR", () => {
    const wrapped = toToolError(new Error("boom"));
    expect(wrapped).toBeInstanceOf(ToolError);
    expect(wrapped.code).toBe("UPSTREAM_ERROR");
    expect(wrapped.message).toContain("boom");
  });

  it("wraps a non-Error thrown value", () => {
    const wrapped = toToolError("just a string");
    expect(wrapped.code).toBe("UPSTREAM_ERROR");
    expect(wrapped.message).toContain("just a string");
  });
});
