CREATE TABLE IF NOT EXISTS shared_plans (
  id TEXT PRIMARY KEY,
  payload TEXT NOT NULL,
  access_hash TEXT,
  admin_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER,
  revoked_at INTEGER
);

CREATE INDEX IF NOT EXISTS shared_plans_expiry_idx
  ON shared_plans (expires_at);
