ALTER TABLE orders ADD COLUMN schema_version INTEGER DEFAULT 1;
ALTER TABLE orders ADD COLUMN order_items TEXT;
ALTER TABLE orders ADD COLUMN currency TEXT;
ALTER TABLE orders ADD COLUMN subtotal REAL;
ALTER TABLE orders ADD COLUMN shipping_cost REAL;
ALTER TABLE orders ADD COLUMN addons_total REAL;
ALTER TABLE orders ADD COLUMN total REAL;
ALTER TABLE orders ADD COLUMN validation_details TEXT;
ALTER TABLE orders ADD COLUMN validated_at TEXT;

CREATE INDEX IF NOT EXISTS idx_orders_shop_ordernumber_status
  ON orders(shop_id, ordernumber, status);
