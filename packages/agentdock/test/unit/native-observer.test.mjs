import assert from "node:assert/strict";
import { test } from "vitest";
import { ToolObserver } from "../../src/langgraph/tool-observer.js";
import { EventContext } from "../../src/events/event-context.js";
import { WireEventMapper } from "../../src/events/from-langgraph.js";

const start = (
  observer,
  runId,
  q,
  metadata = { langgraph_checkpoint_ns: "child:c|work:w" },
  tags,
  callId,
) =>
  observer.handleToolStart(
    {},
    JSON.stringify({ q }),
    runId,
    undefined,
    tags,
    metadata,
    "lookup",
    callId,
  );

test("callback run IDs correlate overlapping unnamed tools, progress and failures", () => {
  const observer = new ToolObserver();
  start(observer, "run-a", "A");
  start(observer, "run-b", "B");
  observer.handleToolEvent("B progress", "run-b");
  observer.handleToolEnd("B result", "run-b");
  observer.handleToolEvent("A progress", "run-a");
  observer.handleToolError(new Error("private"), "run-a");
  const chunks = observer.drain();
  assert.deepEqual(
    chunks.map((c) => c.value.toolCallId),
    ["run-a", "run-b", "run-b", "run-b", "run-a", "run-a"],
  );
  assert.equal(observer.drain().length, 0);
  const mapper = new WireEventMapper(new EventContext("run", 0), ["child:c"]);
  const events = chunks.flatMap((c) =>
    mapper.map(c.mode, c.value, c.namespace),
  );
  assert.deepEqual(
    events.find((e) => e.type === "tool.completed").result.input,
    { q: "B" },
  );
  assert.deepEqual(events.find((e) => e.type === "tool.failed").error.input, {
    q: "A",
  });
  assert.equal(JSON.stringify(events).includes("private"), false);
});
test("native tool-call IDs take precedence over execution IDs", () => {
  const observer = new ToolObserver();
  start(observer, "execution", "A", {}, undefined, "native-call");
  observer.handleToolEnd("ok", "execution");
  assert.deepEqual(
    observer.drain().map((c) => c.value.toolCallId),
    ["native-call", "native-call"],
  );
});
test("observation respects native hidden tags and ignores orphan events", () => {
  const observer = new ToolObserver();
  start(observer, "hidden", "A", {}, ["langsmith:hidden"]);
  observer.handleToolStart({}, "x", "missing", undefined, undefined, undefined);
  observer.handleToolEnd("x", "unknown");
  observer.handleToolError(new Error("x"), "hidden");
  observer.handleToolEvent("x", "missing");
  assert.deepEqual(observer.drain(), []);
  assert.equal(observer.observedTools, false);
});
test("root task identities follow native steps and ignore subgraph task IDs", () => {
  const observer = new ToolObserver();
  const task = (ns, step) =>
    observer.handleChainStart({}, {}, "run", undefined, [], {
      langgraph_checkpoint_ns: ns,
      langgraph_step: step,
    });
  task("a:id-a", 1);
  task("b:id-b", 1);
  assert.deepEqual([...observer.rootTasks].sort(), ["id-a", "id-b"]);
  task("child:outer|nested:inner", 4);
  task("root:id-next", 2);
  task("old:id-old", 1);
  observer.handleChainStart({}, {}, "run");
  task("root", 2);
  assert.deepEqual([...observer.rootTasks], ["id-next"]);
});
test("native lifecycle payload is retained without changing IDs or checkpoints", () => {
  const observer = new ToolObserver();
  const event = {
    checkpointId: "cp",
    checkpointNs: [],
    interrupts: [{ id: "i", value: false }],
    status: "pending",
  };
  observer.handleInterrupt(event);
  assert.equal(observer.interruption, event);
});
test("a legacy raw mapper rejects ambiguous parallel correlation", () => {
  const mapper = new WireEventMapper(new EventContext("run", 0));
  for (const q of ["A", "B"])
    mapper.map("tools", {
      event: "on_tool_start",
      name: "lookup",
      input: { q },
    });
  assert.throws(
    () =>
      mapper.map("tools", {
        event: "on_tool_end",
        name: "lookup",
        output: "B",
      }),
    /native execution ID/,
  );
});
