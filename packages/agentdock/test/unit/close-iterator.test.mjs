import assert from "node:assert/strict";
import { test } from "vitest";
import { closeIterator } from "../../src/utils/close-iterator.js";

test("cleanup accepts absent iterators and return methods", async () => {
  await closeIterator();
  await closeIterator({ next() {} });
});

test.each([false, true])(
  "cleanup preserves the outcome when return throws (async=%s)",
  async (asyncError) => {
    let calls = 0;
    await closeIterator({
      return() {
        calls++;
        if (asyncError) return Promise.reject(new Error("cleanup"));
        throw new Error("cleanup");
      },
    });
    assert.equal(calls, 1);
  },
);
