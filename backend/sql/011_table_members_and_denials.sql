-- =====================================================================
-- AeyChhotu! — 011_table_members_and_denials.sql
--
-- Four facts this app was missing, plus the machinery that keeps them in
-- step with the dining session they belong to:
--
--   1. WHO IS AT THE TABLE — `table_members`. A session is a physical
--      table, not a device: every phone that joins with the PIN or the pass
--      leaves a row here, and clearing the table removes all of them at
--      once. `(table_id, user_id)` is unique so a refresh/reconnect is an
--      upsert, never a second member.
--
--   2. WHEN WAS IT CLEARED — `restaurant_tables.last_cleared_at`. A phone
--      can sit on a stale page for hours; when it finally talks to the API
--      it presents the time it OPENED the page (`scan_time`). If that is
--      older than the moment the table was handed to the next party, the
--      session it is trying to resurrect belongs to strangers, and the
--      backend answers STALE_SESSION instead of seating them at somebody
--      else's bill.
--
--   3. WHO ORDERED IT — `order_items.added_by`. The cart has carried this
--      since 001; until now firing a round lost it, so the running bill
--      could not be split by person. fire_order() now copies it, which is
--      what makes the "your part of the bill" view true instead of a guess.
--
--   4. WHY IT WAS REFUSED — `orders.status = 'denied'` + `denial_reason`.
--      An 86 after the ticket was fired, or a chef who cannot cook a dish,
--      must stop the round without pretending it was served and without
--      deleting it: the diner needs to read the reason and choose. The
--      status-transition trigger is widened to allow *→denied and nothing
--      else new; the one-active-ticket index already ignores denied rows,
--      so a table can fire a replacement round immediately.
--
-- Realtime: `menu_item_images` is published (a replaced photo must reach an
-- open menu) and both it and `restaurant_tables` get REPLICA IDENTITY FULL.
--
-- Apply:  psql "$DATABASE_URL" -f sql/011_table_members_and_denials.sql
--         (or just: npm run db:setup)
-- Safe to re-run (idempotent).
-- =====================================================================

-- -----------------------1. Table members -------------------------------
-- `user_id` is the device's anonymous identity (dev_xxxxxxxx …) — never a
-- real account, and never a secret: it only exists to dedupe a phone that
-- reconnects. CASCADE means a deleted table can never strand a member.
CREATE TABLE IF NOT EXISTS table_members (
  id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  table_id  uuid NOT NULL REFERENCES restaurant_tables(id) ON DELETE CASCADE,
  user_id   text NOT NULL CHECK (char_length(user_id) BETWEEN 1 AND 64),
  name      text NOT NULL DEFAULT 'Guest' CHECK (char_length(name) <= 40),
  joined_at timestamptz NOT NULL DEFAULT now()
);

-- One row per person per table: reconnect is an upsert, not a new member.
CREATE UNIQUE INDEX IF NOT EXISTS table_members_table_user_idx
  ON table_members (table_id, user_id);

CREATE INDEX IF NOT EXISTS table_members_table_joined_idx
  ON table_members (table_id, joined_at);

-- Backend-only data. The browser has no reason to enumerate the people at a
-- table (and a diner token is one table's, not a roster), so the roles are
-- revoked and RLS is enabled with NO anon/authenticated policy — fail closed.
ALTER TABLE table_members ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE table_members FROM anon, authenticated;
GRANT ALL ON TABLE table_members TO service_role;

-- -----------------------2. Clearance cut-off ---------------------------
-- Written by every path that hands a table to its next party (auto-release,
-- staff clear, admin deactivate/regenerate/archive). Deliberately NOT added
-- to the browser column grant (005): it is coordination state, and the
-- client only ever SENDS its own scan time.
ALTER TABLE restaurant_tables
  ADD COLUMN IF NOT EXISTS last_cleared_at timestamptz DEFAULT NULL;

-- -----------------------3. Diner identity on the ticket -----------------
ALTER TABLE order_items
  ADD COLUMN IF NOT EXISTS added_by text NOT NULL DEFAULT 'Guest';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'order_items_added_by_length'
       AND conrelid = 'order_items'::regclass
  ) THEN
    ALTER TABLE order_items
      ADD CONSTRAINT order_items_added_by_length
      CHECK (char_length(added_by) <= 40);
    RAISE NOTICE 'added order_items_added_by_length';
  END IF;
END
$$;

-- -----------------------4. Order denial ---------------------------------
-- The inline CHECK from 001 is auto-named orders_status_check; drop it by
-- that name (a no-op if a later migration already widened it) and re-add a
-- named constraint the rest of this file can rely on.
ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_status_check;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'orders_status_check'
       AND conrelid = 'orders'::regclass
  ) THEN
    ALTER TABLE orders
      ADD CONSTRAINT orders_status_check
      CHECK (status IN ('pending', 'preparing', 'ready', 'served', 'denied'));
    RAISE NOTICE 'orders_status_check now permits denied';
  END IF;
