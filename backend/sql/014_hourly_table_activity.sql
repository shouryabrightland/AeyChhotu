-- =====================================================================
-- AeyChhotu! — 014_hourly_table_activity.sql
--
-- The console's Active Tables card draws a 24-hour line, and nothing
-- recorded how many tables were open an hour ago. `sales_hour` (sql/013)
-- cannot answer it: a quiet table earns no ticket.
--
-- A small sampler in the API process adds one reading every few minutes:
-- `samples` is how many readings the hour received and `active_total` their
-- sum, so the API can plot an hourly AVERAGE instead of an arbitrary
-- last-of-the-hour snapshot. The current hour is deliberately overridden in
-- the API with the live count, so the right edge of the graph is "now" and
-- not stale by up to the sample interval.
--
-- Safe to re-run (idempotent).
-- =====================================================================

-- ----------------------- 0. Browser roles -----------------------------
-- Same stubs as 001/012/013: required on a bare Postgres for the REVOKE
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
CREATE TABLE IF NOT EXISTS table_activity_hour (
  hour         timestamptz PRIMARY KEY,
  samples      integer NOT NULL DEFAULT 0 CHECK (samples >= 0),
  active_total integer NOT NULL DEFAULT 0 CHECK (active_total >= 0)
);

-- ----------------------- 2. Access ------------------------------------
-- Backend-only, like the sales rollups: no browser-role policy.
ALTER TABLE table_activity_hour ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON table_activity_hour FROM anon, authenticated;

-- ----------------------- 3. Postcondition -----------------------------
DO $$
BEGIN
  IF to_regclass('public.table_activity_hour') IS NULL THEN
    RAISE EXCEPTION '014: table_activity_hour is missing';
  END IF;
END
$$;
