-- =====================================================================
-- AeyChhotu! — 008_realtime_expansion.sql
-- Publishes the two catalog/floor tables the consoles watch:
--
--   menu_items        an 86 or a price edit must reach every open diner
--                     screen without a refresh (the admin console and the
--                     kitchen drawer both subscribe to it).
--   restaurant_tables the floor board watches bill_status flip to
--                     'requested'; the diner screen watches it flip to
--                     'paid' when the table is settled.
--
-- REPLICA IDENTITY FULL is required so UPDATE/DELETE events carry the old
-- row too — the floor board needs to know WHICH table changed, and a
-- DELETE event would otherwise only carry the primary key.
--
-- Apply:  psql "$DATABASE_URL" -f sql/008_realtime_expansion.sql
--         (or just: npm run db:setup)
-- Safe to re-run (idempotent): a table is only added to the publication
-- when it is not already a member.
-- =====================================================================

DO $$
BEGIN
  IF current_setting('wal_level', true) = 'logical'
     AND EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
    IF NOT EXISTS (
      SELECT 1 FROM pg_publication_tables
       WHERE pubname = 'supabase_realtime'
         AND schemaname = 'public'
         AND tablename = 'menu_items'
    ) THEN
      ALTER PUBLICATION supabase_realtime ADD TABLE public.menu_items;
      RAISE NOTICE 'added menu_items to supabase_realtime';
    ELSE
      RAISE NOTICE 'menu_items already published — skipped';
    END IF;

    IF NOT EXISTS (
      SELECT 1 FROM pg_publication_tables
       WHERE pubname = 'supabase_realtime'
         AND schemaname = 'public'
         AND tablename = 'restaurant_tables'
    ) THEN
      ALTER PUBLICATION supabase_realtime ADD TABLE public.restaurant_tables;
      RAISE NOTICE 'added restaurant_tables to supabase_realtime';
    ELSE
      RAISE NOTICE 'restaurant_tables already published — skipped';
    END IF;
  ELSE
    RAISE NOTICE 'wal_level is not logical or supabase_realtime is absent — publication unchanged';
  END IF;
END
$$;

ALTER TABLE menu_items REPLICA IDENTITY FULL;
ALTER TABLE restaurant_tables REPLICA IDENTITY FULL;

-- Prove the identity setting actually applied, even when the publication
-- itself could not be changed in this environment.
DO $$
DECLARE
  v_menu text;
  v_tables text;
BEGIN
  SELECT relreplident INTO v_menu FROM pg_class WHERE oid = 'public.menu_items'::regclass;
  SELECT relreplident INTO v_tables FROM pg_class WHERE oid = 'public.restaurant_tables'::regclass;

  IF v_menu <> 'f' OR v_tables <> 'f' THEN
    RAISE EXCEPTION 'REPLICA IDENTITY FULL did not apply (menu_items=%, restaurant_tables=%)', v_menu, v_tables;
  END IF;

  RAISE NOTICE 'menu_items / restaurant_tables use REPLICA IDENTITY FULL';
END
$$;
