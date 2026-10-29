-- =====================================================================
-- AeyChhotu! — 012_sales_rollup_and_session_reset.sql
--
-- Fix for docs/14 #21, with the decision recorded there: a table belongs to
-- ONE party at a time. When a seating ends (staff clear, auto-release, admin
-- clear / deactivate / regenerate / archive) the seating's tickets are
-- removed with it, so the next party never inherits a previous party's
-- orders, total or tracker.
--
-- Orders are BILLING HISTORY though, and the admin console's analytics is a
-- real feature. Deleting the rows would have reset every takings figure, so
-- the sale is recorded in a rollup the moment a ticket becomes `served` —
-- before any clear can touch it. The rollup is small (one row per dish per
-- day), survives the ticket, and is what analytics now reads.
--
-- Exactly-once is guaranteed by sales_recorded_orders: a ticket can only be
-- rolled up once, even if it is served twice by a retried request, and the
-- backfill below re-running on `db:setup` cannot double-count either.
--
-- Safe to re-run (idempotent).
-- =====================================================================

-- ----------------------- 0. Browser roles -----------------------------
-- Same stubs as 001: a bare Postgres needs them for the REVOKE-style
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

-- ----------------------- 1. Tables ------------------------------------

-- One row per ticket that has ever been counted. No FK on purpose: orders
-- are deleted on clear, and the marker must outlive them.
CREATE TABLE IF NOT EXISTS sales_recorded_orders (
  order_id    uuid PRIMARY KEY,
  recorded_at timestamptz NOT NULL DEFAULT now()
);

-- Per-dish, per-day takings. Reads the price frozen on the ticket
-- (order_items.unit_price) — never today's menu price.
CREATE TABLE IF NOT EXISTS sales_rollup (
  day          date NOT NULL,
  menu_item_id uuid NOT NULL REFERENCES menu_items(id) ON DELETE RESTRICT,
  quantity     integer NOT NULL DEFAULT 0 CHECK (quantity >= 0),
  revenue      numeric(12,2) NOT NULL DEFAULT 0 CHECK (revenue >= 0),
  PRIMARY KEY (day, menu_item_id)
);

-- Per-day totals, so "orders served" and revenue survive without any order
-- row existing.
CREATE TABLE IF NOT EXISTS sales_day (
  day           date PRIMARY KEY,
  orders_served integer NOT NULL DEFAULT 0 CHECK (orders_served >= 0),
  revenue       numeric(12,2) NOT NULL DEFAULT 0 CHECK (revenue >= 0)
);

-- ----------------------- 2. Rollup trigger -----------------------------
-- Fires on the TRANSITION into `served` — the only way a real ticket gets
-- there (fire_order() inserts it as pending, then prune or an admin close
-- moves it forward). Deliberately not an INSERT trigger: a row inserted with
-- status='served' would be rolled up before its lines existed. Rows already
-- served before this file are handled by the backfill below.
--
-- The marker table makes it exactly-once; a served → served update is a
-- no-op. Placing it in the database is deliberate: prune, admin deactivate,
-- archive and any future close path all go through it without each service
-- having to remember.
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

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS orders_record_sale_trg ON orders;
CREATE TRIGGER orders_record_sale_trg
  AFTER UPDATE OF status ON orders
  FOR EACH ROW
  WHEN (NEW.status = 'served' AND OLD.status <> 'served')
  EXECUTE FUNCTION record_served_order_sale();

-- ----------------------- 3. Backfill -----------------------------------
-- Every ticket that is already served when this migration first runs is
-- counted once. Both writes are driven by the same "newly inserted marker"
-- set, so a re-run adds nothing.
WITH fresh AS (
  INSERT INTO sales_recorded_orders (order_id)
  SELECT o.id
    FROM orders o
   WHERE o.status = 'served'
  ON CONFLICT (order_id) DO NOTHING
  RETURNING order_id
),
rolled AS (
  INSERT INTO sales_rollup (day, menu_item_id, quantity, revenue)
  SELECT o.created_at::date,
         oi.menu_item_id,
         sum(oi.quantity)::int,
         sum(oi.quantity * oi.unit_price)::numeric(12,2)
    FROM orders o
    JOIN fresh f       ON f.order_id = o.id
    JOIN order_items oi ON oi.order_id = o.id
   GROUP BY o.created_at::date, oi.menu_item_id
  ON CONFLICT (day, menu_item_id) DO UPDATE
    SET quantity = sales_rollup.quantity + EXCLUDED.quantity,
        revenue  = sales_rollup.revenue  + EXCLUDED.revenue
  RETURNING 1
)
INSERT INTO sales_day (day, orders_served, revenue)
SELECT o.created_at::date, count(*)::int, sum(o.total)::numeric(12,2)
  FROM orders o
  JOIN fresh f ON f.order_id = o.id
 GROUP BY o.created_at::date
ON CONFLICT (day) DO UPDATE
  SET orders_served = sales_day.orders_served + EXCLUDED.orders_served,
      revenue       = sales_day.revenue       + EXCLUDED.revenue;

-- ----------------------- 4. Access ------------------------------------
-- Backend-only tables: no RLS policies, so the browser roles (`anon`,
-- `authenticated`) can read nothing even if a Supabase key leaked. The API
-- connects as the owning role, which is not subject to RLS.
ALTER TABLE sales_recorded_orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE sales_rollup          ENABLE ROW LEVEL SECURITY;
ALTER TABLE sales_day             ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON sales_recorded_orders FROM anon, authenticated;
REVOKE ALL ON sales_rollup          FROM anon, authenticated;
REVOKE ALL ON sales_day             FROM anon, authenticated;

-- ----------------------- 5. Postcondition ------------------------------
DO $$
BEGIN
  IF to_regclass('public.sales_rollup') IS NULL
     OR to_regclass('public.sales_day') IS NULL
     OR to_regclass('public.sales_recorded_orders') IS NULL THEN
    RAISE EXCEPTION '012: sales rollup tables are missing';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
     WHERE tgname = 'orders_record_sale_trg'
       AND NOT tgisinternal
  ) THEN
    RAISE EXCEPTION '012: orders_record_sale_trg is missing';
  END IF;
END
$$;
