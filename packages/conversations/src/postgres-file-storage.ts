import type { ConversationFileStorage } from "./attachment-storage.js";
import type { PostgresQueryClient } from "./store-adapters.js";

export interface PostgresConversationFileStorageOptions {
  schema?: string;
  table?: string;
}

/** Creates the byte table and returns a ConversationFileStorage backed by PostgreSQL. */
export async function createPostgresConversationFileStorage(
  database: PostgresQueryClient,
  options: PostgresConversationFileStorageOptions = {},
): Promise<ConversationFileStorage> {
  const schema = sqlIdentifier(options.schema ?? "public", "schema");
  const table = sqlIdentifier(
    options.table ?? "agentdock_conversation_files",
    "table",
  );
  const qualifiedTable = `"${schema}"."${table}"`;

  await database.query(`
    CREATE TABLE IF NOT EXISTS ${qualifiedTable} (
      id text PRIMARY KEY,
      data bytea NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    )
  `);

  return {
    async put({ id, bytes }) {
      await database.query(
        `INSERT INTO ${qualifiedTable} (id, data) VALUES ($1, $2)
         ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data`,
        [id, Buffer.from(bytes)],
      );
      return id;
    },
    async get(reference) {
      const result = await database.query(
        `SELECT data FROM ${qualifiedTable} WHERE id = $1`,
        [reference],
      );
      const data = result.rows[0]?.data;
      if (data === undefined) return null;
      if (!(data instanceof Uint8Array))
        throw new Error("PostgreSQL conversation file data is invalid.");
      return new Uint8Array(data);
    },
    async delete(reference) {
      await database.query(`DELETE FROM ${qualifiedTable} WHERE id = $1`, [
        reference,
      ]);
    },
  };
}

function sqlIdentifier(value: string, label: string): string {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(value))
    throw new Error(`Conversation file ${label} must be a SQL identifier.`);
  return value;
}
