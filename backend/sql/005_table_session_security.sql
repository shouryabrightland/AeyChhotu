-- =====================================================================
-- AeyChhotu! — 005_table_session_security.sql
-- Layer 1 + 2 of table security: a 2-digit PIN that every guest at the
-- table types once, and a 20-character secret that only a device which
-- already joined can present again (QR pass / refresh reconnect).
--
--   1. restaurant_tables gains the session credentials and the
--      table-wide failed-attempt counter. Idempotent, so `npm run
--      db:setup` can re-run it over an existing database.
--
--   2. COLUMN PRIVILEGES: the browser roles (anon / authenticated) may
--      no longer SELECT session_pin or session_secret at all. RLS still
--      decides WHICH table row a diner token can see, but the secret is
--      a bearer credential for the whole table — a row-level policy is
--      the wrong shape for it, because the row is legitimately readable
--      while those two columns are not.
--
--      How: 001_init.sql grants table-wide SELECT, and Postgres cannot
--      subtract a column from a table-level grant — so this file revokes
--      the table grant and re-issues an explicit column list made from
--      the live catalog, minus the two secret columns. Any column added
--      later is therefore NOT readable by a browser until someone adds
--      it deliberately. Fail closed.
--
--      The backend connects as the table owner (and service_role keeps
--      ALL), so the API reads and writes the secrets normally. Nothing
--      browser-side selects restaurant_tables directly except the
--      claim-scoped RLS path, and the realtime publication does not
--      include this table.
--
--   3. A settle (E12 prune) must clear the session, so the next guests
--      start from an unpinned table. That is enforced in
--      kds.service.ts#pruneTicket, not here — this file only owns shape.
--
-- Apply:  psql "$DATABASE_URL" -f sql/005_table_session_security.sql
--         (or just: npm run db:setup)
-- Safe to re-run (idempotent).
-- =====================================================================

-- -----------------------1. Session credential columns -----------------
-- '00'–'99' is stored as text on purpose: the PIN is a label guests read
-- aloud, not a number. A leading zero is significant ("07" ≠ "7"), which
-- an integer column would silently lose.
ALTER TABLE restaurant_tables
  ADD COLUMN IF NOT EXISTS session_pin        varchar(2)  DEFAULT NULL;
ALTER TABLE restaurant_tables
  ADD COLUMN IF NOT EXISTS session_secret     varchar(20) DEFAULT NULL;
ALTER TABLE restaurant_tables
  ADD COLUMN IF NOT EXISTS failed_pin_attempts integer    DEFAULT 0 NOT NULL;
ALTER TABLE restaurant_tables
  ADD COLUMN IF NOT EXISTS session_started_at timestamptz DEFAULT NULL;

-- -----------------------2. Shape guards -------------------------------
-- Two digits, nothing else, and never a leading/trailing space. The
-- backend validates the inbound payload; this is the DB refusing to hold
-- something the keypad could never produce.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'restaurant_tables_session_pin_format'
       AND conrelid = 'restaurant_tables'::regclass
  ) THEN
    ALTER TABLE restaurant_tables
      ADD CONSTRAINT restaurant_tables_session_pin_format
      CHECK (session_pin IS NULL OR session_pin ~ '^[0-9]{2}$');
    RAISE NOTICE 'added restaurant_tables_session_pin_format';
  ELSE
    RAISE NOTICE 'restaurant_tables_session_pin_format already present — skipped';
  END IF;
END
$$;

-- Exactly 20 characters when set: the checker in the diner UI, the QR
-- payload and join-pass all assume that length.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'restaurant_tables_session_secret_length'
       AND conrelid = 'restaurant_tables'::regclass
  ) THEN
    ALTER TABLE restaurant_tables
      ADD CONSTRAINT restaurant_tables_session_secret_length
      CHECK (session_secret IS NULL OR char_length(session_secret) = 20);
    RAISE NOTICE 'added restaurant_tables_session_secret_length';
  ELSE
    RAISE NOTICE 'restaurant_tables_session_secret_length already present — skipped';
  END IF;
END
$$;

-- The counter only ever climbs from zero, and a settle puts it back there.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'restaurant_tables_failed_pin_attempts_range'
       AND conrelid = 'restaurant_tables'::regclass
  ) THEN
    ALTER TABLE restaurant_tables
      ADD CONSTRAINT restaurant_tables_failed_pin_attempts_range
      CHECK (failed_pin_attempts >= 0);
    RAISE NOTICE 'added restaurant_tables_failed_pin_attempts_range';
  ELSE
    RAISE NOTICE 'restaurant_tables_failed_pin_attempts_range already present — skipped';
  END IF;
END
$$;

-- -----------------------3. Zero-knowledge column grants ---------------
DO $$
DECLARE
  v_cols text;
BEGIN
  SELECT string_agg(quote_ident(column_name), ', ' ORDER BY ordinal_position)
    INTO v_cols
    FROM information_schema.columns
   WHERE table_schema = 'public'
     AND table_name   = 'restaurant_tables'
     -- `clear_requested_at` (009) is staff/admin coordination state; it is
     -- deliberately excluded so a re-run cannot widen browser access to it.
     AND column_name NOT IN ('session_pin', 'session_secret', 'clear_requested_at');

  IF v_cols IS NULL THEN
    RAISE EXCEPTION 'restaurant_tables has no readable columns — refusing to revoke SELECT';
  END IF;

  -- Table-level SELECT cannot be narrowed, so drop it and re-grant the
  -- explicit list. service_role keeps GRANT ALL from 001_init.sql.
  REVOKE SELECT ON restaurant_tables FROM anon, authenticated;
  EXECUTE format('GRANT SELECT (%s) ON restaurant_tables TO anon, authenticated', v_cols);

  RAISE NOTICE 'restaurant_tables: browser SELECT limited to [%]', v_cols;
END
$$;

-- -----------------------4. Prove the lockdown -------------------------
DO $$
DECLARE
  v_anon_pin    boolean;
  v_anon_secret boolean;
BEGIN
  SELECT has_column_privilege('anon', 'public.restaurant_tables', 'session_pin', 'SELECT')
      OR has_column_privilege('anon', 'public.restaurant_tables', 'session_secret', 'SELECT')
    INTO v_anon_pin;

  SELECT has_column_privilege('authenticated', 'public.restaurant_tables', 'session_pin', 'SELECT')
      OR has_column_privilege('authenticated', 'public.restaurant_tables', 'session_secret', 'SELECT')
    INTO v_anon_secret;

  IF v_anon_pin OR v_anon_secret THEN
    RAISE EXCEPTION
      'session credentials are still readable by a browser role — the column grant did not apply';
  END IF;

  RAISE NOTICE 'session_pin / session_secret: not readable by anon or authenticated';
END
$$;
