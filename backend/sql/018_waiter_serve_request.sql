-- =====================================================================
-- AeyChhotu! — 018_waiter_serve_request.sql
--
-- The floor's "I'll serve this" used to be a browser-only claim: nothing was
-- written, so the kitchen never knew a waiter had picked the plate up and
-- walked over to find nobody ready for it.
--
-- This adds one nullable timestamp on the table row. The waiter's tap writes
-- it, the KDS ticket payload carries it, and the kitchen clears it when the
-- ticket is served (or denied). It deliberately lives on the TABLE, not the
-- order: the person carrying the plate is serving a seating, and the table
-- is what both surfaces already share.
--
-- NULL means "nobody is on their way" — never "unknown time".
--
-- Safe to re-run (idempotent).
-- =====================================================================

ALTER TABLE restaurant_tables
  ADD COLUMN IF NOT EXISTS serve_requested_at timestamptz;

COMMENT ON COLUMN restaurant_tables.serve_requested_at IS
  'Set when a floor waiter taps "I''ll serve this"; the kitchen shows a "waiter coming" ping until the ticket is served or denied.';

-- The kitchen reads this per open ticket, and the floor board may filter on
-- it later; an index keeps that read cheap on a busy night.
CREATE INDEX IF NOT EXISTS restaurant_tables_serve_requested_at_idx
  ON restaurant_tables (serve_requested_at)
  WHERE serve_requested_at IS NOT NULL;

-- ----------------------- Postcondition --------------------------------
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'restaurant_tables'
       AND column_name = 'serve_requested_at'
  ) THEN
    RAISE EXCEPTION '018: restaurant_tables.serve_requested_at is missing';
  END IF;
END
$$;
