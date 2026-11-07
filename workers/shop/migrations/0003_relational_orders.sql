PRAGMA defer_foreign_keys = on;

DROP TABLE IF EXISTS order_validation_checks;
DROP TABLE IF EXISTS order_addons;
DROP TABLE IF EXISTS order_items;
DROP TABLE IF EXISTS order_status_history;
DROP TABLE IF EXISTS order_submissions;
DROP TABLE IF EXISTS claims;
DROP TABLE IF EXISTS orders;

ALTER TABLE webhook_events RENAME TO webhook_events_legacy;

CREATE TABLE webhook_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  provider TEXT NOT NULL,
  event_id TEXT NOT NULL,
  event_type TEXT,
  payload TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  received_at TEXT NOT NULL DEFAULT (datetime('now')),
  processed_at TEXT,
  UNIQUE(provider, event_id)
);

INSERT INTO webhook_events (
  provider, event_id, event_type, payload, attempts, received_at, processed_at
)
SELECT
  'stripe',
  event_id,
  event_type,
  payload,
  0,
  created_at,
  CASE WHEN processed = 1 THEN created_at ELSE NULL END
FROM webhook_events_legacy;

DROP TABLE webhook_events_legacy;

CREATE TABLE orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  public_id TEXT NOT NULL UNIQUE,
  shop_id TEXT NOT NULL,
  ordernumber TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  firstname TEXT NOT NULL,
  lastname TEXT NOT NULL,
  email TEXT NOT NULL,
  address TEXT NOT NULL,
  zipcode TEXT NOT NULL,
  city TEXT NOT NULL,
  country TEXT NOT NULL,
  message TEXT,
  shipping_title TEXT NOT NULL DEFAULT '',
  shipping_label TEXT NOT NULL DEFAULT '',
  currency TEXT NOT NULL,
  subtotal REAL NOT NULL DEFAULT 0,
  shipping_cost REAL NOT NULL DEFAULT 0,
  addons_total REAL NOT NULL DEFAULT 0,
  total REAL NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'submitted' CHECK (
    status IN ('submitted', 'validated', 'invalid', 'payment_pending', 'claimed', 'paid')
  ),
  payment_method TEXT,
  stripe_session_id TEXT,
  paid_amount REAL CHECK (paid_amount IS NULL OR paid_amount >= 0),
  paid_currency TEXT,
  paid_exchange_rate REAL CHECK (paid_exchange_rate IS NULL OR paid_exchange_rate > 0),
  paid_exchange_rate_source TEXT,
  paid_exchange_rate_at TEXT,
  fulfillment_status TEXT NOT NULL DEFAULT 'unfulfilled' CHECK (
    fulfillment_status IN ('unfulfilled', 'fulfillment_pending', 'fulfilled', 'cancelled')
  ),
  next_url TEXT,
  ip_hash TEXT,
  ua_hash TEXT
);

CREATE TABLE order_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  position INTEGER NOT NULL DEFAULT 0,
  sku TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  variant TEXT NOT NULL DEFAULT '',
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  unit_price REAL NOT NULL CHECK (unit_price >= 0),
  line_total REAL NOT NULL CHECK (line_total >= 0),
  currency TEXT NOT NULL
);

CREATE TABLE order_addons (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  position INTEGER NOT NULL DEFAULT 0,
  group_name TEXT NOT NULL,
  value TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  price REAL NOT NULL DEFAULT 0 CHECK (price >= 0),
  currency TEXT NOT NULL
);

CREATE TABLE order_validation_checks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  position INTEGER NOT NULL DEFAULT 0,
  check_name TEXT NOT NULL,
  passed INTEGER NOT NULL CHECK (passed IN (0, 1)),
  message TEXT NOT NULL DEFAULT ''
);

CREATE TABLE order_submissions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  provider_submission_id TEXT NOT NULL,
  payload TEXT,
  received_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(provider, provider_submission_id)
);

CREATE TABLE order_status_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  status_type TEXT NOT NULL CHECK (status_type IN ('order', 'fulfillment')),
  from_status TEXT,
  to_status TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'system',
  message TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE claims (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  shop_id TEXT NOT NULL,
  order_id INTEGER REFERENCES orders(id) ON DELETE SET NULL,
  ordernumber TEXT,
  email TEXT,
  message TEXT,
  payment_method TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_orders_shop_ordernumber ON orders(shop_id, ordernumber);
CREATE INDEX idx_orders_shop_ordernumber_status ON orders(shop_id, ordernumber, status);
CREATE INDEX idx_orders_status ON orders(status);
CREATE INDEX idx_orders_fulfillment_status ON orders(fulfillment_status);
CREATE INDEX idx_orders_created_at ON orders(created_at);
CREATE INDEX idx_order_items_order ON order_items(order_id, position);
CREATE INDEX idx_order_addons_order ON order_addons(order_id, position);
CREATE INDEX idx_order_validation_checks_order ON order_validation_checks(order_id, position);
CREATE INDEX idx_order_submissions_order ON order_submissions(order_id);
CREATE INDEX idx_order_status_history_order ON order_status_history(order_id, status_type, created_at, id);
CREATE INDEX idx_claims_shop_ordernumber ON claims(shop_id, ordernumber);
CREATE UNIQUE INDEX idx_claims_order_unique ON claims(order_id) WHERE order_id IS NOT NULL;

CREATE TRIGGER orders_status_transition_guard
BEFORE UPDATE OF status ON orders
FOR EACH ROW
WHEN NEW.status <> OLD.status
  AND NOT (
    (OLD.status = 'submitted' AND NEW.status IN ('validated', 'invalid'))
    OR (OLD.status = 'validated' AND NEW.status IN ('payment_pending', 'claimed', 'paid'))
    OR (OLD.status = 'payment_pending' AND NEW.status IN ('paid', 'claimed'))
    OR (OLD.status = 'claimed' AND NEW.status = 'paid')
  )
BEGIN
  SELECT RAISE(ABORT, 'invalid order status transition');
END;

CREATE TRIGGER orders_fulfillment_status_transition_guard
BEFORE UPDATE OF fulfillment_status ON orders
FOR EACH ROW
WHEN NEW.fulfillment_status <> OLD.fulfillment_status
  AND NOT (
    (OLD.fulfillment_status = 'unfulfilled' AND NEW.fulfillment_status IN ('fulfillment_pending', 'cancelled'))
    OR (OLD.fulfillment_status = 'fulfillment_pending' AND NEW.fulfillment_status IN ('fulfilled', 'cancelled'))
  )
BEGIN
  SELECT RAISE(ABORT, 'invalid fulfillment status transition');
END;
