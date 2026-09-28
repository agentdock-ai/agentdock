import assert from "node:assert/strict";
import { test } from "vitest";
import { composeAbortSignals } from "../../src/serving/abort-signal.js";

test("composed signals preserve the first abort reason and detach all listeners", () => {
  const first = new TrackedAbortSignal();
  const second = new TrackedAbortSignal();
  const composed = composeAbortSignals(first, second);
  const reason = new Error("request closed");

  assert.equal(first.addCount, 1);
  assert.equal(second.addCount, 1);
  first.abort(reason);
  second.abort(new Error("later abort"));

  assert.equal(composed.signal.aborted, true);
  assert.equal(composed.signal.reason, reason);
  assert.equal(first.removeCount, 1);
  assert.equal(second.removeCount, 1);
  composed.dispose();
  assert.equal(first.removeCount, 1);
  assert.equal(second.removeCount, 1);
});

test("pre-aborted inputs abort the composed signal without installing listeners", () => {
  const source = new TrackedAbortSignal();
  const reason = new Error("already cancelled");
  source.abort(reason);

  const composed = composeAbortSignals(source);

  assert.equal(composed.signal.aborted, true);
  assert.equal(composed.signal.reason, reason);
  assert.equal(source.addCount, 0);
  assert.equal(source.removeCount, 0);
});

test("disposing before abort is idempotent and removes listeners", () => {
  const source = new TrackedAbortSignal();
  const composed = composeAbortSignals(source);

  composed.dispose();
  composed.dispose();

  assert.equal(source.removeCount, 1);
  source.abort(new Error("after dispose"));
  assert.equal(composed.signal.aborted, false);
});

test("empty signal composition remains usable", () => {
  const composed = composeAbortSignals(undefined, undefined);
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
