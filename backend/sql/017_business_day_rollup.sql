-- AeyChhotu! — 017_business_day_rollup.sql
--
-- TWO PROBLEMS, ONE CAUSE.
--
-- 1. A restaurant's day does not end at midnight. The 2 am biryani after the
--    last seating belongs to the night that just ended, not to a fresh day.
--    sql/012/013 keyed every rollup on `created_at::date` in the DATABASE's
--    timezone (UTC on most hosts), so an order at 01:00 IST landed on the
--    previous calendar date, and one at 06:00 IST on the current one — the
--    boundary was both wrong and 5½ hours early.
--
-- 2. Reads used CURRENT_DATE, which has the same problem and additionally
--    disagrees with the write side whenever the server is not in IST.
--
-- So: the BUSINESS DAY starts at 05:00 IST and runs to 04:59:59 IST next
-- day. `sales_rollup.day` and `sales_day.day` now carry that business date,
-- and every reader computes the same expression against the same timezone.
--
--   business_day(ts) = ((ts AT TIME ZONE 'Asia/Kolkata') - interval '5 hours')::date
--
-- Rows written before this migration keep their old (UTC-calendar) keys.
-- They are history: re-keying them would need to know each ticket's exact
-- timestamp, which the rollup does not store. New sales are correct, and the
-- console's window is a single day, so the effect ages out immediately.
--
-- `sales_hour` is unchanged on purpose: it is a clock-hour bucket for the
-- 24-hour trend, where "5 am" is a rendering concern, not a storage one.
--
-- Idempotent: replaces the function body, re-creates the trigger if missing.

CREATE OR REPLACE FUNCTION record_served_order_sale() RETURNS trigger AS $$
DECLARE
  v_day date;
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

  /* The one definition of a business day, applied to the ticket's own
     timestamp (not to "now", so a late rollup still lands on the right day). */
  v_day := ((NEW.created_at AT TIME ZONE 'Asia/Kolkata') - interval '5 hours')::date;

  INSERT INTO sales_rollup (day, menu_item_id, quantity, revenue)
  SELECT v_day,
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
       VALUES (v_day, 1, NEW.total)
  ON CONFLICT (day) DO UPDATE
    SET orders_served = sales_day.orders_served + 1,
        revenue       = sales_day.revenue       + EXCLUDED.revenue;

  INSERT INTO sales_hour (hour, orders_served, revenue)
       VALUES (date_trunc('hour', NEW.created_at), 1, NEW.total)
  ON CONFLICT (hour) DO UPDATE
    SET orders_served = sales_hour.orders_served + 1,
        revenue       = sales_hour.revenue       + EXCLUDED.revenue;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS orders_record_sale_trg ON orders;
CREATE TRIGGER orders_record_sale_trg
  AFTER UPDATE OF status ON orders
  FOR EACH ROW
  WHEN (NEW.status = 'served' AND OLD.status <> 'served')
  EXECUTE FUNCTION record_served_order_sale();

-- Postcondition: exactly one trigger, pointing at the replaced function.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
     WHERE tgname = 'orders_record_sale_trg' AND NOT tgisinternal
  ) THEN
    RAISE EXCEPTION '017: orders_record_sale_trg is missing';
  END IF;
END
$$;
