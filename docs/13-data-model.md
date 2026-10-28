# 13 — Data Model (tables, payloads, tokens, local state)

The canonical wire contract is [7-api-contract.md](./7-api-contract.md) and the
canonical schema is `backend/sql/`. This document is the one-page version: the
shapes you will actually hold in your hands while working, and the rules that
make them safe. For "which file does what", see
[12-codebase-guide.md](./12-codebase-guide.md).

---

## 1. The response envelope

Every response — success or failure — has a `success` flag.

```jsonc
// success
{ "success": true, "data": { /* resource */ }, "meta": { /* list endpoints only */ } }

// failure
{ "success": false, "error": { "code": "INVENTORY_FAILURE", "message": "…", /* case fields */ } }
```

`meta` (lists only):

```jsonc
{ "page": 1, "limit": 20, "total": 23, "total_pages": 2 }
```

`limit` is capped at **100** on the server, so any client that reads only page 1
silently loses rows — that is why `lib/api-client/paginate.ts` exists.

### Error registry (status · code · what a client should do)

| Status | Code | Meaning / client action |
| --- | --- | --- |
| 400 | `VALIDATION_ERROR` | Bad payload. `error.fields` holds per-field messages. |
| 401 | `UNAUTHORIZED` | No/expired staff token → show the PIN wall. |
| 401 | `INVALID_PIN` | Wrong staff PIN. |
| 401 | `INVALID_ADMIN_PIN` | Wrong manager PIN. |
| 401 | `INVALID_SESSION_PIN` | Wrong table PIN. `attempts_remaining` tells the guest how many tries are left. |
| 401 | `INVALID_SESSION_SECRET` | A pass that does not match this table. |
| 403 | `FORBIDDEN` | Valid token, wrong role (kitchen token on an admin route). |
| 403 | `SESSION_ENDED` | The table was settled; the stored pass is worthless → "scan again". |
| 404 | `NOT_FOUND` | Unknown route. |
| 404 | `TABLE_NOT_FOUND` | Unknown table code. |
| 404 | `CART_ITEM_NOT_FOUND` | Missing **or** another table's line — deliberately indistinguishable. |
| 404 | `MENU_ITEM_NOT_FOUND` | Unknown dish (admin/86). |
| 404 | `ORDER_NOT_FOUND` | Missing **or** another table's order. |
| 409 | `DUPLICATE_ORDER` | This table already has a live ticket. |
| 409 | `EMPTY_CART` | Nothing to fire. |
| 409 | `INVENTORY_FAILURE` | One or more dishes 86'd between add and fire. `error.sold_out` names them; the cart purge still commits. |
| 409 | `ITEM_UNAVAILABLE` | The dish is already 86'd. |
| 409 | `INVALID_STATUS_TRANSITION` | Illegal ticket step (e.g. pending → ready). |
| 423 | `TABLE_PIN_LOCKED` | Three wrong PINs — the keypad is withdrawn; a Table Pass is the only way in. |
| 429 | `RATE_LIMITED` | Login limiter (10 failed tries / 10 min) or the broad API limiter. |
| 500 | `INTERNAL_ERROR` | `error.request_id` matches the server log line. |

Transport-only codes raised by the **client** (never by the server):
`TIMEOUT`, `NETWORK_ERROR`, plus `CONFIG_ERROR` when
`NEXT_PUBLIC_API_URL` is missing.

---

## 2. Database schema

Six tables. Names are the wire names — the client never renames a field.

### `restaurant_tables` — a physical table and its live session

| Column | Type | Notes |
| --- | --- | --- |
| `id` | uuid PK | `gen_random_uuid()` |
| `code` | text | **unique**, `^[a-z0-9]{4,16}$` — the value in `/table/<code>` and the QR |
| `name` | text | human label ("Window four-top") |
| `status` | text | `active` \| `empty` (default `empty`) |
| `session_pin` | varchar(2) | `'00'`–`'99'`, **null when no session** |
| `session_secret` | varchar(20) | the 20-char Table Pass, null when no session |
| `failed_pin_attempts` | integer | `0..3`, table-wide (not per device) |
| `session_started_at` | timestamptz | null when no session |
| `created_at`, `updated_at` | timestamptz | `updated_at` maintained by trigger |
| `deleted_at` | timestamptz | **archive**, not delete. `NULL` = live |

`status='active'` and a non-null `session_*` pair are the same fact, and settle
sets both: status back to `empty`, PIN/pass/counter/started_at cleared.

### `menu_items` — the catalog

