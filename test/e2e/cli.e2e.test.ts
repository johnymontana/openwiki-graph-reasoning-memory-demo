import { spawn } from "node:child_process";
import {
  createServer,
  type IncomingHttpHeaders,
  type IncomingMessage,
} from "node:http";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

interface CommandResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stderr: string;
  stdout: string;
}

interface ObservedRequest {
  body: string;
  headers: IncomingHttpHeaders;
  path: string;
}

const projectRoot = resolve(fileURLToPath(new URL("../../", import.meta.url)));
const builtCli = resolve(projectRoot, "dist/cli.js");
const fixture = resolve(projectRoot, "examples/openwiki-run.json");
const fetchRedirector = resolve(
  projectRoot,
  "test/e2e/redirect-token-fetch.mjs",
);
const servers: ReturnType<typeof createServer>[] = [];

beforeAll(async () => {
  const build = await runCommand("npm", ["run", "build"]);
  if (build.exitCode !== 0) {
    throw new Error(`Unable to build the CLI for E2E tests:\n${build.stderr}`);
  }
}, 30_000);

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolveClose, reject) => {
          if (!server.listening) {
            resolveClose();
            return;
          }
          server.close((error) => (error ? reject(error) : resolveClose()));
        }),
    ),
  );
});

describe("built CLI E2E", () => {
  it("prints help through the executable entry point", async () => {
    const result = await runBuiltCli(["--help"]);

    expect(result).toMatchObject({ exitCode: 0, signal: null, stderr: "" });
    expect(result.stdout).toContain("OpenWiki reasoning-memory POC");
    expect(result.stdout).toContain("npm run demo");
    expect(result.stdout).toContain("npm run query-memory");
  });

  it("translates the checked-in OpenWiki capture without external services", async () => {
    const result = await runBuiltCli(["demo", fixture]);

    expect(result).toMatchObject({ exitCode: 0, signal: null, stderr: "" });
    expect(result.stdout).not.toContain("demo-secret");

    const trace = JSON.parse(result.stdout) as {
      id: string;
      success: boolean;
      steps: Array<{
        action: string;
        toolCalls: Array<{
          arguments: Record<string, unknown>;
          result: unknown;
          status: string;
          toolName: string;
        }>;
      }>;
    };

    expect(trace).toMatchObject({ id: "openwiki-demo-001", success: true });
    expect(trace.steps[0]?.action).toBe("plan");
    expect(trace.steps[1]?.action).toMatch(/^glob\(/u);
    expect(trace.steps[2]?.action).toMatch(/^read_file\(/u);
    expect(trace.steps[1]?.toolCalls[0]).toMatchObject({
      arguments: { authorization: "[REDACTED]" },
      result: ["src/agent/index.ts", "src/agent/prompt.ts"],
      status: "success",
      toolName: "glob",
    });
  });

  it("returns a non-zero status and useful diagnostics for an unknown command", async () => {
    const result = await runBuiltCli(["definitely-not-a-command"]);

    expect(result.exitCode).toBe(1);
    expect(result.signal).toBeNull();
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("Unknown command: definitely-not-a-command");
    expect(result.stderr).toContain("OpenWiki reasoning-memory POC");
  });

  it("queries reasoning memory through token exchange and Streamable HTTP MCP", async () => {
    const observed: ObservedRequest[] = [];
    const server = createServer(async (request, response) => {
      const body = await readBody(request);
      observed.push({
        body,
        headers: request.headers,
        path: request.url ?? "",
      });

      if (request.url === "/oauth/token") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({ access_token: "local-e2e-token", expires_in: 3600 }),
        );
        return;
      }

      if (request.url !== "/mcp") {
        response.writeHead(404).end();
        return;
      }

      const message = JSON.parse(body) as {
        id?: number;
        method: string;
        params?: Record<string, unknown>;
      };

      if (message.method === "notifications/initialized") {
        response.writeHead(202).end();
        return;
      }

      const result = mcpResult(message.method, message.params);
      response.writeHead(200, {
        "content-type": "application/json",
        "mcp-session-id": "local-e2e-session",
      });
      response.end(JSON.stringify({ id: message.id, jsonrpc: "2.0", result }));
    });
    await new Promise<void>((resolveListen, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        server.off("error", reject);
        resolveListen();
      });
    });
    servers.push(server);
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Fake MCP server did not expose a TCP address.");
    }
    const baseUrl = `http://127.0.0.1:${address.port}`;

    const result = await runBuiltCli(
      ["query-memory", "How should OpenWiki inspect TypeScript repositories?"],
      {
        AURA_AGENT_MCP_ACCESS_TOKEN: undefined,
        AURA_AGENT_MCP_CLIENT_ID: "local-client-id",
        AURA_AGENT_MCP_CLIENT_SECRET: "local-client-secret",
        AURA_AGENT_MCP_TOOL: "find-reasoning-for-task",
        AURA_AGENT_MCP_URL: `${baseUrl}/mcp`,
        E2E_TOKEN_REDIRECT_BASE: baseUrl,
        NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --import=${pathToFileURL(fetchRedirector).href}`.trim(),
      },
    );

    expect(result).toMatchObject({
      exitCode: 0,
      signal: null,
      stderr: "",
      stdout: "Use glob before read_file for repository inventories.\n",
    });

    const tokenRequests = observed.filter(
      (request) => request.path === "/oauth/token",
    );
    expect(tokenRequests).toHaveLength(1);
    expect(
      Object.fromEntries(new URLSearchParams(tokenRequests[0]!.body)),
    ).toEqual({
      audience: "https://agent-mcp.neo4j.io",
      client_id: "local-client-id",
      client_secret: "local-client-secret",
      grant_type: "client_credentials",
    });

    const mcpRequests = observed.filter((request) => request.path === "/mcp");
    expect(mcpRequests).toHaveLength(4);
    expect(
      mcpRequests.map(
        (request) => (JSON.parse(request.body) as { method: string }).method,
      ),
    ).toEqual([
      "initialize",
      "notifications/initialized",
      "tools/list",
      "tools/call",
    ]);
    expect(
      mcpRequests.every(
        (request) =>
          request.headers.authorization === "Bearer local-e2e-token",
      ),
    ).toBe(true);
    expect(
      mcpRequests
        .slice(1)
        .every(
          (request) =>
            request.headers["mcp-session-id"] === "local-e2e-session",
        ),
    ).toBe(true);

    const call = JSON.parse(mcpRequests[3]!.body) as {
      params: { arguments: { query: string }; name: string };
    };
    expect(call.params).toEqual({
      arguments: {
        query: "How should OpenWiki inspect TypeScript repositories?",
      },
      name: "find-reasoning-for-task",
    });
  });
});

function mcpResult(
  method: string,
  params: Record<string, unknown> | undefined,
): unknown {
  switch (method) {
    case "initialize":
      return {
        capabilities: { tools: {} },
        protocolVersion: "2025-06-18",
        serverInfo: { name: "local-e2e-mcp", version: "1.0.0" },
      };
    case "tools/list":
      return {
        tools: [
          {
            description: "Find similar successful OpenWiki reasoning traces",
            inputSchema: {
              properties: { query: { type: "string" } },
              required: ["query"],
              type: "object",
            },
            name: "find-reasoning-for-task",
          },
        ],
      };
    case "tools/call":
      if (
        params?.name !== "find-reasoning-for-task" ||
        (params.arguments as { query?: unknown } | undefined)?.query !==
          "How should OpenWiki inspect TypeScript repositories?"
      ) {
        return {
          content: [{ text: "Unexpected tool arguments", type: "text" }],
          isError: true,
        };
      }
      return {
        content: [
          {
            text: "Use glob before read_file for repository inventories.",
            type: "text",
          },
        ],
      };
    default:
      return {};
  }
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

function runBuiltCli(
  args: string[],
  environment: Record<string, string | undefined> = {},
): Promise<CommandResult> {
  return runCommand(process.execPath, [builtCli, ...args], environment);
}

function runCommand(
  command: string,
  args: string[],
  environment: Record<string, string | undefined> = {},
): Promise<CommandResult> {
  const childEnvironment: NodeJS.ProcessEnv = { ...process.env };
  for (const [name, value] of Object.entries(environment)) {
    if (value === undefined) {
      delete childEnvironment[name];
    } else {
      childEnvironment[name] = value;
    }
  }

  return new Promise((resolveResult, reject) => {
    const child = spawn(command, args, {
      cwd: projectRoot,
      env: childEnvironment,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];

    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.once("error", reject);
    child.once("close", (exitCode, signal) => {
      resolveResult({
        exitCode,
        signal,
        stderr: Buffer.concat(stderr).toString("utf8"),
        stdout: Buffer.concat(stdout).toString("utf8"),
      });
    });
  });
}
