CREATE TABLE payment_intents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  shop_id TEXT NOT NULL,
  order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  ordernumber TEXT NOT NULL,
  payment_method TEXT NOT NULL,
  method_label TEXT,
  source TEXT NOT NULL DEFAULT 'link',
  currency TEXT,
  ip_hash TEXT,
  ua_hash TEXT
);

CREATE INDEX idx_payment_intents_order ON payment_intents(order_id, created_at);
CREATE INDEX idx_payment_intents_shop ON payment_intents(shop_id, created_at);
