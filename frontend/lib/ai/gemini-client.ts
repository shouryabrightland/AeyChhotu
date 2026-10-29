/* Browser Gemini client for Chhotu.

   NO KEY IN THE BUNDLE. The key is not a NEXT_PUBLIC_* constant any more: the
   backend releases it with the table credentials, so a device only holds one
   after it has PROVEN it belongs to a table (POST /sessions/initialize on an
   empty table, /join-pin, /join-pass, or /reconnect). An anonymous visitor to
   the site gets nothing, and a scan of a live table answers `locked` with no
   credentials at all.

   TRADE-OFF, stated plainly: every guest who joins the table can still read
   the key from the network tab, so the deployment key must be RESTRICTED
   (HTTP-referrer + API restrictions) and quota-capped. See
   backend/src/config/env.ts (GEMINI_API_KEY) for the server side of this.

   The client is cached per key because the sheet asks for it on every send. */

import { GoogleGenAI } from "@google/genai";

let cached: { apiKey: string; client: GoogleGenAI } | null = null;

/** True when this device's granted session carried a key. */
export function isChhotuConfigured(apiKey: string | null | undefined): boolean {
  return typeof apiKey === "string" && apiKey.trim().length > 0;
}

/** A client for the session's key, or null when the deployment has none. */
export function getChhotuClient(apiKey: string | null | undefined): GoogleGenAI | null {
  const trimmed = apiKey?.trim() ?? "";
  if (!trimmed) return null;

  if (cached?.apiKey !== trimmed) {
    cached = { apiKey: trimmed, client: new GoogleGenAI({ apiKey: trimmed }) };
  }
  return cached.client;
}
