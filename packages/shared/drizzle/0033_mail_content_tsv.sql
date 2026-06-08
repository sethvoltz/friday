ALTER TABLE mail
  ADD COLUMN IF NOT EXISTS content_tsv tsvector
  GENERATED ALWAYS AS (
    to_tsvector('english', coalesce(subject, '') || ' ' || coalesce(body, ''))
  ) STORED;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS mail_content_tsv_idx ON mail USING GIN (content_tsv);
