# 12 — Codebase Guide (every file, and why it exists)

This is the map of the repository. It answers "what is this file, and when do I
touch it?" for every file that ships. For the shapes that move between those
files — database tables, API payloads, tokens, local-storage records — read
[13-data-model.md](./13-data-model.md).

If you only want to *run* the thing, jump to [Running it](#running-it).

---

## 1. The shape of the system

```
phone (diner)        Next.js 16 app          Express 5 API          Postgres
/table/<code>  ───►  frontend/ (port 3000) ─► backend/ (port 4000) ─► aeychhotu-pg (5432)
tablet (kitchen)     React 19 + Tailwind 4    Zod + pg, no ORM      RLS + fire_order()
/kitchen
laptop (manager)
/admin
```

* **The frontend is the product.** Every screen a diner or a cook sees lives in
  `frontend/app` and `frontend/components`.
* **The backend owns truth.** It is the only writer: inventory, the one-active-
  order guard, the status state machine and the session credentials all live in
  SQL and in `backend/src/services`.
* **The frontend talks only to the API** (`NEXT_PUBLIC_API_URL`) — there is no
  direct Supabase client call on any read/write path. Supabase Realtime is used
  for push notifications only, and every screen falls back to REST polling when
  a channel is unavailable.

Two credential families keep the surfaces apart:

| Surface | Gate | Token | Storage key |
| --- | --- | --- | --- |
| Diner `/table/<code>` | 2-digit PIN or 20-char pass | none (the table token *is* the capability) | `aeychhotu.table_session.v1` |
| Kitchen `/kitchen`, Floor `/floor` | `STAFF_PIN` | `role:"kitchen"` JWT, 8 h | `aeychhotu.kds_token` |
| Manager `/admin` | `ADMIN_PIN` | `role:"admin"` JWT, 8 h | `aeychhotu.admin_token` |

---

## 2. Running it

```bash
# 1. database (idempotent: schema + realtime + seed)
cd backend && npm run db:setup

# 2. API
cd backend && npm run dev        # http://localhost:4000

# 3. app
cd frontend && npm run dev       # http://localhost:3000
```

* Diner: `http://localhost:3000/table/<table code>` — e.g. the seeded
  `k7x2p`. The table's PIN appears on the gate screen of the first device that
  claims it.
* Kitchen: `/kitchen`, PIN from `STAFF_PIN` (default in `.env.example`: `000000`).
* Floor: `/floor`, same staff PIN.
* Manager: `/admin`, PIN from `ADMIN_PIN` (`998877` in `.env.example`).
* Marketing/story/showcase: `/`, `/about`, `/presentation`.

---

## 3. Repository root

| File | What it is |
| --- | --- |
| `README.md` | Product summary, the two-service architecture, local setup and the deployment URL list. The first file a newcomer should read. |
| `render.yaml` | Render blueprint: two services (API + web) and their health checks. `plan: free` spins the API down after 15 min idle — that is why `backend/scripts/keep-alive.mjs` exists. |
| `.nvmrc` | Node version pin so a local shell matches the deploy image. |
| `.gitignore` | Ignores `node_modules`, build output, `dist-test`, `.env*` (except `.env.example`). |
| `.github/workflows/ci.yml` | CI: typecheck + lint + tests for both packages, and a Postgres service container so the session/admin tests actually run against a real database. |
| `repomix-output.xml` | Generated snapshot of the whole tree for offline/LLM consumption. Not code — regenerate with repomix, never hand-edit. |
| `.agent-context/context.md` | Working notes kept for AI assistants: conventions, invariants, and "do not do this" rules. Not part of the build. |
| `docs/*.md` | The design record. `1`–`5` are product/UX, `6`–`11` are the frontend, API, backend, integration and deployment reports, `12` is this guide, `13` is the data model. |

---

## 4. `backend/` — the Express API

### 4.1 Configuration

| File | What it is |
| --- | --- |
| `package.json` | ESM package. Scripts: `dev` (tsx watch), `build`/`start` (tsc → dist), `test` (tsc to `dist-test`, then `node --test`), `db:setup`, `db:verify`, `smoke`, `keep-alive`. |
| `tsconfig.json` | Strict TS, `NodeNext` resolution, `src` → `dist`. `import ... from "./x.js"` suffixes are required by NodeNext — do not "fix" them. |
| `tsconfig.test.json` | Same settings but compiles `src` + `test` into `dist-test` so the test run uses plain `node --test` with no loader. |
| `.env.example` | The contract for every env var: `DATABASE_URL`, `CLIENT_URL`, `STAFF_PIN`, `ADMIN_PIN`, `KDS_TOKEN_SECRET`, `SUPABASE_*`, `PORT`, `NODE_ENV`. Copy to `.env`. |
| `.gitignore` | Keeps `.env`, `dist`, `dist-test` out of git. |

### 4.2 `backend/sql/` — migrations (applied in filename order)

| File | What it is |
| --- | --- |
| `001_init.sql` | The base schema: six tables, the upsert/ordering/partial indexes, RLS policies for every table, and the original `fire_order()` RPC. |
| `002_review_fixes.sql` | Review-driven corrections: FK `RESTRICT` where history must not cascade, the partial unique "one active order per table" index, and re-scoped RLS so a table token can only see its own rows. |
| `003_realtime.sql` | Adds the tables to the `supabase_realtime` publication, sets `REPLICA IDENTITY FULL`, and grants the streamed columns — RLS decides *who* may read a row, this file decides whether the change is streamed at all. |
| `004_hardening.sql` | Money and time integrity: `set_updated_at()` triggers, the frozen `order_items.unit_price` / `orders.total`, the `enforce_order_status_transition()` trigger (illegal jumps raise), and `fire_order()` rewritten to snapshot the price. |
| `005_table_session_security.sql` | Table session credentials: `session_pin`, `session_secret`, `failed_pin_attempts`, `session_started_at`, format constraints, and a column-level `REVOKE`/`GRANT` so browser roles can never read either credential. |
| `006_admin_and_soft_deletes.sql` | `deleted_at` on `restaurant_tables` and `menu_items`, partial indexes over live rows only, and the column grant the archive flag needs. "Delete" in the admin console is always an archive. |
| `seed.sql` | Idempotent demo data: one terminal, five tables, twenty dishes with fixed UUIDs and `ON CONFLICT DO NOTHING`. Never deletes or overwrites operator edits. |

### 4.3 `backend/scripts/` — operator tools

| File | What it is |
| --- | --- |
| `db-setup.mjs` | Reads `sql/`, applies every file in order, prints the notices, then reports terminal/table/dish counts. `--no-seed` and `--dry-run` flags. |
| `db-verify.mjs` | Asserts the database built by `db:setup` is actually correct (columns, constraints, RLS, the partial indexes, `fire_order()` shape) instead of trusting exit 0. |
| `smoke.mjs` | End-to-end contract walk against a **running** API: the whole diner → kitchen → floor journey, asserting envelope shapes and error codes. Cleans up after itself so demo state is restored. |
| `keep-alive.mjs` | Pings a free Render instance for a bounded window so a demo does not pay the ~1 min cold start. |

### 4.4 `backend/src/` — application code

**Entry and wiring**

| File | What it is |
| --- | --- |
| `index.ts` | Process entry: validates env, starts the HTTP server, installs SIGTERM/SIGINT graceful shutdown (stop accepting → drain in-flight → close pool). |
| `app.ts` | `createApp()`: helmet headers → request ids → CORS (`CLIENT_URL` allow-list) → login/API rate limits → routers → 404 → error handler. **Order matters**; do not reorder casually. |
| `config/env.ts` | Single source of validated config. Fails loudly with the *name* of the missing variable and exits 1, so a half-configured server never starts. |
| `db/pool.ts` | One shared `pg.Pool`; an idle-client error is logged loudly rather than silently degrading. |
| `errors/app-error.ts` | `AppError(status, code, message, details)` — the only thing services throw; the error middleware renders it. |
| `observability/logger.ts` | ndjson logging + `X-Request-Id` correlation (`requestContext`). One JSON object per line, no logger dependency. |

**Libraries**

| File | What it is |
| --- | --- |
| `lib/jwt.ts` | Hand-rolled HS256 sign/verify on `node:crypto` (no dependency). Signs shift tokens (`role`, `terminal_id`, `iat`, `exp`) and, when `SUPABASE_JWT_SECRET` is set, the read-scoped token Realtime uses. |
| `lib/util.ts` | `buildMeta(page, limit, total)` for the pagination envelope and `iso()` for timestamps. |

**Middleware**

| File | What it is |
| --- | --- |
| `middleware/auth.ts` | `requireAuth` (bearer header, then httpOnly cookie → 401) and `requireRole(role)` (403). Also owns the cookie names `kds_token` / `admin_token`. |
| `middleware/error-handler.ts` | The single place that renders `{ success:false, error:{ code, message, ...details } }`; unexpected errors become `INTERNAL_ERROR` + the request id. |
| `middleware/not-found.ts` | Terminal 404 in the same envelope. |
| `middleware/rate-limit.ts` | `loginLimiter` (10 **failed** attempts / 10 min, shared by both PIN doors) and `apiLimiter` (broad safety net). |

**Routes** (all `/api/v1/*`; each file is thin — validation, auth, one service call)

| File | Endpoints |
| --- | --- |
| `routes/health.ts` | `GET /health` → `{ ok: true }`. Liveness only — never touches the database. |
| `routes/ready.ts` | `GET /ready` → checks the pool. Readiness, so a database blip removes the instance from the load balancer instead of restarting it. |
| `routes/sessions.ts` | `E1 initialize`, `E1b join-pin`, `E1c join-pass`, `E1d reconnect`, `E9 active-check`. |
| `routes/auth.ts` | `E2 kds-login`, `E2c admin-login`, `E2b me`. |
| `routes/menu.ts` | `E3 GET /menu` (public), `E14 availability` (staff). |
| `routes/cart.ts` | `E4` read, `E5` upsert, `E6` update, `E7` remove. |
| `routes/orders.ts` | `E8 fire`, `E15 status`, `E16 history`. |
| `routes/kds.ts` | `E10 tickets`, `E11 status`, `E12 prune`, `E13 shift activate` — all behind `requireAuth` + `requireRole("kitchen")`. |
| `routes/floor.ts` | `E17 floor tables` (staff). |
| `routes/admin.ts` | `/admin/tables` CRUD + `regenerate-token`, `/admin/menu` CRUD, `/admin/analytics/top-selling` — every route behind `requireRole("admin")`. |

**Services** (business rules; routes never contain SQL)

| File | What it is |
| --- | --- |
| `services/auth.service.ts` | PIN comparison (constant-time), shift token issuance, terminal identity. Zero-exposure: secrets never enter a response or a log. |
| `services/sessions.service.ts` | The two-layer table session: PIN minting/checking, three-strike table lock, 20-char pass, reconnect, settle (which nulls every credential). |
| `services/ownership.ts` | `ownedCartLine()` — resolves the table from the token, then proves the row belongs to it. A foreign id is the **same 404** as a missing one. |
| `services/menu.service.ts` | Menu listing (86'd dishes returned, never hidden) and the 86 toggle. |
| `services/cart.service.ts` | Shared cart: atomic upsert on the logical-line unique index, delta-aware updates, ownership-checked deletes. |
| `services/orders.service.ts` | Fire (delegates to the `fire_order()` RPC), status polling scoped to the caller's table, history with the frozen totals. |
| `services/kds.service.ts` | Ticket board, the sequential status machine, prune (serve + clear the table in one transaction), shift activation. |
| `services/floor.service.ts` | The floor summary: active order + its items (for allergy alerts) + staged cart count per table. |
| `services/admin.service.ts` | Table codes (`randomInt`, 5–8 chars), admin PIN claim, table create/rename/regenerate/archive, menu CRUD, best-seller analytics from served orders at fire-time price. |

**Validation**

| File | What it is |
| --- | --- |
| `validation/schemas.ts` | One Zod schema per endpoint. Unknown keys are stripped, not rejected; quantities, note lengths, PIN shape and pagination limits are enforced here. |

### 4.5 `backend/test/`

| File | What it proves |
| --- | --- |
| `jwt.test.ts` | Sign/verify round-trip, tampered payload, expired token, wrong secret. |
| `schemas.test.ts` | Every Zod schema's accept/reject boundaries (PIN `'00'`–`'99'`, pagination clamp, note length). |
| `transitions.test.ts` | The status state machine: legal forward steps, illegal jumps, prune-only `served`. |
| `util.test.ts` | `buildMeta` and `iso` edge cases. |
| `sessions-security.test.ts` | Against real Postgres: claim/join/reconnect, the 3-strike lock, settle wiping PIN+pass+counter, and that no staff payload leaks either credential. |
| `admin.test.ts` | Code generation, constant-time PIN match, admin token role/TTL, and the whole engine (table CRUD, regenerate, archive, menu CRUD, analytics, 404s) against Postgres. |

---

## 5. `frontend/` — the Next.js app

### 5.1 Configuration

| File | What it is |
| --- | --- |
| `package.json` | Scripts: `dev`, `build`, `start`, `lint`, `typecheck`, `test` (node + tsx), `realtime:check`, `check:floor`, `check:session`. |
| `next.config.ts` | `reactStrictMode`, security headers (`Permissions-Policy` keeps `camera=(self)` for the scanner), and **no** `images.remotePatterns` — every photo is local. |
| `tsconfig.json` | Strict TS, `@/*` path alias to the package root. |
| `postcss.config.mjs` | Tailwind 4 via `@tailwindcss/postcss`. |
| `eslint.config.mjs` | `eslint-config-next` plus the React hooks rules that caught the overlay focus bug. |
| `.env.example` | `NEXT_PUBLIC_API_URL`, the public Supabase URL/anon key, and the demo table token. |

### 5.2 `app/` — routes

| File | What it is |
| --- | --- |
| `layout.tsx` | Root shell: fonts, `ToastProvider`, metadata (icons, manifest, iOS `appleWebApp` tags) and the locked 1× viewport with `viewportFit: cover`. |
| `globals.css` | The design system: brand tokens (cream/ember/ink), status colours, radii, shadows, typographic scale, safe-area utilities, `prefers-reduced-motion` handling. Nothing else hardcodes a hex. |
| `error.tsx` | Route-level error boundary with Retry — real failures are shown plainly, never masked with demo data. |
| `not-found.tsx` | Branded 404 that sends the guest back to the scanner. |
| `(marketing)/page.tsx` | **The front door** (`/`): the promise, "scan the QR" (in-app camera) and "enter table code" (5–8 char dialog). Validates the code, then pushes `/table/<code>`. |
| `about/page.tsx` | The customer story. Diner-facing only — deliberately no links to staff rooms. |
| `admin/page.tsx` | **Manager console** (`/admin`): PIN gate → three tabs (analytics, tables, menu). Uses the admin token; every "delete" is an archive. |
| `kitchen/page.tsx` | Kitchen route: sets the light palette/theme colour and renders `KitchenScreen`. |
| `floor/page.tsx` | Floor route: renders `FloorScreen`. |
| `presentation/page.tsx` | Hackathon showcase route; owns its own dark browser chrome. |
| `presentation/PresentationView.tsx` | The exhibit itself: the deck, the live screenshots, the architecture narrative. Large and self-contained on purpose. |
| `presentation/PresentationView.module.css` | Scoped styles for that exhibit only, so the dark showcase cannot leak into the product palette. |
| `table/[token]/page.tsx` | Diner entry for a table code: wraps `DinerTableScreen` in `TableSessionGate`. |
| `table/[token]/tracker/page.tsx` | The live tracker for the same table, behind the same gate. |

> **No `app/api/*` routes exist.** They were removed: the app calls the Express
> API directly (`NEXT_PUBLIC_API_URL`). A Next route handler in the middle only
> added a second place for auth to drift.

### 5.3 `components/ui/` — the primitives

Every screen is built from these; they are the only place that decides how a
button, field or overlay looks.

| File | What it is |
| --- | --- |
| `button.tsx` | `Button` + `buttonStyles`/`buttonIconClass` for link-shaped buttons. Variants (`ember`, `ink`, `soft`, `ghost`), sizes, `loading`, `fullWidth`. |
| `icon-button.tsx` | Square icon-only button with a mandatory `label` (becomes `aria-label`). |
| `badge.tsx` | Status pills; each tone pairs its own foreground/background so contrast is fixed at design time. |
| `card.tsx` | `Card`, `CardHeader`, `CardTitle`, `CardDescription`, `CardFooter`. |
| `container.tsx` | Width-constrained page gutters (`narrow`/`default`/`wide`). |
| `section.tsx`, `page-header.tsx`, `section-header.tsx`, `heading.tsx`, `text.tsx` | The typographic/layout scale. Use these instead of ad-hoc `text-3xl` so two screens never drift. |
| `field.tsx` | `useFieldControl()` (stable ids + `aria-describedby`), `controlStyles()` (the one input skin), `FieldShell` (label + hint/error wiring). |
| `input.tsx`, `textarea.tsx`, `select.tsx` | Controlled form controls built on `FieldShell`; forwards every native prop, so `value`/`onChange` stay the caller's. |
| `modal.tsx` | Centred dialog on `Overlay`, with the header / scrollable body / pinned footer contract. |
| `drawer.tsx` | Right-side sheet on the same `Overlay` (used by the bill, cart and 86 drawers). |
| `overlay.tsx` | **The dialog engine**: backdrop, Escape, focus trap, focus restore, body-scroll lock, enter/exit motion. Its focus effect is keyed to `open` only — see the note in the file. |
| `toast.tsx` | `ToastProvider` + `useToast()` — the app's only transient feedback channel (rendered through a portal). |
| `tooltip.tsx` | Hover/focus label for icon-only actions. |
| `empty-state.tsx` | `EmptyState` and `ErrorState` (the latter takes a retry callback; used by every live board). |
| `loading-state.tsx` | `LoadingState` and `Skeleton` placeholders that keep layout stable while data arrives. |
| `spinner.tsx` | The small activity indicator used inside buttons. |

### 5.4 `components/diner/` — the guest's screens

| File | What it is |
| --- | --- |
| `table-session-gate.tsx` | **The one door into a table.** On mount: reconnect with a stored pass → otherwise PIN pad → or, if flagged, the locked gate. Owns the three-attempt logic and the "session ended" state. |
| `table-pin-pad.tsx` | Hand-built 2-digit keypad (never an `<input>`): big thumb targets, auto-submit on the second digit. |
| `table-locked-gate.tsx` | The flagged table: keypad withdrawn, only a Table Pass can re-open it. |
| `table-pass-modal.tsx` | The Table Pass: the PIN and the QR for the same session, then the table's own card — guest count and names (with "you" marked), dishes ordered, rounds fired, the running total and what is still staged. Two columns from `sm`, so the whole pass fits without scrolling. |
| `in-app-qr-scanner.tsx` | `getUserMedia` + `jsQR` frame decoding — no file picker, no OS camera handoff. |
| `diner-table-screen.tsx` | The menu screen itself: nav bar, search/stage, responsive card grid, cart column/strip, bill drawers, tracker hand-off. |
| `diner-nav-bar.tsx` | The charcoal band: editable "ordering as" name, tracker, one bill pill (carrying the table total; it collapses to its icon below `sm` where the band has no room for the amount) and the table pass. |
| `menu-browser.tsx` | The menu as a wall of folders: one deck per `menu_categories` folder, with search and the diet filter as views over the same decks. |
| `dish-card.tsx`, `dish-deck.tsx` | `dish-card` is one swipeable dish (drag right to add, left to skip, or press the buttons). `dish-deck` stacks one folder's cards into a pile — next two peeking behind, `1 / n` progress, "Up next", skipped chips and **Start again** when the folder runs out. Decks are 1-up on a phone, 2-up on a tablet, back to 1-up from `lg` (the cart aside takes 21rem out of the menu column) and 2-up from `xl`. |
| `dish-photo.tsx` | The single plate treatment (4:3, warm wash while loading, palette tile on failure). |
| `discovery-card.tsx` | One whole-card button used by the cuisine/section pickers. |
| `quantity-stepper.tsx` | −/+ with the minus becoming a bin at 1. |
| `cart-strip.tsx` | Phone-width cart bar (below `lg` only) that opens the cart. |
| `table-cart.tsx` | The desktop sticky cart column — the same cart, second window. |
| `cart-modal.tsx` | The full review sheet: lines, notes, allergy, fire. |
| `cart-line-row.tsx` | One cart line (name, price, stepper, remove) shared by cart and drawer. |
| `allergy-input.tsx` | The allergy note, in its own high-contrast container so it never reads as general instructions. |
| `bill-drawer.tsx` | The running bill, with a scope switch (whole table vs this guest) grouped by fired round. |
| `live-tracker.tsx` | "Where is my food": the status emblem, the journey, the estimate, the ticket. |
| `session-ended-state.tsx` | The clean end of a session: credentials are gone, rescan to start again. |
| `inactive-table-state.tsx` | A valid code on a table with no live session. |
| `active-diners-badge.tsx` | "N phones at this table", from presence. |
| `diet-mark.tsx` | The veg / non-veg square-with-a-dot mark. |
| `home-qr-animation.tsx` | The animated QR flourish on the front door. |

### 5.5 `components/staff/` — kitchen and floor

| File | What it is |
| --- | --- |
| `kitchen-screen.tsx` | Kitchen route shell: PIN wall → board. |
| `kitchen-pin-wall.tsx` | Staff PIN entry (typeable field **and** keypad), with its own storage key so locking one board does not unlock another. |
| `kds-board.tsx` | The three live columns (pending / preparing / ready), chime on new tickets, error + retry state. |
| `kds-card.tsx` | One ticket: dish lines, notes, **allergy alert**, elapsed timer, one-tap advance, prune. |
| `ops-bar.tsx` | The board's top strip: connection state, shift activation (arms audio), 86 shortcut. |
| `menu-availability-drawer.tsx` | The 86 list — flip a dish unavailable without leaving the board. |
| `floor-screen.tsx` | Floor route shell: PIN wall → floor board. |
| `floor-view.tsx` | The room: one card per table with status colour rail, active order, staged cart count and allergy alerts; "settle" clears the table. |
| `staff-gate.tsx` | The reusable locked/unlocked wrapper behind both staff surfaces. |

### 5.6 `components/marketing/`, `components/layout/`, `components/brand/`, `components/motion/`, `components/pwa/`

| File | What it is |
| --- | --- |
| `marketing/hero-visual.tsx` | The hero composition (cut-out server, ambient light, floating status pills). |
| `marketing/hero-pointer-shadow.tsx` | Pointer-tracked ember glow under the hero — CSS variables only, no React state per mousemove. |
| `marketing/expandable-card.tsx` | Tap-to-expand card (real DOM detail, keyboard reachable). |
| `marketing/flip-card.tsx` | Tap-to-flip card with both faces in the DOM and `aria-expanded`. |
| `marketing/innovation-deck.tsx` | The looping card deck on the story page. |
| `marketing/tilt-surface.tsx` | 3D pointer tilt for object-like mockups; plain div under reduced motion. |
| `marketing/workflow-timeline.tsx` | The five-stage rail that advances on its own and pauses while inspected. |
| `layout/site-header.tsx`, `layout/site-footer.tsx` | Marketing chrome; the footer continues the CTA's gradient so the seam is invisible. |
| `brand/logo.tsx` | The brand tile (wordmark and mark), with an on-brand background so a missing file never leaves an empty box. |
| `motion/reveal.tsx` | Scroll-in reveal wrapper that respects reduced motion. |
| `pwa/install-prompt.tsx` | Install banner: replays the stashed `beforeinstallprompt` on Android, explains Share → Add to Home Screen on iOS, and stays quiet once installed. |

### 5.7 `hooks/` — the data runtimes

| File | What it is |
| --- | --- |
| `use-live-table.ts` | Diner runtime: menu, cart, fire, status. Realtime channels plus REST polling underneath; cart writes are optimistic (an add is painted immediately and the badge reads `syncing` until the server's cart is read back); a failure is a real error state, never seeded data. |
| `use-live-kds.ts` | Kitchen runtime: tickets, per-ticket busy map (the double-tap guard), status/prune writes, new-ticket chime. |
| `use-live-floor.ts` | Floor runtime: table summaries, settle, realtime refresh, slow-poll fallback. |
| `use-staff-menu-catalog.ts` | Discovers a real menu for the 86 drawer by asking the floor view for a live table code (the menu endpoint is table-scoped). |
| `use-bills.ts` | `useSyncExternalStore` view of every table's bill state; server render gets a stable empty snapshot so there is no flicker. |
| `use-db.ts` | Subscription to the local operational store (`lib/api/store.ts`) — the cross-tab stand-in for Realtime. |
| `use-presence.ts` | 15 s heartbeat announcing this device to a table (demo store only; live deployments use Supabase Presence). |
| `use-now.ts` | A single ticking clock so every elapsed timer on a board updates together. |
| `use-body-scroll-lock.ts` | Locks `body` scroll while an overlay is open and restores the previous value. |

### 5.8 `lib/api-client/` — the only network layer

| File | What it is |
| --- | --- |
| `apiClient.ts` | The core: base URL from `NEXT_PUBLIC_API_URL`, 20 s timeout, envelope parsing, `ApiError` construction, bearer/cookie auth injection, and the global 401 guard (wipe token → redirect to the matching gate). |
| `endpoints.ts` | Exactly one typed function per contract endpoint (E1–E17, E2b, plus the admin set). Components never call `fetch` directly. |
| `types.ts` | Contract typings, field names verbatim from the DB blueprint. See [13-data-model.md](./13-data-model.md). |
| `errors.ts` | `ApiError` with `status`, `error` code, `details`, plus `soldOut`, `fields`, `isTimeout`, `isNetworkFailure` accessors. |
| `normalize.ts` | Maps contract payloads onto the UI domain types (`lib/api/types.ts`) so screens keep their markup when the wire shape changes. |
| `paginate.ts` | `fetchAllPages` — walks `meta.total_pages` so item 101 is not silently invisible (every list endpoint caps `limit` at 100). |
| `token.ts` / `admin-token.ts` | Staff token and admin token storage, in separate keys and separate modules so one can never be promoted to the other. Memory fallback keeps SSR/tests safe. |
| `realtime.ts` | Channel map and subscription helpers (`table_carts`, `kds_orders`, `order_tracker`) with client-side filters. |
| `realtime-auth.ts` | Holds the Supabase-scoped read token shared by `endpoints.ts` and `realtime.ts` (separate module to avoid an import cycle). |
| `index.ts` | The public surface. Runtime values are re-exported explicitly, types with `export type`. |

### 5.9 `lib/api/` — domain helpers and the local store

| File | What it is |
| --- | --- |
| `types.ts` | The UI domain model (`MenuItem`, `CartLine`, `Order`, `TableSession`, `ServiceResult`, …). |
| `session.ts` | Table token, display name and device id in `localStorage` (+ `createId`). |
| `table-session.ts` | The stored `{ table_token, session_pin, session_secret }` record: read/store/clear/remember, so a refresh reconnects without retyping. |
| `bill.ts` | "Can we have the bill?" — request/settle events, mirrored across tabs over `BroadcastChannel`. |
| `store.ts` | The local operational store: one snapshot, `subscribe()` push channel, `mutate()`, presence heartbeat. Used by the demo surfaces and as the cross-tab transport. |
| `index.ts` | The legacy demo service layer: one async function per documented operation returning `ServiceResult` envelopes. Kept for the local/demo paths — **no live screen imports it** (they all go through `lib/api-client`). |
| `seed.ts` | The demo menu and tables (fixed ids), used by the presentation and the offline/demo surfaces. Live screens never fall back to it. |

### 5.10 `lib/diner/` — pure presentation logic (unit-tested)

| File | What it is |
| --- | --- |
| `menu-atlas.ts` | Turns the flat `category` list into cuisine → section → dish, plus `searchMenu`. |
| `diet.ts` | Derives veg / non-veg / egg / Jain from a dish's own words (the contract has one `vegetarian` flag). |
| `food-photos.ts` | Dish → photo resolution (dish map → category map → palette tile). **Photos are local files in `public/food`**, never hot-linked. |
| `table-pass.ts` | The pure half of the session flow: PIN validity, pass validity, `attemptsRemaining`, `gatePhase`, and the QR pass encode/parse. No React, no `window` — directly unit-tested. |
| `tracker.ts` | The tracker's delight layer: arrival estimate, activity copy, foodie jokes. Never changes a real status. |

### 5.11 `lib/` (root)

| File | What it is |
| --- | --- |
| `site.ts` | Navigation/link constants and the demo table token. |
| `fonts.ts` | The two font instances (display + sans) wired into the Tailwind variables. |
| `motion.ts` | Motion tokens (durations/easings/transitions) kept in step with the CSS `--duration-*` variables. |
| `format.ts` | `formatPrice` (`Rs. 1,20,000.00`, Indian grouping), IST time/date formatting, `formatElapsed`. |
| `sound.ts` | WebAudio chime; must be armed from a user gesture (the "Start shift" tap) because browsers block autoplay. |
| `utils.ts` | `cn()` — `clsx` + `tailwind-merge`. |

### 5.12 `public/`

| File | What it is |
| --- | --- |
| `logo.png`, `ref.png` | The brand mark and the hero cut-out. |
| `icon.svg`, `icon-192.png`, `icon-512.png` | Favicon + PWA icons (192/512 are required for installability). |
| `site.webmanifest` | PWA manifest: name, short name, `standalone`, theme/background colours, icons. |
| `food/*.jpg` | The seventeen dish photos, served from disk through `next/image`. |

### 5.13 `scripts/` and `test/` (frontend)

| File | What it is |
| --- | --- |
| `scripts/session-check.mjs` | Headless-Chrome check of the gate: keypad, auto-submit, 3-strike lock, reconnect, QR pass, and that the pad uses no `<input>`. |
| `scripts/floor-check.mjs` | Headless-Chrome check of the floor board: PIN gate, live E17 data, allergy alert reaching the card, no console errors. |
| `scripts/realtime-check.mjs` | Isolates the one failure that looks like success: a subscribed channel that delivers nothing. |
| `test/normalize.test.mjs` | Contract → domain normalisation (envelopes, nulls, numeric strings). |
| `test/bill.test.mjs` | Bill request/settle events and scope arithmetic. |
| `test/diet.test.mjs` | The four diet filters over real dish copy. |
| `test/menu-atlas.test.mjs` | Atlas grouping, search, and that every referenced photo file exists. |
| `test/sessions-security.test.mjs` | The pure gate rules: PIN/pass validity, attempt counting, phase transitions. |

---

## 6. Where to change what

| I want to… | Edit |
| --- | --- |
| change a colour, radius or type size | `frontend/app/globals.css` (tokens only — never a hex in a component) |
| change what a button/field looks like | `frontend/components/ui/*` |
| add a screen for diners | `frontend/app/table/[token]/…` + a component in `components/diner/` |
| add an API call | `frontend/lib/api-client/endpoints.ts` + a type in `types.ts` |
| change a business rule (inventory, status, session) | the matching `backend/src/services/*.service.ts`, with SQL in `backend/sql/` if it is a data invariant |
| add a column | a new `backend/sql/00N_*.sql` (never edit an applied migration), then `npm run db:setup` |
| change the wire contract | `docs/7-api-contract.md` **first**, then schemas, service, client types, normalizer |
| change the demo data | `backend/sql/seed.sql` (fixed UUIDs, `ON CONFLICT DO NOTHING`) |

Two rules that have already caused bugs when broken:

1. **`overlay.tsx` focus effects must depend on `open` only.** Callers pass
   inline `onClose` arrows, so any effect that lists `onClose` re-runs on every
   keystroke and steals focus out of the field being typed in.
2. **Never hot-link an image.** Photos ship in `public/food`; a remote host in
   `next.config.ts` makes every plate depend on a third party answering the
   optimiser (that is what produced 500s from `/_next/image`).
