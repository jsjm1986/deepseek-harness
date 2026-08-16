DROP INDEX harness.conversation_events_tool_call;

-- Session event payloads may contain valid JSON strings with escaped NUL.
-- PostgreSQL json preserves those strings; jsonb rejects them while decoding.
ALTER TABLE harness.conversation_events
  ALTER COLUMN event TYPE json
  USING event::json;
