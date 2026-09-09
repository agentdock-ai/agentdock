import assert from "node:assert/strict";
import { test } from "vitest";
import { ToolRegistry } from "../../src/index.js";

function createTool(overrides = {}) {
  return {
    name: "get_weather",
    description: "Return the weather.",
    parameters: {
      type: "object",
      properties: { city: { type: "string" } },
      required: ["city"],
      additionalProperties: false,
    },
    execute: async ({ input }) => ({ city: input.city }),
    ...overrides,
  };
}

test("registers tools and returns their public schemas", () => {
  const registry = new ToolRegistry();
  registry.register(createTool({ requiresApproval: true }));

  assert.equal(registry.get("get_weather").name, "get_weather");
  assert.deepEqual(registry.schemas(), [
    {
      name: "get_weather",
      description: "Return the weather.",
      parameters: {
        type: "object",
        properties: { city: { type: "string" } },
        required: ["city"],
        additionalProperties: false,
      },
      requiresApproval: true,
    },
  ]);
});

test("snapshots tools and protects the registry from later mutations", () => {
  const registry = new ToolRegistry();
  const tool = createTool();
  registry.register(tool);

  tool.name = "changed";
  tool.requiresApproval = true;
  tool.parameters.properties.city.type = "number";

  const returned = registry.get("get_weather");
  returned.parameters.properties.city.type = "boolean";

  assert.equal(registry.get("changed"), undefined);
  assert.equal(registry.schemas()[0].requiresApproval, false);
  assert.equal(registry.schemas()[0].parameters.properties.city.type, "string");
});

test("rejects invalid tool boundaries", () => {
  const registry = new ToolRegistry();
  const invalidTools = [
    [{ name: 42 }, /Tool name must be a non-empty string/],
    [createTool({ name: " get_weather" }), /leading or trailing whitespace/],
    [createTool({ description: "" }), /Tool description.*non-empty string/],
    [createTool({ execute: "not-a-function" }), /execute must be a function/],
    [createTool({ authorize: true }), /authorize must be a function/],
    [
      createTool({ requiresApproval: "yes" }),
      /requiresApproval must be a boolean/,
    ],
  ];

  for (const [tool, message] of invalidTools) {
    assert.throws(() => registry.register(tool), message);
  }
});

test("rejects invalid nested schemas and duplicate tools", () => {
  const registry = new ToolRegistry();
  assert.throws(
    () => registry.register(createTool({ parameters: { type: "string" } })),
    /Tool parameters must have an object root type/,
  );
  assert.throws(
    () => registry.register(createTool({ parameters: true })),
    /Tool parameters must be a JSON schema object/,
  );
  assert.throws(
    () =>
      registry.register(
        createTool({
          parameters: { type: "object", properties: { city: 42 } },
        }),
      ),
    /invalid JSON schema at \$\.properties\.city/,
  );
  assert.throws(
    () =>
      registry.register(
        createTool({ parameters: { type: "object", required: ["", 3] } }),
      ),
    /required entries must be non-empty strings/,
  );

  registry.register(createTool());
  assert.throws(
    () => registry.register(createTool()),
    /Tool already registered: get_weather/,
  );
});

test("clear removes all registered tools", () => {
  const registry = new ToolRegistry();
  registry.register(createTool());
  registry.clear();

  assert.deepEqual(registry.list(), []);
  assert.deepEqual(registry.schemas(), []);
});
