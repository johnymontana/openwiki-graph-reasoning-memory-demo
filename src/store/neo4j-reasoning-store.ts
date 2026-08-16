import neo4j, { type Driver } from "neo4j-driver";
import type {
  ReasoningStep,
  ReasoningTrace,
  ToolCall,
} from "../domain/types.js";
import {
  REASONING_SCHEMA_STATEMENTS,
  REFRESH_TOOL_STATS,
  UPSERT_STEPS,
  UPSERT_TOOL_CALLS,
  UPSERT_TRACE,
} from "./cypher.js";
import type { ReasoningStore } from "./reasoning-store.js";

export interface Neo4jReasoningStoreOptions {
  database?: string;
  driver: Driver;
}

export interface Neo4jEnvironment {
  database?: string;
  password: string;
  uri: string;
  username: string;
}

/**
 * Bolt-backed storage for only the reasoning region of neo4j-agent-memory.
 * All trace writes are atomic and idempotent by caller-supplied ids.
 */
export class Neo4jReasoningStore implements ReasoningStore {
  readonly #database?: string;
  readonly #driver: Driver;

  constructor(options: Neo4jReasoningStoreOptions) {
    this.#driver = options.driver;
    this.#database = options.database;
  }

  static fromEnvironment(
    environment: NodeJS.ProcessEnv = process.env,
  ): Neo4jReasoningStore {
    const config = readNeo4jEnvironment(environment);
    const driver = neo4j.driver(
      config.uri,
      neo4j.auth.basic(config.username, config.password),
      { disableLosslessIntegers: true },
    );

    return new Neo4jReasoningStore({
      database: config.database,
      driver,
    });
  }

  async close(): Promise<void> {
    await this.#driver.close();
  }

  async ensureSchema(): Promise<void> {
    await this.#driver.verifyConnectivity();
    const session = this.#driver.session({ database: this.#database });

    try {
      for (const statement of REASONING_SCHEMA_STATEMENTS) {
        await session.run(statement);
      }
    } finally {
      await session.close();
    }
  }

  async saveTrace(trace: ReasoningTrace): Promise<void> {
    validateTraceStructure(trace);
    const session = this.#driver.session({ database: this.#database });
    const steps = trace.steps.map(toStepParameters);
    const toolCalls = trace.steps.flatMap((step) =>
      step.toolCalls.map((toolCall) => toToolCallParameters(step, toolCall)),
    );
    const toolNames = [...new Set(toolCalls.map((call) => call.tool_name))];

    try {
      await session.executeWrite(async (transaction) => {
        await transaction.run(UPSERT_TRACE, toTraceParameters(trace));

        if (steps.length > 0) {
          await transaction.run(UPSERT_STEPS, {
            steps,
            trace_id: trace.id,
          });
        }

        if (toolCalls.length > 0) {
          await transaction.run(UPSERT_TOOL_CALLS, {
            tool_calls: toolCalls,
          });
          await transaction.run(REFRESH_TOOL_STATS, {
            tool_names: toolNames,
          });
        }
      });
    } finally {
      await session.close();
    }
  }
}

export function readNeo4jEnvironment(
  environment: NodeJS.ProcessEnv,
): Neo4jEnvironment {
  return {
    database: optionalEnvironmentValue(environment, "NEO4J_DATABASE"),
    password: requiredEnvironmentValue(environment, "NEO4J_PASSWORD"),
    uri: requiredEnvironmentValue(environment, "NEO4J_URI"),
    username: requiredEnvironmentValue(environment, "NEO4J_USERNAME"),
  };
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

function toTraceParameters(trace: ReasoningTrace): Record<string, unknown> {
  return {
    completed_at: trace.completedAt ?? null,
    id: trace.id,
    metadata: serializeJson(trace.metadata ?? {}),
    outcome: trace.outcome ?? null,
    session_id: trace.sessionId,
    started_at: trace.startedAt,
    success: trace.success ?? null,
    task: trace.task,
  };
}

function toStepParameters(step: ReasoningStep): Record<string, unknown> {
  return {
    action: step.action ?? null,
    created_at: step.createdAt,
    id: step.id,
    metadata: serializeJson(step.metadata ?? {}),
    observation: step.observation ?? null,
    step_number: step.stepNumber,
    thought: step.thought ?? null,
  };
}

function toToolCallParameters(
  step: ReasoningStep,
  toolCall: ToolCall,
): {
  arguments: string | null;
  created_at: string;
  duration_ms: number | null;
  error: string | null;
  id: string;
  result: string | null;
  status: string;
  step_id: string;
  tool_name: string;
} {
  return {
    arguments: serializeJson(toolCall.arguments),
    created_at: toolCall.createdAt,
    duration_ms: toolCall.durationMs ?? null,
    error: toolCall.error ?? null,
    id: toolCall.id,
    result:
      toolCall.result === undefined ? null : serializeJson(toolCall.result),
    status: toolCall.status,
    step_id: step.id,
    tool_name: toolCall.toolName,
  };
}

function validateTraceStructure(trace: ReasoningTrace): void {
  const stepIds = new Set<string>();
  const stepNumbers = new Set<number>();
  const toolCallIds = new Set<string>();

  for (const step of trace.steps) {
    if (step.traceId !== trace.id) {
      throw new Error(
        `Reasoning step ${step.id} belongs to trace ${step.traceId}, not ${trace.id}.`,
      );
    }
    if (stepIds.has(step.id)) {
      throw new Error(`Duplicate reasoning step id: ${step.id}.`);
    }
    stepIds.add(step.id);

    if (!Number.isInteger(step.stepNumber) || step.stepNumber < 1) {
      throw new Error(
        `Reasoning step ${step.id} has invalid step number ${step.stepNumber}.`,
      );
    }
    if (stepNumbers.has(step.stepNumber)) {
      throw new Error(`Duplicate reasoning step number: ${step.stepNumber}.`);
    }
    stepNumbers.add(step.stepNumber);

    for (const toolCall of step.toolCalls) {
      if (toolCall.stepId !== undefined && toolCall.stepId !== step.id) {
        throw new Error(
          `Tool call ${toolCall.id} belongs to step ${toolCall.stepId}, not ${step.id}.`,
        );
      }
      if (toolCallIds.has(toolCall.id)) {
        throw new Error(`Duplicate tool call id: ${toolCall.id}.`);
      }
      toolCallIds.add(toolCall.id);
    }
  }
}

function serializeJson(value: unknown): string | null {
  if (value === undefined) {
    return null;
  }

  try {
    return JSON.stringify(value);
  } catch {
    return JSON.stringify({ value: String(value) });
  }
}
