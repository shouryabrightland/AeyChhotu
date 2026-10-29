-- =====================================================================
-- 015_menu_item_metadata.sql
-- Dish metadata for "Ask Chhotu" / Chhotu AI.
--
-- WHY: the conversational assistant is asked to explain ingredients, spice
-- level, portion size and allergen risk. The original catalog only had a
-- name, a price, a description and a vegetarian flag, so every such answer
-- would have been a guess. These columns make the kitchen's own knowledge
-- queryable — and nullable-by-default rather than invented at request time.
--
-- SAFETY: `check_allergy_safety` must NEVER claim a dish is safe. These
-- columns are kitchen-maintained statements of what a recipe contains, not a
-- medical guarantee; shared equipment and substitutions still apply. The API
-- and the assistant both keep the "confirm with staff" caveat.
--
-- IDEMPOTENT: ADD COLUMN IF NOT EXISTS + a guarded constraint + a backfill
-- that only touches rows nobody has edited yet (empty metadata).
-- =====================================================================

ALTER TABLE menu_items
  ADD COLUMN IF NOT EXISTS ingredients        text[]   NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS spice_level        smallint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS allergens          text[]   NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS diet_tags          text[]   NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS portion_description text    NOT NULL DEFAULT '';

COMMENT ON COLUMN menu_items.ingredients IS
  'Main recipe components, lower-case free text. Empty = not recorded.';
COMMENT ON COLUMN menu_items.spice_level IS
  '0 mild, 1 medium, 2 hot, 3 very hot. Default 0 = not recorded/mild.';
COMMENT ON COLUMN menu_items.allergens IS
  'Declared allergen families (dairy, gluten, nuts, coconut, soy, egg…). Empty = not recorded.';
COMMENT ON COLUMN menu_items.diet_tags IS
  'Best-effort diet tags: jain, vegan, halal, eggitarian. vegetarian lives in its own column.';
COMMENT ON COLUMN menu_items.portion_description IS
  'Human portion, e.g. "serves 1–2" or "2 pieces".';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'menu_items_spice_level_check'
  ) THEN
    ALTER TABLE menu_items
      ADD CONSTRAINT menu_items_spice_level_check CHECK (spice_level BETWEEN 0 AND 3);
  END IF;
END $$;