| Column | Type | Notes |
| --- | --- | --- |
| `id` | uuid PK | |
| `name` | text | unique among live rows (enforced in the service) |
| `price` | numeric(10,2) | `>= 0` |
| `category` | text | default `'Main Course'`; drives the menu atlas |
| `is_available` | boolean | false = **86'd**. The dish still appears, greyed out |
| `description` | text | default `''` |
| `vegetarian` | boolean | the only diet flag on the wire |
| `created_at`, `updated_at` | timestamptz | |
| `deleted_at` | timestamptz | archive; archived dishes leave the diner menu but history keeps pointing at them |

### `cart_items` — the shared, unfired order

| Column | Type | Notes |
| --- | --- | --- |
| `id` | uuid PK | |
| `table_id` | uuid → `restaurant_tables(id)` | `ON DELETE CASCADE` |
| `menu_item_id` | uuid → `menu_items(id)` | `ON DELETE RESTRICT` |
| `quantity` | integer | `1..99` |
| `request_note` | text | `<= 500`, default `''` |
| `allergy_note` | text | `<= 500`, default `''` — **the value the kitchen ticket shouts** |
| `added_by` | text | `<= 40`, default `'Guest'` |
| `created_at`, `updated_at` | timestamptz | |

The **logical line** is `(table_id, menu_item_id, request_note, allergy_note)`.
That quartet is a unique index, so two phones adding "Masala Dosa" merge into
one line instead of forking.

### `orders` — one fired round

| Column | Type | Notes |
| --- | --- | --- |
| `id` | uuid PK | |
| `table_id` | uuid → `restaurant_tables(id)` | `ON DELETE RESTRICT` — history must survive |
| `status` | text | `pending` \| `preparing` \| `ready` \| `served` |
| `total` | numeric(10,2) | **frozen at fire time**, not null, default 0 |
| `created_at`, `updated_at` | timestamptz | |

### `order_items` — the ticket lines (immutable snapshot)

| Column | Type | Notes |
| --- | --- | --- |
| `id` | uuid PK | |
| `order_id` | uuid → `orders(id)` | `ON DELETE CASCADE` |
| `menu_item_id` | uuid → `menu_items(id)` | `ON DELETE RESTRICT` |
| `quantity` | integer | `1..99` |
| `request_note`, `allergy_note` | text | `<= 500` |
| `unit_price` | numeric(10,2) | **the price charged**, frozen at fire |
| `created_at` | timestamptz | |

Dish **names are read live** from `menu_items` (a rename shows through), but
**money is frozen** (`unit_price`, `orders.total`): re-pricing a dish must never
rewrite last week's bill.

### `staff_terminals` — the master terminal

| Column | Type | Notes |
| --- | --- | --- |
| `id` | uuid PK | becomes the `terminal_id` claim |
| `device_label` | text | |
| `role` | text | `kitchen` \| `floor` |
| `is_active` | boolean | |
| `pin_env_var` | text | the **name** of the env var holding the PIN (never the value) |
| `created_at` | timestamptz | |

---

## 3. Indexes and what each one protects

| Index | Shape | Why |
| --- | --- | --- |
| `cart_items_upsert_uq` | UNIQUE `(table_id, menu_item_id, request_note, allergy_note)` | Makes concurrent "add" taps merge via `ON CONFLICT` instead of duplicating. |
| `cart_items_table_created_idx` | `(table_id, created_at, id)` | Stable pagination of a table's cart. |
| `orders_one_active_uq` | UNIQUE `(table_id)` **WHERE** `status IN ('pending','preparing','ready')` | The database half of the duplicate-fire guard. A served round falls out of the index, so the next fire is allowed. |
| `orders_active_idx` | `(status)` **WHERE** `status <> 'served'` | The kitchen board only ever reads live tickets. |
| `orders_created_idx` | `(created_at DESC, id DESC)` | Newest-first history. |
| `orders_table_status_idx` | `(table_id, status)` | "Does this table have a live order?" |
| `order_items_order_idx` | `(order_id)` | Ticket assembly. |
| `menu_items_category_idx` | `(category)` | Menu grouping. |
| `restaurant_tables_active_idx` | `(code)` **WHERE** `deleted_at IS NULL` | Archived tables never slow a QR lookup. |
| `menu_items_active_idx` | `(category)` **WHERE** `deleted_at IS NULL` | Same, for the catalog. |

---

## 4. Functions and triggers

| Object | What it guarantees |
| --- | --- |
| `set_updated_at()` | `BEFORE UPDATE` on `orders`, `menu_items`, `restaurant_tables`, `cart_items` — `updated_at` is never a client's business. |
| `enforce_order_status_transition()` | `BEFORE UPDATE` on `orders`. Allows only `pending→preparing`, `preparing→ready`, and `*→served`. Anything else raises `check_violation`, so a buggy client cannot skip the kitchen. |
| `fire_order(p_table_token text)` | The whole fire in **one transaction**: lock the table row → reject a second live order → copy cart lines into `order_items` with `unit_price` from `menu_items` → verify availability → compute `orders.total` → drain the cart. Business outcomes come back as jsonb codes, so an `INVENTORY_FAILURE` purge still commits. |

