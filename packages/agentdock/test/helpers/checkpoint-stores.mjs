import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemorySaver } from "@langchain/langgraph";
import { SqliteSaver } from "@langchain/langgraph-checkpoint-sqlite";

export async function createCheckpointStores(backend) {
  if (backend === "memory")
    return {
      referenceSaver: new MemorySaver(),
      actualSaver: new MemorySaver(),
      async dispose() {},
    };
  const directory = await mkdtemp(join(tmpdir(), "agentdock-native-state-"));
  const referenceSaver = SqliteSaver.fromConnString(
    join(directory, "reference.sqlite"),
  );
  const actualSaver = SqliteSaver.fromConnString(
    join(directory, "actual.sqlite"),
  );
  return {
    referenceSaver,
    actualSaver,
    async dispose() {
      referenceSaver.db.close();
      actualSaver.db.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}