-- ---- Curated backfill for the 20 seeded dishes ----------------------
-- Only rows whose metadata is still untouched are filled, so re-running
-- `db:setup` can never overwrite an operator's correction.
--
-- diet_tags is deliberately conservative:
--   * `jain` only where the listed recipe has no onion, garlic or root
--     vegetable (ginger counts as a root, so Masala Chai is excluded);
--   * `halal` is NOT tagged — sourcing/certification cannot be inferred from
--     a recipe, and the assistant says so instead of guessing;
--   * `vegan` is NOT tagged — shared ghee/butter finish makes it unverifiable.
UPDATE menu_items AS mi
   SET ingredients         = v.ingredients,
       spice_level         = v.spice_level,
       allergens           = v.allergens,
       diet_tags           = v.diet_tags,
       portion_description = v.portion_description
  FROM (VALUES
    ('Masala Dosa',          ARRAY['rice','urad dal','potato','mustard seeds','curry leaves','coconut']::text[],
                             1::smallint, ARRAY['coconut']::text[], ARRAY[]::text[], '1 dosa with chutney'),
    ('Paneer Butter Masala', ARRAY['paneer','tomato','cashew','butter','cream','spices']::text[],
                             1::smallint, ARRAY['dairy','nuts']::text[], ARRAY[]::text[], 'serves 1–2'),
    ('Veg Noodles',          ARRAY['wheat noodles','mixed vegetables','soy sauce','oil']::text[],
                             2::smallint, ARRAY['gluten','soy']::text[], ARRAY[]::text[], 'serves 1'),
    ('Hyderabadi Biryani',   ARRAY['basmati rice','chicken','yogurt','saffron','fried onions','spices']::text[],
                             3::smallint, ARRAY['dairy']::text[], ARRAY[]::text[], 'serves 1'),
    ('Palak Paneer',         ARRAY['paneer','spinach','garlic','cream','spices']::text[],
                             1::smallint, ARRAY['dairy']::text[], ARRAY[]::text[], 'serves 1'),
    ('Chole Bhature',        ARRAY['chickpeas','refined flour','yogurt','spices','oil']::text[],
                             2::smallint, ARRAY['gluten','dairy']::text[], ARRAY[]::text[], 'serves 1'),
    ('Masala Tacos',         ARRAY['corn tortilla','cumin slaw','smoked chilli','salsa']::text[],
                             3::smallint, ARRAY[]::text[], ARRAY[]::text[], '3 tacos'),
    ('Chhotu Burger',        ARRAY['house patty','brioche bun','pickled onion','cheese','sauce']::text[],
                             1::smallint, ARRAY['gluten','dairy','egg']::text[], ARRAY[]::text[], 'serves 1'),
    ('Onion Pakora',         ARRAY['gram flour','onion','oil','mint chutney']::text[],
                             2::smallint, ARRAY[]::text[], ARRAY[]::text[], 'serves 1'),
    ('Samosa Chaat',         ARRAY['samosa pastry','potato','peas','chickpeas','yogurt','tamarind chutney']::text[],
                             2::smallint, ARRAY['gluten','dairy']::text[], ARRAY[]::text[], 'serves 1'),
    ('Garlic Naan',          ARRAY['refined flour','garlic','butter','yogurt']::text[],
                             1::smallint, ARRAY['gluten','dairy']::text[], ARRAY[]::text[], '1 naan'),
    ('Tandoori Roti',        ARRAY['whole wheat flour','water','salt']::text[],
                             0::smallint, ARRAY['gluten']::text[], ARRAY['jain']::text[], '1 roti'),
    ('Butter Naan',          ARRAY['refined flour','butter','yogurt']::text[],
                             0::smallint, ARRAY['gluten','dairy']::text[], ARRAY[]::text[], '1 naan'),
    ('Aloo Paratha',         ARRAY['whole wheat flour','potato','butter','pickle']::text[],
                             1::smallint, ARRAY['gluten','dairy']::text[], ARRAY[]::text[], '2 parathas'),
    ('Sweet Lassi',          ARRAY['yogurt','milk','rose','pistachio','sugar']::text[],
                             0::smallint, ARRAY['dairy','nuts']::text[], ARRAY['jain']::text[], '1 glass'),
    ('Masala Chai',          ARRAY['assam tea','milk','ginger','cardamom','sugar']::text[],
                             0::smallint, ARRAY['dairy']::text[], ARRAY[]::text[], '1 cup'),
    ('Mango Lassi',          ARRAY['mango','yogurt','milk','cardamom','sugar']::text[],
                             0::smallint, ARRAY['dairy']::text[], ARRAY[]::text[], '1 glass'),
    ('Filter Coffee',        ARRAY['coffee decoction','milk','sugar']::text[],
                             0::smallint, ARRAY['dairy']::text[], ARRAY['jain']::text[], '1 cup'),
    ('Malai Kulfi',          ARRAY['milk','sugar','saffron','almond']::text[],
                             0::smallint, ARRAY['dairy','nuts']::text[], ARRAY['jain']::text[], '1 kulfi'),
    ('Gulab Jamun',          ARRAY['khoya','refined flour','sugar','cardamom','ghee']::text[],
                             0::smallint, ARRAY['dairy','gluten']::text[], ARRAY['jain']::text[], '2 pieces')
  ) AS v(name, ingredients, spice_level, allergens, diet_tags, portion_description)
 WHERE lower(mi.name) = lower(v.name)
   AND mi.deleted_at IS NULL
   AND cardinality(mi.ingredients) = 0
   AND mi.portion_description = '';
