/**
 * This is the reasoning-memory subset of neo4j-agent-memory's graph model.
 * There are intentionally no Conversation, Message, Entity, Fact, or
 * Preference statements in this project.
 */
export const REASONING_SCHEMA_STATEMENTS = [
  "CREATE CONSTRAINT reasoning_trace_id IF NOT EXISTS FOR (n:ReasoningTrace) REQUIRE n.id IS UNIQUE",
  "CREATE CONSTRAINT reasoning_step_id IF NOT EXISTS FOR (n:ReasoningStep) REQUIRE n.id IS UNIQUE",
  "CREATE CONSTRAINT tool_call_id IF NOT EXISTS FOR (n:ToolCall) REQUIRE n.id IS UNIQUE",
  "CREATE CONSTRAINT tool_name IF NOT EXISTS FOR (n:Tool) REQUIRE n.name IS UNIQUE",
  "CREATE INDEX trace_session_idx IF NOT EXISTS FOR (n:ReasoningTrace) ON (n.session_id)",
  "CREATE INDEX trace_repository_idx IF NOT EXISTS FOR (n:ReasoningTrace) ON (n.repository)",
  "CREATE INDEX trace_success_idx IF NOT EXISTS FOR (n:ReasoningTrace) ON (n.success)",
  "CREATE INDEX trace_error_kind_idx IF NOT EXISTS FOR (n:ReasoningTrace) ON (n.error_kind)",
  "CREATE INDEX tool_call_status_idx IF NOT EXISTS FOR (n:ToolCall) ON (n.status)",
  "CREATE FULLTEXT INDEX reasoning_memory_search IF NOT EXISTS FOR (n:ReasoningTrace) ON EACH [n.task, n.outcome]",
] as const;

export const UPSERT_TRACE = `
MERGE (rt:ReasoningTrace {id: $id})
ON CREATE SET rt.started_at = datetime($started_at),
              rt.task_embedding = null
SET rt.session_id = $session_id,
    rt.repository = $repository,
    rt.task = $task,
    rt.outcome = $outcome,
    rt.success = $success,
    rt.completed_at = CASE
      WHEN $completed_at IS NULL THEN null
      ELSE datetime($completed_at)
    END,
    rt.metadata = $metadata
RETURN rt.id AS id
`;

export const UPSERT_STEPS = `
UNWIND $steps AS step
MATCH (rt:ReasoningTrace {id: $trace_id})
MERGE (rs:ReasoningStep {id: step.id})
ON CREATE SET rs.timestamp = datetime(step.created_at),
              rs.embedding = null
SET rs.step_number = step.step_number,
    rs.thought = step.thought,
    rs.action = step.action,
    rs.observation = step.observation,
    rs.metadata = step.metadata
MERGE (rt)-[hasStep:HAS_STEP]->(rs)
SET hasStep.order = step.step_number
`;

export const UPSERT_TOOL_CALLS = `
UNWIND $tool_calls AS toolCall
MATCH (rs:ReasoningStep {id: toolCall.step_id})
MERGE (tool:Tool {name: toolCall.tool_name})
ON CREATE SET tool.created_at = datetime(),
              tool.total_calls = 0,
              tool.successful_calls = 0,
              tool.failed_calls = 0,
              tool.total_duration_ms = 0
MERGE (tc:ToolCall {id: toolCall.id})
ON CREATE SET tc.timestamp = datetime(toolCall.created_at)
SET tc.tool_name = toolCall.tool_name,
    tc.arguments = toolCall.arguments,
    tc.result = toolCall.result,
    tc.status = toolCall.status,
    tc.duration_ms = toolCall.duration_ms,
    tc.error = toolCall.error
MERGE (rs)-[:USES_TOOL]->(tc)
MERGE (tc)-[:INSTANCE_OF]->(tool)
`;

/**
 * Per-trace roll-up used by the evaluation report. Metadata is returned as
 * its stored JSON string: callers parse client-side because JSON-string
 * properties cannot be filtered or aggregated in Cypher.
 */
export const FETCH_TRACE_SUMMARIES = `
MATCH (trace:ReasoningTrace)
WHERE trace.session_id STARTS WITH $session_id_prefix
OPTIONAL MATCH (trace)-[:HAS_STEP]->(step:ReasoningStep)
OPTIONAL MATCH (step)-[:USES_TOOL]->(call:ToolCall)
WITH trace,
     count(DISTINCT step) AS steps,
     count(DISTINCT call) AS tool_calls,
     count(DISTINCT CASE WHEN call.status IN ['error', 'timeout'] THEN call END) AS failed_tool_calls,
     count(DISTINCT CASE WHEN call.status = 'cancelled' THEN call END) AS cancelled_tool_calls
RETURN trace.id AS id,
       trace.session_id AS session_id,
       trace.task AS task,
       trace.repository AS repository,
       trace.success AS success,
       toString(trace.started_at) AS started_at,
       CASE
         WHEN trace.completed_at IS NULL THEN null
         ELSE toString(trace.completed_at)
       END AS completed_at,
       trace.metadata AS metadata,
       steps,
       tool_calls,
       failed_tool_calls,
       cancelled_tool_calls
ORDER BY started_at ASC
`;

export const REFRESH_TOOL_STATS = `
UNWIND $tool_names AS toolName
MATCH (tool:Tool {name: toolName})
OPTIONAL MATCH (tool)<-[:INSTANCE_OF]-(tc:ToolCall)
WITH tool,
     count(tc) AS total,
     sum(CASE WHEN tc.status = 'success' THEN 1 ELSE 0 END) AS succeeded,
     sum(CASE WHEN tc.status IN ['error', 'timeout'] THEN 1 ELSE 0 END) AS failed,
     sum(coalesce(tc.duration_ms, 0)) AS duration,
     max(tc.timestamp) AS lastUsed
SET tool.total_calls = total,
    tool.successful_calls = succeeded,
    tool.failed_calls = failed,
    tool.total_duration_ms = duration,
    tool.last_used_at = lastUsed
`;

