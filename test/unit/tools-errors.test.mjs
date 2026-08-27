import assert from "node:assert/strict";
import { test, vi } from "vitest";
import { ToolRegistry } from "../../src/tools/registry.js";
import { buildToolSet } from "../../src/agent/runtime/tools.js";
import {
  deriveAbortSignal,
  toErrorMessage,
  withAbortSignal,
} from "../../src/agent/runtime/errors.js";

test("toErrorMessage normalizes supported error shapes", () => {
  assert.equal(toErrorMessage(new Error("Request failed")), "Request failed");
  assert.equal(toErrorMessage("Request failed"), "Request failed");
  assert.equal(
    toErrorMessage({ name: "TimeoutError", message: "after 100ms" }),
    "Tool timed out: after 100ms",
  );
  assert.equal(
    toErrorMessage({ name: "AbortError", message: "aborted" }),
    "Tool execution was aborted",
  );
  assert.equal(toErrorMessage({ unexpected: true }), "Tool execution failed");
});

test("withAbortSignal rejects when the operation is aborted", async () => {
  const controller = new AbortController();
  const operation = new Promise(() => {});
  const guarded = withAbortSignal(operation, controller.signal);
  const reason = new Error("Request cancelled");

  controller.abort(reason);

  await assert.rejects(guarded, (error) => error === reason);
});

test("deriveAbortSignal preserves a parent signal and composes a timeout", () => {
  const controller = new AbortController();
  const parentSignal = deriveAbortSignal(controller.signal, undefined);
  const combinedSignal = deriveAbortSignal(controller.signal, 10_000);

  assert.equal(parentSignal, controller.signal);
  assert.equal(combinedSignal.aborted, false);

  controller.abort();
  assert.equal(combinedSignal.aborted, true);
});

test("buildToolSet executes tools and reports lifecycle hooks", async () => {
  const registry = new ToolRegistry();
  const calls = [];
  const results = [];
  const received = [];

  registry.register({
    name: "lookup_report",
    description: "Look up a report.",
    parameters: { type: "object", properties: {} },
    execute: async ({ input, ctx, signal }) => {
      received.push({ input, ctx, signal });
      return { reportId: "report-2026-08", found: true };
    },
  });

  const tools = buildToolSet(
    registry,
    { userId: "user-123" },
    undefined,
    undefined,
    {
      onToolCall: (call) => calls.push(call),
      onToolResult: (result) => results.push(result),
    },
    [],
  );

  const output = await tools.lookup_report.execute(
    { reportType: "monthly" },
    { toolCallId: "call-lookup-report" },
  );

  assert.deepEqual(output, { reportId: "report-2026-08", found: true });
  assert.deepEqual(calls, [{
    toolCallId: "call-lookup-report",
    name: "lookup_report",
    input: { reportType: "monthly" },
  }]);
  assert.deepEqual(results, [{
    toolCallId: "call-lookup-report",
    name: "lookup_report",
    input: { reportType: "monthly" },
    result: { reportId: "report-2026-08", found: true },
  }]);
  assert.equal(received[0].ctx.userId, "user-123");
  assert.equal(received[0].signal, undefined);
});

test("buildToolSet converts tool failures into tool error results", async () => {
  const registry = new ToolRegistry();
  const toolErrors = [];
  const results = [];

  registry.register({
    name: "load_report",
    description: "Load a report.",
    parameters: { type: "object", properties: {} },
    execute: async () => {
      throw new Error("Report service unavailable");
    },
  });

  const tools = buildToolSet(
    registry,
    {},
    undefined,
    undefined,
    { onToolResult: (result) => results.push(result) },
    toolErrors,
  );

  const output = await tools.load_report.execute(
    { reportId: "report-2026-08" },
    { toolCallId: "call-load-report" },
  );

  assert.deepEqual(output, { error: "Report service unavailable" });
  assert.deepEqual(toolErrors, [{
    toolCallId: "call-load-report",
    name: "load_report",
    input: { reportId: "report-2026-08" },
    error: "Report service unavailable",
  }]);
  assert.deepEqual(results, [{
    toolCallId: "call-load-report",
    name: "load_report",
    input: { reportId: "report-2026-08" },
    result: undefined,
    error: "Report service unavailable",
  }]);
});

test("buildToolSet converts synchronous tool throws into tool error results", async () => {
  const registry = new ToolRegistry();
  const toolErrors = [];

  registry.register({
    name: "sync_failure",
    description: "A synchronously failing tool.",
    parameters: { type: "object", properties: {} },
    execute: () => {
      throw new Error("Synchronous failure");
    },
  });

  const tools = buildToolSet(registry, {}, undefined, undefined, undefined, toolErrors);
  const output = await tools.sync_failure.execute(
    {},
    { toolCallId: "call-sync-failure" },
  );

  assert.deepEqual(output, { error: "Synchronous failure" });
  assert.equal(toolErrors[0].error, "Synchronous failure");
});

test("buildToolSet rejects tool input that is not an object", async () => {
  const registry = new ToolRegistry();
  registry.register({
    name: "validate_input",
    description: "Validates tool input.",
    parameters: { type: "object", properties: {} },
    execute: async () => ({ ok: true }),
  });

  const tools = buildToolSet(registry, {}, undefined, undefined, undefined, []);

  await assert.rejects(
    tools.validate_input.execute(null, { toolCallId: "call-invalid-input" }),
    /object|input/i,
  );
});

test("buildToolSet releases completed tool timeout timers", async () => {
  vi.useFakeTimers();
  try {
    const registry = new ToolRegistry();
    let signal;
    registry.register({
      name: "quick_tool",
      description: "Completes before its timeout.",
      parameters: { type: "object", properties: {} },
      execute: async (input) => {
        signal = input.signal;
        return { ok: true };
      },
    });

    const tools = buildToolSet(registry, {}, undefined, 1_000, undefined, []);
    await tools.quick_tool.execute({}, { toolCallId: "call-quick-tool" });

    vi.advanceTimersByTime(1_000);
    assert.equal(signal.aborted, false);
  } finally {
    vi.useRealTimers();
  }
});
