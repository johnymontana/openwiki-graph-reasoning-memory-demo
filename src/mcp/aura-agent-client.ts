export interface McpTool {
  annotations?: Record<string, unknown>;
  description?: string;
  inputSchema?: {
    properties?: Record<string, unknown>;
    required?: string[];
    type?: string;
  };
  name: string;
}

export interface AuraAgentMemoryResult {
  raw: unknown;
  text: string;
  toolName: string;
}

export interface AuraAgentMcpClientOptions {
  bearerToken?: string;
  endpoint: string;
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
  tokenProvider?: AuraAgentTokenProvider;
  toolName?: string;
}

export interface AuraAgentTokenProviderOptions {
  clientId: string;
  clientSecret: string;
  fetch?: typeof globalThis.fetch;
  tokenEndpoint?: string;
}

type JsonRpcResponse = {
  error?: { code?: number; message?: string };
  id?: number;
  result?: unknown;
};

/** Small Streamable HTTP MCP client tailored to an external Aura Agent. */
export class AuraAgentMcpClient {
  readonly #bearerToken?: string;
  readonly #endpoint: URL;
  readonly #fetch: typeof globalThis.fetch;
  readonly #timeoutMs: number;
  readonly #tokenProvider?: AuraAgentTokenProvider;
  readonly #toolName?: string;
  #nextId = 1;
  #sessionId?: string;
  #initialized = false;

  constructor(options: AuraAgentMcpClientOptions) {
    this.#endpoint = validateEndpoint(options.endpoint);
    this.#bearerToken = options.bearerToken;
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#timeoutMs = options.timeoutMs ?? 60_000;
    this.#tokenProvider = options.tokenProvider;
    this.#toolName = options.toolName;
  }

  async initialize(): Promise<void> {
    if (this.#initialized) {
      return;
    }

    await this.#request("initialize", {
      capabilities: {},
      clientInfo: {
        name: "openwiki-reasoning-memory",
        version: "0.1.0",
      },
      protocolVersion: "2025-06-18",
    });
    await this.#notification("notifications/initialized", {});
    this.#initialized = true;
  }

  async listTools(): Promise<McpTool[]> {
    await this.initialize();
    const result = await this.#request("tools/list", {});
    if (!isRecord(result) || !Array.isArray(result.tools)) {
      throw new Error("Aura Agent MCP tools/list returned an invalid response.");
    }

    return result.tools.filter(isMcpTool);
  }

  async queryMemory(question: string): Promise<AuraAgentMemoryResult> {
    const prompt = question.trim();
    if (!prompt) {
      throw new Error("A non-empty memory question is required.");
    }

    const tools = await this.listTools();
    const tool = selectQueryTool(tools, this.#toolName);
    const result = await this.#request("tools/call", {
      arguments: buildToolArguments(tool, prompt),
      name: tool.name,
    });
    if (isRecord(result) && result.isError === true) {
      const detail = extractMcpText(result);
      throw new Error(
        `Aura Agent MCP tool ${tool.name} failed${detail ? `: ${detail}` : "."}`,
      );
    }

    return {
      raw: result,
      text: extractMcpText(result),
      toolName: tool.name,
    };
  }

  async #notification(method: string, params: Record<string, unknown>): Promise<void> {
    await this.#post({ jsonrpc: "2.0", method, params });
  }

  async #request(
    method: string,
    params: Record<string, unknown>,
  ): Promise<unknown> {
    const id = this.#nextId++;
    const response = await this.#post({ id, jsonrpc: "2.0", method, params });
    if (response.error) {
      throw new Error(
        `Aura Agent MCP ${method} failed: ${response.error.message ?? "unknown error"}`,
      );
    }
    return response.result;
  }

  async #post(message: Record<string, unknown>): Promise<JsonRpcResponse> {
    const bearerToken =
      this.#bearerToken ?? (await this.#tokenProvider?.getAccessToken());
    const response = await this.#fetch(this.#endpoint, {
      body: JSON.stringify(message),
      headers: {
        Accept: "application/json, text/event-stream",
        ...(bearerToken
          ? { Authorization: `Bearer ${bearerToken}` }
          : {}),
        "Content-Type": "application/json",
        "MCP-Protocol-Version": "2025-06-18",
        ...(this.#sessionId ? { "Mcp-Session-Id": this.#sessionId } : {}),
      },
      method: "POST",
      signal: AbortSignal.timeout(this.#timeoutMs),
    });

    const sessionId = response.headers.get("mcp-session-id");
    if (sessionId) {
      this.#sessionId = sessionId;
    }

    const body = await response.text();
    if (!response.ok) {
      throw new Error(
        `Aura Agent MCP request failed with HTTP ${response.status}${body ? `: ${body.slice(0, 500)}` : ""}`,
      );
    }
    if (response.status === 202 || body.trim() === "") {
      return {};
    }

    return parseMcpResponse(body, response.headers.get("content-type") ?? "");
  }
}

/**
 * Exchanges Aura Agent & MCP client credentials and caches the token for its
 * advertised lifetime. The gateway limits exchanges to 15/hour/client id.
 */
export class AuraAgentTokenProvider {
  readonly #clientId: string;
  readonly #clientSecret: string;
  readonly #fetch: typeof globalThis.fetch;
  readonly #tokenEndpoint: URL;
  #cached?: { accessToken: string; expiresAt: number };

