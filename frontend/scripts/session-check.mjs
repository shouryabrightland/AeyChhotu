#!/usr/bin/env node
/* AeyChhotu! — table session gate browser check.
 *
 * The gate is the security feature with the most client-side state, so a
 * green build says very little about it: the PIN pad, the auto-submit, the
 * 3-strike lock, the reconnect path and the Table Pass QR only exist at
 * runtime. This drives real headless Chrome over the DevTools protocol and
 * asserts what a guest would actually see.
 *
 * What it proves, in order:
 *   1. the FIRST scan of an empty table claims it and opens the menu
 *   2. that device now holds exactly { table_token, session_pin,
 *      session_secret } in localStorage (the stored shape the spec asks for)
 *   3. the Table Pass modal shows the 2-digit PIN and a real SVG QR
 *   4. a second, storageless visit is asked for the PIN — no menu leaks
 *   5. two digits auto-submit and open the menu (custom keypad, no <input>)
 *   6. three wrong PINs withdraw the keypad and show the scan gate
 *   7. the 20-character pass unlocks the table and resets the counter
 *   8. a device holding the pass RECONNECTS with no keypad at all
 *
 * Usage (both servers running, backend on :4000, web on :3000):
 *   cd backend  && npm run dev
 *   cd frontend && npm run dev
 *   cd frontend && npm run check:session
 *
 *   CHROME_PATH=/usr/bin/google-chrome       (override)
 *   SESSION_WEB_URL=http://localhost:3000    (override)
 *   SESSION_API_URL=http://localhost:4000    (override)
 */

import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function loadEnvFile(path) {
  try {
    for (const line of readFileSync(path, "utf8").split("\n")) {
      const match = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*)$/);
      if (match && process.env[match[1]] === undefined) process.env[match[1]] = match[2].trim();
    }
  } catch {
    /* absent file is fine — values may come from the real environment */
  }
}
loadEnvFile(new URL("../.env.local", import.meta.url).pathname);

const WEB = (process.env.SESSION_WEB_URL ?? "http://localhost:3000").replace(/\/+$/, "");
const API = (process.env.SESSION_API_URL ?? "http://localhost:4000").replace(/\/+$/, "");
const CHROME = process.env.CHROME_PATH ?? "google-chrome";
const PORT = Number(process.env.CDP_PORT ?? 9223);
const TABLE_TOKEN = "k7x2p";
const STORAGE_KEY = "aeychhotu.table_session.v1";

let passed = 0;
const failures = [];
const check = (label, ok, detail = "") => {
  if (ok) {
    passed += 1;
    console.log(`  ✅ ${label}`);
  } else {
    failures.push(label);
    console.log(`  ❌ ${label}${detail ? ` — ${detail}` : ""}`);
  }
};
const section = (title) => console.log(`\n${title}`);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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

