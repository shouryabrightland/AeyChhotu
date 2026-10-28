import { randomUUID } from "node:crypto";
import sharp from "sharp";
import { pool } from "../db/pool.js";
import { AppError } from "../errors/app-error.js";

/* Dish photography — processing and storage.

   One upload produces the three files a menu card actually needs:

     original  1600px WebP  — the plate at full quality
     small      480px WebP  — the card image
     tiny        50px WebP  — the blur-up placeholder, also inlined as a data
                              URL so the blur is painted with the card instead
                              of after another round trip on a slow phone

   Every byte is re-encoded and stripped of metadata. That is deliberate:
   a camera JPEG carries GPS and orientation, and an uploaded SVG/HTML hybrid
   is an XSS vector. Only JPEG, PNG, WebP and AVIF pass, sniffed from the
   magic bytes rather than trusted from the Content-Type header.

   Storage: `menu_image_objects` (bytea) by default — durable on a host with
   an ephemeral disk. A deployment that sets IMAGE_STORAGE=supabase plus a
   project URL, service-role key and bucket stores the same keys in Supabase
   Storage instead; the driver is recorded per image so deletion never has to
   guess where an object lives. */

export type ImageSize = "original" | "small" | "tiny";

export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
/** 24 MP: larger than any phone camera this app will see, and below the
    point where a crafted file can exhaust memory during decode. */
const MAX_INPUT_PIXELS = 24_000_000;
const MIN_EDGE = 64;

const SUPABASE_URL = (process.env.SUPABASE_URL ?? "").replace(/\/+$/, "");
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
const SUPABASE_BUCKET = process.env.SUPABASE_MENU_BUCKET ?? "menu-images";
const WANT_SUPABASE = (process.env.IMAGE_STORAGE ?? "").toLowerCase() === "supabase";
const SUPABASE_READY = Boolean(SUPABASE_URL && SUPABASE_SERVICE_KEY);
const DRIVER: "postgres" | "supabase" = WANT_SUPABASE && SUPABASE_READY ? "supabase" : "postgres";

if (WANT_SUPABASE && !SUPABASE_READY) {
  console.warn(
    "[images] IMAGE_STORAGE=supabase but SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are missing — falling back to Postgres storage.",
  );
}

const ACCEPTED = new Set(["image/jpeg", "image/png", "image/webp", "image/avif"]);

function invalid(message: string): never {
  throw new AppError(400, "INVALID_IMAGE", message);
}

/** Trust bytes, not headers. Returns the real mime or null. */
export function sniffImageType(buffer: Buffer): string | null {
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return "image/jpeg";
  }
  if (
    buffer.length >= 8 &&
    buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  ) {
    return "image/png";
  }
  if (
    buffer.length >= 12 &&
    buffer.toString("ascii", 0, 4) === "RIFF" &&
    buffer.toString("ascii", 8, 12) === "WEBP"
  ) {
    return "image/webp";
  }
  if (buffer.length >= 12 && buffer.toString("ascii", 4, 8) === "ftyp") {
    const brand = buffer.toString("ascii", 8, 12);
    if (brand === "avif" || brand === "avis") return "image/avif";
  }
  return null;
}

interface Derivatives {
  original: Buffer;
  small: Buffer;
  tiny: Buffer;
  width: number;
  height: number;
}

async function renderDerivatives(buffer: Buffer): Promise<Derivatives> {
  const source = () => sharp(buffer, { limitInputPixels: MAX_INPUT_PIXELS, failOn: "warning" }).rotate();

  const meta = await source().metadata();
  const width = meta.width ?? 0;
  const height = meta.height ?? 0;

  if (width === 0 || height === 0) invalid("That file is not a readable image.");
  if (Math.min(width, height) < MIN_EDGE) {
    invalid(`Use an image at least ${MIN_EDGE}×${MIN_EDGE} pixels.`);
  }

  const original = await source()
    .resize({ width: 1600, height: 1600, fit: "inside", withoutEnlargement: true })
    .webp({ quality: 86, effort: 4 })
    .toBuffer({ resolveWithObject: true });

  const small = await source()
    .resize({ width: 480, height: 480, fit: "inside", withoutEnlargement: true })
    .webp({ quality: 78, effort: 4 })
    .toBuffer();

  const tiny = await source()
    .resize(50, 50, { fit: "cover", position: "centre" })
    .webp({ quality: 62, effort: 4 })
    .toBuffer();

  return {
    original: original.data,
    small,
    tiny,
    width: original.info.width,
    height: original.info.height,
  };
}

/* ---- Object storage ------------------------------------------------- */

