import assert from "node:assert/strict";
import { test } from "vitest";
import { parseStreamChunk } from "../../src/langgraph/parse-stream-chunk.js";

test.each(["messages", "updates", "tasks"])(
  "parses a %s stream chunk",
  (mode) => {
    const value = { payload: mode };
    assert.deepEqual(parseStreamChunk([mode, value]), { mode, value });
  },
);

test.each([
  [null, /unsupported stream chunk/],
  [[], /unsupported stream chunk/],
  [["messages"], /unsupported stream chunk/],
  [["tools", {}], /unsupported stream mode/],
  [["unknown", {}], /unsupported stream mode/],
])("rejects malformed stream chunks: %j", (chunk, error) => {
  assert.throws(() => parseStreamChunk(chunk), error);
});

test.each(["messages", "updates", "tasks"])(
  "parses namespaced %s chunks",
  (mode) => {
    const namespace = ["child:uuid", "nested:uuid"];
    assert.deepEqual(parseStreamChunk([namespace, mode, { value: 1 }]), {
      namespace,
      mode,
      value: { value: 1 },
    });
  },
);

test.each([
  [null, "updates", {}],
  [[1], "messages", {}],
  ["child", "messages", {}],
  [[], "unknown", {}],
])("rejects invalid namespaced chunks: %j", (...chunk) => {
  assert.throws(() => parseStreamChunk(chunk));
});
