import assert from "node:assert/strict";
import { test } from "vitest";
import { isRecord } from "../../src/utils/is-record.js";

test("isRecord accepts object instances and rejects non-record values", () => {
  class ModelMessage {
    content = "hello";
  }

  assert.equal(isRecord(new ModelMessage()), true);
  assert.equal(isRecord({ content: "hello" }), true);
  assert.equal(isRecord(null), false);
  assert.equal(isRecord([]), false);
  assert.equal(isRecord("message"), false);
});
