#!/usr/bin/env node
import { config as loadEnvironment } from "dotenv";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  AuraAgentTokenProvider,
  createAuraAgentMcpClientFromEnvironment,
} from "./mcp/aura-agent-client.js";
import type { AuraAgentTokenProviderOptions } from "./mcp/aura-agent-client.js";
import { readCaptureLog, translateCaptureLog } from "./io/capture-log.js";
import {
  augmentOpenWikiTaskWithReasoningMemory,
  type ReasoningMemoryClient,
} from "./integration/memory-context.js";
import { Neo4jReasoningStore } from "./store/neo4j-reasoning-store.js";
import type { ReasoningStore } from "./store/reasoning-store.js";

loadEnvironment({ quiet: true });

const DEFAULT_CAPTURE_FILE = resolve("examples/openwiki-run.json");

export interface CliDependencies {
  createMcpClient: () => ReasoningMemoryClient;
  createStore: () => ReasoningStore;
  createTokenProvider: (
    options: AuraAgentTokenProviderOptions,
  ) => Pick<AuraAgentTokenProvider, "getAccessToken">;
  environment: NodeJS.ProcessEnv;
}

const DEFAULT_DEPENDENCIES: CliDependencies = {
  createMcpClient: () => createAuraAgentMcpClientFromEnvironment(),
  createStore: () => Neo4jReasoningStore.fromEnvironment(),
  createTokenProvider: (options) => new AuraAgentTokenProvider(options),
  environment: process.env,
};

export async function runCli(
  argv: string[],
  io: Pick<Console, "error" | "log"> = console,
  dependencies: CliDependencies = DEFAULT_DEPENDENCIES,
): Promise<number> {
  const [command = "help", ...args] = argv;

  switch (command) {
    case "demo": {
      const ingest = args.includes("--ingest");
      const positional = args.filter((argument) => argument !== "--ingest");
      const filePath = resolve(positional[0] ?? DEFAULT_CAPTURE_FILE);
      const trace = translateCaptureLog(await readCaptureLog(filePath));
      io.log(JSON.stringify(trace, null, 2));

      if (ingest) {
        await saveToNeo4j(trace, dependencies);
        io.error(`Ingested reasoning trace ${trace.id}.`);
      }
      return 0;
    }

    case "ingest": {
      const filePath = resolve(args[0] ?? DEFAULT_CAPTURE_FILE);
      const trace = translateCaptureLog(await readCaptureLog(filePath));
      await saveToNeo4j(trace, dependencies);
      io.log(`Ingested reasoning trace ${trace.id}.`);
      return 0;
    }

    case "schema": {
      const store = dependencies.createStore();
      try {
        await store.ensureSchema();
      } finally {
        await store.close();
      }
      io.log("Reasoning-only Neo4j schema is ready.");
      return 0;
    }

    case "query-memory": {
      const question = args.join(" ").trim();
      if (!question) {
        throw new Error("Usage: npm run query-memory -- <question>");
      }
      const result = await dependencies.createMcpClient().queryMemory(question);
      io.log(result.text || JSON.stringify(result.raw, null, 2));
      return 0;
    }

    case "augment-task": {
      const { remaining, value: repository } = extractOption(
        args,
        "--repository",
      );
      const task = remaining.join(" ").trim();
      if (!task) {
        throw new Error(
          "Usage: npm run augment-task -- [--repository <host/owner/repo>] <OpenWiki task>",
        );
      }
      const result = await augmentOpenWikiTaskWithReasoningMemory(
        task,
        dependencies.createMcpClient(),
        { repository },
      );
      if (result.recallError) {
        io.error(
          `Reasoning-memory recall failed open; the task is unaugmented: ${result.recallError.message}`,
        );
      }
      io.log(result.augmentedTask);
      return 0;
    }

    case "mint-token": {
      const clientId = requiredEnv(
        dependencies.environment,
        "AURA_AGENT_MCP_CLIENT_ID",
      );
      const clientSecret = requiredEnv(
        dependencies.environment,
        "AURA_AGENT_MCP_CLIENT_SECRET",
      );
      const token = await dependencies.createTokenProvider({
        clientId,
        clientSecret,
      }).getAccessToken();
      io.error(
        "Sensitive short-lived token follows. Do not commit it; refresh it after expiry.",
      );
      io.log(token);
      return 0;
    }

    case "help":
    case "--help":
    case "-h":
      io.log(helpText());
      return 0;

    default:
      throw new Error(`Unknown command: ${command}\n\n${helpText()}`);
  }
}

async function saveToNeo4j(
  trace: ReturnType<typeof translateCaptureLog>,
  dependencies: CliDependencies,
): Promise<void> {
  const store = dependencies.createStore();
  try {
    await store.ensureSchema();
    await store.saveTrace(trace);
  } finally {
    await store.close();
  }
}

/** Removes one `--name <value>` pair from an argument list. */
function extractOption(
  argumentList: string[],
  name: string,
): { remaining: string[]; value: string | undefined } {
  const index = argumentList.indexOf(name);
  if (index === -1) {
    return { remaining: argumentList, value: undefined };
  }

  const value = argumentList[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`${name} requires a value.`);
  }
  return {
    remaining: [
      ...argumentList.slice(0, index),
      ...argumentList.slice(index + 2),
    ],
    value,
  };
}

function requiredEnv(environment: NodeJS.ProcessEnv, name: string): string {
  const value = environment[name]?.trim();
  if (!value) {
    throw new Error(`${name} is required.`);
  }
  return value;
}

function helpText(): string {
  return [
    "OpenWiki reasoning-memory POC",
    "",
    "  npm run demo -- [capture.json] [--ingest]",
    "  npm run ingest -- [capture.json]",
    "  npm run schema",
    "  npm run query-memory -- <question>",
    "  npm run augment-task -- <OpenWiki task>",
    "  npx tsx src/cli.ts mint-token",
  ].join("\n");
}

const entryPoint = process.argv[1];
if (entryPoint && import.meta.url === pathToFileURL(entryPoint).href) {
  runCli(process.argv.slice(2)).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
