MATCH (trace:ReasoningTrace)
OPTIONAL MATCH (trace)-[:HAS_STEP]->(step:ReasoningStep)
OPTIONAL MATCH (step)-[:USES_TOOL]->(call:ToolCall)
RETURN count(DISTINCT trace) AS traces,
       count(DISTINCT step) AS steps,
       count(DISTINCT call) AS tool_calls,
       count(DISTINCT CASE WHEN trace.success THEN trace END) AS successful_traces;

