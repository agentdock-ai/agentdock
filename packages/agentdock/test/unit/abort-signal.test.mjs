import assert from "node:assert/strict";
import { test } from "vitest";
import { createAbortScope } from "../../src/signals/abort-scope.js";

test("parent and owner cancellation preserve the first reason and detach listeners", () => {
  const first = new TrackedAbortSignal();
  const composed = createAbortScope(first);
  const reason = new Error("request closed");

  assert.equal(first.addCount, 1);
  first.abort(reason);
  composed.abort(new Error("later abort"));

  assert.equal(composed.signal.aborted, true);
  assert.equal(composed.signal.reason, reason);
  assert.equal(first.removeCount, 1);
  composed.dispose();
  assert.equal(first.removeCount, 1);
});

test("pre-aborted inputs abort the composed signal without installing listeners", () => {
  const source = new TrackedAbortSignal();
  const reason = new Error("already cancelled");
  source.abort(reason);

  const composed = createAbortScope(source);

  assert.equal(composed.signal.aborted, true);
  assert.equal(composed.signal.reason, reason);
  assert.equal(source.addCount, 0);
  assert.equal(source.removeCount, 0);
});

test("disposing before abort is idempotent and removes listeners", () => {
  const source = new TrackedAbortSignal();
  const composed = createAbortScope(source);

  composed.dispose();
  composed.dispose();

  assert.equal(source.removeCount, 1);
  source.abort(new Error("after dispose"));
  assert.equal(composed.signal.aborted, false);
});

test("an owned abort scope propagates its reason and detaches parent listeners", () => {
  const parent = new TrackedAbortSignal();
  const scope = createAbortScope(parent);
  const reason = new Error("consumer stopped");

  scope.abort(reason);

  assert.equal(scope.signal.aborted, true);
  assert.equal(scope.signal.reason, reason);
  assert.equal(parent.aborted, false);
  assert.equal(parent.removeCount, 1);
  scope.dispose();
  assert.equal(parent.removeCount, 1);
});

test("an abort scope without a parent remains usable", () => {
  const composed = createAbortScope();
  assert.equal(composed.signal.aborted, false);
  composed.dispose();
});

class TrackedAbortSignal extends EventTarget {
  aborted = false;
  reason;
  addCount = 0;
  removeCount = 0;

  addEventListener(type, listener, options) {
    if (type === "abort") this.addCount += 1;
    return super.addEventListener(type, listener, options);
  }

  removeEventListener(type, listener, options) {
    if (type === "abort") this.removeCount += 1;
    return super.removeEventListener(type, listener, options);
  }

  abort(reason) {
    if (this.aborted) return;
    this.aborted = true;
    this.reason = reason;
    this.dispatchEvent(new Event("abort"));
  }
}
