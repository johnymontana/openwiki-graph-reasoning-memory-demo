CREATE CONSTRAINT reasoning_trace_id IF NOT EXISTS
FOR (n:ReasoningTrace) REQUIRE n.id IS UNIQUE;

CREATE CONSTRAINT reasoning_step_id IF NOT EXISTS
FOR (n:ReasoningStep) REQUIRE n.id IS UNIQUE;

CREATE CONSTRAINT tool_call_id IF NOT EXISTS
FOR (n:ToolCall) REQUIRE n.id IS UNIQUE;

CREATE CONSTRAINT tool_name IF NOT EXISTS
FOR (n:Tool) REQUIRE n.name IS UNIQUE;

CREATE INDEX trace_session_idx IF NOT EXISTS
FOR (n:ReasoningTrace) ON (n.session_id);

CREATE INDEX trace_success_idx IF NOT EXISTS
FOR (n:ReasoningTrace) ON (n.success);

CREATE INDEX trace_error_kind_idx IF NOT EXISTS
FOR (n:ReasoningTrace) ON (n.error_kind);

CREATE INDEX tool_call_status_idx IF NOT EXISTS
FOR (n:ToolCall) ON (n.status);

CREATE FULLTEXT INDEX reasoning_memory_search IF NOT EXISTS
FOR (n:ReasoningTrace) ON EACH [n.task, n.outcome];

