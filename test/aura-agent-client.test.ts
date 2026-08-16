import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AuraAgentMcpClient,
  AuraAgentTokenProvider,
  buildToolArguments,
  createAuraAgentMcpClientFromEnvironment,
  extractMcpText,
  selectQueryTool,
  type McpTool,
} from "../src/mcp/aura-agent-client.js";

interface StubReply {
  body?: string;
  headers?: HeadersInit;
  json?: unknown;
  status?: number;
}

function createFetchMock(replies: StubReply[]) {
  return vi.fn(async (
    _input: string | URL | Request,
    _init?: RequestInit,
  ) => {
    const reply = replies.shift();
    if (!reply) {
      throw new Error("Unexpected fetch call.");
    }

    const hasJson = Object.hasOwn(reply, "json");
    return new Response(
      reply.body ?? (hasJson ? JSON.stringify(reply.json) : null),
      {
        headers:
          reply.headers ??
          (hasJson ? { "content-type": "application/json" } : undefined),
        status: reply.status,
      },
    );
  });
}

function requestBody(fetchMock: ReturnType<typeof createFetchMock>, index: number) {
  return JSON.parse(String(fetchMock.mock.calls[index]?.[1]?.body)) as Record<
    string,
    any
  >;
}

afterEach(() => {
  vi.useRealTimers();
});

