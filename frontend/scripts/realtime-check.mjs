#!/usr/bin/env node
/* AeyChhotu! — Realtime end-to-end check.
 *
 * Realtime is the one part of the stack that can be "configured" and still
 * deliver nothing: the browser subscribes successfully, no error is raised,
 * and the app quietly falls back to REST polling. Every failure below looks
 * identical from the UI, so this script isolates them.
 *
 * Phases:
 *   0  E1 issues a realtime_token (skips cleanly when REST-only)
 *   1  Supabase ACCEPTS that token — verifies the signature algorithm and
 *      that SUPABASE_JWT_SECRET really belongs to this project
 *   2  channel A (table_carts) DELIVERS an INSERT to an authenticated client
 *   3  ...and does NOT deliver it to a client holding only the anon key
 *      (the RLS scoping claim, tested through Supabase rather than SQL)
 *   4  Presence (channel D) counts two devices at one table
 *
 * Usage:
 *   1. terminal A:  cd backend  && npm run dev
 *   2. terminal B:  cd frontend && npm run realtime:check
 *
 *   REALTIME_API_URL=http://localhost:4000   (default)
 */

import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";

// ---- env ------------------------------------------------------------------

/** Minimal .env reader — the frontend has no dotenv dependency. */
function loadEnvFile(path) {
  try {
    for (const line of readFileSync(path, "utf8").split("\n")) {
      const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*)$/);
      if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].trim();
    }
  } catch {
    /* absent file is fine — the caller may pass real env vars */
  }
}
loadEnvFile(new URL("../.env.local", import.meta.url).pathname);

