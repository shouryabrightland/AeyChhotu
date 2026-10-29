-- =====================================================================
-- AeyChhotu! — seed.sql
-- Production-ready, IDEMPOTENT seed. Running it any number of times
-- never duplicates rows, never collides on primary/unique keys, and
-- never deletes or mutates operator-edited data:
--   * every row carries a FIXED uuid → ON CONFLICT (id) DO NOTHING
--   * restaurant_tables.code is UNIQUE  → ON CONFLICT (code) DO NOTHING
--   * no DELETE/TRUNCATE anywhere (docs/2: operators edit menu in the
--     Supabase dashboard; re-seeding must not clobber that).
--
-- Populates:
--   1  Active master terminal session setup (bound to the STAFF_PIN env var)
--   5  Physical tables with non-guessable QR tokens
--   20 Realistic Indian menu items with INR pricing
--
-- Apply:  psql "$DATABASE_URL" -f sql/seed.sql
-- =====================================================================

-- ---- 1. Active master terminal session parameters --------------------
-- ZERO-EXPOSURE: only the environment variable NAME that holds the PIN
-- is stored — the PIN value itself never touches the database.
INSERT INTO staff_terminals (id, device_label, role, is_active, pin_env_var)
VALUES (
  '7e8f9a0b-1c2d-4e3f-8a5b-6c7d8e9f0a1b',
  'Master KDS Terminal',
  'kitchen',
  true,
  'STAFF_PIN'
)
ON CONFLICT (id) DO NOTHING;

-- ---- 5. Physical tables → randomized, non-guessable QR tokens --------
-- /table/k7x2p, /table/m9b3x, … (never sequential integers — docs/2).
INSERT INTO restaurant_tables (id, code, name, status) VALUES
  ('8c3b9b4f-8012-4f35-90d1-0f796d11f181', 'k7x2p', 'Window four-top',  'empty'),
  ('5f9e1d2c-7b6a-4c3d-9e8f-0a1b2c3d4e5f', 'm9b3x', 'High-top two',     'empty'),
  ('2d4e6f80-1a3b-4c5d-8e9f-0a1b2c3d4e5f', 'm3q8z', 'Corner booth',     'empty'),
  ('b7a6c5d4-e3f2-4b1a-8c9d-0e1f2a3b4c5d', 'v9w1s', 'Communal table',   'empty'),
  ('9c8b7a6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d', 't6r4y', 'Garden six-top',   'empty')
ON CONFLICT (id) DO NOTHING;