async function putObject(key: string, buffer: Buffer, contentType: string): Promise<void> {
  if (DRIVER === "supabase") {
    const res = await fetch(
      `${SUPABASE_URL}/storage/v1/object/${encodeURIComponent(SUPABASE_BUCKET)}/${key}`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
          "Content-Type": contentType,
          "Cache-Control": "31536000",
          "x-upsert": "true",
        },
        body: buffer,
      },
    );

    if (!res.ok) {
      throw new AppError(
        502,
        "IMAGE_STORAGE_ERROR",
        "The photo could not be saved to the image bucket.",
      );
    }
    return;
  }

  await pool.query(
    `INSERT INTO menu_image_objects (storage_key, content_type, bytes, size_bytes)
          VALUES ($1, $2, $3, $4)
     ON CONFLICT (storage_key) DO UPDATE
            SET content_type = EXCLUDED.content_type,
                bytes        = EXCLUDED.bytes,
                size_bytes   = EXCLUDED.size_bytes,
                created_at   = now()`,
    [key, contentType, buffer, buffer.length],
  );
}

async function deleteObjects(keys: string[]): Promise<void> {
  const unique = [...new Set(keys.filter(Boolean))];
  if (unique.length === 0) return;

  try {
    if (DRIVER === "supabase") {
      const res = await fetch(
        `${SUPABASE_URL}/storage/v1/object/${encodeURIComponent(SUPABASE_BUCKET)}`,
        {
          method: "DELETE",
          headers: {
            Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ prefixes: unique }),
        },
      );
      if (!res.ok) throw new Error(`storage delete ${res.status}`);
      return;
    }

    await pool.query("DELETE FROM menu_image_objects WHERE storage_key = ANY($1::text[])", [unique]);
  } catch (err) {
    /* Best effort: an orphaned object wastes bytes but never corrupts the
       menu. The database row is the source of truth for what exists. */
    console.error("[images] could not delete old objects", err);
  }
}

function publicUrl(key: string, menuItemId: string, size: ImageSize): string {
  if (DRIVER === "supabase") {
    return `${SUPABASE_URL}/storage/v1/object/public/${encodeURIComponent(SUPABASE_BUCKET)}/${key}`;
  }
  /* Relative: the browser joins it to NEXT_PUBLIC_API_URL. Keeping the host
     out of the database means the same row works on localhost, a LAN IP and
     the deployed API. */
  return `/api/v1/menu/items/${menuItemId}/image/${size}`;
}

/* ---- Public contract ------------------------------------------------- */

export interface MenuImageDto {
  image_url: string;
  image_small_url: string;
  blur_data_url: string;
}

export interface MenuImageRow {
  menu_item_id: string;
  storage_driver: string;
  original_key: string;
  small_key: string;
  tiny_key: string;
  content_type: string;
  width: number;
  height: number;
  size_bytes: number;
  blur_data_url: string;
}

export function imageDtoFromRow(row: {
  menu_item_id: string;
  storage_driver: string;
  original_key: string;
  small_key: string;
  tiny_key: string;
  blur_data_url: string;
}): MenuImageDto {
  const driver = row.storage_driver === "supabase" ? "supabase" : "postgres";
  const url = (key: string, size: ImageSize) =>
    driver === "supabase"
      ? `${SUPABASE_URL}/storage/v1/object/public/${encodeURIComponent(SUPABASE_BUCKET)}/${key}`
      : `/api/v1/menu/items/${row.menu_item_id}/image/${size}`;

  return {
    image_url: url(row.original_key, "original"),
    image_small_url: url(row.small_key, "small"),
    blur_data_url: row.blur_data_url,
  };
}

