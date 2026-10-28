import { pool } from "../db/pool.js";
import { AppError } from "../errors/app-error.js";
import {
  imageDtoFromRow,
  type MenuImageDto,
} from "./menu-image.service.js";

/* Catalogue folders — the menu console's file explorer.

   `menu_categories` is a real tree: a folder may contain child folders and
   dishes, and its cover is one of its own dishes' photos (no separate upload
   to keep in sync). Names are unique among live siblings, so the explorer can
   never show two identical folders next to each other.

   DELETING A FOLDER IS ARCHIVING IT. A folder with live children or live
   dishes is refused rather than silently orphaning them: the operator moves
   or archives the contents first. Nothing is ever hard-deleted, so history
   keeps pointing at the same rows. */

export interface CategoryDto {
  category_id: string;
  name: string;
  parent_id: string | null;
  sort_order: number;
  item_count: number;
  thumbnail_menu_item_id: string | null;
  thumbnail: MenuImageDto | null;
}

interface CategoryRow {
  id: string;
  name: string;
  parent_id: string | null;
  sort_order: number;
  item_count: number;
  thumbnail_menu_item_id: string | null;
  image_item_id: string | null;
  storage_driver: string | null;
  original_key: string | null;
  small_key: string | null;
  tiny_key: string | null;
  blur_data_url: string | null;
}

function categoryDto(row: CategoryRow): CategoryDto {
  return {
    category_id: row.id,
    name: row.name,
    parent_id: row.parent_id,
    sort_order: row.sort_order,
    item_count: row.item_count,
    thumbnail_menu_item_id: row.thumbnail_menu_item_id,
    thumbnail:
      row.image_item_id && row.storage_driver && row.original_key && row.small_key && row.tiny_key
        ? imageDtoFromRow({
            menu_item_id: row.image_item_id,
            storage_driver: row.storage_driver,
            original_key: row.original_key,
            small_key: row.small_key,
            tiny_key: row.tiny_key,
            blur_data_url: row.blur_data_url ?? "",
          })
        : null,
  };
}

const CATEGORY_SELECT = `
  SELECT c.id,
         c.name,
         c.parent_id,
         c.sort_order,
         c.thumbnail_menu_item_id,
         (SELECT count(*)::int
            FROM menu_items mi
           WHERE mi.category_id = c.id
             AND mi.deleted_at IS NULL) AS item_count,
         i.menu_item_id AS image_item_id,
         i.storage_driver,
         i.original_key,
         i.small_key,
         i.tiny_key,
         i.blur_data_url
    FROM menu_categories c
    LEFT JOIN menu_item_images i ON i.menu_item_id = c.thumbnail_menu_item_id
`;

/* GET /api/v1/admin/categories */
export async function listCategories(): Promise<CategoryDto[]> {
  const res = await pool.query<CategoryRow>(
    `${CATEGORY_SELECT}
      WHERE c.deleted_at IS NULL
      ORDER BY c.sort_order, lower(c.name)`,
  );
  return res.rows.map(categoryDto);
}

/* GET /api/v1/categories — the diner-facing tree (names only, no photos of
   archived dishes leaking out). */
export async function listPublicCategories(): Promise<
  { category_id: string; name: string; parent_id: string | null; sort_order: number }[]
> {
  const res = await pool.query<{
    id: string;
    name: string;
    parent_id: string | null;
    sort_order: number;
  }>(
    `SELECT id, name, parent_id, sort_order
       FROM menu_categories
      WHERE deleted_at IS NULL
      ORDER BY sort_order, lower(name)`,
  );

  return res.rows.map((row) => ({
    category_id: row.id,
    name: row.name,
    parent_id: row.parent_id,
    sort_order: row.sort_order,
  }));
}

function duplicateCategory(): never {
  throw new AppError(
    409,
    "CATEGORY_EXISTS",
    "A folder with that name already exists in this folder.",
  );
}

async function loadCategory(id: string): Promise<{ id: string; name: string; parent_id: string | null }> {
  const res = await pool.query<{ id: string; name: string; parent_id: string | null }>(
    "SELECT id, name, parent_id FROM menu_categories WHERE id = $1 AND deleted_at IS NULL",
    [id],
  );
  const row = res.rows[0];
  if (!row) throw new AppError(404, "CATEGORY_NOT_FOUND", "Unknown folder.");
  return row;
}