  constructor(options: AuraAgentTokenProviderOptions) {
    this.#clientId = options.clientId;
    this.#clientSecret = options.clientSecret;
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#tokenEndpoint = new URL(
      options.tokenEndpoint ?? "https://mcp.neo4j.io/oauth/token",
    );
  }

  async getAccessToken(): Promise<string> {
    const now = Date.now();
    if (this.#cached && now < this.#cached.expiresAt - 30_000) {
      return this.#cached.accessToken;
    }

    const response = await this.#fetch(this.#tokenEndpoint, {
      body: new URLSearchParams({
        audience: "https://agent-mcp.neo4j.io",
        client_id: this.#clientId,
        client_secret: this.#clientSecret,
        grant_type: "client_credentials",
      }),
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      method: "POST",
    });
    const body = (await response.json()) as unknown;
    if (!response.ok || !isRecord(body) || typeof body.access_token !== "string") {
      throw new Error(
        `Aura Agent MCP token exchange failed with HTTP ${response.status}.`,
      );
    }

    const expiresIn =
      typeof body.expires_in === "number" && body.expires_in > 0
        ? body.expires_in
        : 3_600;
    this.#cached = {
      accessToken: body.access_token,
      expiresAt: now + expiresIn * 1_000,
    };
    return this.#cached.accessToken;
  }
}

export function createAuraAgentMcpClientFromEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
): AuraAgentMcpClient {
  const endpoint = requiredEnvironmentValue(environment, "AURA_AGENT_MCP_URL");
  const bearerToken = optionalEnvironmentValue(
    environment,
    "AURA_AGENT_MCP_ACCESS_TOKEN",
  );
  const clientId = optionalEnvironmentValue(
    environment,
    "AURA_AGENT_MCP_CLIENT_ID",
  );
  const clientSecret = optionalEnvironmentValue(
    environment,
    "AURA_AGENT_MCP_CLIENT_SECRET",
  );

  if (!bearerToken && (!clientId || !clientSecret)) {
    throw new Error(
      "Set AURA_AGENT_MCP_ACCESS_TOKEN or both AURA_AGENT_MCP_CLIENT_ID and AURA_AGENT_MCP_CLIENT_SECRET.",
    );
  }

  return new AuraAgentMcpClient({
    bearerToken,
    endpoint,
    tokenProvider:
      bearerToken || !clientId || !clientSecret
        ? undefined
        : new AuraAgentTokenProvider({ clientId, clientSecret }),
    toolName: optionalEnvironmentValue(environment, "AURA_AGENT_MCP_TOOL"),
  });
}

export function selectQueryTool(tools: McpTool[], preferredName?: string): McpTool {
  if (tools.length === 0) {
    throw new Error("Aura Agent MCP exposed no tools.");
  }

  if (preferredName) {
    const preferred = tools.find((tool) => tool.name === preferredName);
    if (!preferred) {
      throw new Error(
        `AURA_AGENT_MCP_TOOL=${preferredName} was not returned by tools/list. Available tools: ${tools.map((tool) => tool.name).join(", ")}`,
      );
    }
    return preferred;
  }

  if (tools.length === 1) {
    return tools[0]!;
  }

  const likely = tools.filter((tool) =>
    /(?:agent|ask|query|memory|reason)/iu.test(
      `${tool.name} ${tool.description ?? ""}`,
    ),
  );
  if (likely.length === 1) {
    return likely[0]!;
  }

  throw new Error(
    `Aura Agent MCP exposed multiple tools. Set AURA_AGENT_MCP_TOOL to one of: ${tools.map((tool) => tool.name).join(", ")}`,
  );
}

export function buildToolArguments(
  tool: McpTool,
  question: string,
): Record<string, unknown> {
  const properties = tool.inputSchema?.properties ?? {};
  for (const candidate of ["input", "query", "question", "prompt"]) {
    if (candidate in properties) {
      return { [candidate]: question };
    }
  }

  const required = tool.inputSchema?.required ?? [];
  if (required.length === 1) {
    return { [required[0]!]: question };
  }

  if (Object.keys(properties).length === 0) {
    return { input: question };
  }

  throw new Error(
    `Cannot infer the question argument for MCP tool ${tool.name}; set AURA_AGENT_MCP_TOOL to a tool with an input, query, question, or prompt field.`,
  );
}

export function extractMcpText(result: unknown): string {
  if (typeof result === "string") {
    return result;
  }
  if (!isRecord(result) || !Array.isArray(result.content)) {
    return JSON.stringify(result);
  }

  return result.content
    .flatMap((block) => {
      if (typeof block === "string") {
        return [block];
      }
      if (isRecord(block) && typeof block.text === "string") {
        return [block.text];
      }
      return [];
    })
    .join("\n")
    .trim();
}

function parseMcpResponse(body: string, contentType: string): JsonRpcResponse {
  if (!contentType.includes("text/event-stream")) {
    return JSON.parse(body) as JsonRpcResponse;
  }

  const dataLines = body
    .split(/\r?\n/u)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice("data:".length).trim());

  for (const data of dataLines) {
    const parsed = JSON.parse(data) as JsonRpcResponse;
    if (parsed.id !== undefined || parsed.result !== undefined || parsed.error) {
      return parsed;
    }
  }
  return {};
}

function isMcpTool(value: unknown): value is McpTool {
  return isRecord(value) && typeof value.name === "string";
}

function isRecord(value: unknown): value is Record<string, any> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validateEndpoint(value: string): URL {
  const url = new URL(value);
  const isLocal = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (url.protocol !== "https:" && !(isLocal && url.protocol === "http:")) {
    throw new Error("Aura Agent MCP endpoint must use HTTPS (HTTP is allowed only for localhost). ");
  }
  return url;
}

function requiredEnvironmentValue(
  environment: NodeJS.ProcessEnv,
  name: string,
): string {
  const value = optionalEnvironmentValue(environment, name);
  if (!value) {
    throw new Error(`${name} is required.`);
  }
  return value;
}

function optionalEnvironmentValue(
  environment: NodeJS.ProcessEnv,
  name: string,
): string | undefined {
  const value = environment[name]?.trim();
  return value ? value : undefined;
}
