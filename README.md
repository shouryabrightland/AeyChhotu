<div align="center">

# 🍛 AeyChhotu!

### One table, one order, live from the kitchen.

A zero-download, real-time operational bridge that **groups every phone at a table into one
shared cart**, fires **one clean ticket** to the kitchen, and streams two-way status updates
back to the diner — no app install, no login for guests.

It also runs **three voice assistants** — the guest's waiter, the chef's hands-free board and the
owner's read-only analyst — on **one Gemini Live model**, all backed by the same database.

[![Next.js](https://img.shields.io/badge/Next.js-16.3.6-black?logo=nextdotjs&logoColor=white)](#-tech-stack)
[![React](https://img.shields.io/badge/React-19.3-61DAFB?logo=react&logoColor=white)](#-tech-stack)
[![TypeScript](https://img.shields.io/badge/TypeScript-6.0_strict-3178C6?logo=typescript&logoColor=white)](#-tech-stack)
[![Tailwind CSS](https://img.shields.io/badge/Tailwind-v4-06B6D4?logo=tailwindcss&logoColor=white)](#-tech-stack)
[![Express](https://img.shields.io/badge/Express-5.2-000000?logo=express&logoColor=white)](#-tech-stack)
[![Postgres](https://img.shields.io/badge/Postgres-Supabase-4169E1?logo=postgresql&logoColor=white)](#-tech-stack)
[![Zod](https://img.shields.io/badge/Zod-4.6-3E67B1?logo=zod&logoColor=white)](#-tech-stack)

**Status:** Feature-complete and verified against a live database — **81** schema, RLS & hardening
assertions, **126** live contract checks, **211** unit tests, and both apps green on typecheck · lint ·
build. CI enforces it (see [Project Status](#-project-status)).

</div>

---

## 📖 Table of contents

- [Live deployment](#-live-deployment)
- [The problem](#-the-problem)
- [Core features](#-core-features)
- [Voice & AI surfaces](#-voice--ai-surfaces)
- [Who it is for](#-who-it-is-for)
- [System architecture](#-system-architecture)
- [Order lifecycle](#-order-lifecycle)
- [Calling for the bill](#-calling-for-the-bill)
- [Data model](#-data-model)
- [Backend architecture](#-backend-architecture)
- [Frontend architecture](#-frontend-architecture)
- [Realtime channels](#-realtime-channels)
- [Tech stack](#-tech-stack)
- [Repository layout](#-repository-layout)
- [Quick start](#-quick-start)
- [Environment variables](#-environment-variables)
- [Database setup](#-database-setup)
- [API reference](#-api-reference)
- [Security model](#-security-model)
- [Build & verification](#-build-verification)
- [Project status](#-project-status)
- [Documentation index](#-documentation-index)

---

## 🌍 Live deployment

The free path is **deployed and verified** — Vercel + Render + Supabase, no code changes required.

| Surface | URL | Credential |
|---|---|---|
| Diner menu · live shared cart | <https://aeychhotu.vercel.app/table/k7x2p> | none |
| Order tracker | <https://aeychhotu.vercel.app/table/k7x2p/tracker> | none |
| Kitchen board (KDS) | <https://aeychhotu.vercel.app/kitchen> | `STAFF_PIN` |
| Floor view | <https://aeychhotu.vercel.app/floor> | `STAFF_PIN` |
| REST API | <https://aeychhotu-api-bkp8.onrender.com> | — |

> ⏰ **The free API sleeps — plan around it for a demo.** Render spins a Free web service down after
> **15 minutes** with no inbound traffic (HTTP requests *or* WebSocket messages), and waking it takes
> **~1 minute**. Both apps handle it: the client surfaces *"Serving line taking a moment to spin up,
> please try again!"*, and the production demo-fallback gate means it will **not** quietly serve seeded
> dishes instead.

### ⏰ Keeping the API awake for a demo

Run this **once** — it holds the API awake for **3 hours**, then stops by itself, so you spend instance
hours only for the window you asked for:

```bash
cd backend && npm run keep-alive -- https://aeychhotu-api-bkp8.onrender.com
```

To keep it running after you close the terminal:

```bash
cd backend && nohup npm run keep-alive -- https://aeychhotu-api-bkp8.onrender.com > /tmp/aeychhotu-keepalive.log 2>&1 &
```

Tune the window with `KEEP_ALIVE_HOURS` (default `3`) and `KEEP_ALIVE_INTERVAL_MIN` (default `10`).
Leaving the **`/floor`** screen open also works — it polls every 15 s unconditionally. `/kitchen` and the
diner screens do **not**: with Realtime healthy their updates arrive over Supabase WebSockets, which
never touch Render.

> Budget note: Render grants **750 Free instance hours per workspace per month**, and one always-on
> service costs up to 744 h — so a 24/7 pinger leaves no margin and fits **only if that is the only Free
> web service you run.** Full detail in [`docs/11-deploy.md`](docs/11-deploy.md) §4.

---

## 😖 The problem

Traditional QR-ordering tools stop manual typing errors but create three new ones:

| # | Failure mode | What happens in a real rush |
|---|---|---|
| 1 | **Ticket fragmentation** | 8 people at one table each tap “Submit” → the kitchen gets **8 separate tickets**, courses arrive out of order. |
| 2 | **Buried allergy notes** | Serious allergy text hides in the same tiny box as “extra sauce”. Kitchens miss it. |
| 3 | **One-way kitchen screens** | The cook taps *Done* → nothing reaches the diner or the server. Everyone waits blind, food dies under the lamp. |

**AeyChhotu! attacks all three:** a shared table cart that fires once, allergy notes rendered
unavoidably on the KDS, and a live `pending → preparing → ready → served` state stream to the diner’s browser.

---

## ✨ Core features

### 🍽 Guest experience

| # | Feature | Where it lives |
|---|---|---|
| 1 | **Zero-install table session** — scan the QR, no app, no account | `E1` + `app/table/[token]` |
| 2 | **Two ways to claim a table** — a 2-digit PIN for the first device, a 20-char table pass for everyone else | `table-session-gate` + `table-pass` |
| 3 | **Shared multi-device cart** — upsert plus atomic delta edits, every line attributed to who added it | `E4`–`E7` + channel A |
| 4 | **Atomic “Review & Fire”** — cart frozen, inventory re-checked, one ticket created, cart drained, in one transaction | `E8` → `fire_order()` |
| 5 | **Double-fire guard** — two phones tapping together produce one order; the other gets a polite 409 | `E9` + partial unique index |
| 6 | **Live tracker** — `pending → preparing → ready` with a green confirmation and a wait estimate | `E15`/`E16` + channel C |
| 7 | **Voice-and-text waiter** — Gemini 3.8 Live; Hinglish, barge-in, and typed input over the same session | `lib/ai/*` + `chhotu-assistant` |
| 8 | **A conversation that survives a real order** — session memory, incomplete sentences, follow-ups, corrections (“actually make that three”), several commands in one breath | `system-prompt.ts` + `lib/ai/tools.ts` |
| 9 | **Real tools, not a script** — menu search, dish detail, recommend, compare, cart add/update/remove/clear, fire, status, wait, bill, allergy screen, feedback | `tool-declarations.ts` |
| 10 | **Dish cards with photos** — curated photo, uploaded photo, or a designed fallback plate | `dish-photo` + `food-photos` |
| 11 | **Allergy screening that never certifies safety** — contains / may contain / not listed / not recorded, plus a staff-confirmation caveat | `lib/ai/allergy.ts` |
| 12 | **Bill request** — one tap, persisted server-side, with the split by who ordered what | `sessions/:token/bill-request` |
| 13 | **A kitchen “no” is usable** — a denied ticket shows the reason and offers retry, edit or cancel | `orders/:id/retry` · `requeue` · `dismiss` |
| 14 | **Feedback that reaches the owner** — 1–5 plus a comment, written server-side | `sessions/:token/feedback` |

### 🍳 Kitchen

| # | Feature | Where it lives |
|---|---|---|
| 15 | **Kanban board** — Pending / Preparing / Ready, live over Realtime with a 15 s poll that also self-heals a dead socket | `E10` + channel B |
| 16 | **Allergy-first ticket cards** — the note is the loudest element, with per-line check-off for plating | `kds-card` |
| 17 | **One-tap advance** — sequential state machine enforced in SQL, per-ticket busy guard against double taps | `E11` |
| 18 | **Refusal with a required reason** — the guest reads it and can retry | `kds/tickets/:id/deny` |
| 19 | **Serving closes the ticket** — only from Ready, and it clears the waiter ping in the same transaction | `E12` |
| 20 | **86 from the board** — live catalogue, shared with the floor, greys the dish for every guest | `E14` + `useStaffMenuCatalog` |
| 21 | **Hands-free voice** — one tap to listen, 11 tools covering every board task, spoken confirmation before anything destructive | `kitchen-voice` + `kitchen-tools` |
| 22 | **“Waiter coming” strip** — a floor tap appears at the pass with a chime | `serve-request` + `kds-board` |
| 23 | **Shift arming** — unlocks audio for chimes and registers the device | `E13` |

### 🏃 Floor

| # | Feature | Where it lives |
|---|---|---|
| 24 | **Urgency-sorted room** — ready / cooking / bill tabs, stale-device detection, guest counts | `E17` + `floor-view` |
| 25 | **Take payment → auto-release** — a table is cleared only when paid, with no open ticket and no device heartbeat | `settle` + `007_bill_and_auto_release.sql` |
| 26 | **Unpaid-table guard** — a staff clear is refused `409 BILL_UNPAID` and a manager is alerted; admin is the override | `clear` · `notify` |
| 27 | **“I’ll serve this” / Release** — a real handoff to the kitchen, not a local flag | `floor/tables/:id/serve-request` |

### 🧑‍💼 Manager console

| # | Feature | Where it lives |
|---|---|---|
| 28 | **Its own PIN and role** — `ADMIN_PIN` → `role:"admin"`; tables create, rename, re-code, regenerate QR, clear, deactivate, archive | `admin/tables` |
| 29 | **Catalogue control** — dishes, categories, photos, re-pricing, 86 | `admin/menu` · `admin/categories` |
| 30 | **Insight reads** — daily sales (today vs yesterday vs 7-day), best sellers, pending tickets, occupancy with guest names, inventory, low stock, feedback | `/admin/insights/*` |
| 31 | **Recipe catalogue for the assistant** — ingredients, allergens, spice, diet tags, portion | `insights/menu` |
| 32 | **Read-only assistant** — 8 tools, and no destructive one exists | `admin-assistant` |
| 33 | **Revenue survives a cleared table** — per-dish/day rollup fires on `served`, priced at fire time | `012` + `orders_record_sale_trg` |
| 34 | **A business day that fits a restaurant** — 05:00 → 05:00 IST, so a 2 am order belongs to the night that just ended | `017_business_day_rollup.sql` |

### 🔐 Platform guarantees

| # | Feature | Where it lives |
|---|---|---|
| 35 | **Three credential families** — table capability, shift JWT (kitchen/floor), admin JWT; 401 vs 403 is real | `middleware/auth.ts` |
| 36 | **Realtime is optional** — every channel has a REST path; a dead socket degrades to polling | `lib/api-client/realtime.ts` |
| 37 | **The model never holds a credential** — no assistant tool accepts a token, and the key is released per role | `*/assistant/key` |
| 38 | **Production never fakes data** — the offline demo store is gated off in a production build | `shouldUseDemoFallback()` |
| 39 | **The whole thing is re-runnable** — 19 idempotent migrations, 211 unit tests, 126 contract checks, 81 schema assertions | `sql/` · `scripts/` |

> **Honest state:** stock counts are `untracked` until someone enters them, guest feedback starts empty,
> and the kitchen voice dock needs a Chromium browser with mic permission. The assistants say so rather
> than inventing an answer.

---

## 🎙 Voice & AI surfaces

Three surfaces, **one model** (`gemini-3.8-live`). There is no text model anywhere: typed input
travels over the same Live socket.

| Surface | Persona | Voice | Can it write? |
|---|---|---|---|
| Diner `/table/<code>` | the waiter | **Puck** (warm male) | cart, fire, bill, feedback |
| Kitchen `/kitchen` | a line cook's right hand | **Kore** | tickets, 86, shift |
| Manager `/admin` | an operations analyst | **Aoede** | **no** — read-only by construction |

### Why the kitchen is the interesting one

- **One tap, then talk.** The tap is the browser's gesture; after it the mic streams continuously —
  16 kHz PCM16 mono chunks over the same session, so a cook never touches the screen again.
- The answer is **spoken and written at once**: the transcript under the mic is the same sentence, so
  the dock doubles as a readable log of the shift. Nothing is typed there.
- Every board task has a tool: lanes and ages, one table's ticket, move, serve, deny, 86/restock, the
  86 list, waiter pings, a board re-read and shift arming.
- `deny_ticket` and an 86 do **not** run on the ask. They park a closure; only `confirm_action` after a
  spoken yes can execute it, so a hallucinated `confirm: true` has nothing to fire.
- Tickets are resolved by **table code** (“table four” → `T04`); an ambiguous reference is refused with
  the candidates rather than guessed.

### What the model is never given

- **No token as a tool argument.** The table grant, shift JWT and admin JWT are bound inside each
  runtime's closure by the api-client.
- **No bundled API key.** The backend releases it per role (`/admin/assistant/key`,
  `/kds/assistant/key`, or with the table session), and a wrong role gets 401/403.
- **No destructive console tools.** Archiving a dish or clearing a table is a button a human presses.

Full detail, including the tap-to-talk session and every tool: [`docs/15`](docs/15-voice-assistants-and-insights.md).

---

## 🧑‍🍳 Who it is for

<div align="center">

| 👤 The Diner | 🍳 The Line Chef (Mr. Baawarchi) | 🏃 The Server (Chhotu) |
|---|---|---|
| Scans QR, edits the shared cart, types allergy notes, taps **Review & Fire** | Watches the Kanban, reads bold-red allergy alerts, one-tap status tags | Monitors floor pacing, runs food, 86’s dishes in one tap |
| `/table/[token]` · `/table/[token]/tracker` | `/kitchen` | `/floor` |

</div>

---

## 🏗 System architecture

```mermaid
graph LR
    classDef client fill:#F7EAD7,stroke:#9A7354,stroke-width:2px,color:#3A2A1E
    classDef app fill:#C7A27D,stroke:#3A2A1E,stroke-width:2px,color:#3A2A1E
    classDef api fill:#9A7354,stroke:#3A2A1E,stroke-width:2px,color:#F7EAD7
    classDef data fill:#4169E1,stroke:#1E3A8A,stroke-width:2px,color:#fff
    classDef rt fill:#2ECC71,stroke:#1E7A45,stroke-width:2px,color:#06301A

    D["📱 Diner phone<br/>(shared cart + tracker)"]:::client
    K["🖥️ Kitchen tablet<br/>(KDS Kanban)"]:::client
    F["📟 Floor handheld<br/>(pacing + 86)"]:::client

    N["▲ Next.js 16 App Router<br/>React 19 · Tailwind v4"]:::app
    A["🛠 Express 5 REST API<br/>/api/v1 · zod-validated"]:::api
    P[("🗄️ Postgres<br/>Supabase")]:::data
    R["⚡ Supabase Realtime<br/>(postgres_changes + Presence)"]:::rt

    D -->|REST| N
    K -->|REST| N
    F -->|REST| N
    N -->|fetch + Bearer| A
    A -->|pg pool| P
    P -.->|WAL| R
    R -.->|websocket| D
    R -.->|websocket| K
```

**Three guarantees the architecture makes:**

1. **No business rule lives only in the browser.** Fire, duplicate-guard, inventory check and cart drain happen in *one* Postgres transaction (`fire_order()`).
2. **Realtime is an optimization, never a requirement.** Every subscription has a REST path underneath; a dead socket degrades to polite 5 s polling.
3. **`service_role` never leaves the server.** Browsers hold only the public `anon` key plus a **read-scoped** `realtime_token` whose claims the RLS policies match on.

### Verification scripts

Every claim above is a command anyone can re-run:

| Command | Where | What it proves |
|---|---|---|
| `npm run db:setup` | `backend/` | applies all SQL (idempotent) |
| `npm test` | both apps | isolated unit tests: schemas, JWT, transitions, admin (75) · normalizers, AI tools, kitchen confirmation, menu atlas (136) |
| `npm run db:verify` | `backend/` | 81 assertions: schema, RLS on, policies, indexes, claim-scoping, privileges, hardening |
| `npm run smoke` | `backend/` | 126 contract checks across diner → kitchen → floor → admin |
| `npm run realtime:check` | `frontend/` | Realtime auth, delivery, RLS scoping, Presence |
| `npm run check:floor` | `frontend/` | the floor UI in real headless Chrome |

The three live suites need both servers running (`npm run dev` in each app).

### The data-source ladder (diner + KDS)

```mermaid
flowchart TD
    A["Hook requests data"] --> B{"Backend reachable?"}
    B -->|yes| C["Live REST + Realtime"]
    B -->|"status 0 (down / timeout / unconfigured)"| D["Seeded offline demo store<br/>lib/api · badge shows “demo”"]
    C --> E{"Socket SUBSCRIBED?"}
    E -->|yes| F["Live push"]
    E -->|"no / error after 3 s grace"| G["REST polling every 5 s"]
```

---

## 🔄 Order lifecycle

```mermaid
stateDiagram-v2
    [*] --> pending : fire_order() · E8 · 201
    pending --> preparing : one tap · E11
    preparing --> ready : one tap · E11
    ready --> served : prune · E12
    served --> [*] : table goes “empty”

    note right of pending
        Only ONE active order per table
        (partial UNIQUE index on
         status IN pending/preparing/ready)
    end note
```

**Key rule:** a `served` order **falls out** of the partial unique index, so a closed round
never blocks the table’s next fire — the “cancelled booking must not block re-booking” requirement.

---

## 🧾 Calling for the bill

The last mile of the meal: the diner asks, the floor answers, the table clears.

```mermaid
sequenceDiagram
    participant D as 📱 Diner
    participant API as Express
    participant DB as Postgres
    participant F as 📟 Floor board

    D->>API: POST /sessions/:table_token/bill-request
    API->>DB: bill_status = 'requested'
    F->>API: PATCH /floor/tables/:id/settle
    API->>DB: bill_status = 'paid' → release check
    Note over DB: release only when paid<br/>AND no open ticket<br/>AND no device heartbeat
    D->>API: GET /sessions/:table_token
    API-->>D: paid → “Thank you!”, table empty for the next party
```

| Step | Where it lives |
|---|---|
| **Request** — a receipt glyph beside *Review & fire*; written to `restaurant_tables.bill_status`, so every device sees it | `components/diner/table-cart.tsx` → `bill-request` |
| **Split** — per-person subtotals from `added_by` on each order line | `requestTableBill()` |
| **Settle** — the floor card grows an ember “Bill requested → tap to take payment” row; staff-only | `components/staff/floor-view.tsx` |
| **Release** — the engine clears only when paid, with no open ticket and no device heartbeat | `007_bill_and_auto_release.sql` |
| **Refuse** — clearing an unpaid table is `409 BILL_UNPAID` and raises a manager alert; only admin overrides | `clearFloorTable()` · `notifyFloorTable()` |
| **Thank** — full-screen “Thank you!”, then the table is empty for the next party | `components/diner/diner-table-screen.tsx` |

> **Scope — server-persisted.** The request is a column, not a browser event, so a diner's phone and a
> floor tablet agree across devices. Settlement is a staff action; release is a database decision, not a
> button's opinion.

---

## 🗄 Data model

```mermaid
erDiagram
    restaurant_tables ||--o{ cart_items : "holds cart lines"
    restaurant_tables ||--o{ orders : "places"
    menu_items ||--o{ cart_items : "is added to"
    orders ||--o{ order_items : "contains"
    menu_items ||--o{ order_items : "is sold as"

    restaurant_tables {
        uuid id PK
        text code UK "QR token ^[a-z0-9]{4,16}$"
        text name
        text status "active | empty"
    }
    menu_items {
        uuid id PK
        text name
        numeric price "numeric(10,2) >= 0"
        text category
        boolean is_available "86 flag"
        text description
        boolean vegetarian
    }
    cart_items {
        uuid id PK
        uuid table_id FK
        uuid menu_item_id FK
        int quantity "1..99"
        text request_note "<=500"
        text allergy_note "<=500"
        text added_by "<=40"
        timestamptz created_at
    }
    orders {
        uuid id PK
        uuid table_id FK
        text status "pending|preparing|ready|served"
        timestamptz created_at
        timestamptz updated_at
    }
    order_items {
        uuid id PK
        uuid order_id FK
        uuid menu_item_id FK
        int quantity "1..99"
        text request_note "<=500"
        text allergy_note "<=500"
    }
    staff_terminals {
        uuid id PK
        text device_label
        text role "kitchen | floor"
        boolean is_active
        text pin_env_var "NAME of the env var, never the PIN"
        timestamptz created_at
    }
```

**Delete behaviour:** `cart_items → restaurant_tables` is `CASCADE`; `orders → restaurant_tables`
is `RESTRICT` (history can never be wiped by a table delete); every `→ menu_items` link is `RESTRICT`.

**Indexes** (7 + 1 partial unique): `cart_items_upsert_uq`, `cart_items_table_created_idx`,
`orders_table_status_idx`, `orders_active_idx` (partial), `orders_created_idx`,
`order_items_order_idx`, `menu_items_category_idx`, `orders_one_active_uq` (partial unique).
The DB review in [`docs/10-db-report.md`](docs/10-db-report.md) confirms **zero additional indexes are needed** — every access path is already covered.

---

## 🛠 Backend architecture

```
Request
  → cors(CLIENT_URL only) → express.json(1mb)
  → Router (zod parseOrThrow → service)          E1–E17
  → notFoundHandler → errorHandler  ⟶ { success:false, error:{ code, message, … } }
```

| Layer | Files | Responsibility |
|---|---|---|
| **Config** | `src/config/env.ts` | Validates env at boot; missing/invalid → loud `exit(1)` |
| **DB** | `src/db/pool.ts` | Single shared `pg` Pool (max 10), fatal on idle-client error |
| **Routes** | `src/routes/*.ts` | Thin HTTP → service mapping, contract envelope |
| **Validators** | `src/validation/schemas.ts` | One zod schema per endpoint; failures → `400 VALIDATION_ERROR` with `error.fields` |
| **Services** | `src/services/*.ts` | All business logic + SQL; ownership checks; `AppError`s |
| **Auth** | `src/lib/jwt.ts`, `src/middleware/auth.ts` | Dependency-free HS256 sign/verify, `requireAuth` (401) + `requireRole` (403) |
| **Errors** | `src/errors/app-error.ts`, `middleware/error-handler.ts` | One envelope, no stack traces leaked |

### The atomic fire (E8)

```mermaid
sequenceDiagram
    participant P as 📱 Phone A
    participant Q as 📱 Phone B
    participant API as Express
    participant DB as Postgres

    P->>API: POST /orders/fire
    Q->>API: POST /orders/fire
    API->>DB: SELECT fire_order(token)
    Note over DB: txn 1: lock table row FOR UPDATE<br/>guard → freeze cart → lock menu rows<br/>insert order + items → drain cart
    DB-->>API: OK / jsonb code
    Note over DB: txn 2 waits on the lock,<br/>takes a FRESH snapshot → sees txn 1’s order
    DB-->>API: DUPLICATE_ORDER
    API-->>P: 201 order_id
    API-->>Q: 409 DUPLICATE_ORDER
```

Business outcomes are **returned as `jsonb` codes rather than raised**, so an
`INVENTORY_FAILURE` cart purge still commits — the cart the diner sees always matches the 409 they are told.

---

## 🎨 Frontend architecture

| Layer | Path | Notes |
|---|---|---|
| App Router pages | `app/` | 8 routes: `/`, `/about`, `/presentation`, `/admin`, `/floor`, `/kitchen`, `/table/[token]`, `/table/[token]/tracker` |
| UI primitives | `components/ui/` | 24 reusable components (Button, Card, Modal, Drawer, Toast, Field, EmptyState, …) |
| Diner surfaces | `components/diner/` | menu list, cart modal/strip, allergy input, live tracker |
| Staff surfaces | `components/staff/` | PIN wall, KDS board + cards, floor view, 86 drawer |
| Data runtimes | `hooks/use-live-table.ts`, `hooks/use-live-kds.ts` | Live-first with mock fallback + realtime + polling safety net |
| AI runtimes | `lib/ai/` | Gemini Live session (tap-to-talk), three personas, three tool sets, confirmation state |
| API client | `lib/api-client/` | `apiClient` (20 s timeout, envelope parse, 401 guard), `endpoints` (1 fn per endpoint), `realtime`, `paginate`, `normalize` |
| Offline demo store | `lib/api/` | Seeded store used **only** when the backend is unreachable |
| Design tokens | `app/globals.css` | `@theme` block (Hospitality skin) + an unlayered `[data-skin="ops"]` block that enlarges the kitchen/floor ticket type — palette, type scale, radii, shadows, motion timings |

**Motion:** entrance reveals (`components/motion/reveal.tsx`), status/overlay/card transitions,
transform/opacity-only animations, and `useReducedMotion` respected everywhere.

**Skins:** every surface uses the one Hospitality skin; `/kitchen` and `/floor` add `data-skin="ops"`
to enlarge the ticket type for reading at distance.

---

## ⚡ Realtime channels

| # | Channel | Transport | Payload | Consumers |
|---|---|---|---|---|
| **A** | `table_carts:{table_token}` | `postgres_changes` on `cart_items` | INSERT / UPDATE / DELETE | S1 menu, S2 cart |
| **B** | `kds_orders` | `postgres_changes` on `orders` | INSERT → chime + refetch | S5 board |
| **C** | `order_tracker:{order_id}` | `postgres_changes` on `orders` | UPDATE → colour / green flash | S1, S3 tracker |
| **D** | `table_presence:{table_token}` | Supabase **Presence** | `{ device_id, table_token }` | S1 active-diners badge |
| **E** | `table_updates` | `postgres_changes` on `restaurant_tables` | UPDATE → bill state, session end, **waiter ping** | S1, S3, S5 |

> Realtime needs **all three**: `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`
> (frontend) **and** `SUPABASE_JWT_SECRET` (backend, used to mint the RLS-scoped `realtime_token`).
> Without them the app silently — and safely — runs REST + polling.

---

## 🧰 Tech stack

<table>
<tr><th>Layer</th><th>Technology</th></tr>
<tr><td><b>Frontend</b></td><td>Next.js 16.3.6 (App Router, Turbopack) · React 19.3 · TypeScript 6 strict · Tailwind CSS v4 · <code>motion</code> v13 · lucide-react · Fraunces + Inter via <code>next/font</code></td></tr>
<tr><td><b>Backend</b></td><td>Node ≥ 20 · Express 5.2.1 · <code>pg</code> 8.23 · zod 4.6.5 · TypeScript 6 (<code>tsx</code> dev, <code>tsc</code> build) · zero-dependency HS256 JWT</td></tr>
<tr><td><b>Data</b></td><td>Postgres (Supabase) · SQL migrations · RLS · plpgsql <code>fire_order()</code> RPC</td></tr>
<tr><td><b>Realtime</b></td><td>Supabase Realtime (<code>postgres_changes</code> + Presence) — optional, with REST polling fallback</td></tr>
</table>

**No UI kits, no ORM, no auth provider** — the surface is deliberately small and dependency-light.

---

## 📁 Repository layout

```
.
├── README.md                  ← you are here
├── .gitignore                 ← repo-wide: secrets, logs, build output, noise
├── render.yaml                ← free hosting Blueprint for the API (docs/11-deploy.md)
├── .github/workflows/ci.yml   ← typecheck · lint · build + schema/contract suites
├── backend/                   ← Express REST API (owns all writes)
│   ├── sql/
│   │   ├── 001_init.sql       ← tables, indexes, RLS, fire_order() RPC
│   │   ├── 002_review_fixes.sql ← FK RESTRICT, one-active-order index, scoped RLS
│   │   ├── 003_realtime.sql   ← Realtime publication + REPLICA IDENTITY FULL
│   │   ├── 015–018*.sql       ← catalogue metadata · stock & feedback · business day · waiter ping
│   │   └── seed.sql           ← idempotent: 1 terminal / 5 tables / 23 dishes
│   ├── scripts/
│   │   ├── db-setup.mjs       ← npm run db:setup   (apply every sql/*.sql)
│   │   ├── db-verify.mjs      ← npm run db:verify  (81 schema/RLS/hardening assertions)
│   │   └── smoke.mjs          ← npm run smoke      (126 contract checks)
│   ├── src/
│   │   ├── config/env.ts      ← boot-time env validation (exit 1 if broken)
│   │   ├── db/pool.ts         ← shared pg Pool
│   │   ├── lib/               ← jwt.ts · util.ts
│   │   ├── middleware/        ← auth · not-found · error-handler
│   │   ├── routes/            ← sessions auth menu cart orders kds floor admin health
│   │   ├── services/          ← all business logic + SQL
│   │   ├── validation/        ← zod schemas (one per endpoint)
│   │   └── main: index.ts · app.ts
│   ├── .env.example
│   └── package.json
├── frontend/                  ← Next.js 16 app
│   ├── app/                   ← routes, layout, globals.css, error/not-found
│   ├── components/            ← ui/ · diner/ · staff/ · motion/ · layout/ · brand/
│   ├── hooks/                 ← use-live-table · use-live-kds · use-bills · use-db · use-presence · use-now
│   ├── lib/
│   │   ├── api-client/        ← apiClient · endpoints · realtime · paginate · normalize · types
│   │   ├── ai/                ← Live session, personas, tools, confirmation state
│   │   └── api/               ← offline demo store (fallback only)
│   ├── .env.example
│   └── package.json
└── docs/                      ← 15 design + engineering documents (source of truth)
```

---

## 🚀 Quick start

### Prerequisites

- **Node.js ≥ 20** (backend declares `engines.node >= 20`)
- **A Postgres database** — Supabase project (recommended) or local Postgres 15+
- `psql` on your PATH

### 1 · Install

```bash
cd backend  && npm install
cd ../frontend && npm install
```

### 2 · Create the schema, wire Realtime and seed

```bash
cd backend
npm run db:setup          # applies every sql/*.sql in order
npm run db:verify         # asserts the result (see below)
```

No `psql` needed — the runner uses the `pg` dependency you already have. Every step is **idempotent**, so re-running is always safe: 1 terminal, 5 tables, 23 dishes, no duplicates.

```bash
npm run db:setup -- --dry-run     # list what would be applied
npm run db:setup -- --no-seed     # schema only
npm run db:verify                 # 81 assertions: schema, RLS scope, indexes, privileges, hardening
```

> 🌱 **`db:setup` also wires Supabase Realtime** (`003_realtime.sql`). That step used to be a dashboard click that failed *silently* when skipped — the browser subscribes fine, receives zero events, and the app quietly falls back to REST polling. On a Postgres without `wal_level=logical` it now reports that instead of aborting.

### 3 · Configure environment

```bash
cp backend/.env.example  backend/.env
cp frontend/.env.example frontend/.env.local
# edit both files — see the reference below
```

### 4 · Run

```bash
# terminal 1
cd backend  && npm run dev        # → http://localhost:4000

# terminal 2
cd frontend && npm run dev        # → http://localhost:3000
```

### 5 · Open the surfaces

| Surface | URL | Credential |
|---|---|---|
| Diner menu (seeded QR token) | <http://localhost:3000/table/k7x2p> | none |
| Live order tracker | <http://localhost:3000/table/k7x2p/tracker> | none |
| Kitchen board | <http://localhost:3000/kitchen> | `STAFF_PIN` (example `1234`) |
| Floor view | <http://localhost:3000/floor> | `STAFF_PIN` |
| API liveness | <http://localhost:4000/api/v1/health> | none |

**Going live:** the free path (Next.js on Vercel · API on Render · Postgres on Supabase) is **already
deployed** — see [Live deployment](#-live-deployment). [`docs/11-deploy.md`](docs/11-deploy.md) is the
step-by-step record, including the CORS round-trip, the sleep/cold-start caveat and the verification
commands. Both apps are push-to-deploy on `main`.

---

## 🔐 Environment variables

### `backend/.env`

| Variable | Required | Example | Purpose |
|---|---|---|---|
| `PORT` | no | `4000` | API listen port |
| `NODE_ENV` | no | `development` | `production` adds the `Secure` flag to the KDS cookie |
| `CLIENT_URL` | **yes** | `http://localhost:3000` | CORS allow-list — one origin, or several **comma-separated** (prod domain + Vercel preview URLs). No trailing slash |
| `DATABASE_URL` | **yes** | `postgresql://…` | Postgres/Supabase connection string — server refuses to boot without it |
| `STAFF_PIN` | **yes** | `1234` | 4–6 digit kitchen PIN; validated at boot |
| `ADMIN_PIN` | **yes** | `998877` | 4–6 digit **manager** PIN for `/admin` (`POST /api/v1/auth/admin-login`). Separate from `STAFF_PIN` on purpose — the admin console archives tables and rewrites the catalog. Validated at boot: missing or non-numeric ⇒ the server refuses to start |
| `KDS_TOKEN_SECRET` | **yes** | long random string | HMAC secret for shift JWTs |
| `SUPABASE_JWT_SECRET` | no | from Supabase → Settings → API | When set, E1/E2 also mint the RLS-scoped `realtime_token`. Empty ⇒ REST-only, by design |
| `COOKIE_SAME_SITE` | no | `strict` | `strict` \| `lax` \| `none` for the httpOnly `kds_token` cookie. Use `none` when frontend and API live on **different sites** — it forces `Secure` automatically |
| `GEMINI_API_KEY` | for voice | `AIza…` | The **only** model key. Released per role: diner with a table session, `/admin/assistant/key`, `/kds/assistant/key`. Empty ⇒ every voice surface shows an “assistant is off” notice |

### `frontend/.env.local`

| Variable | Required | Example | Purpose |
|---|---|---|---|
| `NEXT_PUBLIC_API_URL` | **yes** | `http://localhost:4000` | Express base URL, no trailing slash |
| `NEXT_PUBLIC_SUPABASE_URL` | for Realtime | `https://xxx.supabase.co` | Realtime endpoint |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | for Realtime | `eyJ…` | **Public anon key only** — never `service_role` |
| `NEXT_PUBLIC_ENABLE_DEMO_FALLBACK` | no | *(empty)* | Opts back into the offline demo store. **Default: on in `next dev`, off in a production build** — a deployment with a wrong API URL must fail loudly, not render seeded dishes as real orders |
| `STAFF_PIN` | no | `1234` | Used only by the dev-only offline route `app/api/v1/auth/kds-login`, which returns `404` in a production build |

> ⚠️ Never commit `.env` / `.env.local`. Both are gitignored; only the `.env.example` templates are tracked.

---

## 🗃 Database setup

```mermaid
flowchart LR
    A["001_init.sql<br/>tables · indexes · RLS · fire_order()"] --> B["002_review_fixes.sql<br/>FK RESTRICT · one-active-order<br/>claim-scoped RLS"]
    B -->    C["003_realtime.sql<br/>supabase_realtime publication<br/>REPLICA IDENTITY FULL"]
    C --> F["004_hardening.sql<br/>price snapshot · audit timestamps<br/>status-transition guard"]
    F --> D["015–018 + seed.sql<br/>metadata · stock · 23 dishes"]
    D --> E["db:verify<br/>81 assertions"]
```

Run the whole chain with **`npm run db:setup`** — no `psql`, no dashboard clicks, safe to re-run.
`003_realtime.sql` needs `wal_level=logical` (Supabase default). On a plain Postgres it reports the
limitation and skips, and the app correctly degrades to REST + polling instead of failing to set up.

`fire_order(p_table_token text) RETURNS jsonb` is the heart of the system: it locks the table row
(`FOR UPDATE`), guards duplicates, freezes and checks the cart, locks the referenced menu rows
(`FOR UPDATE OF mi`, so 86-ing serializes against it), builds the ticket, and drains only the frozen lines.
It is **revoked from `anon`/`authenticated`** — only the backend’s service path may execute it.

---

## 📡 API reference

**Envelope (every endpoint):**

```jsonc
// success
{ "success": true, "data": { }, "meta": { "page": 1, "limit": 20, "total": 12, "total_pages": 1 } }
// error
{ "success": false, "error": { "code": "SCREAMING_SNAKE_CASE", "message": "…", "fields": { } } }
```

`meta` appears **only** on paginated list endpoints. Full contract: [`docs/7-api-contract.md`](docs/7-api-contract.md).

| # | Method & path | Auth | Screen | Paginated |
|---|---|---|---|---|
| E1 | `POST /api/v1/sessions/initialize` | none | S1 | — |
| E2 | `POST /api/v1/auth/kds-login` | none | S4 | — |
| E2b | `GET /api/v1/auth/me` | staff token (header **or** cookie) | S4/S5 | — |
| E3 | `GET /api/v1/menu` | none | S1 · S5 · S6 | ✅ |
| E4 | `GET /api/v1/cart/items` | none | S1 · S2 | ✅ |
| E5 | `POST /api/v1/cart/items` | none | S1 · S2 | — |
| E6 | `PATCH /api/v1/cart/items/:cart_item_id` | none | S2 | — |
| E7 | `DELETE /api/v1/cart/items` | none | S2 | — |
| E8 | `POST /api/v1/orders/fire` | none | S2 | — |
| E9 | `GET /api/v1/sessions/:table_token/active-check` | none | S1 · S2 · S3 | — |
| E10 | `GET /api/v1/kds/tickets` | staff | S5 | ✅ |
| E11 | `PATCH /api/v1/kds/tickets/:order_id/status` | staff | S5 | — |
| E12 | `PATCH /api/v1/kds/tickets/:order_id/prune` | staff | S5 | — |
| E13 | `POST /api/v1/kds/shift/activate` | staff | S5 | — |
| E14 | `PATCH /api/v1/menu/items/:menu_item_id/availability` | staff | S5 · S6 | — |
| E15 | `GET /api/v1/orders/:order_id/status` | none (`order_id` + `table_token`) | S3 | — |
| E16 | `GET /api/v1/orders` | none | S3 | ✅ |
| E17 | `GET /api/v1/floor/tables` | staff | S6 | ✅ |

### Beyond the E1–E17 contract

Added for the operational and AI layers; same envelopes and the same role checks.

| Method & path | Auth | Purpose |
|---|---|---|
| `GET /api/v1/sessions/:table_token` | none | own table state (bill, session, roster size) |
| `POST /api/v1/sessions/:table_token/bill-request` | none | diner calls for the bill |
| `POST /api/v1/sessions/:table_token/feedback` | none | 1–5 rating the owner can read |
| `PATCH /api/v1/kds/tickets/:order_id/deny` | kitchen | refuse with a reason the guest sees |
| `GET /api/v1/kds/assistant/key` | kitchen | Live key for the kitchen dock |
| `POST /api/v1/floor/tables/:table_id/serve-request` | staff | “I'll serve this” → kitchen ping |
| `DELETE /api/v1/floor/tables/:table_id/serve-request` | staff | Release the ping |
| `GET /api/v1/admin/insights/{sales,best-selling,pending-orders,tables,inventory,menu,feedback}` | admin | console reads and assistant tools |
| `GET /api/v1/admin/assistant/key` | admin | Live key for the console |

**Error-code registry:** `VALIDATION_ERROR` `400` · `INVALID_PIN` `401` · `UNAUTHORIZED` `401`
`FORBIDDEN` `403` · `TABLE_NOT_FOUND` `404` · `MENU_ITEM_NOT_FOUND` `404` · `CART_ITEM_NOT_FOUND` `404`
`ORDER_NOT_FOUND` `404` · `ITEM_UNAVAILABLE` `409` · `EMPTY_CART` `409` · `DUPLICATE_ORDER` `409`
`INVENTORY_FAILURE` `409` · `INVALID_STATUS_TRANSITION` `409` · `NO_READY_TICKET` `409` ·
`BILL_UNPAID` `409` · `NO_OUTSTANDING_BILL` `409` · `TABLE_HAS_ACTIVE_ORDERS` `409` ·
`INTERNAL_ERROR` `500`

---

## 🛡 Security model

| Concern | Mitigation |
|---|---|
| **No login for diners** | The random QR token (`^[a-z0-9]{4,16}$`) **is** the capability credential; it is unguessable and maps to one table |
| **Token never displayed** | The code is a credential, so no diner surface renders it (generic copy only); staff label tables by their human `name`, and only the PIN-gated kitchen board shows the code |
| **Cross-table data leaks** | Three layers: `table_token` resolved server-side, every SQL write re-asserts `AND table_id = $2`, and RLS SELECT policies are claim-scoped (`table_token` claim for diners, `staff` claim for the kitchen) |
| **No token ⇒ no rows** | A browser with only the public `anon` key reads nothing — the old `USING (true)` hole is closed in `002_review_fixes.sql` |
| **Kitchen is PIN-gated** | `STAFF_PIN` compared with `timingSafeEqual`; token is an 8-hour HS256 JWT with an explicit `role: "kitchen"` claim; `requireAuth` → 401, `requireRole` → 403 |
| **Writes bypass RLS only server-side** | `service_role` and `fire_order()` never reach the browser; `anon` has **no** INSERT/UPDATE/DELETE policy |
| **Secrets never echo** | `staff_terminals.pin_env_var` stores the *variable name*; no PIN, secret or stack trace ever appears in a payload or log |
| **Admin is a separate role** | `ADMIN_PIN` issues a `role:"admin"` JWT; a kitchen/floor token gets `403` on `/admin`, and an admin token gets `403` on `/kds` |
| **The model never gets a credential** | No assistant tool accepts a token; each runtime binds the caller's credential, and the Gemini key is released per role — never bundled |
| **Boot fails loudly** | Missing/invalid env → clear message + `exit(1)`, never a half-working server |

---

## ✅ Build & verification

Everything below was run and is green on the current tree:

| Check | Command | Result |
|---|---|---|
| Backend types | `cd backend && npm run typecheck` | ✅ 0 errors |
| Backend build | `cd backend && npm run build` | ✅ clean `dist/` emit |
| **Backend unit tests** | `cd backend && npm test` | ✅ **75/75** — validation schemas, HS256 JWT (tamper/expiry/alg-none), pagination meta, ISO timestamps, Rule-13 matrix, session security, menu metadata, admin |
| Frontend types | `cd frontend && npm run typecheck` | ✅ 0 errors |
| Frontend lint | `cd frontend && npm run lint` | ✅ 0 errors |
| Frontend build | `cd frontend && npm run build` | ✅ 8 routes compiled |
| **Frontend unit tests** | `cd frontend && npm test` | ✅ **147/147** — normalizers incl. the fire-time price snapshot, production demo-fallback gate, menu atlas/photos, bill handoff, diner AI tools, kitchen tools + confirmation flow, waiter pings, catalogue queries |
| **Schema + RLS assertions** | `cd backend && npm run db:verify` | ✅ **81/81** — tables, RLS on, policies, indexes, claim-scoping, privileges, hardening (004), stock + feedback, waiter ping |
| **Contract smoke (live server)** | `cd backend && npm run smoke` | ✅ **126/126** — every endpoint in the real diner → kitchen → floor journey, incl. the frozen bill and denial paths |
| Realtime wiring | `db:setup` on `wal_level=logical` | ✅ publication created, `REPLICA IDENTITY FULL` set |
| Degradation path | `db:setup` on `wal_level=replica` | ✅ reports and skips; app runs REST + 5 s polling |
| Production fallback gate | `next build && next start` | ✅ dev-only login route returns `404` in prod; pages serve `200` |
| **Realtime end-to-end** | `cd frontend && npm run realtime:check` | ✅ **12/12** — token acceptance, delivery, RLS scoping, Presence |
| **Floor view in a browser** | `cd frontend && npm run check:floor` | ✅ **12/12** — headless Chrome over CDP: gate holds, E17 carries the QR code server-side, live board renders the fixture table by name, allergy alert reaches the card |
| **Deployed stack (live)** | CORS preflight + E1→E17 against Vercel + Render | ✅ **27/27** — the real diner→kitchen→tracker journey on the hosted URLs, incl. cross-site cookie flags and the Realtime token |
| Suites are idempotent | `npm run smoke` twice in a row | ✅ **126/126** both times (pre-flight reset) |
| CI | [`.github/workflows/ci.yml`](.github/workflows/ci.yml) | ✅ 3 jobs — typecheck · lint · build, schema verify + smoke against Postgres 17, and the browser E2E for the floor view |

<details>
<summary><b>Production build output</b></summary>

```
Route (app)
┌ ○ /                            (Static)
├ ○ /_not-found
├ ○ /about                       (Static)
├ ○ /admin                       (Static)
├ ○ /floor                       (Static)
├ ○ /kitchen                     (Static)
├ ○ /presentation                (Static)
├ ƒ /table/[token]               (Dynamic)
└ ƒ /table/[token]/tracker       (Dynamic)
```

</details>

---

## 🚦 Project status

**Done:** **39 shipped features** across four surfaces — guest, kitchen, floor and manager — the
17-endpoint contract plus the admin/insights surface, **three voice assistants on one Live model**, the
atomic fire RPC, claim-scoped RLS, a 05:00→05:00 business day, and the design system. Both apps are green
on typecheck · lint · build, with **211 unit tests**, **81 schema/RLS/hardening assertions** and a
**126-check contract smoke** across the whole diner → kitchen → floor → admin journey.

**Closed in this pass:**

| Area | What changed |
|---|---|
| **Realtime wiring** | `003_realtime.sql` adds the streamed tables + `REPLICA IDENTITY FULL`. Previously a manual dashboard step whose omission failed silently; now versioned, idempotent, and asserted by `db:verify` |
| **Realtime delivery bug** | `realtime.ts` authenticated the REST client but **not the websocket** — supabase-js only applies `accessToken` to REST, so the socket connected as `anon`, RLS matched no rows, and every event was dropped with no error while the channel still reported `SUBSCRIBED`. Found by `realtime:check` (variant A delivered nothing, variant B delivered), fixed with an explicit `realtime.setAuth()` at client creation, and guarded by a source assertion so it cannot silently regress |
| **Floor view (S6)** | Now `useLiveFloor` → real E17 data behind a shared PIN gate, with a staff-wide `orders` feed for instant refresh plus a 15 s polling safety net. Allergy alerts come from the new `active_order.items` on E17 |
| **86 drawer** | Reads a **live** catalog via `useStaffMenuCatalog` (E3 with a table token discovered from E17) — previously it could only ever 86 a *seeded* dish. Shared by both staff surfaces |
| **Dead code** | `use-table-data.ts` deleted; `checkActiveOrder` (E9) now used as the diner's documented double-tap guardrail, and `getMe` (E2b) surfaced as a shift-expiry indicator on the KDS header |
| **Production demo gate** | New `shouldUseDemoFallback()` predicate on all 12 fallback paths, plus `NEXT_PUBLIC_ENABLE_DEMO_FALLBACK`. A production build never renders seeded data |
| **Dev-only auth route** | The frontend’s duplicate `kds-login` returns `404` in production and now speaks the contract envelope |
| **Hosting flexibility** | Multi-origin CORS allow-list, `credentials: true`, configurable `COOKIE_SAME_SITE`, `credentials: "include"` on the client — same code works same-site *or* cross-site |
| **Data integrity (004)** | `004_hardening.sql` freezes the bill at fire time (`order_items.unit_price`, `orders.total`), adds trigger-maintained `created_at`/`updated_at` to every table, and enforces Rule 13 with an `enforce_order_status_transition()` trigger — all asserted by `db:verify` §5, including firing a real cart in a rolled-back transaction |
| **Automated verification** | `db:verify` (81 assertions) and `smoke` (126 assertions) replace the hand-run curl sweep |
| **CI** | `.github/workflows/ci.yml` — typecheck, lint, build for both apps, plus schema verify and contract smoke against a real Postgres 17 |
| **Repo hygiene** | Root `.gitignore` (covers `.env`, logs, `.pgdata`, editor noise); `dev.log` can no longer be committed |
| **Ops hardening** | helmet security headers (backend + `next.config.ts`), two-tier rate limiting (10 *failed* PIN attempts / 10 min on `kds-login` — correct PINs never consume budget), ndjson structured logs with `X-Request-Id` correlation (upstream ids honoured), `/api/v1/ready` readiness probe with a cached real Postgres ping, and bounded graceful shutdown on SIGTERM (drain → close pool) — verified live: brute-force gets 429 after 10 tries, SIGTERM drains and exits cleanly |
| **Unit tests** | `node:test` (zero test deps): backend 75 (schemas/JWT/transitions/admin/menu metadata), frontend 147 (normalizers, AI tools, kitchen confirmation, waiter pings, catalogue), both wired into CI |
| **Bill handoff** | “Get bill now” is **server-persisted**: `bill_status` on the table, a staff-only settle, and an auto-release engine that requires paid + no open ticket + no device heartbeat. An unpaid clear is refused with `409 BILL_UNPAID` and raises a manager alert |
| **Voice surfaces** | Diner waiter, kitchen dock and manager console share one Gemini Live runtime (`lib/ai/live-session.ts`), one model and one transcript format; voices are per surface (Puck / Kore / Aoede) |
| **Kitchen voice** | One tap opens the mic — no wake word and nothing typed; deny/86 park an action that only `confirm_action` can run after a spoken yes |
| **Waiter ping** | “I’ll serve this” writes `serve_requested_at` (`sql/018`); the KDS shows a “Waiter coming” strip, watches `restaurant_tables`, and clears the flag on serve/deny |
| **Manager insights + catalogue** | Seven admin insight reads plus `insights/menu` (ingredients, allergens, spice, diet tags) feed a read-only assistant with 8 tools and guest names |
| **Business day** | `sql/017` keys every rollup on `((created_at AT TIME ZONE 'Asia/Kolkata') - interval '5 hours')::date`, so a 2 am order belongs to the night that just ended |
| **Docs** | `README.md` with architecture, ER, state-machine and sequence diagrams |

**Still open:**

| Area | Gap |
|---|---|
| **Coverage gate** | Unit tests cover the highest-risk pure logic; there is no coverage percentage gate in CI yet |
| **Licence** | No LICENSE file (deliberate, for now) |
| **CSP** | `Content-Security-Policy` not yet set on either app — needs nonce plumbing with Next inlines; the rest of the header set is in place |
| **Secrets rotation** | `KDS_TOKEN_SECRET`/`STAFF_PIN`/`ADMIN_PIN` rotation is manual (restart with new values); no dual-secret overlap window |
| **Stock entry UI** | `stock_quantity` / `low_stock_threshold` exist and the assistant reads them, but there is no screen yet to enter counts — so every dish reports `untracked` |
| **Voice QA** | The tool layer and confirmation flow are pinned by tests; real playback and mic capture need a Chromium browser with a mic tap, so rehearse on the demo machine |
| **Transcription dependency** | The written transcript is Live `inputTranscription`; if it never arrives the cook still hears the answer and the tool still runs, but the log line is missing |

Full engineering detail lives in the [docs index](#-documentation-index) — especially
[`docs/10-db-report.md`](docs/10-db-report.md) §4 and [`docs/9-integration-report.md`](docs/9-integration-report.md).

---

## 📚 Documentation index

| Doc | Contents |
|---|---|
| [`docs/1-real-problems.md`](docs/1-real-problems.md) | The 5 real restaurant problems + gap analysis of Toast/Square/me&u |
| [`docs/2-mvp-ideation.md`](docs/2-mvp-ideation.md) | Value proposition, core features, innovations, DB blueprint |
| [`docs/3-user-workflow.md`](docs/3-user-workflow.md) | Mermaid flows for diner, chef and server |
| [`docs/4-architectural-mapping.md`](docs/4-architectural-mapping.md) | Feature → endpoint → tables mapping |
| [`docs/5-ui-ux-blueprint.md`](docs/5-ui-ux-blueprint.md) | Screen map and design language |
| [`docs/6-frontend-report.md`](docs/6-frontend-report.md) | Frontend build + browser QA report |
| [`docs/7-api-contract.md`](docs/7-api-contract.md) | **The API contract** — envelopes, E1–E17, errors, channels |
| [`docs/8-backend-report.md`](docs/8-backend-report.md) | Backend build + live endpoint verification |
| [`docs/9-integration-report.md`](docs/9-integration-report.md) | Frontend ↔ API integration report, 18/18 smoke |
| [`docs/10-db-report.md`](docs/10-db-report.md) | Senior-DB review: rules → constraints, indexes, hygiene audit |
| [`docs/11-deploy.md`](docs/11-deploy.md) | Free deployment: Vercel + Render + Supabase, push-to-deploy, verification |
| [`docs/12-codebase-guide.md`](docs/12-codebase-guide.md) | Every file, and why it exists |
| [`docs/13-data-model.md`](docs/13-data-model.md) | Tables, tokens and payloads that move between those files |
| [`docs/14-issue-audit.md`](docs/14-issue-audit.md) | Issue audit and the fixes behind them |
| [`docs/15-voice-assistants-and-insights.md`](docs/15-voice-assistants-and-insights.md) | **The three Gemini Live surfaces** — diner waiter, kitchen voice, manager console; tap-to-talk, chef tools, insight endpoints, the 05:00 business day and the waiter ping |

---

<div align="center">

**AeyChhotu!** — *one table, one order, live from the kitchen.* 🍛

Built with Next.js, Express and Postgres/Supabase.

</div>