/** True when `candidateParent` is `id` itself or one of its descendants. */
async function wouldCycle(id: string, candidateParent: string): Promise<boolean> {
  const res = await pool.query<{ id: string }>(
    `WITH RECURSIVE ancestry AS (
       SELECT id, parent_id FROM menu_categories WHERE id = $1 AND deleted_at IS NULL
       UNION ALL
       SELECT c.id, c.parent_id
         FROM menu_categories c
         JOIN ancestry a ON c.id = a.parent_id
        WHERE c.deleted_at IS NULL
     )
     SELECT id FROM ancestry WHERE id = $2`,
    [candidateParent, id],
  );
  return res.rows.length > 0;
}

async function assertThumbnailInCategory(menuItemId: string, categoryId: string): Promise<void> {
  const res = await pool.query<{ ok: boolean }>(
    `WITH RECURSIVE subtree AS (
       SELECT id FROM menu_categories WHERE id = $1 AND deleted_at IS NULL
       UNION ALL
       SELECT c.id
         FROM menu_categories c
         JOIN subtree s ON c.parent_id = s.id
        WHERE c.deleted_at IS NULL
     )
     SELECT true AS ok
       FROM menu_items mi
      WHERE mi.id = $2
        AND mi.deleted_at IS NULL
        AND mi.category_id IN (SELECT id FROM subtree)`,
    [categoryId, menuItemId],
  );

  if (!res.rows[0]) {
    throw new AppError(
      400,
      "CATEGORY_THUMBNAIL_INVALID",
      "Pick a dish that lives in this folder or one of its subfolders.",
    );
  }
}

/* POST /api/v1/admin/categories */
export async function createCategory(input: {
  name: string;
  parent_id?: string | null;
}): Promise<CategoryDto> {
  const name = input.name.trim();
  if (!name) {
    throw new AppError(400, "VALIDATION_ERROR", "Request payload failed validation.", {
      fields: { name: "Give the folder a name." },
    });
  }

  if (input.parent_id) {
    await loadCategory(input.parent_id);
  }

  try {
    const res = await pool.query<{ id: string }>(
      `INSERT INTO menu_categories (name, parent_id, sort_order)
            VALUES (
              $1,
              $2,
              COALESCE((SELECT max(sort_order) + 1
                          FROM menu_categories
                         WHERE parent_id IS NOT DISTINCT FROM $2
                           AND deleted_at IS NULL), 0)
            )
         RETURNING id`,
      [name, input.parent_id ?? null],
    );

    const id = res.rows[0]?.id;
    if (!id) throw new AppError(500, "INTERNAL_ERROR", "The folder could not be created.");

    const list = await listCategories();
    const created = list.find((entry) => entry.category_id === id);
    if (!created) throw new AppError(500, "INTERNAL_ERROR", "The folder could not be read back.");
    return created;
  } catch (err) {
    if (typeof err === "object" && err !== null && (err as { code?: string }).code === "23505") {
      duplicateCategory();
    }
    throw err;
  }
}

/* PATCH /api/v1/admin/categories/:category_id */
export async function updateCategory(
  categoryId: string,
  input: {
    name?: string;
    parent_id?: string | null;
    sort_order?: number;
    thumbnail_menu_item_id?: string | null;
  },
): Promise<CategoryDto> {
  const current = await loadCategory(categoryId);

  if (input.parent_id !== undefined && input.parent_id !== null) {
    if (input.parent_id === categoryId) {
      throw new AppError(400, "CATEGORY_CYCLE", "A folder cannot be its own parent.");
    }
    await loadCategory(input.parent_id);
    if (await wouldCycle(categoryId, input.parent_id)) {
      throw new AppError(400, "CATEGORY_CYCLE", "That move would put a folder inside itself.");
    }
  }

  if (input.thumbnail_menu_item_id) {
    await assertThumbnailInCategory(input.thumbnail_menu_item_id, categoryId);
  }

  const name = input.name !== undefined ? input.name.trim() : undefined;
  if (name === "") {
    throw new AppError(400, "VALIDATION_ERROR", "Request payload failed validation.", {
      fields: { name: "The folder name cannot be empty." },
    });
  }

  try {
    await pool.query(
      `UPDATE menu_categories
          SET name                    = COALESCE($2, name),
              parent_id               = CASE WHEN $3::boolean THEN $4 ELSE parent_id END,
              sort_order              = COALESCE($5, sort_order),
              thumbnail_menu_item_id  = CASE WHEN $6::boolean THEN $7 ELSE thumbnail_menu_item_id END
        WHERE id = $1 AND deleted_at IS NULL`,
      [
        categoryId,
        name ?? null,
        input.parent_id !== undefined,
        input.parent_id ?? null,
        input.sort_order ?? null,
        input.thumbnail_menu_item_id !== undefined,
        input.thumbnail_menu_item_id ?? null,
      ],
    );

    /* Keep the legacy text label in step with the folder name, so a client
       that only understands `category` still groups dishes correctly. */
    if (name !== undefined && name !== current.name) {
      await pool.query(
        `UPDATE menu_items
            SET category = $2
          WHERE category_id = $1 AND deleted_at IS NULL`,
        [categoryId, name],
      );
    }
  } catch (err) {
    if (typeof err === "object" && err !== null && (err as { code?: string }).code === "23505") {
      duplicateCategory();
    }
    throw err;
  }

  const list = await listCategories();
  const updated = list.find((entry) => entry.category_id === categoryId);
  if (!updated) throw new AppError(404, "CATEGORY_NOT_FOUND", "Unknown folder.");
  return updated;
}

