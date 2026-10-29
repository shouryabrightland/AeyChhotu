-- AeyChhotu! — 016_stock_and_feedback.sql
--
-- Two things the manager console's AI needs that the schema did not have:
--
--   STOCK. Until now "inventory" in this product was the boolean
--   `menu_items.is_available` (the kitchen's 86 switch): there was no count,
--   so nobody could answer "what are we about to run out of?". This adds an
--   OPTIONAL count and threshold per dish. NULL means "not tracked" — the
--   honest default for a kitchen that does not weigh portions — and every
--   reader must treat NULL as unknown, never as zero.
--
--   FEEDBACK. `guest_feedback` is written by the diner's table session (one
--   row per rating the guest leaves in the assistant) and read only by the
--   admin console. It is intentionally NOT exposed to the browser roles: RLS
--   is on and every privilege is revoked, exactly like sales_rollup.
--
-- Idempotent: safe to re-run from `npm run db:setup`.

ALTER TABLE menu_items
  ADD COLUMN IF NOT EXISTS stock_quantity      integer,
  ADD COLUMN IF NOT EXISTS low_stock_threshold integer NOT NULL DEFAULT 5,
  ADD COLUMN IF NOT EXISTS stock_updated_at    timestamptz;

/* A negative count is a data-entry bug, not a state: a dish at or below zero
   reads as "out", and the check keeps the arithmetic honest. Guarded because
   ADD CONSTRAINT has no IF NOT EXISTS. */
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'menu_items_stock_quantity_check'
  ) THEN
    ALTER TABLE menu_items
      ADD CONSTRAINT menu_items_stock_quantity_check
      CHECK (stock_quantity IS NULL OR stock_quantity >= 0);
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'menu_items_low_stock_threshold_check'
  ) THEN
    ALTER TABLE menu_items
      ADD CONSTRAINT menu_items_low_stock_threshold_check
      CHECK (low_stock_threshold >= 0);
  END IF;
END $$;

/* One guest's rating of one visit. `table_id` is enough context (the console
   can join the table name); the order is deliberately not linked, because a
   guest may rate the service after the ticket is already archived. */
CREATE TABLE IF NOT EXISTS guest_feedback (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  table_id   uuid NOT NULL REFERENCES restaurant_tables(id) ON DELETE CASCADE,
  rating     integer NOT NULL CHECK (rating BETWEEN 1 AND 5),
  comment    text NOT NULL DEFAULT '' CHECK (char_length(comment) <= 500),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS guest_feedback_created_idx
  ON guest_feedback (created_at DESC);

/* Only the backend writes or reads these: no diner device and no anonymous
   visitor can select them directly, so a rating never leaks between tables. */
ALTER TABLE guest_feedback ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON guest_feedback FROM anon, authenticated;