describe("AuraAgentMcpClient", () => {
  it("initializes, discovers a tool, and queries it", async () => {
    const replies = [
      { result: { protocolVersion: "2025-06-18" } },
      {},
      {
        result: {
          tools: [
            {
              inputSchema: {
                properties: { input: { type: "string" } },
                required: ["input"],
              },
              name: "reasoning-memory-agent",
            },
          ],
        },
      },
      { result: { content: [{ text: "Try glob before read_file.", type: "text" }] } },
    ];
    const fetchMock = vi.fn(async (
      _input: string | URL | Request,
      _init?: RequestInit,
    ) => {
      const reply = replies.shift();
      return new Response(JSON.stringify(reply), {
        headers: { "content-type": "application/json" },
      });
    });
    const client = new AuraAgentMcpClient({
      bearerToken: "not-logged",
      endpoint: "https://mcp.neo4j.io/agent?project_id=p&agent_id=a",
      fetch: fetchMock as typeof fetch,
    });

    const result = await client.queryMemory("How should I inspect this repo?");

    expect(result.text).toBe("Try glob before read_file.");
    expect(result.toolName).toBe("reasoning-memory-agent");
    expect(fetchMock).toHaveBeenCalledTimes(4);
    const callBody = JSON.parse(String(fetchMock.mock.calls[3]![1]?.body));
    expect(callBody.params.arguments).toEqual({
      input: "How should I inspect this repo?",
    });
  });

  it("rejects MCP tool results marked as errors", async () => {
    const replies = [
      { result: { protocolVersion: "2025-06-18" } },
      {},
      { result: { tools: [{ name: "reasoning-memory-agent" }] } },
      {
        result: {
          content: [{ text: "Agent invocation failed", type: "text" }],
          isError: true,
        },
      },
    ];
    const fetchMock = vi.fn(async (
      _input: string | URL | Request,
      _init?: RequestInit,
    ) =>
      new Response(JSON.stringify(replies.shift()), {
        headers: { "content-type": "application/json" },
      }),
    );
    const client = new AuraAgentMcpClient({
      bearerToken: "not-logged",
      endpoint: "https://mcp.neo4j.io/agent?project_id=p&agent_id=a",
      fetch: fetchMock as typeof fetch,
    });

    await expect(client.queryMemory("query")).rejects.toThrow(
      "Aura Agent MCP tool reasoning-memory-agent failed: Agent invocation failed",
    );
  });

  it("rejects an empty question without making a request", async () => {
    const fetchMock = createFetchMock([]);
    const client = new AuraAgentMcpClient({
      endpoint: "https://mcp.neo4j.io/agent?project_id=p&agent_id=a",
      fetch: fetchMock as typeof fetch,
    });

    await expect(client.queryMemory(" \n\t ")).rejects.toThrow(
      "A non-empty memory question is required.",
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reports HTTP and JSON-RPC initialization errors", async () => {
    const httpFetch = createFetchMock([
      { body: "access denied", status: 401 },
    ]);
    const httpClient = new AuraAgentMcpClient({
      endpoint: "https://mcp.neo4j.io/agent?project_id=p&agent_id=a",
      fetch: httpFetch as typeof fetch,
    });

    await expect(httpClient.initialize()).rejects.toThrow(
      "Aura Agent MCP request failed with HTTP 401: access denied",
    );

    const rpcFetch = createFetchMock([
      {
        json: {
          error: { code: -32_600, message: "invalid initialize request" },
          id: 1,
          jsonrpc: "2.0",
        },
      },
    ]);
    const rpcClient = new AuraAgentMcpClient({
      endpoint: "https://mcp.neo4j.io/agent?project_id=p&agent_id=a",
      fetch: rpcFetch as typeof fetch,
    });

    await expect(rpcClient.initialize()).rejects.toThrow(
      "Aura Agent MCP initialize failed: invalid initialize request",
    );
  });

  it("rejects malformed tool discovery responses", async () => {
    const fetchMock = createFetchMock([
      { json: { id: 1, result: { protocolVersion: "2025-06-18" } } },
      { status: 202 },
      { json: { id: 2, result: { tools: "not-an-array" } } },
    ]);
    const client = new AuraAgentMcpClient({
      endpoint: "https://mcp.neo4j.io/agent?project_id=p&agent_id=a",
      fetch: fetchMock as typeof fetch,
    });

    await expect(client.listTools()).rejects.toThrow(
      "Aura Agent MCP tools/list returned an invalid response.",
    );
  });

  it("rejects an SSE tool stream with no response event", async () => {
    const fetchMock = createFetchMock([
      { json: { id: 1, result: { protocolVersion: "2025-06-18" } } },
      { status: 202 },
      {
        body: [
          "event: message",
          'data: {"jsonrpc":"2.0","method":"notifications/progress"}',
          "",
        ].join("\n"),
        headers: { "content-type": "text/event-stream" },
      },
    ]);
    const client = new AuraAgentMcpClient({
      endpoint: "https://mcp.neo4j.io/agent?project_id=p&agent_id=a",
      fetch: fetchMock as typeof fetch,
    });

    await expect(client.listTools()).rejects.toThrow(
      "Aura Agent MCP tools/list returned an invalid response.",
    );
  });

  it("parses SSE, keeps the server session, and initializes only once", async () => {
    const initializeSse = [
      "event: message",
      'data: {"jsonrpc":"2.0","method":"notifications/progress"}',
      "",
      "event: message",
      'data: {"jsonrpc":"2.0","id":1,"result":{"protocolVersion":"2025-06-18"}}',
      "",
    ].join("\n");
    const toolsSse = [
      "event: message",
      'data: {"jsonrpc":"2.0","id":2,"result":{"tools":[null,{"name":7},{"name":"memory"}]}}',
      "",
    ].join("\n");
    const fetchMock = createFetchMock([
      {
        body: initializeSse,
        headers: {
          "content-type": "text/event-stream",
          "mcp-session-id": "session-42",
        },
      },
      { status: 202 },
      { body: toolsSse, headers: { "content-type": "text/event-stream" } },
      { json: { id: 3, result: { tools: [{ name: "memory" }] } } },
    ]);
    const client = new AuraAgentMcpClient({
      bearerToken: "bearer-value",
      endpoint: "https://mcp.neo4j.io/agent?project_id=p&agent_id=a",
      fetch: fetchMock as typeof fetch,
    });

    await expect(client.listTools()).resolves.toEqual([{ name: "memory" }]);
    await expect(client.listTools()).resolves.toEqual([{ name: "memory" }]);

    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(fetchMock.mock.calls.map((_, index) => requestBody(fetchMock, index).method))
      .toEqual([
        "initialize",
        "notifications/initialized",
        "tools/list",
        "tools/list",
      ]);
    expect(
      new Headers(fetchMock.mock.calls[0]?.[1]?.headers).get("mcp-session-id"),
    ).toBeNull();
    for (const call of fetchMock.mock.calls.slice(1)) {
      const headers = new Headers(call[1]?.headers);
      expect(headers.get("authorization")).toBe("Bearer bearer-value");
      expect(headers.get("mcp-session-id")).toBe("session-42");
      expect(headers.get("mcp-protocol-version")).toBe("2025-06-18");
    }
  });

  it("surfaces invalid JSON responses", async () => {
    const fetchMock = createFetchMock([
      {
        body: "this is not JSON",
        headers: { "content-type": "application/json" },
      },
    ]);
    const client = new AuraAgentMcpClient({
      endpoint: "https://mcp.neo4j.io/agent?project_id=p&agent_id=a",
      fetch: fetchMock as typeof fetch,
    });

    await expect(client.initialize()).rejects.toBeInstanceOf(SyntaxError);
  });
});

describe("Aura Agent MCP configuration", () => {
  it("requires HTTPS except for loopback development endpoints", () => {
    expect(
      () =>
        new AuraAgentMcpClient({
          endpoint: "http://mcp.neo4j.io/agent?project_id=p&agent_id=a",
        }),
    ).toThrow("Aura Agent MCP endpoint must use HTTPS");
    expect(
      () =>
        new AuraAgentMcpClient({
          endpoint: "http://localhost:3000/mcp",
        }),
    ).not.toThrow();
    expect(
      () =>
        new AuraAgentMcpClient({
          endpoint: "http://127.0.0.1:3000/mcp",
        }),
    ).not.toThrow();
  });

  it("requires an endpoint and either a bearer token or complete client credentials", () => {
    expect(() =>
      createAuraAgentMcpClientFromEnvironment({
        AURA_AGENT_MCP_ACCESS_TOKEN: "token",
      }),
    ).toThrow("AURA_AGENT_MCP_URL is required.");

    const endpointEnvironment = {
      AURA_AGENT_MCP_URL:
        "https://mcp.neo4j.io/agent?project_id=p&agent_id=a",
    };
    expect(() =>
      createAuraAgentMcpClientFromEnvironment(endpointEnvironment),
    ).toThrow(
      "Set AURA_AGENT_MCP_ACCESS_TOKEN or both AURA_AGENT_MCP_CLIENT_ID and AURA_AGENT_MCP_CLIENT_SECRET.",
    );
    expect(() =>
      createAuraAgentMcpClientFromEnvironment({
        ...endpointEnvironment,
        AURA_AGENT_MCP_CLIENT_ID: "client-only",
      }),
    ).toThrow("both AURA_AGENT_MCP_CLIENT_ID and AURA_AGENT_MCP_CLIENT_SECRET");
    expect(() =>
      createAuraAgentMcpClientFromEnvironment({
        ...endpointEnvironment,
        AURA_AGENT_MCP_CLIENT_SECRET: "secret-only",
      }),
    ).toThrow("both AURA_AGENT_MCP_CLIENT_ID and AURA_AGENT_MCP_CLIENT_SECRET");
  });

  it("accepts either supported environment authentication form", () => {
    const endpoint =
      "https://mcp.neo4j.io/agent?project_id=p&agent_id=a";

    expect(
      createAuraAgentMcpClientFromEnvironment({
        AURA_AGENT_MCP_ACCESS_TOKEN: " token ",
        AURA_AGENT_MCP_URL: ` ${endpoint} `,
      }),
    ).toBeInstanceOf(AuraAgentMcpClient);
    expect(
      createAuraAgentMcpClientFromEnvironment({
        AURA_AGENT_MCP_CLIENT_ID: "client",
        AURA_AGENT_MCP_CLIENT_SECRET: "secret",
        AURA_AGENT_MCP_URL: endpoint,
      }),
    ).toBeInstanceOf(AuraAgentMcpClient);
  });
});

describe("MCP tool helpers", () => {
  const tools: McpTool[] = [
    { name: "status" },
    {
      description: "Ask reasoning memory",
      inputSchema: { properties: { query: { type: "string" } } },
      name: "ask-memory",
    },
  ];

  it("selects an explicit or unambiguous memory tool", () => {
    expect(selectQueryTool(tools, "status").name).toBe("status");
    expect(selectQueryTool(tools).name).toBe("ask-memory");
    expect(selectQueryTool([{ name: "only-tool" }]).name).toBe("only-tool");
  });

  it("rejects empty, missing, and ambiguous tool selections", () => {
    expect(() => selectQueryTool([])).toThrow(
      "Aura Agent MCP exposed no tools.",
    );
    expect(() => selectQueryTool(tools, "missing")).toThrow(
      "Available tools: status, ask-memory",
    );
    expect(() =>
      selectQueryTool([
        { description: "Memory lookup", name: "first" },
        { description: "Reasoning lookup", name: "second" },
      ]),
    ).toThrow(
      "Aura Agent MCP exposed multiple tools. Set AURA_AGENT_MCP_TOOL to one of: first, second",
    );
  });

  it("maps a question to a declared query field", () => {
    expect(buildToolArguments(tools[1]!, "question")).toEqual({
      query: "question",
    });
    expect(
      buildToolArguments(
        {
          inputSchema: {
            properties: { custom: { type: "string" } },
            required: ["custom"],
          },
          name: "custom-tool",
        },
        "question",
      ),
    ).toEqual({ custom: "question" });
    expect(buildToolArguments({ name: "schema-free" }, "question")).toEqual({
      input: "question",
    });
  });

  it("uses the standard argument-name priority and rejects ambiguous schemas", () => {
    expect(
      buildToolArguments(
        {
          inputSchema: {
            properties: {
              input: { type: "string" },
              query: { type: "string" },
            },
          },
          name: "multi-standard",
        },
        "question",
      ),
    ).toEqual({ input: "question" });
    expect(() =>
      buildToolArguments(
        {
          inputSchema: {
            properties: {
              first: { type: "string" },
              second: { type: "string" },
            },
            required: ["first", "second"],
          },
          name: "ambiguous",
        },
        "question",
      ),
    ).toThrow("Cannot infer the question argument for MCP tool ambiguous");
  });

  it("extracts text blocks", () => {
    expect(
      extractMcpText({
        content: [
          { text: "one", type: "text" },
          { text: "two", type: "text" },
        ],
      }),
    ).toBe("one\ntwo");
    expect(extractMcpText("plain text")).toBe("plain text");
    expect(extractMcpText({ value: 42 })).toBe('{"value":42}');
    expect(
      extractMcpText({
        content: [null, { data: "ignored", type: "image" }, " three "],
      }),
    ).toBe("three");
  });
});

describe("AuraAgentTokenProvider", () => {
  it("caches a machine token for its expires_in window", async () => {
    const fetchMock = vi.fn(
      async (_input: string | URL | Request, _init?: RequestInit) =>
        new Response(
          JSON.stringify({ access_token: "token-value", expires_in: 3600 }),
          { headers: { "content-type": "application/json" } },
        ),
    );
    const provider = new AuraAgentTokenProvider({
      clientId: "client",
      clientSecret: "secret",
      fetch: fetchMock as typeof fetch,
    });

    expect(await provider.getAccessToken()).toBe("token-value");
    expect(await provider.getAccessToken()).toBe("token-value");
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const [url, request] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe("https://mcp.neo4j.io/oauth/token");
    expect(request?.method).toBe("POST");
    expect(new Headers(request?.headers).get("content-type")).toBe(
      "application/x-www-form-urlencoded",
    );
    expect(Object.fromEntries(new URLSearchParams(String(request?.body)))).toEqual({
      audience: "https://agent-mcp.neo4j.io",
      client_id: "client",
      client_secret: "secret",
      grant_type: "client_credentials",
    });
  });

  it("refreshes inside the expiry safety window and honors a custom endpoint", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-16T12:00:00.000Z"));
    const fetchMock = createFetchMock([
      { json: { access_token: "first", expires_in: 60 } },
      { json: { access_token: "second", expires_in: 60 } },
    ]);
    const provider = new AuraAgentTokenProvider({
      clientId: "client",
      clientSecret: "secret",
      fetch: fetchMock as typeof fetch,
      tokenEndpoint: "https://auth.example.test/token",
    });

    await expect(provider.getAccessToken()).resolves.toBe("first");
    vi.setSystemTime(new Date("2026-08-16T12:00:29.999Z"));
    await expect(provider.getAccessToken()).resolves.toBe("first");
    vi.setSystemTime(new Date("2026-08-16T12:00:30.000Z"));
    await expect(provider.getAccessToken()).resolves.toBe("second");

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      "https://auth.example.test/token",
    );
  });

  it("rejects failed exchanges and successful responses without a token", async () => {
    const rejectedProvider = new AuraAgentTokenProvider({
      clientId: "client",
      clientSecret: "secret",
      fetch: createFetchMock([
        { json: { error: "access_denied" }, status: 401 },
      ]) as typeof fetch,
    });
    await expect(rejectedProvider.getAccessToken()).rejects.toThrow(
      "Aura Agent MCP token exchange failed with HTTP 401.",
    );

    const malformedProvider = new AuraAgentTokenProvider({
      clientId: "client",
      clientSecret: "secret",
      fetch: createFetchMock([
        { json: { expires_in: 3_600 }, status: 200 },
      ]) as typeof fetch,
    });
    await expect(malformedProvider.getAccessToken()).rejects.toThrow(
      "Aura Agent MCP token exchange failed with HTTP 200.",
    );
  });

  it("supplies its cached token to every MCP initialization request", async () => {
    const tokenFetch = createFetchMock([
      { json: { access_token: "machine-token", expires_in: 3_600 } },
    ]);
    const mcpFetch = createFetchMock([
      { json: { id: 1, result: { protocolVersion: "2025-06-18" } } },
      { status: 202 },
    ]);
    const provider = new AuraAgentTokenProvider({
      clientId: "client",
      clientSecret: "secret",
      fetch: tokenFetch as typeof fetch,
    });
    const client = new AuraAgentMcpClient({
      endpoint: "https://mcp.neo4j.io/agent?project_id=p&agent_id=a",
      fetch: mcpFetch as typeof fetch,
      tokenProvider: provider,
    });

    await client.initialize();

    expect(tokenFetch).toHaveBeenCalledOnce();
    expect(mcpFetch).toHaveBeenCalledTimes(2);
    for (const call of mcpFetch.mock.calls) {
      expect(new Headers(call[1]?.headers).get("authorization")).toBe(
        "Bearer machine-token",
      );
    }
  });
});
