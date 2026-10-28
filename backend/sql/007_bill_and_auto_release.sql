-- =====================================================================
-- AeyChhotu! — 007_bill_and_auto_release.sql
-- Bill settlement + device presence, the two facts that decide when a
-- table may be released for the next party.
--
--   1. restaurant_tables gains bill_status / bill_requested_at /
--      bill_paid_at. 'unrequested' → 'requested' → 'paid'; only a table
--      whose bill is PAID is eligible for auto-release.
--
--   2. table_device_presence is the heartbeat registry. A diner device
--      upserts its row every 15s (POST /sessions/:token/heartbeat) and
--      removes it on pagehide (DELETE /sessions/:token/heartbeat).
--      A table is only released once no row has been seen in the last
--      45 seconds — a phone that is still sitting at the table keeps its
--      session alive even after the bill is paid.
--
--   3. COLUMN GRANTS. 005 revoked table-wide SELECT on restaurant_tables
--      and re-granted an explicit column list, which cannot include a
--      column that did not exist yet. The three bill columns are not
--      credentials, and the diner read path needs them, so they are
--      granted deliberately here (006 does the same for deleted_at).
--
-- Apply:  psql "$DATABASE_URL" -f sql/007_bill_and_auto_release.sql
--         (or just: npm run db:setup)
-- Safe to re-run (idempotent).
-- =====================================================================

-- -----------------------1. Bill columns --------------------------------
ALTER TABLE restaurant_tables
  ADD COLUMN IF NOT EXISTS bill_status text NOT NULL DEFAULT 'unrequested';

ALTER TABLE restaurant_tables
  ADD COLUMN IF NOT EXISTS bill_requested_at timestamptz DEFAULT NULL;

ALTER TABLE restaurant_tables
  ADD COLUMN IF NOT EXISTS bill_paid_at timestamptz DEFAULT NULL;

-- -----------------------2. Bill status guard ---------------------------
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'restaurant_tables_bill_status_check'
       AND conrelid = 'restaurant_tables'::regclass
  ) THEN
    ALTER TABLE restaurant_tables
      ADD CONSTRAINT restaurant_tables_bill_status_check
      CHECK (bill_status IN ('unrequested', 'requested', 'paid'));
    RAISE NOTICE 'added restaurant_tables_bill_status_check';
  ELSE
    RAISE NOTICE 'restaurant_tables_bill_status_check already present — skipped';
  END IF;
END
$$;

-- A paid bill always has a payment timestamp, and a paid timestamp only
-- belongs to a paid bill. This keeps the periodic sweeper from finding rows whose
-- state contradicts itself.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'restaurant_tables_bill_paid_consistency'
       AND conrelid = 'restaurant_tables'::regclass
  ) THEN
    ALTER TABLE restaurant_tables
      ADD CONSTRAINT restaurant_tables_bill_paid_consistency
      CHECK (
        (bill_status = 'paid' AND bill_paid_at IS NOT NULL) OR
        (bill_status <> 'paid')
      );
    RAISE NOTICE 'added restaurant_tables_bill_paid_consistency';
  ELSE
    RAISE NOTICE 'restaurant_tables_bill_paid_consistency already present — skipped';
  END IF;
END
$$;

-- -----------------------3. Device presence ----------------------------
CREATE TABLE IF NOT EXISTS table_device_presence (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  table_id uuid NOT NULL REFERENCES restaurant_tables(id) ON DELETE CASCADE,
  device_id text NOT NULL,
  last_seen timestamptz NOT NULL DEFAULT now(),
  UNIQUE(table_id, device_id)
);

CREATE INDEX IF NOT EXISTS table_device_presence_table_idx
  ON table_device_presence (table_id, last_seen);

-- Presences are ephemeral. This partial index makes the stale-row cleanup
-- cheap without growing with the table's history.
CREATE INDEX IF NOT EXISTS table_device_presence_last_seen_idx
  ON table_device_presence (last_seen);

-- -----------------------4. Browser column grants ----------------------
GRANT SELECT (bill_status, bill_requested_at, bill_paid_at)
  ON restaurant_tables TO anon, authenticated;

-- -----------------------5. Prove the shape ----------------------------
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name   = 'restaurant_tables'
       AND column_name  = 'bill_status'
  ) THEN
    RAISE EXCEPTION 'restaurant_tables.bill_status is missing';
  END IF;

  IF to_regclass('public.table_device_presence') IS NULL THEN
    RAISE EXCEPTION 'table_device_presence is missing';
  END IF;

  IF NOT has_column_privilege('anon', 'public.restaurant_tables', 'bill_status', 'SELECT') THEN
    RAISE EXCEPTION 'anon cannot read restaurant_tables.bill_status — the column grant did not apply';
  END IF;

  RAISE NOTICE 'bill tracking + device presence ready';
END
$$;