Because `fire_order` is the only writer of `orders`/`order_items`, "one tap, one
ticket" holds even under simultaneous taps from two phones.

---

## 5. Access control in the database

* RLS is **enabled on every table**; there are no permissive gaps.
* `service_role` (the API's own connection) reads/writes everything — the API
  enforces ownership in `services/ownership.ts` before it ever reaches SQL.
* Browser roles (`anon`, `authenticated`) are claim-scoped: a diner read token
  can only see rows for its own `table_token`, a staff token only the staff
  surfaces. `002_review_fixes.sql` is where those predicates were tightened.
* `005_table_session_security.sql` **revokes** table-wide `SELECT` on
  `restaurant_tables` and re-grants an explicit column list that **excludes**
  `session_pin` and `session_secret`. `006` adds the one new column
  (`deleted_at`) to that grant deliberately — a new column is denied until
  someone grants it, which is the fail-closed behaviour we want.

Consequence: no browser, however it is configured, can read a table's PIN or
pass. Only the API (service role) can.

---

## 6. Credentials

### 6.1 Table session (diner)

| Value | Shape | Lifetime |
| --- | --- | --- |
| `session_pin` | 2 digits, `'00'`–`'99'` | minted when a table is claimed; typed once per guest device |
| `session_secret` | 20 chars | held only by devices that already joined; the QR pass and the reconnect credential |
| `failed_pin_attempts` | `0..3` | table-wide; at 3 the table is **locked** (423) |

Rules:

* First scan of an `empty` table → `status:"active"` + both credentials.
* Scan of an `active` table → `locked`, **no credentials and no read token**.
* `join-pin` compares the PIN; a wrong one increments the counter and answers
  `401 INVALID_SESSION_PIN` with `attempts_remaining`; the third answers
  `423 TABLE_PIN_LOCKED`.
* `join-pass` with the 20-char secret unlocks **and clears** the counter.
* `reconnect` presents the secret with no keypad; after settle it answers
  `403 SESSION_ENDED`.
* Settle (prune of the last live order, or the admin/bill settle) sets
  `status='empty'` and **nulls PIN, secret, counter and started_at** — the next
  party starts from a genuinely fresh pair.

The frontend stores this record locally:

```ts
// localStorage["aeychhotu.table_session.v1"]
{
  table_token: string,       // the code in the URL
  table_id: string,
  session_pin: string,       // "00".."99"
  session_secret: string,    // 20 chars
  session_started_at: string | null
}
```

### 6.2 Staff and admin JWTs (HS256, shared secret `KDS_TOKEN_SECRET`)

```ts
{ role: "kitchen" | "admin", terminal_id: string | null, iat: number, exp: number }
```

| Token | TTL | Cookie | Header | Local storage |
| --- | --- | --- | --- | --- |
| Kitchen/floor shift | 8 h | `kds_token` (httpOnly) | `Authorization: Bearer` | `aeychhotu.kds_token` |
| Manager | 8 h | `admin_token` (httpOnly) | `Authorization: Bearer` | `aeychhotu.admin_token` |

The role lives in the claim, and `requireRole()` checks it on every request —
so a kitchen token can never call `/api/v1/admin/*`, and the two tokens live in
separate storage keys so neither can overwrite or outlive the other.

### 6.3 Supabase read token (Realtime only)

When `SUPABASE_JWT_SECRET` is configured, `E1`/`E2` also return
`realtime_token`: a token signed with the **Supabase** secret carrying
`{ role, table_token | staff }`. It is scope, not a secret — it can only read
the rows RLS already allows, and it is what Realtime attaches to a channel.
Absent when the app runs REST-only.

---

## 7. Resource payloads

### Diner side

```ts
// E3 menu item
{ menu_item_id, name, price, category, is_available, description, vegetarian }

// E4 cart line
{ id, table_id, menu_item_id, quantity, request_note, allergy_note, added_by }

// E5/E6 cart line result
CartLine & { total_table_quantity: number }

// E1 claim / join (credentials are the diner's own)
{ table_id, code, name, status: "active",
  session_pin, session_secret, session_started_at, realtime_token }

// E1 scan of an occupied table (no credentials, ever)
{ table_id, code, name, status: "locked",
  pin_locked, attempts_remaining, realtime_token: null }

// E8 fired order
{ order_id, table_id, status, created_at, message }

// E9 anti-duplicate guardrail (union)
{ has_active_order: true,  order_id, status, message }
{ has_active_order: false, message }

// E15 status poll
{ order_id, table_id, status, created_at }

// E16 history row
{ order_id, table_id, status, created_at, total, items: OrderItemLine[] }
```

```ts
// A ticket line, shared by KDS tickets, floor rows and history
{
  menu_item_id: string,
  name: string,          // joined LIVE from menu_items
  quantity: number,
  request_note: string,
  allergy_note: string,  // the kitchen's alarm
  unit_price?: number    // the price CHARGED at fire time
}
```

### Kitchen side

```ts
// E10 ticket
{ order_id, table: { id, code, name }, status: "pending"|"preparing"|"ready",
  created_at, items: OrderItemLine[] }

// E11 result            { order_id, status }
// E12 prune result      { order_id, status: "served", table_cleared: boolean }
// E13 shift activation  { device_id, audio_armed: true, message }
```

### Floor side

```ts
// E17 row
{
  table_id, code, name, status: "active"|"empty",
  active_order: { order_id, status, created_at, items?: OrderItemLine[] } | null,
  cart_line_count: number
}
```

`active_order.items` is why a runner can see a table's allergy alerts without
opening the kitchen board.

### Admin side

```ts
// AdminTable
{ table_id, code, name, status, active_order_count, cart_line_count,
  has_session, session_started_at, created_at }

// AdminMenuItem = MenuItem
// AdminTableToken (regenerate)
{ table_id, code, name }

// AdminAnalytics
{ items: { menu_item_id, name, category, total_sold, total_revenue }[],
  total_revenue, total_orders_served, active_tables_count }
```

### Request payloads worth remembering

```ts
// E5
{ table_token, menu_item_id, quantity?, allergy_note?, request_note?, added_by? }

// E6 — absolute OR delta, never both needed
{ table_token, quantity?, quantity_delta?, request_note?, allergy_note? }

// E7
{ table_token, cart_item_id }

// E1b / E1c / E1d
{ table_token, pin }            // exactly two digits
{ table_token, secret }         // 20 chars
{ table_token, secret }

// E2 / E2c
{ pin }
```

`quantity_delta` is applied atomically in SQL (`quantity = quantity + delta`),
so two phones pressing + at the same moment cannot lose an increment.

---

## 8. Frontend local state

| Key | Shape | Purpose |
| --- | --- | --- |
| `aeychhotu.table_session.v1` | `{ table_token, table_id, session_pin, session_secret, session_started_at }` | reconnect without retyping; the QR pass payload |
| `aeychhotu.table_token` | string | last table opened (device convenience) |
| `aeychhotu.diner_name` | string | "Ordering as" name, sent as `added_by` |
| `aeychhotu.device_id` | string | stable per browser, used for presence |
| `aeychhotu.kds_token` | string | staff bearer copy |
| `aeychhotu.admin_token` | string | manager bearer copy (separate key) |
| `aeychhotu.bills.v1` | `{ [tableCode]: { requested_at, requested_by, settled_at } }` | "can we have the bill?" across tabs |
| `aeychhotu.db.v1` | `{ cart, orders, presence, tables, menu }` | the local operational store + cross-tab transport |

Cross-tab transport is `BroadcastChannel` (bills, store) — the same shape as a
Realtime subscription, which is why screens render from a `subscribe()` channel
in both the demo and the live path.

### Realtime channels (Supabase)

| Channel | Table / events | Consumer |
| --- | --- | --- |
| `table_carts:{table_token}` | `cart_items` INSERT/UPDATE/DELETE | diner menu + cart |
| `kds_orders` | `orders` INSERT | kitchen chime + refetch |
| `order_tracker:{order_id}` | `orders` UPDATE | tracker status flips |

Every channel is a **hint to refetch**, not a second source of truth: the REST
response is always what renders. When a channel is unavailable the screens fall
back to polling and say so, rather than freezing.

---

## 9. Invariants (break these and the product lies)

1. **One live order per table.** Enforced by `orders_one_active_uq` and by
   `fire_order()`; the client's E9 check is only a courtesy.
2. **Money is frozen at fire.** `order_items.unit_price` and `orders.total`
   never change; `menu_items.price` changes only affect future fires.
3. **Status only moves forward.** `pending → preparing → ready`, and `served`
   only through prune. The trigger rejects anything else.
4. **Credentials never travel upward.** No staff or admin payload contains
   `session_pin` or `session_secret`; the database revokes those columns from
   browser roles. Only the diner's own join/claim response carries them.
5. **A settled table holds nothing.** Status `empty`, both credentials null,
   counter 0, cart drained.
6. **A foreign id is a 404, never a 403.** Existence of another table's cart
   line or order is not disclosed.
7. **Deletes are archives.** `deleted_at` keeps history valid; nothing
   `DELETE`s a table or a dish that an old ticket points at.
8. **The UI never invents data.** Every board renders the API's rows or an
   error state with Retry — a seeded fallback would send a cook to a table that
   is not there.
