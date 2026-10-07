import { InMemoryStore, type Item } from "@langchain/langgraph-checkpoint";
import type { ConversationStore } from "./store.js";

interface CatalogDatabase {
  query(
    sql: string,
    values?: unknown[],
  ): Promise<{ rows: Record<string, unknown>[] }>;
}

/** Development/test adapter. All data is already held by the in-memory Store. */
export function createInMemoryConversationStore(
  store = new InMemoryStore(),
): ConversationStore {
  return withCatalog(store, async (namespace, limit, offset) => {
    const items = await store.search(namespace, {
      limit: Number.MAX_SAFE_INTEGER,
    });
    items.sort(
      (left, right) =>
        compareText(right.value.updatedAt, left.value.updatedAt) ||
        compareText(left.value.id, right.value.id),
    );
    return items.slice(offset, offset + limit);
  });
}

/** Call after the host has set up its LangGraph PostgresStore. */
export async function createPostgresConversationStore(
  store: ConversationStore,
  database: CatalogDatabase,
  schema = "public",
): Promise<ConversationStore> {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(schema))
    throw new Error("Conversation Store schema must be a SQL identifier.");
  const table = `"${schema}".store`;
  const catalogOnly = "namespace_path LIKE 'agentdock-conversations:%:threads'";
  await database.query(`CREATE INDEX IF NOT EXISTS agentdock_conversation_catalog_order
    ON ${table} (namespace_path, (value->>'updatedAt') DESC, (value->>'id') COLLATE "C" ASC)
    WHERE ${catalogOnly}`);
  return withCatalog(store, async (namespace, limit, offset) => {
    const result = await database.query(
      `SELECT namespace_path, key, value, created_at, updated_at FROM ${table}
       WHERE namespace_path = $1 AND ${catalogOnly}
         AND (expires_at IS NULL OR expires_at > CURRENT_TIMESTAMP)
       ORDER BY (value->>'updatedAt') DESC, (value->>'id') COLLATE "C" ASC
       LIMIT $2 OFFSET $3`,
      [namespace.join(":"), limit, offset],
    );
    return result.rows.map((row): Item => {
      if (
        typeof row.namespace_path !== "string" ||
        typeof row.key !== "string" ||
        typeof row.value !== "object" ||
        row.value === null ||
        Array.isArray(row.value) ||
        !(row.created_at instanceof Date) ||
        !(row.updated_at instanceof Date)
      )
        throw new Error("Conversation catalog row is invalid.");
      return {
        namespace: row.namespace_path.split(":"),
        key: row.key,
        value: row.value,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      };
    });
  });
}

function withCatalog(
  store: ConversationStore,
  searchThreads: NonNullable<ConversationStore["searchThreads"]>,
): ConversationStore {
  return {
    get: store.get.bind(store),
    put: store.put.bind(store),
    delete: store.delete.bind(store),
    batch: store.batch.bind(store),
    searchThreads,
  };
}

function compareText(left: unknown, right: unknown): number {
  if (typeof left !== "string" || typeof right !== "string")
    throw new Error("Conversation catalog ordering fields are invalid.");
  return Buffer.compare(Buffer.from(left), Buffer.from(right));
}
