-- =====================================================================
-- AeyChhotu! — 009_table_clear_alerts.sql
-- Staff can clear an abandoned table, but not one that still owes money.
--
-- When a staff member tries to clear a flagged table whose bill is unpaid,
-- the backend refuses and stamps `clear_requested_at`. That single column
-- is the alert the manager console renders: it persists across restarts,
-- survives a dropped Realtime socket, and is only cleared when the table is
-- finally cleared (by an admin) or its bill is settled and auto-released.
--
-- "Unpaid" means: bill_status <> 'paid' AND at least one order exists for
-- the table. A table with no orders has nothing to charge, so staff may
-- clear it directly.
--
-- Apply:  psql "$DATABASE_URL" -f sql/009_table_clear_alerts.sql
--         (or just: npm run db:setup)
-- Safe to re-run (idempotent).
-- =====================================================================

ALTER TABLE restaurant_tables
  ADD COLUMN IF NOT EXISTS clear_requested_at timestamptz DEFAULT NULL;

-- Only the handful of tables waiting on a manager are indexed; the partial
-- index keeps the admin query trivial without growing with table history.
CREATE INDEX IF NOT EXISTS restaurant_tables_clear_requested_idx
  ON restaurant_tables (clear_requested_at)
  WHERE clear_requested_at IS NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name   = 'restaurant_tables'
       AND column_name  = 'clear_requested_at'
  ) THEN
    RAISE EXCEPTION 'restaurant_tables.clear_requested_at is missing';
  END IF;

  RAISE NOTICE 'staff clear-request flag ready';
END
$$;