END
$$;

ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS denial_reason text NOT NULL DEFAULT '';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'orders_denial_reason_length'
       AND conrelid = 'orders'::regclass
  ) THEN
    ALTER TABLE orders
      ADD CONSTRAINT orders_denial_reason_length
      CHECK (char_length(denial_reason) <= 300);
    RAISE NOTICE 'added orders_denial_reason_length';
  END IF;
END
$$;

-- A denied round is history the diner may still be reading, so it keeps its
-- lines and its frozen total; only the STATUS changes. The partial unique
-- index from 001 keys pending/preparing/ready only, so denial frees the
-- table to fire again without any index change.

-- -----------------------5. Status transition guard ----------------------
-- Same matrix as 004 plus one rule: any live ticket may be DENIED. Backwards,
-- skipping and repeating moves stay illegal, and 'denied' is terminal for
-- the same reason 'served' is — a denied round is closed for good (a retry is
-- a NEW ticket, never a resurrection).
CREATE OR REPLACE FUNCTION enforce_order_status_transition()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF NEW.status IS NOT DISTINCT FROM OLD.status THEN
    RETURN NEW;
  END IF;

  IF (OLD.status = 'pending'   AND NEW.status = 'preparing')
     OR (OLD.status = 'preparing' AND NEW.status = 'ready')
     OR (NEW.status = 'served' AND OLD.status IN ('pending', 'preparing', 'ready'))
     -- Kitchen refusal (KDS deny) and the automatic 86 rejection.
     OR (NEW.status = 'denied' AND OLD.status IN ('pending', 'preparing', 'ready'))
  THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'illegal order status transition: % -> %', OLD.status, NEW.status
    USING ERRCODE = 'check_violation',
          HINT = 'Allowed: pending->preparing, preparing->ready, ->served, or ->denied.';
END
$function$;

DROP TRIGGER IF EXISTS orders_status_transition ON orders;
CREATE TRIGGER orders_status_transition
  BEFORE UPDATE ON orders
  FOR EACH ROW
  EXECUTE FUNCTION enforce_order_status_transition();

-- -----------------------6. fire_order() — keep added_by ----------------
-- Identical to 004 (lock, guard, freeze, inventory check, build, drain) with
-- the one addition this migration exists for: `added_by` travels from the
-- cart line onto the ticket, so the bill can be attributed per person.
CREATE OR REPLACE FUNCTION fire_order(p_table_token text)
RETURNS jsonb
LANGUAGE plpgsql
AS $function$
DECLARE
  v_table_id      uuid;
  v_active_id     uuid;
  v_active_status text;
  v_line_ids      uuid[];
  v_sold_out      text[] := '{}';
  v_order_id      uuid;
  v_created_at    timestamptz;
  v_total         numeric(10,2);
BEGIN
  -- 1) Serialize concurrent fires for this physical table.
  SELECT id INTO v_table_id
    FROM restaurant_tables
   WHERE code = p_table_token
     FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('code', 'TABLE_NOT_FOUND');
  END IF;

  -- 2) Duplicate guard — a denied round is NOT active (its index entry is
  --    gone), so a table whose order was refused can fire a fresh one.
  SELECT id, status INTO v_active_id, v_active_status
    FROM orders
   WHERE table_id = v_table_id
     AND status IN ('pending', 'preparing', 'ready')
   LIMIT 1;
  IF FOUND THEN
    RETURN jsonb_build_object(
      'code', 'DUPLICATE_ORDER', 'order_id', v_active_id, 'status', v_active_status);
  END IF;

  -- 3) Freeze the cart snapshot, then check it is not empty.
  SELECT array_agg(id) INTO v_line_ids
    FROM (SELECT id FROM cart_items WHERE table_id = v_table_id FOR UPDATE) AS frozen;
  IF v_line_ids IS NULL OR array_length(v_line_ids, 1) = 0 THEN
    RETURN jsonb_build_object('code', 'EMPTY_CART');
  END IF;

  -- 4) Inventory check on exactly the frozen lines.
  PERFORM mi.id
    FROM cart_items ci
    JOIN menu_items mi ON mi.id = ci.menu_item_id
   WHERE ci.id = ANY(v_line_ids)
     FOR UPDATE OF mi;

  SELECT COALESCE(array_agg(mi.name ORDER BY mi.name), '{}') INTO v_sold_out
    FROM cart_items ci
    JOIN menu_items mi ON mi.id = ci.menu_item_id
   WHERE ci.id = ANY(v_line_ids)
     AND mi.is_available = false;
  IF array_length(v_sold_out, 1) > 0 THEN
    DELETE FROM cart_items ci
     WHERE ci.id = ANY(v_line_ids)
       AND EXISTS (SELECT 1 FROM menu_items mi
                    WHERE mi.id = ci.menu_item_id AND mi.is_available = false);
    RETURN jsonb_build_object('code', 'INVENTORY_FAILURE', 'sold_out', to_jsonb(v_sold_out));
  END IF;

  -- 5) Build the ticket from the frozen snapshot.
  INSERT INTO orders (table_id, status)
  VALUES (v_table_id, 'pending')
  RETURNING id, created_at INTO v_order_id, v_created_at;

  INSERT INTO order_items (
    order_id, menu_item_id, quantity, request_note, allergy_note, added_by, unit_price
  )
  SELECT v_order_id,
         ci.menu_item_id,
         ci.quantity,
         ci.request_note,
         ci.allergy_note,
         ci.added_by,          -- ← attribution survives the fire
         mi.price
    FROM cart_items ci
    JOIN menu_items mi ON mi.id = ci.menu_item_id
   WHERE ci.id = ANY(v_line_ids)
   ORDER BY ci.created_at, ci.id;

  -- 6) Freeze the bill.
  SELECT COALESCE(sum(quantity * unit_price), 0)
    INTO v_total
    FROM order_items
   WHERE order_id = v_order_id;
  UPDATE orders SET total = v_total WHERE id = v_order_id;

  -- 7) Drain only those same lines.
  DELETE FROM cart_items WHERE id = ANY(v_line_ids);

  RETURN jsonb_build_object(
    'code', 'OK',
    'order_id', v_order_id,
    'table_id', v_table_id,
    'status', 'pending',
    'created_at', to_jsonb(v_created_at));