-- ---- 20. Realistic Indian menu items (prices in ₹) -------------------
-- Metadata columns come from sql/015_menu_item_metadata.sql. The seed carries
-- the same curated values so a FRESH database (migrations run before seed.sql)
-- starts with them; 015 backfills existing installations.
INSERT INTO menu_items (
  id, name, price, category, is_available, description, vegetarian,
  ingredients, spice_level, allergens, diet_tags, portion_description
) VALUES
  -- Main Course
  ('a1b2c3d4-e5f6-7a8b-9c0d-1e2f3a4b5c6d', 'Masala Dosa',         180.00, 'Main Course', true, 'Crisp rice crepe, potato masala, coconut chutney.',            true,
   ARRAY['rice','urad dal','potato','mustard seeds','curry leaves','coconut']::text[], 1, ARRAY['coconut']::text[], ARRAY[]::text[], '1 dosa with chutney'),
  ('f6e5d4c3-b2a1-0f9e-8d7c-6b5a4f3e2d1c', 'Paneer Butter Masala', 320.00, 'Main Course', true, 'Paneer in a slow-cooked tomato and cashew gravy.',             true,
   ARRAY['paneer','tomato','cashew','butter','cream','spices']::text[], 1, ARRAY['dairy','nuts']::text[], ARRAY[]::text[], 'serves 1–2'),
  ('5e4d3c2b-1a0f-4e8d-7c6b-5a4f3e2d1c0b', 'Veg Noodles',          240.00, 'Main Course', true, 'Wok-tossed noodles with seasonal vegetables.',                 true,
   ARRAY['wheat noodles','mixed vegetables','soy sauce','oil']::text[], 2, ARRAY['gluten','soy']::text[], ARRAY[]::text[], 'serves 1'),
  ('3c7d2e19-5b48-4f6a-9d21-8e6c0a7f4b12', 'Hyderabadi Biryani',   380.00, 'Main Course', true, 'Dum-cooked basmati, saffron, fried onions, raita.',            false,
   ARRAY['basmati rice','chicken','yogurt','saffron','fried onions','spices']::text[], 3, ARRAY['dairy']::text[], ARRAY[]::text[], 'serves 1'),
  ('3d4e5f6a-7b8c-4d9e-8f2a-1b0c9d8e7f6a', 'Palak Paneer',         290.00, 'Main Course', true, 'Cottage cheese simmered in garlic-spinach gravy.',              true,
   ARRAY['paneer','spinach','garlic','cream','spices']::text[], 1, ARRAY['dairy']::text[], ARRAY[]::text[], 'serves 1'),
  ('1e2d3c4b-5a6f-4b7c-8d9e-0f1a2b3c4d5e', 'Chole Bhature',        180.00, 'Main Course', true, 'Punjabi chickpea curry with fluffy fried bhature.',            true,
   ARRAY['chickpeas','refined flour','yogurt','spices','oil']::text[], 2, ARRAY['gluten','dairy']::text[], ARRAY[]::text[], 'serves 1'),
  -- Starters
  ('9f8e7d6c-5b4a-4c2d-9e0f-a9b8c7d6e5f4', 'Masala Tacos',         260.00, 'Starters',    true, 'Three soft tacos, cumin slaw, smoked chilli.',                 true,
   ARRAY['corn tortilla','cumin slaw','smoked chilli','salsa']::text[], 3, ARRAY[]::text[], ARRAY[]::text[], '3 tacos'),
  ('4a5b6c7d-8e9f-4a1b-ac3d-4e5f6a7b8c9d', 'Chhotu Burger',        290.00, 'Starters',    true, 'House patty, pickled onion, warm brioche bun.',                false,
   ARRAY['house patty','brioche bun','pickled onion','cheese','sauce']::text[], 1, ARRAY['gluten','dairy','egg']::text[], ARRAY[]::text[], 'serves 1'),
  ('7c8d9e0f-1a2b-4c4d-9e6f-7a8b9c0d1e2f', 'Onion Pakora',         160.00, 'Starters',    true, 'Crisp gram-flour fritters with mint chutney.',                 true,
   ARRAY['gram flour','onion','oil','mint chutney']::text[], 2, ARRAY[]::text[], ARRAY[]::text[], 'serves 1'),
  ('2c3d4e5f-6a7b-4c8d-9e1f-0a9b8c7d6e5f', 'Samosa Chaat',         150.00, 'Starters',    true, 'Crushed samosas, chickpeas, yogurt, tamarind chutney.',        true,
   ARRAY['samosa pastry','potato','peas','chickpeas','yogurt','tamarind chutney']::text[], 2, ARRAY['gluten','dairy']::text[], ARRAY[]::text[], 'serves 1'),
  -- Breads
  ('2b3c4d5e-6f7a-4b9c-8d1e-2f3a4b5c6d7e', 'Garlic Naan',           90.00, 'Breads',      true, 'Tandoor naan brushed with garlic butter.',                     true,
   ARRAY['refined flour','garlic','butter','yogurt']::text[], 1, ARRAY['gluten','dairy']::text[], ARRAY[]::text[], '1 naan'),
  ('8d9e0f1a-2b3c-4d5e-8f7a-8b9c0d1e2f3a', 'Tandoori Roti',         60.00, 'Breads',      true, 'Whole wheat roti straight off the tandoor.',                   true,
   ARRAY['whole wheat flour','water','salt']::text[], 0, ARRAY['gluten']::text[], ARRAY['jain']::text[], '1 roti'),
  ('f0e1d2c3-4b5a-4c6d-8e7f-9a0b1c2d3e4f', 'Butter Naan',           90.00, 'Breads',      true, 'Soft tandoor naan finished with a generous butter glaze.',     true,
   ARRAY['refined flour','butter','yogurt']::text[], 0, ARRAY['gluten','dairy']::text[], ARRAY[]::text[], '1 naan'),
  ('4e5f6a7b-8c9d-4e0f-9a3b-2c1d0e9f8a7b', 'Aloo Paratha',         110.00, 'Breads',      true, 'Stuffed potato flatbread with white butter and pickle.',       true,
   ARRAY['whole wheat flour','potato','butter','pickle']::text[], 1, ARRAY['gluten','dairy']::text[], ARRAY[]::text[], '2 parathas'),
  -- Drinks
  ('6f7a8b9c-0d1e-4f3a-8b5c-6d7e8f9a0b1c', 'Sweet Lassi',          120.00, 'Drinks',      true, 'Chilled hand-churned yogurt, rose, pistachio.',                true,
   ARRAY['yogurt','milk','rose','pistachio','sugar']::text[], 0, ARRAY['dairy','nuts']::text[], ARRAY['jain']::text[], '1 glass'),
  ('a2b3c4d5-e6f7-4a8b-9c0d-1e2f3a4b5c6d', 'Masala Chai',           70.00, 'Drinks',      true, 'Assam leaf tea, ginger, cardamom.',                            true,
   ARRAY['assam tea','milk','ginger','cardamom','sugar']::text[], 0, ARRAY['dairy']::text[], ARRAY[]::text[], '1 cup'),
  ('1b2c3d4e-5f6a-4b7c-9d0e-8f7a6b5c4d3e', 'Mango Lassi',          130.00, 'Drinks',      true, 'Alphonso mango blended with thick yogurt, cardamom.',          true,
   ARRAY['mango','yogurt','milk','cardamom','sugar']::text[], 0, ARRAY['dairy']::text[], ARRAY[]::text[], '1 glass'),
  ('6a7b8c9d-0e1f-4a2b-9c5d-4e3f2a1b0c9d', 'Filter Coffee',         60.00, 'Drinks',      true, 'South Indian decoction with frothed hot milk.',                true,
   ARRAY['coffee decoction','milk','sugar']::text[], 0, ARRAY['dairy']::text[], ARRAY['jain']::text[], '1 cup'),
  -- Desserts
  ('3e4f5a6b-7c8d-4e9f-8a1b-2c3d4e5f6a7b', 'Malai Kulfi',          140.00, 'Desserts',    true, 'Slow-reduced milk kulfi, saffron, almond.',                    true,
   ARRAY['milk','sugar','saffron','almond']::text[], 0, ARRAY['dairy','nuts']::text[], ARRAY['jain']::text[], '1 kulfi'),
  ('5f6a7b8c-9d0e-4f1a-8b4c-3d2e1f0a9b8c', 'Gulab Jamun',          120.00, 'Desserts',    true, 'Warm khoya dumplings in cardamom sugar syrup.',                true,
   ARRAY['khoya','refined flour','sugar','cardamom','ghee']::text[], 0, ARRAY['dairy','gluten']::text[], ARRAY['jain']::text[], '2 pieces')
ON CONFLICT (id) DO NOTHING;
