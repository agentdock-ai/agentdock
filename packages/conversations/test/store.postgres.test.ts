import { randomUUID } from "node:crypto";
import { it } from "vitest";
import { Pool } from "pg";
import { PostgresStore } from "@langchain/langgraph-checkpoint-postgres/store";
import {
  ConversationRecords,
  createPostgresConversationStore,
} from "../src/index.js";
import { verifyConversationRecords } from "./store-contract.js";

const databaseUrl = process.env.AGENTDOCK_TEST_DATABASE_URL;

it.skipIf(!databaseUrl)(
  "runs the shared record-isolation and globally ordered catalog contract in PostgreSQL",
  async () => {
    if (!databaseUrl || !/test/i.test(new URL(databaseUrl).pathname))
      throw new Error(
        "AGENTDOCK_TEST_DATABASE_URL must name a disposable test database.",
      );
    const schema = `conversation_test_${randomUUID().replaceAll("-", "")}`;
    const pool = new Pool({ connectionString: databaseUrl });
    const native = PostgresStore.fromConnString(databaseUrl, { schema });
    try {
      await native.setup();
      const store = await createPostgresConversationStore(native, pool, schema);
      await verifyConversationRecords(
        new ConversationRecords(store, "contract"),
      );
    } finally {
      await native.stop();
      try {
        await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      } finally {
        await pool.end();
      }
    }
  },
  30_000,
);