// --------------------------------------------------------------------- chrome
const profileDir = mkdtempSync(join(tmpdir(), "aeychhotu-session-"));
const chrome = spawn(
  CHROME,
  [
    "--headless",
    "--disable-gpu",
    "--no-sandbox",
    "--no-first-run",
    "--no-default-browser-check",
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profileDir}`,
    "about:blank",
  ],
  { stdio: "ignore" },
);

let ws = null;

async function cleanupChrome() {
  try {
    ws?.close();
  } catch {
    /* already closed */
  }
  chrome.kill("SIGKILL");
  try {
    rmSync(profileDir, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
}

async function targetUrl() {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      const list = await res.json();
      const page = list.find((target) => target.type === "page" && target.webSocketDebuggerUrl);
      if (page) return page.webSocketDebuggerUrl;
    } catch {
      /* chrome not up yet */
    }
    await sleep(300);
  }
  throw new Error(`Chrome did not expose a page target on port ${PORT}`);
}

function connect(url) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    let nextId = 1;
    const pending = new Map();
    const consoleErrors = [];

    socket.addEventListener("message", (event) => {
      const msg = JSON.parse(event.data);

      if (msg.id && pending.has(msg.id)) {
        const { resolve: done, reject: fail } = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) fail(new Error(msg.error.message));
        else done(msg.result);
        return;
      }

      if (msg.method === "Runtime.consoleAPICalled" && msg.params?.type === "error") {
        consoleErrors.push(
          (msg.params.args ?? []).map((arg) => arg.value ?? arg.description ?? "").join(" "),
        );
      }
      if (msg.method === "Runtime.exceptionThrown") {
        consoleErrors.push(msg.params?.exceptionDetails?.text ?? "uncaught exception");
      }
    });

    socket.addEventListener("error", () => reject(new Error("CDP socket error")));
    socket.addEventListener("open", () => {
      const send = (method, params = {}) =>
        new Promise((done, fail) => {
          const id = nextId++;
          pending.set(id, { resolve: done, reject: fail });
          socket.send(JSON.stringify({ id, method, params }));
        });
      resolve({ send, consoleErrors, close: () => socket.close() });
    });
  });
}

/* Leaves the demo table EMPTY with no credentials, by firing a real order and
   serving it. Settling is the only path that wipes the session (sql/005), so
   this also proves the wipe from the outside. */
async function settleDemoTable(staffToken) {
  const problems = [];

  const cart = await api(`/api/v1/cart/items?table_token=${TABLE_TOKEN}&limit=100`);
  for (const line of cart.body?.data ?? []) {
    await api("/api/v1/cart/items", {
      method: "DELETE",
      body: { table_token: TABLE_TOKEN, cart_item_id: line.id },
    });
  }

  for (let attempt = 0; attempt < 4; attempt += 1) {
    const active = await api(`/api/v1/sessions/${TABLE_TOKEN}/active-check`);
    const orderId = active.body?.data?.order_id;
    if (!active.body?.data?.has_active_order || !orderId) break;

    await api(`/api/v1/kds/tickets/${orderId}/status`, {
      method: "PATCH",
      token: staffToken,
      body: { status: "preparing" },
    });
    await api(`/api/v1/kds/tickets/${orderId}/status`, {
      method: "PATCH",
      token: staffToken,
      body: { status: "ready" },
    });
    const pruned = await api(`/api/v1/kds/tickets/${orderId}/prune`, {
      method: "PATCH",
      token: staffToken,
    });
    if (pruned.status !== 200) problems.push(`prune ${orderId}: HTTP ${pruned.status}`);
  }

  return problems;
}

/* Fires an order so the settle above has something to serve. */
async function seedAnOrder() {
  const menu = await api(`/api/v1/menu?table_token=${TABLE_TOKEN}&limit=100`);
  const dish = (menu.body?.data ?? []).find((item) => item.is_available);
  if (!dish) throw new Error("the seed menu has no available dish");

  await api("/api/v1/cart/items", {
    method: "POST",
    body: { table_token: TABLE_TOKEN, menu_item_id: dish.menu_item_id, quantity: 1 },
  });
  const fired = await api("/api/v1/orders/fire", {
    method: "POST",
    body: { table_token: TABLE_TOKEN },
  });
  if (fired.status !== 201) throw new Error(`could not fire the cleanup order (${fired.status})`);
}

let staffToken = null;

try {
  const wsUrl = await targetUrl();
  const { send, consoleErrors, close } = await connect(wsUrl);
  ws = { close };

  await send("Page.enable");
  await send("Runtime.enable");

  const evaluate = async (expression) => {
    const res = await send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (res.exceptionDetails) {
      throw new Error(res.exceptionDetails.exception?.description ?? res.exceptionDetails.text);
    }
    return res.result?.value;
  };

  const goto = async (url) => {
    await send("Page.navigate", { url });
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      const ready = await evaluate("document.readyState").catch(() => null);
      if (ready === "complete") return;
      await sleep(200);
    }
  };

  const bodyText = () => evaluate("document.body ? document.body.innerText : ''");

  const waitForText = async (needle, timeoutMs = 20_000) => {
    const wanted = needle.toLowerCase();
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const text = await bodyText().catch(() => "");
      if (text.toLowerCase().includes(wanted)) return text;
      await sleep(250);
    }
    return null;
  };

  const clickByText = (text) =>
    evaluate(
      `(() => {
         const button = [...document.querySelectorAll('button')]
           .find((node) => node.textContent.trim() === ${JSON.stringify(text)});
         if (!button) return false;
         button.click();
         return true;
       })()`,
    );

  // ---------------------------------------------------------------- fixtures
  section("0. Fixtures — a settled, credential-free table");

  const staffPin = process.env.STAFF_PIN;
  if (!staffPin) throw new Error("STAFF_PIN missing from the environment");

  const login = await api("/api/v1/auth/kds-login", { method: "POST", body: { pin: staffPin } });
  staffToken = login.body?.data?.token ?? null;
  check("staff login for the fixtures", Boolean(staffToken), `HTTP ${login.status}`);

  /* Fire, then settle. Pruning is the ONLY path that sets a table empty AND
     wipes its credentials, and it needs an order to serve — a table left
     `active` with an empty cart (an abandoned session) would otherwise keep
     its session and this run would start at the PIN gate instead of the
     claim. */
  await seedAnOrder();
  const preflightProblems = await settleDemoTable(staffToken);
  check(
    "demo table starts empty and credential-free",
    preflightProblems.length === 0,
    preflightProblems.join(", "),
  );

  // ------------------------------------------------------------ 1. claiming
  section("1. First scan claims the empty table");

  await goto(`${WEB}/`);
  await evaluate(`localStorage.removeItem(${JSON.stringify(STORAGE_KEY)}); 'ok'`);
  await goto(`${WEB}/table/${TABLE_TOKEN}`);

  /* The menu opens on the cuisine level ("What are you in the mood for?"),
     not on a dish list, so that is the marker for "the gate opened". */
  const claimedText = await waitForText("in the mood for", 25_000);
  check("the menu opens for the first scanner", Boolean(claimedText));

  const stored = await evaluate(
    `(() => { try { return JSON.parse(localStorage.getItem(${JSON.stringify(STORAGE_KEY)})); } catch { return null; } })()`,
  );
  check("the device stored a table session", Boolean(stored));
  check("stored shape is { table_token, session_pin, session_secret }",
    stored &&
      typeof stored.table_token === "string" &&
      typeof stored.session_pin === "string" &&
      typeof stored.session_secret === "string",
  );
  check("stored token is this table", stored?.table_token === TABLE_TOKEN, String(stored?.table_token));
  check("stored PIN is two digits", /^\d{2}$/.test(stored?.session_pin ?? ""), String(stored?.session_pin));
  check(
    "stored pass is 20 characters",
    /^[A-Za-z0-9]{20}$/.test(stored?.session_secret ?? ""),
    String(stored?.session_secret?.length),
  );

  // Everything below depends on these credentials; continuing without them
  // would report a dozen misleading failures instead of one real cause.
  if (!stored?.session_secret || !stored?.session_pin) {
    throw new Error("no table session was stored — the gate did not claim the table");
  }

  // ----------------------------------------------------------- 2. Table Pass
  section("2. The Table Pass sheet");

  const opened = await evaluate(
    `(() => {
       const button = document.querySelector('button[aria-label="Show the table pass"]');
       if (!button) return false;
       button.click();
       return true;
     })()`,
  );
  check("the navbar offers a Table Pass action", opened === true);

  // "Or scan this pass" is unique to the pass sheet — "Table PIN" also matches
  // the keypad's own heading, which is how a missing modal went unnoticed.
  const passText = await waitForText("Or scan this pass", 10_000);
  check("the pass sheet opens", Boolean(passText));
  check("the PIN is rendered as the stored value", (passText ?? "").includes(stored?.session_pin ?? "@@"));

  const hasQr = await evaluate(
    `Boolean(document.querySelector('[role="img"][aria-label*="QR"] svg'))`,
  );
  check("the pass sheet draws a real SVG QR", hasQr === true);

  const secretVisible = (passText ?? "").includes(stored?.session_secret ?? "@@");
  check("the raw secret is never printed as text", secretVisible === false);

  await evaluate(
    `(() => {
       const close = document.querySelector('button[aria-label="Close"]');
       close?.click();
       return true;
     })()`,
  );

  // ------------------------------------------------------- 3. the PIN keypad
  section("3. A storageless visit must ask for the PIN");

  await evaluate(`localStorage.removeItem(${JSON.stringify(STORAGE_KEY)}); 'ok'`);
  await goto(`${WEB}/table/${TABLE_TOKEN}`);

  const padText = await waitForText("Enter table PIN", 25_000);
  check("the keypad gate is shown", Boolean(padText));
  check(
    "the menu does NOT render behind the gate",
    !(padText ?? "").toLowerCase().includes("in the mood for"),
  );

  const inputCount = await evaluate(`document.querySelectorAll('main input').length`);
  check("the pad uses no <input> (no device keyboard)", inputCount === 0);

  const pin = stored?.session_pin ?? "";
  for (const digit of pin.split("")) {
    await clickByText(digit);
    await sleep(120);
  }

  const afterPin = await waitForText("in the mood for", 20_000);
  check("two digits auto-submit and open the menu", Boolean(afterPin));

  // --------------------------------------------------------- 4. the 3-strike lock
  section("4. Three wrong PINs withdraw the keypad");

  await evaluate(`localStorage.removeItem(${JSON.stringify(STORAGE_KEY)}); 'ok'`);
  await goto(`${WEB}/table/${TABLE_TOKEN}`);
  await waitForText("Enter table PIN", 25_000);

  const wrongDigit = pin.startsWith("0") ? "9" : "0";
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await clickByText(wrongDigit);
    await sleep(90);
    await clickByText(wrongDigit);
    await sleep(900);
  }

  const lockedText = await waitForText("Table locked", 20_000);
  check("the locked gate appears", Boolean(lockedText));
  check(
    "it explains the 3 failed attempts",
    (lockedText ?? "").toLowerCase().includes("3 failed attempts"),
  );
  check(
    "it offers the single scan CTA",
    ((lockedText ?? "").toLowerCase().includes("scan") ?? false) &&
      (await evaluate(`document.querySelectorAll('button').length >= 1`)),
  );
  check(
    "the keypad is gone, not merely disabled",
    !(lockedText ?? "").toLowerCase().includes("enter table pin"),
  );

  // --------------------------------------------- 5. the pass unlocks the table
  section("5. The 20-character pass unlocks the flagged table");

  const unlocked = await api("/api/v1/sessions/join-pass", {
    method: "POST",
    body: { table_token: TABLE_TOKEN, secret: stored?.session_secret ?? "" },
  });
  check("join-pass accepts a tablemate's pass", unlocked.status === 200, `HTTP ${unlocked.status}`);
  check("the counter is reset by the pass", unlocked.body?.data?.status === "active");

  const relocked = await api("/api/v1/sessions/initialize", {
    method: "POST",
    body: { table_token: TABLE_TOKEN },
  });
  check("the table is no longer flagged", relocked.body?.data?.pin_locked === false);

  // ------------------------------------------------- 6. reconnect without a pad
  section("6. A device holding the pass reconnects silently");

  await evaluate(
    `localStorage.setItem(${JSON.stringify(STORAGE_KEY)}, ${JSON.stringify(JSON.stringify(stored))}); 'ok'`,
  );
  await goto(`${WEB}/table/${TABLE_TOKEN}`);

  const reconnected = await waitForText("in the mood for", 25_000);
  check("the menu returns without a keypad", Boolean(reconnected));
  check(
    "no PIN prompt was shown on the way in",
    !(reconnected ?? "").toLowerCase().includes("enter table pin"),
  );

  // ------------------------------------------------------------ 7. hygiene
  section("7. Console hygiene");
  const realErrors = consoleErrors.filter(
    (line) => !/favicon|Failed to load resource|unsplash|image/i.test(line),
  );
  check(
    "no console errors or uncaught exceptions",
    realErrors.length === 0,
    realErrors.join(" | "),
  );
} catch (err) {
  console.error(`\n[session] aborted: ${err.message}`);
  failures.push(`runner crashed: ${err.message}`);
}

// ------------------------------------------------------------------ cleanup
/* Settle the table so the next run starts from a claimed-empty state and no
   credential is left behind on the demo database. */
try {
  await seedAnOrder();
  const problems = await settleDemoTable(staffToken);
  if (problems.length > 0) {
    console.log(`\n[session] ⚠️  cleanup incomplete — ${problems.join(", ")}`);
    failures.push("cleanup left the demo table dirty");
  } else {
    console.log("\n[session] demo table settled — session wiped");
  }
} catch (err) {
  console.log(`\n[session] ⚠️  cleanup crashed: ${err.message}`);
  failures.push("cleanup crashed");
}

await cleanupChrome();

console.log(
  `\n[session] ${passed} check(s) passed` +
    (failures.length ? `, ${failures.length} FAILED:\n  • ${failures.join("\n  • ")}` : ""),
);
process.exit(failures.length > 0 ? 1 : 0);
