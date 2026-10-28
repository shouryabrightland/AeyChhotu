-- =====================================================================
-- AeyChhotu! — 006_admin_and_soft_deletes.sql
-- The admin console deletes tables and dishes by ARCHIVING them, never by
-- removing the row: an order fired last month still points at its table and
-- its dishes (order_items.menu_item_id is ON DELETE RESTRICT, and history is
-- supposed to be immutable — see 004_hardening.sql). A hard DELETE would
-- either fail on that restrict or rewrite the past.
--
--   1. `deleted_at` on restaurant_tables and menu_items. NULL = live.
--   2. PARTIAL indexes on the live catalog only: every diner/staff query
--      filters `deleted_at IS NULL`, so the index carries exactly the rows
--      those queries can see.
--   3. COLUMN GRANTS. 005 revoked table-wide SELECT on restaurant_tables and
--      re-granted an explicit column list, which cannot include a column that
--      did not exist yet. `deleted_at` therefore needs its own grant, or the
--      browser roles would be denied a column the published RLS contract
--      says they can read.
--
-- Apply:  psql "$DATABASE_URL" -f sql/006_admin_and_soft_deletes.sql
--         (or just: npm run db:setup)
-- Safe to re-run (idempotent).
-- =====================================================================

-- -----------------------1. Archive columns ----------------------------
ALTER TABLE restaurant_tables ADD COLUMN IF NOT EXISTS deleted_at timestamptz DEFAULT NULL;
ALTER TABLE menu_items        ADD COLUMN IF NOT EXISTS deleted_at timestamptz DEFAULT NULL;

-- -----------------------2. Live-row indexes ---------------------------
-- A partial index is the point, not an optimisation detail: it only ever
-- holds rows a diner query can return, so an archived table cannot slow the
-- QR sweep down and `code` stays unique among the LIVE tables below.
CREATE INDEX IF NOT EXISTS restaurant_tables_active_idx
  ON restaurant_tables (code) WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS menu_items_active_idx
  ON menu_items (category) WHERE deleted_at IS NULL;

-- -----------------------3. Browser column grants ----------------------
-- 005 grants an explicit column list built from the live catalog. Adding a
-- column later is therefore denied to `anon`/`authenticated` until someone
-- grants it deliberately (that fail-closed behaviour is the point). Here we
-- deliberately grant the archive flag: it is not a credential, and the diner
-- read path filters on it.
GRANT SELECT (deleted_at) ON restaurant_tables TO anon, authenticated;
GRANT SELECT (deleted_at) ON menu_items        TO anon, authenticated;

-- -----------------------4. Prove the shape ----------------------------
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name   = 'restaurant_tables'
       AND column_name  = 'deleted_at'
  ) THEN
    RAISE EXCEPTION 'restaurant_tables.deleted_at is missing';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name   = 'menu_items'
       AND column_name  = 'deleted_at'
  ) THEN
    RAISE EXCEPTION 'menu_items.deleted_at is missing';
  END IF;

  IF NOT has_column_privilege('anon', 'public.restaurant_tables', 'deleted_at', 'SELECT') THEN
    RAISE EXCEPTION 'anon cannot read restaurant_tables.deleted_at — the column grant did not apply';
  END IF;

  RAISE NOTICE 'soft-delete columns + partial indexes ready';
END
$$;
