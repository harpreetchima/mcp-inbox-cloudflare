CREATE TABLE messages (
  id TEXT PRIMARY KEY,
  raw_key TEXT NOT NULL UNIQUE,
  raw_sha256 TEXT UNIQUE,
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

CREATE INDEX messages_status_received_idx
  ON messages (status, received_at);

CREATE INDEX messages_thread_idx
  ON messages (thread_id, received_at);