/** POST /api/v1/admin/menu/:menu_item_id/image (raw body). */
export async function replaceMenuItemImage(
  menuItemId: string,
  buffer: Buffer,
  declaredType: string,
): Promise<MenuImageDto & { width: number; height: number; size_bytes: number }> {
  if (buffer.length === 0) {
    throw new AppError(400, "INVALID_IMAGE", "Attach an image file to upload.");
  }
  if (buffer.length > MAX_IMAGE_BYTES) {
    throw new AppError(413, "IMAGE_TOO_LARGE", "Photos must be 8 MB or smaller.");
  }

  const sniffed = sniffImageType(buffer);
  if (!sniffed || !ACCEPTED.has(sniffed)) {
    invalid("Use a JPEG, PNG, WebP or AVIF photo.");
  }
  const declared = declaredType.split(";")[0]!.trim().toLowerCase();
  if (declared.startsWith("image/") && !ACCEPTED.has(declared)) {
    invalid("That file type is not supported.");
  }

  const item = await pool.query<{ id: string }>(
    "SELECT id FROM menu_items WHERE id = $1 AND deleted_at IS NULL",
    [menuItemId],
  );
  if (!item.rows[0]) {
    throw new AppError(404, "MENU_ITEM_NOT_FOUND", "Unknown menu item.");
  }

  let derivatives: Derivatives;
  try {
    derivatives = await renderDerivatives(buffer);
  } catch (err) {
    if (err instanceof AppError) throw err;
    invalid("That photo could not be read. Try another file.");
  }

  const previous = await pool.query<{ original_key: string; small_key: string; tiny_key: string }>(
    "SELECT original_key, small_key, tiny_key FROM menu_item_images WHERE menu_item_id = $1",
    [menuItemId],
  );
  const old = previous.rows[0];

  const stamp = `${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
  const keys = {
    original: `${menuItemId}/${stamp}-original.webp`,
    small: `${menuItemId}/${stamp}-small.webp`,
    tiny: `${menuItemId}/${stamp}-tiny.webp`,
  };

  try {
    await putObject(keys.original, derivatives.original, "image/webp");
    await putObject(keys.small, derivatives.small, "image/webp");
    await putObject(keys.tiny, derivatives.tiny, "image/webp");

    await pool.query(
      `INSERT INTO menu_item_images (
         menu_item_id, storage_driver, original_key, small_key, tiny_key,
         content_type, width, height, size_bytes, blur_data_url, updated_at
       ) VALUES ($1,$2,$3,$4,$5,'image/webp',$6,$7,$8,$9, now())
       ON CONFLICT (menu_item_id) DO UPDATE
         SET storage_driver = EXCLUDED.storage_driver,
             original_key   = EXCLUDED.original_key,
             small_key      = EXCLUDED.small_key,
             tiny_key       = EXCLUDED.tiny_key,
             content_type   = EXCLUDED.content_type,
             width          = EXCLUDED.width,
             height         = EXCLUDED.height,
             size_bytes     = EXCLUDED.size_bytes,
             blur_data_url  = EXCLUDED.blur_data_url,
             updated_at     = now()`,
      [
        menuItemId,
        DRIVER,
        keys.original,
        keys.small,
        keys.tiny,
        derivatives.width,
        derivatives.height,
        derivatives.original.length,
        `data:image/webp;base64,${derivatives.tiny.toString("base64")}`,
      ],
    );
  } catch (err) {
    // Nothing half-saved: a failed row write removes the objects it created.
    await deleteObjects([keys.original, keys.small, keys.tiny]);
    throw err;
  }

  if (old) {
    await deleteObjects([old.original_key, old.small_key, old.tiny_key]);
  }

  return {
    image_url: publicUrl(keys.original, menuItemId, "original"),
    image_small_url: publicUrl(keys.small, menuItemId, "small"),
    blur_data_url: `data:image/webp;base64,${derivatives.tiny.toString("base64")}`,
    width: derivatives.width,
    height: derivatives.height,
    size_bytes: derivatives.original.length,
  };
}

/** DELETE /api/v1/admin/menu/:menu_item_id/image */
export async function removeMenuItemImage(menuItemId: string): Promise<{ removed: boolean }> {
  const previous = await pool.query<{
    original_key: string;
    small_key: string;
    tiny_key: string;
  }>(
    `DELETE FROM menu_item_images
      WHERE menu_item_id = $1
      RETURNING original_key, small_key, tiny_key`,
    [menuItemId],
  );

  const row = previous.rows[0];
  if (!row) return { removed: false };

  await deleteObjects([row.original_key, row.small_key, row.tiny_key]);
  return { removed: true };
}

/** GET /api/v1/menu/items/:menu_item_id/image/:size — Postgres-backed bytes. */
export async function readMenuItemImage(
  menuItemId: string,
  size: ImageSize,
): Promise<{ bytes: Buffer; contentType: string } | null> {
  const image = await pool.query<{ storage_driver: string; original_key: string; small_key: string; tiny_key: string }>(
    "SELECT storage_driver, original_key, small_key, tiny_key FROM menu_item_images WHERE menu_item_id = $1",
    [menuItemId],
  );
  const row = image.rows[0];
  if (!row) return null;

  const key = size === "original" ? row.original_key : size === "small" ? row.small_key : row.tiny_key;

  /* A Supabase-backed row has no bytes here; its URLs point at the bucket. */
  if (row.storage_driver === "supabase") return null;

  const object = await pool.query<{ bytes: Buffer; content_type: string }>(
    "SELECT bytes, content_type FROM menu_image_objects WHERE storage_key = $1",
    [key],
  );
  const found = object.rows[0];
  if (!found) return null;

  return { bytes: found.bytes, contentType: found.content_type };
}
