import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { test } from "vitest";
import {
  createAgentReducerState,
  reduceAgentEvent,
} from "@agentdock-ai/contracts";

const execute = promisify(execFile);
const worker = fileURLToPath(
  new URL("../helpers/checkpoint-process.mjs", import.meta.url),
);
const cases = ["sync", "async", "exit"].flatMap((durability) => [
  { durability, start: "adapter", resume: "adapter" },
  { durability, start: "native", resume: "adapter" },
  { durability, start: "adapter", resume: "native" },
]);

test.each(cases)(
  "file-backed process restart: $durability / $start start / $resume resume",
  async ({ durability, start, resume }) => {
    const directory = await mkdtemp(
      join(tmpdir(), "agentdock-checkpoint-restart-"),
    );
    const database = join(directory, "checkpoints.sqlite");
    const threadId = "restart-thread";
    const step = async (mode, action, answer) => {
      const { stdout } = await execute(
        process.execPath,
        [
          worker,
          database,
          threadId,
          durability,
          mode,
          action,
          JSON.stringify(answer ?? null),
        ],
        { timeout: 10000, maxBuffer: 1024 * 1024 },
      );
      const result = JSON.parse(stdout);
      assert.notEqual(result.pid, process.pid);
      assert.equal(
        result.events.some((event) => event.type === "run.failed"),
        false,
      );
      assert.equal("agentEventState" in result.snapshot.values, false);
      return result;
    };
    try {
      const paused = await step(start, "start");
      assert.equal(paused.seed.interrupt.prompt, "First?");
      assert.equal(paused.seed.interrupt.occurrence, 0);
      await assert.rejects(() => readFile(`${database}.effects`), {
        code: "ENOENT",
      });
      const hydrated = await step("adapter", "read");
      assert.notEqual(hydrated.pid, paused.pid);
      assert.deepEqual(hydrated.seed, paused.seed);
      assert.equal(hydrated.checkpointDigest, paused.checkpointDigest);
      const second = await step(resume, "resume", {
        [paused.seed.interrupt.interruptId]: "one",
      });
      assert.notEqual(second.pid, paused.pid);
      assert.equal(
        second.seed.interrupt.interruptId,
        paused.seed.interrupt.interruptId,
      );
      assert.equal(second.seed.interrupt.prompt, "Second?");
      assert.equal(second.seed.interrupt.occurrence, 1);
      await assert.rejects(() => readFile(`${database}.effects`), {
        code: "ENOENT",
      });
      if (resume === "adapter") {
        const warm = second.events.reduce(reduceAgentEvent, hydrated.seed);
        assert.deepEqual(warm.interrupts, second.seed.interrupts);
        assert.deepEqual(warm.pausedNodes, second.seed.pausedNodes);
      }
      const completed = await step(resume, "resume", {
        [second.seed.interrupt.interruptId]: "two",
      });
      assert.equal(completed.seed, null);
      assert.deepEqual(completed.snapshot.values, {
        answers: ["one", "two"],
        executions: 1,
      });
      assert.deepEqual(completed.snapshot.next, []);
      assert.equal(
        await readFile(`${database}.effects`, "utf8"),
        "committed\n",
      );
      if (resume === "adapter")
        assert.equal(
          completed.events.reduce(reduceAgentEvent, second.seed).status,
          "completed",
        );
      if (start === "adapter")
        assert.equal(
          paused.events.reduce(reduceAgentEvent, createAgentReducerState())
            .status,
          "waiting",
        );
      const afterRestart = await step("adapter", "read");
      assert.equal(afterRestart.seed, null);
      assert.deepEqual(afterRestart.snapshot.values, completed.snapshot.values);
      assert.equal(afterRestart.checkpointDigest, completed.checkpointDigest);
      assert.equal(
        await readFile(`${database}.effects`, "utf8"),
        "committed\n",
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
  15000,
);