/* DELETE /api/v1/admin/categories/:category_id — archive, and only when empty. */
export async function deleteCategory(categoryId: string): Promise<{ category_id: string }> {
  await loadCategory(categoryId);

  const usage = await pool.query<{ children: number; items: number }>(
    `SELECT
       (SELECT count(*)::int
          FROM menu_categories
         WHERE parent_id = $1 AND deleted_at IS NULL) AS children,
       (SELECT count(*)::int
          FROM menu_items
         WHERE category_id = $1 AND deleted_at IS NULL) AS items`,
    [categoryId],
  );
  const row = usage.rows[0];

  if ((row?.children ?? 0) > 0 || (row?.items ?? 0) > 0) {
    throw new AppError(
      409,
      "CATEGORY_NOT_EMPTY",
      "This folder still holds dishes or subfolders. Move or archive them first.",
    );
  }

  await pool.query(
    "UPDATE menu_categories SET deleted_at = now(), thumbnail_menu_item_id = NULL WHERE id = $1",
    [categoryId],
  );

  return { category_id: categoryId };
}

/* ---- Write-path helpers shared with the menu CRUD ------------------- */

export interface CategoryAssignment {
  category_id: string | null;
  category: string;
}

/** Resolve the folder a dish write should land in.

    A client may send a folder id (the explorer), a label (the old contract)
    or both. A label with no folder is matched to a root folder
    case-insensitively, and created when it is new — otherwise a dish created
    through the legacy form would be invisible in the explorer. */
export async function resolveCategoryForWrite(input: {
  category_id?: string | null;
  category?: string;
}): Promise<CategoryAssignment> {
  if (input.category_id) {
    const res = await pool.query<{ id: string; name: string }>(
      "SELECT id, name FROM menu_categories WHERE id = $1 AND deleted_at IS NULL",
      [input.category_id],
    );
    const row = res.rows[0];
    if (!row) throw new AppError(404, "CATEGORY_NOT_FOUND", "Unknown folder.");
    return { category_id: row.id, category: row.name };
  }

  const label = (input.category ?? "").trim();
  if (!label) {
    return { category_id: null, category: "Main Course" };
  }

  const existing = await pool.query<{ id: string; name: string }>(
    `SELECT id, name
       FROM menu_categories
      WHERE parent_id IS NULL
        AND deleted_at IS NULL
        AND lower(name) = lower($1)
      LIMIT 1`,
    [label],
  );
  const row = existing.rows[0];
  if (row) return { category_id: row.id, category: row.name };

  try {
    const created = await pool.query<{ id: string; name: string }>(
      `INSERT INTO menu_categories (name)
            VALUES ($1)
         RETURNING id, name`,
      [label],
    );
    const made = created.rows[0];
    if (made) return { category_id: made.id, category: made.name };
  } catch (err) {
    if (typeof err === "object" && err !== null && (err as { code?: string }).code === "23505") {
      const raced = await pool.query<{ id: string; name: string }>(
        `SELECT id, name FROM menu_categories
          WHERE parent_id IS NULL AND deleted_at IS NULL AND lower(name) = lower($1)
          LIMIT 1`,
        [label],
      );
      const found = raced.rows[0];
      if (found) return { category_id: found.id, category: found.name };
    }
    throw err;
  }

  return { category_id: null, category: label };
}
