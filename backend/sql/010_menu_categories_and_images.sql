-- =====================================================================
-- AeyChhotu! — 010_menu_categories_and_images.sql
--
-- Two catalogue upgrades that belong together:
--
--   1. FOLDERS. `menu_items.category` was a free-text label. It stays for
--      backwards compatibility (the diner contract groups on it), but the
--      source of truth becomes `menu_categories`: a real tree with a
--      parent_id, an order, and a thumbnail chosen from a dish's photo.
--      Existing labels are migrated to root folders, so a running install
--      opens the new explorer already organised.
--
--   2. PHOTOS. One row per dish in `menu_item_images` holds the three
--      derivatives every card needs — original, small, 50×50 tiny — plus the
--      tiny as a data URL for the blur-up placeholder. Bytes live either in
--      `menu_image_objects` (the self-contained default) or in Supabase
--      Storage when the deployment configures it; the driver column records
--      which, so a later switch never has to guess how to delete an object.
--
-- Everything here is idempotent: db:setup may be run on an existing install.
-- =====================================================================

CREATE TABLE IF NOT EXISTS menu_categories (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name          text NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 60),
  parent_id     uuid REFERENCES menu_categories(id) ON DELETE RESTRICT,
  /* The folder's cover art: one of its own dishes, never a separate upload. */
  thumbnail_menu_item_id uuid REFERENCES menu_items(id) ON DELETE SET NULL,
  sort_order    integer NOT NULL DEFAULT 0,
  created_at    timestamptz NOT NULL DEFAULT now(),
  deleted_at    timestamptz
);

/* Sibling names are unique, case-insensitively, among live folders. The
   coalesce() gives root folders a fixed sentinel parent so (parent_id IS NULL)
   participates in the unique index. */
CREATE UNIQUE INDEX IF NOT EXISTS menu_categories_sibling_name_idx
  ON menu_categories (
    lower(name),
    coalesce(parent_id, '00000000-0000-0000-0000-000000000000'::uuid)
  )
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS menu_categories_parent_idx
  ON menu_categories (parent_id, sort_order, name)
  WHERE deleted_at IS NULL;

ALTER TABLE menu_items
  ADD COLUMN IF NOT EXISTS category_id uuid REFERENCES menu_categories(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS menu_items_category_id_idx
  ON menu_items (category_id)
  WHERE deleted_at IS NULL;

/* ---- Migrate existing labels into root folders ---------------------- */

INSERT INTO menu_categories (name)
SELECT DISTINCT trim(mi.category)
  FROM menu_items mi
 WHERE mi.deleted_at IS NULL
   AND trim(mi.category) <> ''
   AND NOT EXISTS (
         SELECT 1
           FROM menu_categories c
          WHERE c.parent_id IS NULL
            AND c.deleted_at IS NULL
            AND lower(c.name) = lower(trim(mi.category))
       );

UPDATE menu_items mi
   SET category_id = c.id
  FROM menu_categories c
 WHERE mi.category_id IS NULL
   AND mi.deleted_at IS NULL
   AND c.parent_id IS NULL
   AND c.deleted_at IS NULL
   AND lower(c.name) = lower(trim(mi.category));

/* ---- Dish photos ---------------------------------------------------- */

CREATE TABLE IF NOT EXISTS menu_item_images (
  menu_item_id  uuid PRIMARY KEY REFERENCES menu_items(id) ON DELETE CASCADE,
  /* 'postgres' stores the bytes in menu_image_objects; 'supabase' stores them
     in the configured Storage bucket under the same keys. */
  storage_driver text NOT NULL DEFAULT 'postgres'
                 CHECK (storage_driver IN ('postgres', 'supabase')),
  original_key  text NOT NULL,
  small_key     text NOT NULL,
  tiny_key      text NOT NULL,
  content_type  text NOT NULL,
  width         integer NOT NULL CHECK (width > 0),
  height        integer NOT NULL CHECK (height > 0),
  size_bytes    integer NOT NULL CHECK (size_bytes > 0),
  /* The 50×50 WebP as a data URL. Inline so the blur appears with the card,
     not after a second round trip on the connection that is already slow. */
  blur_data_url text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS menu_image_objects (
  storage_key   text PRIMARY KEY,
  content_type  text NOT NULL,
  bytes         bytea NOT NULL,
  size_bytes    integer NOT NULL CHECK (size_bytes > 0),
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS menu_image_objects_created_idx
  ON menu_image_objects (created_at);

/* Backend-only data: the API reads it as the database owner (RLS bypassed),
   while the browser roles — anon/authenticated — must never see raw bytes or
   the folder tree outside the menu contract. */
ALTER TABLE menu_categories    ENABLE ROW LEVEL SECURITY;
ALTER TABLE menu_item_images   ENABLE ROW LEVEL SECURITY;
ALTER TABLE menu_image_objects ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    EXECUTE 'REVOKE ALL ON TABLE menu_categories, menu_item_images, menu_image_objects FROM anon';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    EXECUTE 'REVOKE ALL ON TABLE menu_categories, menu_item_images, menu_image_objects FROM authenticated';
  END IF;
END $$;
