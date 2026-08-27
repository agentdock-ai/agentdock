import assert from "node:assert/strict";
import { test } from "vitest";
import { ToolRegistry } from "../../src/tools/registry.js";

function createTool(overrides = {}) {
  return {
    name: "lookup_report",
    description: "Look up a report.",
    parameters: { type: "object", properties: {} },
    execute: async () => ({ ok: true }),
    ...overrides,
  };
}

test("ToolRegistry rejects invalid tool definitions at registration time", () => {
  const registry = new ToolRegistry();

  assert.throws(
    () => registry.register(createTool({ name: "" })),
    /name/i,
  );
  assert.throws(
    () => registry.register(createTool({ parameters: { type: "not-an-object" } })),
    /schema|parameter|object/i,
  );
});

test("ToolRegistry does not expose mutable registered tool records", () => {
  const registry = new ToolRegistry();
  registry.register(createTool());

  registry.get("lookup_report").description = "Mutated description";
  registry.list()[0].name = "mutated_name";

  assert.equal(registry.get("lookup_report").description, "Look up a report.");
  assert.equal(registry.get("lookup_report").name, "lookup_report");
});
