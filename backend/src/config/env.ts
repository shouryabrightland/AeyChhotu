import "dotenv/config";

/* Central env validation. This module fails loudly (clear message + exit 1)
   the moment a required variable is missing, so a misconfigured server never
   starts half-working. */

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    console.error(
      [
        `[config] FATAL: required environment variable "${name}" is missing or empty.`,
        `[config] Copy backend/.env.example to backend/.env and fill it in.`,
        `[config] Server refusing to start.`,
      ].join("\n"),
    );
    process.exit(1);
  }
  return value;
}

function requirePin(name: string): string {
  const pin = process.env[name]?.trim();
  if (!pin || !/^\d{4,6}$/.test(pin)) {
    console.error(
      [
        `[config] FATAL: ${name} must be a 4-6 digit numeric string — it is missing or invalid.`,
        `[config] Copy backend/.env.example to backend/.env and fill it in.`,
        `[config] Server refusing to start.`,
      ].join("\n"),
    );
    process.exit(1);
  }
  return pin;
}

/* Both PINs are the same shape and both fail the same way. They are kept as
   two separate calls so the error names the variable that is actually wrong,
   which is the difference between a one-minute fix and a hunt. */
function requireStaffPin(): string {
  return requirePin("STAFF_PIN");
}

/** Owner/manager console PIN. Deliberately NOT the staff PIN: the admin
    console can archive tables and rewrite the catalog, so a line cook who
    knows the kitchen PIN must not be able to open it. */
function requireAdminPin(): string {
  return requirePin("ADMIN_PIN");
}

const portRaw = process.env.PORT ?? "4000";
const port = Number(portRaw);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  console.error(`[config] FATAL: PORT must be a valid TCP port number, got "${portRaw}".`);
  process.exit(1);
}

/* CLIENT_URL is the CORS allow-list. A single origin is the common case
   (same domain behind one reverse proxy); a comma-separated list covers
   "Next.js on one host, API on another" — e.g. Vercel preview URLs plus the
   production domain. Trailing slashes are stripped because a browser's
   Origin header never carries one, so `https://x.com/` would never match. */
function parseOrigins(raw: string): string[] {
  return raw
    .split(",")
    .map((origin) => origin.trim().replace(/\/+$/, ""))
    .filter(Boolean);
}

const clientUrls = parseOrigins(requireEnv("CLIENT_URL"));
if (clientUrls.length === 0) {
  console.error("[config] FATAL: CLIENT_URL must list at least one origin.");
  process.exit(1);
}

/* Cookie scope for the httpOnly kds_token issued by E2.
     strict (default) — frontend and API share a site; the cookie is never
                        sent cross-site, which is the safest default.
     lax               — top-level navigations may carry it.
     none              — required when the API lives on a DIFFERENT site than
                        the frontend (e.g. Vercel app + *.onrender.com API).
                        Browsers reject `SameSite=None` without `Secure`,
                        so that combination is enforced below. */
const SAME_SITE_VALUES = ["strict", "lax", "none"] as const;
type SameSiteValue = (typeof SAME_SITE_VALUES)[number];

const sameSiteRaw = (process.env.COOKIE_SAME_SITE ?? "strict").trim().toLowerCase();
if (!SAME_SITE_VALUES.includes(sameSiteRaw as SameSiteValue)) {
  console.error(
    `[config] FATAL: COOKIE_SAME_SITE must be one of ${SAME_SITE_VALUES.join(", ")}, got "${sameSiteRaw}".`,
  );
  process.exit(1);
}
const cookieSameSite = sameSiteRaw as SameSiteValue;

const nodeEnv = process.env.NODE_ENV ?? "development";

/* Secure is mandatory in production, and mandatory for SameSite=None in ANY
   environment because browsers silently drop the cookie otherwise. */
const cookieSecure = nodeEnv === "production" || cookieSameSite === "none";

export const env = {
  nodeEnv,
  port,
  /** First allow-listed origin — used for logging and back-compat. */
  clientUrl: clientUrls[0] as string,
  /** Every origin allowed by CORS (CLIENT_URL, comma-separated). */
  clientUrls,
  /** SameSite attribute for the kds_token cookie. */
  cookieSameSite: (cookieSameSite.charAt(0).toUpperCase() + cookieSameSite.slice(1)) as
    | "Strict"
    | "Lax"
    | "None",
  /** Adds `Secure` to the kds_token cookie (forces HTTPS-only transport). */
  cookieSecure,
  /** Postgres/Supabase connection string — fails loudly if missing. */
  databaseUrl: requireEnv("DATABASE_URL"),
  /** Kitchen shift PIN checked by POST /api/v1/auth/kds-login (E2). */
  staffPin: requireStaffPin(),
  /** Executive console PIN checked by POST /api/v1/auth/admin-login. */
  adminPin: requireAdminPin(),
  /** HMAC secret used to sign/verify the KDS bearer tokens issued by E2. */
  kdsTokenSecret: requireEnv("KDS_TOKEN_SECRET"),
  /** Supabase JWT secret (Project Settings → API). Optional: when set, E1/E2
      also issue a Supabase-scoped read token whose claims the RLS policies
      in sql/001_init.sql scope per table (diner: table_token, staff: staff).
      Without it no realtime token is issued and Realtime runs REST-only. */
  supabaseJwtSecret: process.env.SUPABASE_JWT_SECRET?.trim() || null,
  /* Google Gemini API key for the client-side "Ask Chhotu" assistant.

     The backend never calls Gemini. It holds this key for exactly one reason:
     to hand it to a device that has PROVEN it belongs to a table (initialize
     on an empty table, join-pin, join-pass, or reconnect). It is therefore
     never in the JS bundle and never in a pre-join payload — the locked scan
     reply carries no credentials at all.

     OPTIONAL on purpose: the rest of the app must keep working without it, so
     a missing key degrades the assistant only (the client hides it) instead of
     refusing to boot. This value is the single source; the client never reads
     NEXT_PUBLIC_* for it. */
  geminiApiKey: process.env.GEMINI_API_KEY?.trim() || null,
} as const;
