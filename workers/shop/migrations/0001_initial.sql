CREATE TABLE IF NOT EXISTS shops (
  id TEXT PRIMARY KEY,
  origin TEXT NOT NULL,
  site_config_url TEXT,
  catalog_url TEXT,
  active INTEGER DEFAULT 1,
  authorized_at TEXT DEFAULT (datetime('now')),
  stripe_secret_key TEXT,
  stripe_webhook_secret TEXT,
  allowed_features TEXT,
  config_cache TEXT,
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  shop_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  ordernumber TEXT NOT NULL,
  firstname TEXT NOT NULL,
  lastname TEXT NOT NULL,
  email TEXT NOT NULL,
  address TEXT NOT NULL,
  zipcode TEXT NOT NULL,
  city TEXT NOT NULL,
  shipping TEXT NOT NULL,
  country TEXT NOT NULL,
  gift_wrapping TEXT NOT NULL,
  custom_engraving TEXT NOT NULL,
  message TEXT,
  order_details TEXT NOT NULL,
  checkout TEXT NOT NULL,
  next_url TEXT,
  status TEXT DEFAULT 'pending',
  payment_method TEXT,
  amount_usd REAL,
  amount_eur REAL,
  stripe_session_id TEXT,
  legal_checks_passed INTEGER DEFAULT 0,
  legal_checks_details TEXT,
  claim_info TEXT,
  ip_hash TEXT,
  ua_hash TEXT
);

CREATE TABLE IF NOT EXISTS claims (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  shop_id TEXT NOT NULL,
  order_id INTEGER,
  ordernumber TEXT,
  email TEXT,
  claim_data TEXT,
  status TEXT DEFAULT 'pending',
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS webhook_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  shop_id TEXT,
  event_id TEXT UNIQUE,
  event_type TEXT,
  payload TEXT,
  processed INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_orders_shop_ordernumber ON orders(shop_id, ordernumber);
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
CREATE INDEX IF NOT EXISTS idx_shops_origin ON shops(origin);
