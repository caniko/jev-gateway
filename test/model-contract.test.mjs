import { describe, it, expect } from "vitest";
import { modelContractError } from "./fixtures/model-contract.mjs";

describe("scripted model request semantics", () => {
  const tools = [{ type: "function", function: { name: "read" } }];
  it("honors none, required, and named selections", () => {
    expect(modelContractError({ tools, tool_choice: "none" }, { name: "read" })).toBeDefined();
    expect(modelContractError({ tools, tool_choice: "none" }, undefined)).toBeUndefined();
    expect(modelContractError({ tools, tool_choice: "required" }, undefined)).toBeDefined();
    expect(modelContractError({ tools, tool_choice: { function: { name: "read" } } }, undefined)).toBeDefined();
    expect(modelContractError({ tools, tool_choice: { function: { name: "read" } } }, { name: "read" })).toBeUndefined();
  });
  it("requires advertised names except in explicit adversarial cases", () => {
    expect(modelContractError({ tools }, { name: "write" })).toBeDefined();
    expect(modelContractError({ tools }, { name: "write" }, true)).toBeUndefined();
    expect(modelContractError({ tools }, { name: "read" })).toBeUndefined();
  });
});
