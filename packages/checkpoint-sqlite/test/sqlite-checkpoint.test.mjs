import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "vitest";
import { SqliteCheckpoint } from "../src/index.ts";

const temporaryDirectories = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("SqliteCheckpoint", () => {
  it("creates the LangGraph schema during idempotent initialization", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "agentdock-sqlite-"));
    temporaryDirectories.push(directory);

    const checkpoint = new SqliteCheckpoint({
      path: path.join(directory, "checkpoints.sqlite"),
    });

    await checkpoint.initialize();
    await checkpoint.initialize();

    const tables = checkpoint.saver.db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
      )
      .all()
      .map(({ name }) => name);

    assert.deepEqual(tables, ["checkpoints", "writes"]);

    await checkpoint.close();
    await checkpoint.close();
  });
});