const API = (process.env.REALTIME_API_URL ?? process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000")
  .replace(/\/+$/, "");
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const TABLE_TOKEN = "k7x2p";

let passed = 0;
const failures = [];

function check(label, ok, detail = "") {
  if (ok) {
    passed += 1;
    console.log(`  ✅ ${label}`);
  } else {
    failures.push(label);
    console.log(`  ❌ ${label}${detail ? ` — ${detail}` : ""}`);
  }
}
const section = (t) => console.log(`\n${t}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Polls `fn` until it returns truthy or the deadline passes. */
async function waitFor(fn, timeoutMs, intervalMs = 250) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await fn();
    if (value) return value;
    await sleep(intervalMs);
  }
  return null;
}

async function api(path, { method = "GET", body, token } = {}) {
  const headers = { Accept: "application/json" };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${API}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

console.log(`[realtime] API ${API}`);
console.log(`[realtime] Supabase ${SUPABASE_URL ?? "(not configured)"}`);

if (!SUPABASE_URL || !ANON_KEY) {
  console.log(
    "\n⏭️  skipped — NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY are not set.\n" +
      "    The app runs REST + 5s polling without them, by design.",
  );
  process.exit(0);
}

const createdLines = [];

try {
  // ---------------------------------------------------------------- phase 0
  section("0. Diner session issues a realtime token");
  const session = await api("/api/v1/sessions/initialize", {
    method: "POST",
    body: { table_token: TABLE_TOKEN, user_id: "realtime-check", name: "Realtime Check" },
  });
  check("E1 → 200", session.status === 200, `got ${session.status}`);

  const tableId = session.body?.data?.table_id;
  const realtimeToken = session.body?.data?.realtime_token;

  if (!realtimeToken) {
    console.log(
      "\n⏭️  skipped — backend returned realtime_token: null.\n" +
        "    That means SUPABASE_JWT_SECRET is not set in backend/.env, so the app\n" +
        "    deliberately runs REST-only. Set it and re-run to verify Realtime.",
    );
    process.exit(0);
  }
  check("E1 returned a realtime_token", typeof realtimeToken === "string");

  const claims = JSON.parse(Buffer.from(realtimeToken.split(".")[1], "base64url").toString("utf8"));
  const header = JSON.parse(Buffer.from(realtimeToken.split(".")[0], "base64url").toString("utf8"));
  console.log(
    `  ℹ️  token: alg=${header.alg} role=${claims.role} ` +
      `table_token=${claims.table_token ?? "-"} staff=${claims.staff ?? "-"} ` +
      `expires=${new Date(claims.exp * 1000).toISOString()}`,
  );

  // ---------------------------------------------------------------- phase 1
  section("1. Supabase accepts the token (signature + signing keys)");
  {
    // Direct PostgREST call: the narrowest possible test of "does this JWT
    // verify and do its claims reach RLS".
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/restaurant_tables?select=code`,
      { headers: { apikey: ANON_KEY, Authorization: `Bearer ${realtimeToken}` } },
    );
    const body = await res.json().catch(() => null);

    if (res.status === 200) {
      const rows = Array.isArray(body) ? body : [];
      check("token verifies against PostgREST", true);
      check(
        "claims scope the read to exactly this table",
        rows.length === 1 && rows[0].code === TABLE_TOKEN,
        `returned ${rows.length} row(s): ${JSON.stringify(rows)}`,
      );
    } else {
      check(
        "token verifies against PostgREST",
        false,
        `HTTP ${res.status} ${JSON.stringify(body)}`,
      );
      console.log(
        "\n  💡 A 401 here means Supabase rejected the signature. Most common cause:\n" +
          "     the project uses the newer ASYMMETRIC JWT signing keys, so the legacy\n" +
          "     HS256 secret our backend signs with is not the verifying key.\n" +
          "     Fix either by enabling the legacy JWT secret (Project Settings → API →\n" +
          "     JWT Settings) or by signing realtime_token with the project's key pair.",
      );
    }
  }

  /* ---------------------------------------------------------------- phase 2
     Two variants on purpose. supabase-js accepts an `accessToken` option that
     is used for REST calls; whether the REALTIME socket picks it up depends
     on the client applying it via realtime.setAuth(). If variant A fails and
     B passes, then any client that relies on `accessToken` alone (and never
     calls setAuth) silently receives nothing — exactly the failure mode this
     script exists to catch. */
  async function subscribeAndInsert(withExplicitAuth, menuItemId) {
    const client = createClient(SUPABASE_URL, ANON_KEY, {
      accessToken: async () => realtimeToken,
    });
    if (withExplicitAuth) client.realtime.setAuth(realtimeToken);

    let received = null;
    const statuses = [];
    const channel = client
      .channel(`table_carts:${TABLE_TOKEN}`)
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "cart_items", filter: `table_id=eq.${tableId}` },
        (payload) => {
          received = payload.new;
        },
      )
      .subscribe((status) => statuses.push(status));

    const subscribed = await waitFor(() => statuses.includes("SUBSCRIBED"), 15_000);
    if (!subscribed) {
      await client.removeChannel(channel);
      await client.realtime.disconnect?.();
      return { subscribed: false, received: null, statuses };
    }

    // The subscription is acknowledged before the replication listener is
    // necessarily attached; writing in that window can miss the event.
    await sleep(700);

    const added = await api("/api/v1/cart/items", {
      method: "POST",
      body: { table_token: TABLE_TOKEN, menu_item_id: menuItemId, quantity: 1, added_by: "realtime-check" },
    });
    const lineId = added.body?.data?.id ?? null;
    if (lineId) createdLines.push(lineId);

    const event = await waitFor(() => received, 15_000);
    await client.removeChannel(channel);
    await client.realtime.disconnect?.();
    return { subscribed: true, received: event, lineId, statuses };
  }

  section("2a. Diagnostic — does `accessToken` alone authenticate the socket?");
  {
    const r = await subscribeAndInsert(false, "a1b2c3d4-e5f6-7a8b-9c0d-1e2f3a4b5c6d");
    check("channel reaches SUBSCRIBED", r.subscribed, `saw: ${r.statuses.join(", ") || "nothing"}`);
    // Informational, NOT an assertion: this documents the upstream behaviour
    // that makes the explicit setAuth in realtime.ts mandatory. If it ever
    // starts passing, that fix is merely redundant — not broken.
    console.log(
      r.received
        ? "  ℹ️  accessToken alone delivered the event — the explicit setAuth in realtime.ts is now redundant (harmless)."
        : "  ℹ️  accessToken alone delivered nothing, exactly as expected — the websocket needs realtime.setAuth().",
    );
  }

  section("2b. Channel A — client that also calls realtime.setAuth()");
  {
    const r = await subscribeAndInsert(true, "2b3c4d5e-6f7a-4b9c-8d1e-2f3a4b5c6d7e");
    check("channel reaches SUBSCRIBED", r.subscribed, `saw: ${r.statuses.join(", ") || "nothing"}`);
    check("INSERT delivered after explicit setAuth", Boolean(r.received));
    if (r.received) check("event carries the cart row", r.received.menu_item_id !== undefined);
  }

  section("2c. Guard — the app's own client must do the same thing");
  {
    // Regression guard: the fix above lives in source, and CI cannot open a
    // browser. Assert it is still there, so a future refactor cannot quietly
    // remove it and reintroduce a silent no-streaming bug.
    const src = readFileSync(new URL("../lib/api-client/realtime.ts", import.meta.url), "utf8");
    check("realtime.ts calls realtime.setAuth()", /realtime\.setAuth\(/.test(src));
    check("realtime.ts pushes an already-stored token on creation", /getRealtimeAuth\(\)/.test(src));
  }

  // ---------------------------------------------------------------- phase 3
  section("3. Channel A does NOT deliver to an anon-only client (RLS)");
  {
    const anonClient = createClient(SUPABASE_URL, ANON_KEY); // no accessToken
    let leaked = null;
    const channel = anonClient
      .channel(`table_carts:${TABLE_TOKEN}`)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "cart_items", filter: `table_id=eq.${tableId}` },
        () => {
          leaked = true;
        },
      )
      .subscribe();

    await waitFor(() => true, 4_000); // let the channel settle

    await api("/api/v1/cart/items", {
      method: "POST",
      body: {
        table_token: TABLE_TOKEN,
        menu_item_id: "2b3c4d5e-6f7a-4b9c-8d1e-2f3a4b5c6d7e", // Garlic Naan (seed)
        quantity: 1,
        added_by: "realtime-check",
      },
    });

    // Give the socket ample time to (not) deliver.
    await waitFor(() => leaked, 10_000);
    check("no event leaked to the public anon key", leaked === null);

    await anonClient.removeChannel(channel);
    await anonClient.realtime.disconnect?.();
  }

  // ---------------------------------------------------------------- phase 4
  section("4. Presence (channel D) counts devices at a table");
  {
    const clients = [
      createClient(SUPABASE_URL, ANON_KEY, { accessToken: async () => realtimeToken }),
      createClient(SUPABASE_URL, ANON_KEY, { accessToken: async () => realtimeToken }),
    ];
    const channels = clients.map((c) => c.channel(`table_presence:${TABLE_TOKEN}`));
    const counts = [0, 0];

    channels.forEach((ch, i) => {
      ch.on("presence", { event: "sync" }, () => {
        counts[i] = Object.keys(ch.presenceState()).length;
      }).subscribe(() => {
        ch.track({ device_id: `realtime-check-${i}`, table_token: TABLE_TOKEN });
      });
    });

    const both = await waitFor(() => counts[0] >= 2 && counts[1] >= 2, 15_000);
    check(
      "both devices see each other (2 presences)",
      Boolean(both),
      `counts: ${counts.join(" / ")}`,
    );

    for (let i = 0; i < clients.length; i += 1) {
      await clients[i].removeChannel(channels[i]);
      await clients[i].realtime.disconnect?.();
    }
  }
} catch (err) {
  console.error(`\n[realtime] aborted: ${err.message}`);
  failures.push(`runner crashed: ${err.message}`);
}

// ------------------------------------------------------------------ cleanup
// Leave the demo table exactly as we found it.
for (const id of createdLines) {
  await api("/api/v1/cart/items", {
    method: "DELETE",
    body: { table_token: TABLE_TOKEN, cart_item_id: id },
  }).catch(() => {});
}
const cart = await api(`/api/v1/cart/items?table_token=${TABLE_TOKEN}&limit=100`).catch(() => null);
for (const line of cart?.body?.data ?? []) {
  await api("/api/v1/cart/items", {
    method: "DELETE",
    body: { table_token: TABLE_TOKEN, cart_item_id: line.id },
  }).catch(() => {});
}
console.log(`\n[realtime] demo table cart cleared (${createdLines.length} test line(s) removed)`);

console.log(
  `\n[realtime] ${passed} check(s) passed` +
    (failures.length ? `, ${failures.length} FAILED:\n  • ${failures.join("\n  • ")}` : ""),
);

if (failures.length > 0) process.exitCode = 1;
process.exit(failures.length > 0 ? 1 : 0);
