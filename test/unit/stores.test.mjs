import assert from "node:assert/strict";
import { test } from "vitest";
import { InMemoryAgentStore } from "../../src/index.js";
import { defineAgentStoreContract } from "../contracts/agent-store.contract.mjs";

defineAgentStoreContract("InMemoryAgentStore", () => new InMemoryAgentStore());

test("InMemoryAgentStore keeps independent run and session records", () => {
  const store = new InMemoryAgentStore();

  assert.notEqual(store.runs, store.sessions);
  assert.equal(store.runs.get("missing-run"), null);
  assert.equal(store.sessions.get("missing-session"), null);
});
