CREATE TABLE IF NOT EXISTS contact_submissions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  message TEXT,
  terms TEXT,
  payload TEXT NOT NULL,
  ip_hash TEXT,
  ua_hash TEXT
);

CREATE INDEX IF NOT EXISTS idx_contact_submissions_created ON contact_submissions(created_at);
