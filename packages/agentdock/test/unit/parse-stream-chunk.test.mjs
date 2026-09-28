import assert from "node:assert/strict";
import { test } from "vitest";
import { parseStreamChunk } from "../../src/langgraph/parse-stream-chunk.js";

test.each(["messages", "tools", "updates"])(
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
  [["unknown", {}], /unsupported stream mode/],
])("rejects malformed stream chunks: %j", (chunk, error) => {
  assert.throws(() => parseStreamChunk(chunk), error);
});