END
$function$;

REVOKE ALL ON FUNCTION fire_order(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION fire_order(text) TO service_role;

-- -----------------------7. Realtime -------------------------------------
-- A replaced photo writes menu_item_images, not menu_items, so that table
-- has to be published or an open menu keeps yesterday's picture.
DO $$
BEGIN
  IF current_setting('wal_level', true) = 'logical'
     AND EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
    IF NOT EXISTS (
      SELECT 1 FROM pg_publication_tables
       WHERE pubname = 'supabase_realtime'
         AND schemaname = 'public'
         AND tablename = 'menu_item_images'
    ) THEN
      ALTER PUBLICATION supabase_realtime ADD TABLE public.menu_item_images;
      RAISE NOTICE 'added menu_item_images to supabase_realtime';
    END IF;

    IF NOT EXISTS (
      SELECT 1 FROM pg_publication_tables
       WHERE pubname = 'supabase_realtime'
         AND schemaname = 'public'
         AND tablename = 'restaurant_tables'
    ) THEN
      ALTER PUBLICATION supabase_realtime ADD TABLE public.restaurant_tables;
      RAISE NOTICE 'added restaurant_tables to supabase_realtime';
    END IF;
  ELSE
    RAISE NOTICE 'wal_level is not logical or supabase_realtime is absent — publication unchanged';
  END IF;
END
$$;

ALTER TABLE menu_item_images REPLICA IDENTITY FULL;
ALTER TABLE restaurant_tables REPLICA IDENTITY FULL;

-- 010 revoked every browser privilege on menu_item_images because the bytes
-- are served by the API. The METADATA is what a Realtime subscriber needs to
-- know a photo changed, and the resulting URLs are public anyway, so grant
-- exactly those columns plus an explicit read policy. The raw bytes table
-- (menu_image_objects) stays backend-only.
GRANT SELECT (
  menu_item_id,
  storage_driver,
  original_key,
  small_key,
  tiny_key,
  blur_data_url,
  updated_at
) ON menu_item_images TO anon, authenticated;

DROP POLICY IF EXISTS menu_item_images_select_public ON menu_item_images;
CREATE POLICY menu_item_images_select_public ON menu_item_images
  FOR SELECT TO anon, authenticated USING (true);

-- -----------------------8. Prove the shape ------------------------------
DO $$
DECLARE
  v_menu_img text;
  v_tables   text;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name   = 'restaurant_tables'
       AND column_name  = 'last_cleared_at'
  ) THEN
    RAISE EXCEPTION 'restaurant_tables.last_cleared_at is missing';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name   = 'order_items'
       AND column_name  = 'added_by'
  ) THEN
    RAISE EXCEPTION 'order_items.added_by is missing';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name   = 'orders'
       AND column_name  = 'denial_reason'
  ) THEN
    RAISE EXCEPTION 'orders.denial_reason is missing';
  END IF;

  IF to_regclass('public.table_members') IS NULL THEN
    RAISE EXCEPTION 'table_members is missing';
  END IF;

  SELECT relreplident INTO v_menu_img FROM pg_class WHERE oid = 'public.menu_item_images'::regclass;
  SELECT relreplident INTO v_tables   FROM pg_class WHERE oid = 'public.restaurant_tables'::regclass;
  IF v_menu_img <> 'f' OR v_tables <> 'f' THEN
    RAISE EXCEPTION 'REPLICA IDENTITY FULL did not apply (menu_item_images=%, restaurant_tables=%)',
      v_menu_img, v_tables;
  END IF;

  RAISE NOTICE 'table members, stale cutoff, attribution and denial ready';
END
$$;
