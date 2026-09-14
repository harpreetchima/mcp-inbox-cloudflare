-- Rebuild the table to replace the original column-level UNIQUE constraint.
-- Copy every field unchanged, including delivery-address casing and claim state.
CREATE TABLE messages_multi_address (
  id TEXT PRIMARY KEY,
  raw_key TEXT NOT NULL UNIQUE,
  raw_sha256 TEXT,
  envelope_from TEXT NOT NULL,
  envelope_to TEXT NOT NULL,
  from_name TEXT,
  from_address TEXT,
  reply_to TEXT,
  subject TEXT NOT NULL DEFAULT '',
  message_id TEXT,
  in_reply_to TEXT,
  references_json TEXT NOT NULL DEFAULT '[]',
  thread_id TEXT NOT NULL,
  sent_at TEXT,
  received_at TEXT NOT NULL,
  body_text TEXT NOT NULL DEFAULT '',
  links_json TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'new'
    CHECK (status IN ('new', 'claimed', 'completed', 'error')),
  claimed_by TEXT CHECK (claimed_by IN ('codex', 'hermes')),
  claimed_at TEXT,
  claim_expires_at TEXT,
  completed_at TEXT,
  parse_error TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO messages_multi_address (
  id, raw_key, raw_sha256, envelope_from, envelope_to, from_name,
  from_address, reply_to, subject, message_id, in_reply_to,
  references_json, thread_id, sent_at, received_at, body_text,
  links_json, status, claimed_by, claimed_at, claim_expires_at,
  completed_at, parse_error, created_at
)
SELECT
  id, raw_key, raw_sha256, envelope_from, envelope_to, from_name,
  from_address, reply_to, subject, message_id, in_reply_to,
  references_json, thread_id, sent_at, received_at, body_text,
  links_json, status, claimed_by, claimed_at, claim_expires_at,
  completed_at, parse_error, created_at
FROM messages;

DROP TABLE messages;
ALTER TABLE messages_multi_address RENAME TO messages;

CREATE UNIQUE INDEX messages_address_raw_sha_idx
  ON messages (envelope_to COLLATE NOCASE, raw_sha256);

CREATE INDEX messages_status_received_idx
  ON messages (status, received_at);

CREATE INDEX messages_thread_idx
  ON messages (thread_id, received_at);

CREATE INDEX messages_address_received_idx
  ON messages (envelope_to COLLATE NOCASE, received_at, id);

CREATE INDEX messages_address_status_received_idx
  ON messages (envelope_to COLLATE NOCASE, status, received_at, id);
