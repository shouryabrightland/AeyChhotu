-- =====================================================================
-- AeyChhotu! — 013_hourly_sales_rollup.sql
--
-- The console's top cards now carry a 24-hour trend, and `sales_day` only
-- knows daily totals. This adds the missing hourly bucket and writes it from
-- the SAME place the daily rollup is written: the transition into `served`.
--
-- Exactly-once comes from `sales_recorded_orders` (sql/012), which the
-- replaced function still consults, so re-runs and a served → served update
-- cannot double-count either table.
--
-- Attribution uses `orders.created_at`, matching `sales_day`: a ticket fired
-- at 23:50 and served at 00:05 belongs to the day/hour it was ordered, not
-- to whichever hour the kitchen happened to close it.
--
-- Safe to re-run (idempotent).
-- =====================================================================

-- ----------------------- 0. Browser roles -----------------------------
-- Same stubs as 001/012: a bare Postgres needs them for the REVOKE-style
-- posture below; Supabase already has them.
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'anon') THEN
    CREATE ROLE anon NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'authenticated') THEN
    CREATE ROLE authenticated NOLOGIN;
  END IF;
END
$$;

-- ----------------------- 1. The hourly bucket --------------------------
-- One row per clock hour that actually had a served ticket. The API fills
-- the empty hours with zero when it builds the 24-point series, so gaps do
-- not need rows here.
CREATE TABLE IF NOT EXISTS sales_hour (
  hour          timestamptz PRIMARY KEY,
  orders_served integer NOT NULL DEFAULT 0 CHECK (orders_served >= 0),
  revenue       numeric(12,2) NOT NULL DEFAULT 0 CHECK (revenue >= 0)
);

-- ----------------------- 2. Rollup trigger -----------------------------
-- Same body as sql/012 with one extra upsert. The marker insert is what
-- decides "first time": a second served → served update returns early and
-- neither the daily nor the hourly figures move.
CREATE OR REPLACE FUNCTION record_served_order_sale() RETURNS trigger AS $$
BEGIN
  IF NEW.status <> 'served' THEN
    RETURN NEW;
  END IF;

  INSERT INTO sales_recorded_orders (order_id)
       VALUES (NEW.id)
  ON CONFLICT (order_id) DO NOTHING;

  -- Already counted: never add the same ticket twice.
  IF NOT FOUND THEN
    RETURN NEW;
  END IF;

  INSERT INTO sales_rollup (day, menu_item_id, quantity, revenue)
  SELECT NEW.created_at::date,
         oi.menu_item_id,
         sum(oi.quantity)::int,
         sum(oi.quantity * oi.unit_price)::numeric(12,2)
    FROM order_items oi
   WHERE oi.order_id = NEW.id
   GROUP BY oi.menu_item_id
  ON CONFLICT (day, menu_item_id) DO UPDATE
    SET quantity = sales_rollup.quantity + EXCLUDED.quantity,
        revenue  = sales_rollup.revenue  + EXCLUDED.revenue;

  INSERT INTO sales_day (day, orders_served, revenue)
       VALUES (NEW.created_at::date, 1, NEW.total)
  ON CONFLICT (day) DO UPDATE
    SET orders_served = sales_day.orders_served + 1,
        revenue       = sales_day.revenue       + EXCLUDED.revenue;

  INSERT INTO sales_hour (hour, orders_served, revenue)
       VALUES (date_trunc('hour', NEW.created_at), 1, NEW.total)
  ON CONFLICT (hour) DO UPDATE
    SET orders_served = sales_hour.orders_served + 1,
        revenue       = sales_hour.revenue       + EXCLUDED.revenue;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- The trigger itself was created by 012 and calls this function by name, so
-- replacing the body above is enough; this block only repairs a database
-- where 012's trigger is somehow missing.
DROP TRIGGER IF EXISTS orders_record_sale_trg ON orders;
CREATE TRIGGER orders_record_sale_trg
  AFTER UPDATE OF status ON orders
  FOR EACH ROW
  WHEN (NEW.status = 'served' AND OLD.status <> 'served')
  EXECUTE FUNCTION record_served_order_sale();

-- ----------------------- 3. Access ------------------------------------
-- Backend-only table, exactly like the daily rollup: no policy for the
-- browser roles, so a leaked Supabase key still reads nothing.
ALTER TABLE sales_hour ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON sales_hour FROM anon, authenticated;

-- ----------------------- 4. Postcondition -----------------------------
DO $$
BEGIN
  IF to_regclass('public.sales_hour') IS NULL THEN
    RAISE EXCEPTION '013: sales_hour is missing';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
     WHERE tgname = 'orders_record_sale_trg'
       AND NOT tgisinternal
  ) THEN
    RAISE EXCEPTION '013: orders_record_sale_trg is missing';
  END IF;
END
$$;
