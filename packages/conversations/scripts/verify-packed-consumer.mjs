import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repo = fileURLToPath(new URL("../../../", import.meta.url));
const project = await mkdtemp(
  resolve(tmpdir(), "agentdock-conversations-consumer-"),
);
const artifacts = resolve(project, "artifacts");
await mkdir(artifacts);

async function run(command, args, cwd) {
  await new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { cwd, stdio: "inherit", shell: false });
    child.on("error", reject);
    child.on("exit", (code) =>
      code === 0
        ? resolvePromise()
        : reject(new Error(`${command} failed (${code})`)),
    );
  });
}

async function pack(packageDirectory) {
  await run(
    "npm",
    ["pack", "--ignore-scripts", "--pack-destination", artifacts, "--silent"],
    packageDirectory,
  );
  const metadata = JSON.parse(
    await readFile(resolve(packageDirectory, "package.json"), "utf8"),
  );
  const filename = `${metadata.name.replace(/^@/, "").replaceAll("/", "-")}-${metadata.version}.tgz`;
  return `file:${resolve(artifacts, filename)}`;
}

try {
  const contracts = await pack(resolve(repo, "packages/contracts"));
  const agentdock = await pack(resolve(repo, "packages/agentdock"));
  const conversations = await pack(resolve(repo, "packages/conversations"));
  await mkdir(resolve(project, "src"));
  await writeFile(
    resolve(project, "package.json"),
    JSON.stringify(
      {
        name: "agentdock-conversations-packed-consumer",
        version: "0.0.0",
        private: true,
        type: "module",
        dependencies: {
          "@agentdock-ai/conversations": conversations,
          "@agentdock-ai/agentdock": agentdock,
          "@agentdock-ai/contracts": contracts,
          "@langchain/core": "^1.2.11",
          "@langchain/langgraph": "^1.4.17",
          "@langchain/langgraph-checkpoint": "^1.1.5",
        },
        devDependencies: {
          "@types/node": "^26.0.0",
          typescript: "^5.8.0",
        },
      },
      null,
      2,
    ),
  );
  await writeFile(
    resolve(project, "tsconfig.json"),
    JSON.stringify(
      {
        compilerOptions: {
          target: "ES2022",
          module: "NodeNext",
          moduleResolution: "NodeNext",
          strict: true,
          skipLibCheck: true,
          noEmit: true,
          types: ["node"],
        },
        include: ["src/**/*.ts"],
      },
      null,
      2,
    ),
  );
  await writeFile(
    resolve(project, "src/index.ts"),
    `import { ConversationService, createConversationHttpHandler, createInMemoryConversationStore, createPostgresConversationStore } from "@agentdock-ai/conversations";
import { cloneConversationHistory } from "@agentdock-ai/contracts";
const store = createInMemoryConversationStore();
const database = { query: async (_sql: string, _values?: unknown[]) => ({ rows: [] }) };
void createPostgresConversationStore(store, database, "public");
void [ConversationService, createConversationHttpHandler, cloneConversationHistory];
`,
  );
  await run("npm", ["install", "--no-audit", "--no-fund"], project);
  await run("npm", ["exec", "tsc", "--", "--noEmit"], project);
  await run(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      'import assert from "node:assert/strict";const mod=await import("@agentdock-ai/conversations");assert.equal(typeof mod.ConversationService,"function");assert.equal(typeof mod.createConversationHttpHandler,"function");assert.equal(typeof mod.createPostgresConversationStore,"function");assert.equal(typeof mod.createInMemoryConversationStore().searchThreads,"function");',
    ],
    project,
  );
  console.log(
    "Packed Node consumer installed, typechecked, and imported all public entry points.",
  );
} finally {
  await rm(project, { recursive: true, force: true });
}
