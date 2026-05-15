-- Add `error` to the set of `blocks.kind` values. The column is plain TEXT
-- with no CHECK constraint, so the schema doesn't change — but registering
-- this migration in the journal pins the new value to a release boundary
-- and keeps Drizzle's snapshot chain intact. The daemon writes
-- `kind='error'` rows once API failures (529, 429, 401, etc.) are
-- persisted as visible chat bubbles. content_json carries:
--   { code, headline, httpStatus?, retryAfterSeconds?, requestId?, rawMessage }
SELECT 1;
