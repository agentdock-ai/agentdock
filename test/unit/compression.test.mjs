import assert from "node:assert/strict";
import { test } from "vitest";
import { SummarizeCompression } from "../../src/compression/strategy.js";

function createCompression(options = {}) {
  return new SummarizeCompression({
    model: {},
    maxTokens: 20,
    tailTokenBudget: 8,
    headCount: 1,
    ...options,
  });
}

test("SummarizeCompression detects when active message tokens exceed the limit", () => {
  const compression = createCompression({ maxTokens: 5 });

  assert.equal(
    compression.shouldCompress([
      { role: "user", content: "Short" },
    ]),
    false,
  );
  assert.equal(
    compression.shouldCompress([
      { role: "user", content: "This message contains more than five tokens." },
    ]),
    true,
  );
  assert.equal(
    compression.shouldCompress([
      { role: "user", content: "This is inactive and should be ignored.", active: false },
    ]),
    false,
  );
});

test("SummarizeCompression leaves histories without a compressible middle unchanged", async () => {
  const compression = createCompression({ headCount: 3 });
  const messages = [
    { role: "system", content: "Follow the report policy." },
    { role: "user", content: "Find the report." },
    { role: "assistant", content: "I will look for it." },
  ];

  const result = await compression.compress(messages);

  assert.equal(result, messages);
  assert.deepEqual(result, messages);
});
