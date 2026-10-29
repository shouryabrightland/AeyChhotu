# 📑 API Contract Specifications: AeyChhotu! MVP (v2)

This contract defines the complete interaction layer for the **AeyChhotu!** order management system built on **Next.js (App Router)** and **Supabase**. It covers every REST endpoint, the response envelope, validation rules, the error-code registry, auth tiers, and the Supabase Realtime channel patterns.

**Sources of truth reconciled in this version:** `docs/2-mvp-ideation.md` (Database Tables blueprint), `docs/3-user-workflow.md`, `docs/4-architectural-mapping.md`, `docs/5-ui-ux-blueprint.md` (Screen Map), `docs/6-frontend-report.md`, and the existing frontend service layer (`frontend/lib/api/*`).

---

## 📝 Changelog — what was corrected in v2

| # | v1 issue | v2 correction | Why |
|---|---|---|---|
| 1 | Mixed envelopes (`{success, …fields}`, `{ok:true}`, `error` as a plain string) | One success envelope `{success, data, meta?}` and one error envelope `{success:false, error:{code, message, …}}` for **every** endpoint | Rule: same response envelope everywhere; rule: every failure carries `error.code` |
| 2 | Enum field `status_tag` with Title Case (`Pending`) | Field renamed to **`status`** with lowercase values (`pending, preparing, ready, served`) | DB blueprint: `orders: id, table_id, status (pending, preparing, ready, served)`; matches existing frontend `OrderStatus` type |
| 3 | `table_number` in session + KDS payloads | Replaced with **`code`** and **`name`** | Blueprint `restaurant_tables` has no `table_number` column |
| 4 | `normal_note` | Renamed to **`request_note`** | Blueprint: `cart_items.request_note`, `order_items.request_note` |
| 5 | `item_name` on KDS tickets | Renamed to **`name`** (joined from `menu_items`) | Blueprint: `menu_items.name` |
| 6 | POST /cart response `cart_item_id` | Row now serialized as **`id`** (the PK) | `cart_item_id` exists nowhere in the blueprint; it is kept only as the **request parameter** name |
| 7 | No pagination on list endpoints | `?page=&limit=` + `meta{page,limit,total,total_pages}` on all 5 list endpoints | Rule: list endpoints paginated |
| 8 | Missing endpoints: cart read, cart update, order history, floor view, shift activation | Added E4, E6, E16, E17, E13 | `fetchFloorSummaries`, `updateCartLine`, `getOrdersForTable`, `POST /kds/shift/activate` exist in the codebase/`docs/4` but had no endpoint in v1 |
| 9 | KDS login returned no usable token; staff endpoints had no auth | kds-login returns a signed `token`; all staff endpoints require `Authorization: Bearer <token>` | Contract v1 promised a JWT; security rule: staff endpoints must be guarded |
| 10 | Example prices inconsistent with seed data (120/250) | Corrected to seed prices (180/320/…) | `frontend/lib/api/seed.ts` is the codebase's menu source |
| 11 | Table status `Active/Empty` floats with no column | Kept, lowercase `active/empty`, **flagged as a required blueprint addition** (see §6) | `docs/4` pruning feature requires it; blueprint omits it |
| 12 | No floor-view screen coverage, Screen Map missing Screen 6 | Screen Map extended to 6 screens (see §1.6) | `/floor` exists in code, `docs/3`, and `docs/6` |

---

## 1. Global Rules & Standards

### 1.1 Response envelope (identical on every endpoint)

**Success:**
```json
{
  "success": true,
  "data": { },
  "meta": { "page": 1, "limit": 20, "total": 12, "total_pages": 1 }
}
```
- `data` is an object or an array. `meta` appears **only** on paginated list endpoints (§1.5).

**Error:**
```json
{
  "success": false,
  "error": {
    "code": "SCREAMING_SNAKE_CASE",
    "message": "Human-readable English copy safe to show in the UI.",
    "fields": { "quantity": "Must be an integer between 1 and 99." }
  }
}
```
- `error.code` is mandatory on **every** non-2xx response.
- `error.fields` is present only on `VALIDATION_ERROR`.
- Case-specific error details (`sold_out`, `order_id`, `current_status`, …) are extra keys **inside** `error`.

### 1.2 Field-naming rule (DB blueprint is law)

Response payload fields must be names taken verbatim from the blueprint:

| Table | Blueprint columns |
|---|---|
| `restaurant_tables` | `id`, `code`, `name` (+ `status` — see §6) |
| `menu_items` | `id`, `name`, `price`, `category`, `is_available` (+ `description`, `vegetarian` — see §6) |
| `cart_items` | `id`, `table_id`, `menu_item_id`, `quantity`, `request_note`, `allergy_note` (+ `added_by` — see §6) |
| `orders` | `id`, `table_id`, `status`, `created_at` |
| `order_items` | `id`, `order_id`, `menu_item_id`, `quantity`, `request_note`, `allergy_note` |

**Addressing vocabulary (request side).** Parameters that address a row use FK-style names that resolve 1:1 to a primary key. These are the only non-column field names allowed:

| Parameter | Resolves to |
|---|---|
| `table_token` | `restaurant_tables.code` (the QR link token; alias documented once, used everywhere) |
| `menu_item_id` | `menu_items.id` (also a literal blueprint column) |
| `order_id` | `orders.id` (also a literal blueprint column) |
| `cart_item_id` | `cart_items.id` |

**Response-side identity fields:** a serialized order uses `order_id`, a menu row uses `menu_item_id`, a table uses `table_id`, a cart row uses `id` (its PK). Protocol/computed fields (`success`, `data`, `meta`, `error`, `message`, `has_active_order`, `table_cleared`, `total_table_quantity`, `audio_armed`, `token`, `sold_out`, `fields`) are exempt from the column rule.

**Money:** `price` is a JSON number with 2 decimals, in ₹ (INR). No currency field is sent.
**Timestamps:** ISO-8601 UTC strings, e.g. `"2026-09-27T21:35:00Z"`.

### 1.3 Enums

| Enum | Values (lowercase, exact) |
|---|---|
| `orders.status` | `pending` \| `preparing` \| `ready` \| `served` |
| `restaurant_tables.status` | `active` \| `empty` |

State machine: `pending → preparing → ready → served`. `served` is only ever set by the prune endpoint (E12).

### 1.4 Authentication tiers

| Tier | Who | Mechanism |
|---|---|---|
| **none** (anonymous diner) | Any phone scanning the QR | No header. `table_token` is the session capability credential, passed as query param or body field. Tokens are random and unguessable (`^[a-z0-9]{4,16}$`). |
| **logged-in user** (staff) | Kitchen tablet / floor handheld | `Authorization: Bearer <kds_token>` (or the httpOnly `kds_token` cookie) on every staff endpoint. Token is an HMAC-SHA256 JWT issued only by E2 after the `STAFF_PIN` env-var match, carrying explicit claims `{ role: "kitchen", terminal_id, iat, exp }`, 8-hour expiry. `requireAuth` → 401; `requireRole('kitchen')` → 403 on role mismatch. Identity is readable at E2b. |
| **admin** | — | **No admin API exists in the MVP.** Menu and tables are seeded directly in the Supabase dashboard (`docs/2`). The `service_role` key must never leave the server; browsers only ever hold the public `anon` key plus RLS. |

Endpoints by tier: staff = E10, E11, E12, E13, E14, E17. Everything else = none.

### 1.5 Pagination (all list endpoints)

| Param | Type | Required | Rules | Default |
|---|---|---|---|---|
| `page` | integer | no | `≥ 1` | `1` |
| `limit` | integer | no | `1 – 100` | `20` |

- `meta = { page, limit, total, total_pages }`, `total_pages = ceil(total / limit)`.
- A `page` beyond the last returns `200` with `data: []` and accurate `meta` (never 404).
- Paginated endpoints: **E3 (menu), E4 (cart items), E10 (KDS tickets), E16 (orders), E17 (floor tables)**.

### 1.6 Screen Map (who consumes what)

| ID | Screen | Route |
|---|---|---|
| S1 | Diner Menu & Shared Cart View | `/table/[token]` |
| S2 | Diner Checkout Confirmation Modal | overlay on S1 (cart button) |
| S3 | Diner Live Progress Tracker | `/table/[token]/tracker` |
| S4 | Kitchen Authentication Wall | `/kitchen` |
| S5 | Kitchen Kanban Display Dashboard | `/kitchen` (post-login) |
| S6 | Floor View (Chhotu, server handheld) | `/floor` |

> S3's route is `—` and S5 shares `/kitchen` in `docs/5`; S6 is missing from `docs/5` entirely but exists in code, `docs/3`, and `docs/6`. This list is the corrected Screen Map.

### 1.7 Validation rules (apply to every endpoint)

- `Content-Type: application/json` is required on all mutating requests (`POST`, `PATCH`, `DELETE`); missing/malformed JSON → `400 VALIDATION_ERROR`.
- Unknown body fields are ignored (forward compatible).
- Strings are trimmed; empty optional notes normalize to `""`.
- Shared constraints:

| Field | Type | Rules |
|---|---|---|
| `table_token` | string | required where listed; `^[a-z0-9]{4,16}$`; must exist (else `404 TABLE_NOT_FOUND`) |
| `pin` | string | required; `^\d{4,6}$` |
| `menu_item_id`, `order_id`, `cart_item_id` | string | required; UUID v4 |
| `quantity` | integer | `1 – 99` (default `1` on E5) |
| `request_note`, `allergy_note` | string | `≤ 500` chars |
| `added_by` | string | `≤ 40` chars, default `"Guest"` |
| `is_available` | boolean | required |
| `device_id` | string | required, `1 – 64` chars |

### 1.8 Error-code registry

| `error.code` | HTTP | Meaning |
|---|---|---|
| `VALIDATION_ERROR` | 400 | Payload/query failed §1.7. Includes `error.fields`. |
| `TABLE_NOT_FOUND` | 404 | `table_token` does not resolve to a table. |
| `MENU_ITEM_NOT_FOUND` | 404 | `menu_item_id` does not exist. |
| `CART_ITEM_NOT_FOUND` | 404 | `cart_item_id` does not exist **for this table** (mismatched table returns the same 404 — never leak existence). |
| `ORDER_NOT_FOUND` | 404 | `order_id` does not exist. |
| `INVALID_PIN` | 401 | PIN does not match `STAFF_PIN`. |
| `UNAUTHORIZED` | 401 | Missing, malformed, invalid, or expired staff token. |
| `FORBIDDEN` | 403 | Valid shift token whose `role` claim is not `kitchen` (role gate on admin/kitchen changes). |
| `ITEM_UNAVAILABLE` | 409 | Item was 86'd between adding to cart and the add request. |
| `EMPTY_CART` | 409 | Fire attempted with zero cart lines. |
| `DUPLICATE_ORDER` | 409 | Table already has an order in `pending/preparing/ready`. Carries `error.order_id`, `error.status`. |
| `INVENTORY_FAILURE` | 409 | Sold-out detected during fire. Carries `error.sold_out: string[]`. |
| `INVALID_STATUS_TRANSITION` | 409 | Non-sequential status tap or prune out of turn. Carries `error.current_status`, `error.requested_status`. |
| `INTERNAL_ERROR` | 500 | Unexpected failure. Never leaks stack traces. |

### 1.9 Global design rules

- Diners never log in; kitchen staff are guarded by the PIN-issued token (§1.4).
- **No business rule or concurrency check lives only in the browser.** E8 (fire) performs the inventory check, availability validation, duplicate guard, cart drain, and ticket build inside **one atomic Postgres transaction (RPC function)**. 409s originate server-side.
- `service_role` key: server route handlers / RPC only. Never in client bundles, never in Realtime URLs.

---

## 2. Endpoint Specifications

### Module 1 — Session & Access Control

---

#### E1. `POST /api/v1/sessions/initialize`
**Auth:** none · **Screen:** S1 · **Feature:** 1 — Anonymous Table Initialization (`docs/4`)

**Request body**

| Field | Type | Required | Rules |
|---|---|---|---|
| `table_token` | string | yes | `^[a-z0-9]{4,16}$`; must exist in `restaurant_tables` |
| `name` | string | **yes** | Trimmed, `1 – 40` chars. The guest's first name, collected by the gate before this call. An unnamed scan is `400 VALIDATION_ERROR` — see E1b–E1d, which require it too |
| `user_id` | string | no | Device id, `≤ 64` chars. When present the device is upserted into `table_members`, so it appears on the roster and the Table Pass |
| `scan_time` | ISO string | no | When the client opened the page; older than `last_cleared_at` → `409 STALE_SESSION` |

**Name:** every entry point (E1, E1b join-pin, E1c join-pass, E1d reconnect)
requires `name`. It is copied onto each cart line the guest adds and each
ticket the kitchen fires, and it is what keeps the split bill split. There is
no `"Guest"` fallback.

**Success — `200 OK`** (marks the table `active` if it was `empty`)
```json
{
  "success": true,
  "data": {
    "table_id": "8c3b9b4f-8012-4f35-90d1-0f796d11f181",
    "code": "k7x2p",
    "name": "Window four-top",
    "status": "active",
    "realtime_token": "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiI4YzNiOWI0Zi0uLi4iLCJyb2xlIjoiYXV0aGVudGljYXRlZCIsInRhYmxlX3Rva2VuIjoiazd4MnAiLCJpYXQiOjE3OTA1NjgsImV4cCI6MTc5MDYxMX0.signature"
  }
}
```
`realtime_token` is the Supabase-scoped READ token whose `table_token`
claim the RLS policies in `sql/001_init.sql` match on — the browser sends
it as the JWT for Realtime so its channels only receive **this** table's
rows. It is `null` when `SUPABASE_JWT_SECRET` is not configured (the app
then runs REST-only). Read scope only: every write still requires this API.

**Errors**

| Status | `error.code` | Trigger |
|---|---|---|
| 400 | `VALIDATION_ERROR` | Missing, wrong-type, or malformed `table_token` |
| 404 | `TABLE_NOT_FOUND` | No table with that code (v1's "Invalid table token parsed." message) |
| 500 | `INTERNAL_ERROR` | Unexpected |

---

#### E2. `POST /api/v1/auth/kds-login`
**Auth:** none (issues the staff token) · **Screen:** S4 · **Feature:** 2 — KDS Shift Authentication

**Request body**

| Field | Type | Required | Rules |
|---|---|---|---|
| `pin` | string | yes | `^\d{4,6}$`; compared to `STAFF_PIN` env var |

**Success — `200 OK`**
```json
{
  "success": true,
  "data": {
    "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzY29wZSI6ImrkcyIsImV4cCI6MTc2MDMxODh9.signature",
    "token_type": "Bearer",
    "expires_in": 28800,
    "realtime_token": "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiI3ZThmOWEwYi0uLi4iLCJyb2xlIjoiYXV0aGVudGljYXRlZCIsInN0YWZmIjoia2l0Y2hlbiIsImlhdCI6MTc5MDU2OCwiZXhwIjoxNzkwNTk2fQ.signature",
    "message": "Shift active · Audio armed."
  }
}
```
`realtime_token` is the Supabase-scoped staff read token (claim
`staff: "kitchen"`) used for channel B — it lets the board's Realtime
subscription read every order, and is `null` without `SUPABASE_JWT_SECRET`.
It is never the `service_role` key.
```
`token` is signed server-side (HMAC-SHA256) with claims `{ role: "kitchen", terminal_id, iat, exp }`, 8h TTL. It is **not** the `service_role` key and is only accepted by the staff endpoints (E10–E14, E17) plus E2b. The response also sets an `httpOnly; SameSite=Strict` `kds_token` cookie for same-origin browser terminals. The raw `STAFF_PIN` never appears in any payload or log.

**Errors**

| Status | `error.code` | Trigger |
|---|---|---|
| 400 | `VALIDATION_ERROR` | `pin` missing or not 4–6 digits |
| 401 | `INVALID_PIN` | PIN ≠ `STAFF_PIN` (copy: "Invalid staff access configuration credentials.") |
| 500 | `INTERNAL_ERROR` | Unexpected |

---

#### E2b. `GET /api/v1/auth/me`
**Auth:** staff token (header bearer **or** `kds_token` cookie) · **Screen:** S4/S5 (restore an armed shift without re-entering the PIN)

**Request:** no body; token via `Authorization: Bearer <token>` or `Cookie: kds_token=<token>`.

**Success — `200 OK`**
```json
{
  "success": true,
  "data": {
    "authenticated": true,
    "role": "kitchen",
    "terminal_id": "7e8f9a0b-1c2d-4e3f-8a5b-6c7d8e9f0a1b",
    "issued_at": "2026-09-27T21:30:00Z",
    "expires_at": "2026-09-28T05:30:00Z",
    "source": "header"
  }
}
```
Claims only — no PIN, no secret, no internal configuration is ever echoed.

**Errors:** `401 UNAUTHORIZED` (missing / malformed / invalid / expired token, either source) · `500 INTERNAL_ERROR`

---

### Module 2 — Collaborative Ordering & Menu Engine

---

#### E3. `GET /api/v1/menu?table_token=k7x2p&page=1&limit=20`
**Auth:** none · **Screens:** S1 (menu list), S5 + S6 (86 panels read the same catalog) · **Feature:** 3 — Live Menu Browsing

**Query params**

| Param | Type | Required | Rules |
|---|---|---|---|
| `table_token` | string | yes | `^[a-z0-9]{4,16}$`, must exist |
| `page`, `limit` | integer | no | §1.5 |
| `category` | string | no | Exact match on `menu_items.category` |
| `q` | string | no | `≤ 50` chars; case-insensitive match on `name` (S1 search bar) |

**Success — `200 OK`** (unavailable items are returned **with** `is_available:false` — clients grey them out, they are not hidden)
```json
{
  "success": true,
  "data": [
    {
      "menu_item_id": "a1b2c3d4-e5f6-7a8b-9c0d-1e2f3a4b5c6d",
      "name": "Masala Dosa",
      "price": 180.00,
      "category": "Main Course",
      "is_available": true,
      "description": "Crisp rice crepe, potato masala, coconut chutney.",
      "vegetarian": true
    },
    {
      "menu_item_id": "f6e5d4c3-b2a1-0f9e-8d7c-6b5a4f3e2d1c",
      "name": "Paneer Butter Masala",
      "price": 320.00,
      "category": "Main Course",
      "is_available": false,
      "description": "Paneer in a slow-cooked tomato and cashew gravy.",
      "vegetarian": true
    }
  ],
  "meta": { "page": 1, "limit": 20, "total": 12, "total_pages": 1 }
}
```

**Errors**

| Status | `error.code` | Trigger |
|---|---|---|
| 400 | `VALIDATION_ERROR` | Malformed `table_token`, `page < 1`, `limit` outside 1–100, `q > 50` chars |
| 404 | `TABLE_NOT_FOUND` | Unknown `table_token` |
| 500 | `INTERNAL_ERROR` | Unexpected |

---

#### E4. `GET /api/v1/cart/items?table_token=k7x2p&page=1&limit=20`
**Auth:** none · **Screens:** S1, S2 · **Purpose:** REST bootstrap of the shared cart before Realtime channel A starts delivering (v1 had no cart read — clients could only render after a local mutation)

**Query params:** `table_token` (required, §1.7), `page`, `limit` (§1.5). Returns only this table's rows, ordered oldest-first.

**Success — `200 OK`**
```json
{
  "success": true,
  "data": [
    {
      "id": "77f98d72-4d2a-43d9-a78c-02cf119a9a3b",
      "table_id": "8c3b9b4f-8012-4f35-90d1-0f796d11f181",
      "menu_item_id": "a1b2c3d4-e5f6-7a8b-9c0d-1e2f3a4b5c6d",
      "quantity": 2,
      "request_note": "Extra butter",
      "allergy_note": "NO PEANUTS - SEVERE",
      "added_by": "Amit"
    },
    {
      "id": "b1c2d3e4-5f6a-7b8c-9d0e-1f2a3b4c5d6e",
      "table_id": "8c3b9b4f-8012-4f35-90d1-0f796d11f181",
      "menu_item_id": "3c7d2e19-5b48-4f6a-9d21-8e6c0a7f4b12",
      "quantity": 1,
      "request_note": "",
      "allergy_note": "",
      "added_by": "Priya"
    }
  ],
  "meta": { "page": 1, "limit": 20, "total": 2, "total_pages": 1 }
}
```

**Errors:** `400 VALIDATION_ERROR` · `404 TABLE_NOT_FOUND` · `500 INTERNAL_ERROR`

---

#### E5. `POST /api/v1/cart/items`
**Auth:** none · **Screens:** S1 (`+ Add`), S2 · **Feature:** 4 — Real-Time Shared Cart Mutator

**Request body**

| Field | Type | Required | Rules |
|---|---|---|---|
| `table_token` | string | yes | §1.7 |
| `menu_item_id` | string | yes | UUID v4; must exist |
| `quantity` | integer | no | `1 – 99`, default `1` |
| `allergy_note` | string | no | `≤ 500` chars — **medical allergies only** (S2 red box) |
| `request_note` | string | no | `≤ 500` chars — normal instructions (was `normal_note` in v1) |
| `added_by` | string | **yes** | Trimmed, `1 – 40` chars — the name the session gate collected. Required: an unnamed line becomes an unnamed ticket, so there is no `"Guest"` fallback |

**Upsert semantics:** if an identical line already exists for this table (`menu_item_id` + `request_note` + `allergy_note` all equal), `quantity` is incremented on that row instead of inserting a duplicate; the surviving `added_by` becomes the latest writer.

**Success — `200 OK`**
```json
{
  "success": true,
  "data": {
    "id": "77f98d72-4d2a-43d9-a78c-02cf119a9a3b",
    "table_id": "8c3b9b4f-8012-4f35-90d1-0f796d11f181",
    "menu_item_id": "a1b2c3d4-e5f6-7a8b-9c0d-1e2f3a4b5c6d",
    "quantity": 2,
    "request_note": "Extra butter",
    "allergy_note": "NO PEANUTS - SEVERE",
    "added_by": "Amit",
    "total_table_quantity": 3
  }
}
```
`total_table_quantity` = sum of `quantity` for this `menu_item_id` across the table's cart (drives S1's row counter).

**Errors**

| Status | `error.code` | Trigger |
|---|---|---|
| 400 | `VALIDATION_ERROR` | Any §1.7 violation (bad UUID, `quantity` out of range, note > 500) |
| 404 | `TABLE_NOT_FOUND` | Unknown `table_token` |
| 404 | `MENU_ITEM_NOT_FOUND` | Unknown `menu_item_id` |
| 409 | `ITEM_UNAVAILABLE` | `is_available = false` at write time (item 86'd while in the menu view) |
| 500 | `INTERNAL_ERROR` | Unexpected |

---

#### E6. `PATCH /api/v1/cart/items/:cart_item_id`
**Auth:** none · **Screen:** S2 (quantity steppers & note editing inside the cart modal) · **Feature:** 4 — Shared Cart update half (v1 had no update endpoint although `updateCartLine` exists in the service layer)

**Path:** `cart_item_id` — UUID v4.

**Request body** — at least one field required:

| Field | Type | Required | Rules |
|---|---|---|---|
| `table_token` | string | yes | Ownership check: row must belong to this table |
| `quantity` | integer | no | Absolute "set to N", `1 – 99`. `0` is invalid — use E7 to remove. Last write wins |
| `quantity_delta` | integer | no | Relative step, `-99…99`, never `0`. **What the +/- steppers send**: applied atomically as `quantity = quantity + delta`, so two phones tapping at once cannot overwrite each other (no lost updates). Result must stay `1 – 99`, else `400 VALIDATION_ERROR` with `error.fields.quantity_delta` |
| `request_note` | string | no | `≤ 500` chars |
| `allergy_note` | string | no | `≤ 500` chars |

At least one of `quantity` / `quantity_delta` / `request_note` /
`allergy_note` is required.

**Success — `200 OK`** (full updated row + aggregate, same shape as E5)
```json
{
  "success": true,
  "data": {
    "id": "77f98d72-4d2a-43d9-a78c-02cf119a9a3b",
    "table_id": "8c3b9b4f-8012-4f35-90d1-0f796d11f181",
    "menu_item_id": "a1b2c3d4-e5f6-7a8b-9c0d-1e2f3a4b5c6d",
    "quantity": 3,
    "request_note": "Extra butter, cut into pieces",
    "allergy_note": "NO PEANUTS - SEVERE",
    "added_by": "Amit",
    "total_table_quantity": 3
  }
}
```

**Errors:** `400 VALIDATION_ERROR` (incl. no editable field present, `quantity < 1`) · `404 TABLE_NOT_FOUND` · `404 CART_ITEM_NOT_FOUND` (unknown id **or** belongs to another table) · `500 INTERNAL_ERROR`

---

#### E7. `DELETE /api/v1/cart/items`
**Auth:** none · **Screen:** S2 (remove line) · **Feature:** 5 — Cart Item Removal

**Request body**

| Field | Type | Required | Rules |
|---|---|---|---|
| `table_token` | string | yes | §1.7 |
| `cart_item_id` | string | yes | UUID v4; must belong to this table |

**Success — `200 OK`**
```json
{
  "success": true,
  "data": {
    "id": "77f98d72-4d2a-43d9-a78c-02cf119a9a3b",
    "message": "Line item purged from table cart."
  }
}
```

**Errors:** `400 VALIDATION_ERROR` · `404 TABLE_NOT_FOUND` · `404 CART_ITEM_NOT_FOUND` · `500 INTERNAL_ERROR`

---

#### E8. `POST /api/v1/orders/fire`
**Auth:** none · **Screen:** S2 (BIG FIRE ORDER button) · **Feature:** 6 — "Review & Fire" Submission · **HTTP:** `201 Created`

> **Atomicity requirement:** the availability check, duplicate guard, inventory check, `orders` + `order_items` insert, and cart drain execute in a **single Postgres transaction (RPC / secure Edge function)**. The 409s below are raised inside that transaction; no client-side check is authoritative.

**Request body**

| Field | Type | Required | Rules |
|---|---|---|---|
| `table_token` | string | yes | §1.7 |

**Success — `201 Created`**
```json
{
  "success": true,
  "data": {
    "order_id": "99b0c2a5-4f71-477c-bc8a-d142b78aef01",
    "table_id": "8c3b9b4f-8012-4f35-90d1-0f796d11f181",
    "status": "pending",
    "created_at": "2026-09-27T21:35:00Z",
    "message": "Order successfully routed to KDS line."
  }
}
```

**Errors**

| Status | `error.code` | Trigger |
|---|---|---|
| 400 | `VALIDATION_ERROR` | Malformed/missing `table_token` |
| 404 | `TABLE_NOT_FOUND` | Unknown token |
| 409 | `EMPTY_CART` | No cart lines for the table |
| 409 | `DUPLICATE_ORDER` | Table already has `pending/preparing/ready` order (second tap → "Order already sent") |
| 409 | `INVENTORY_FAILURE` | A cart item's `is_available` flipped to false since it was added |

`INVENTORY_FAILURE` example:
```json
{
  "success": false,
  "error": {
    "code": "INVENTORY_FAILURE",
    "message": "Paneer Butter Masala has sold out. Cart updated.",
    "sold_out": ["Paneer Butter Masala"]
  }
}
```
On `INVENTORY_FAILURE` the sold-out lines are purged from `cart_items` inside the same transaction, so the cart the diner sees matches the server.

---

#### E9. `GET /api/v1/sessions/:table_token/active-check`
**Auth:** none · **Screens:** S1/S2 (double-tap guardrail), S3 (bootstrap current order) · **Feature:** 7 — Anti-Duplicate Guardrail

**Path:** `table_token` — `^[a-z0-9]{4,16}$`.

**Success — `200 OK` (active processing block detected)**
```json
{
  "success": true,
  "data": {
    "has_active_order": true,
    "order_id": "99b0c2a5-4f71-477c-bc8a-d142b78aef01",
    "status": "pending",
    "message": "Order already sent"
  }
}
```

**Success — `200 OK` (clear slate)**
```json
{
  "success": true,
  "data": {
    "has_active_order": false,
    "message": "Ready for new order round initialization."
  }
}
```
"Active" = any order for the table with `status ∈ {pending, preparing, ready}`. This is a read: it never returns 409.

**Errors:** `400 VALIDATION_ERROR` · `404 TABLE_NOT_FOUND` · `500 INTERNAL_ERROR`

---

### Module 3 — Kitchen Display System (KDS)

> All Module 3 endpoints require `Authorization: Bearer <kds_token>` (E2). Missing/invalid/expired → `401 UNAUTHORIZED` (listed once here; implicit below).

---

#### E10. `GET /api/v1/kds/tickets?status=pending&page=1&limit=20`
**Auth:** staff · **Screen:** S5 · **Feature:** 8 (columns) + 9 (allergy rendering lives in each item payload)

**Query params:** `page`, `limit` (§1.5); `status` optional filter, one of `pending|preparing|ready`. Default returns every order whose `status ≠ 'served'`, oldest first.

**Success — `200 OK`**
```json
{
  "success": true,
  "data": [
    {
      "order_id": "99b0c2a5-4f71-477c-bc8a-d142b78aef01",
      "table": { "id": "8c3b9b4f-8012-4f35-90d1-0f796d11f181", "code": "k7x2p", "name": "Window four-top" },
      "status": "pending",
      "created_at": "2026-09-27T21:35:00Z",
      "items": [
        {
          "menu_item_id": "a1b2c3d4-e5f6-7a8b-9c0d-1e2f3a4b5c6d",
          "name": "Masala Dosa",
          "quantity": 2,
          "unit_price": 130,
          "request_note": "Extra butter",
          "allergy_note": "NO PEANUTS - SEVERE"
        },
        {
          "menu_item_id": "3c7d2e19-5b48-4f6a-9d21-8e6c0a7f4b12",
          "name": "Hyderabadi Biryani",
          "quantity": 1,
          "unit_price": 220,
          "request_note": "",
          "allergy_note": ""
        }
      ]
    }
  ],
  "meta": { "page": 1, "limit": 20, "total": 3, "total_pages": 1 }
}
```
`items[].name` is the live join to `menu_items.name` (v1's `item_name`); `allergy_note` is always rendered bold red on the card while `request_note` stays normal text. `items[].unit_price` is the price **charged at fire time** (`sql/004_hardening.sql`), not today's menu price — a re-priced dish must never rewrite an old ticket's bill.

**Errors:** `400 VALIDATION_ERROR` (bad `status`/pagination) · `401 UNAUTHORIZED` · `500 INTERNAL_ERROR`

---

#### E11. `PATCH /api/v1/kds/tickets/:order_id/status`
**Auth:** staff · **Screen:** S5 (one-tap COOK button) · **Feature:** 10 — One-Tap Tag State-Machine Mutator

**Path:** `order_id` — UUID v4.

**Request body**

| Field | Type | Required | Rules |
|---|---|---|---|
| `status` | string | yes | exactly `preparing` or `ready`; must be the **next** sequential state (`pending→preparing`, `preparing→ready`). `served` is set only by E12. |

**Success — `200 OK`**
```json
{
  "success": true,
  "data": {
    "order_id": "99b0c2a5-4f71-477c-bc8a-d142b78aef01",
    "status": "preparing"
  }
}
```
Each success emits Realtime channel C (`order_tracker:{order_id}`) so S3 flips grey → amber → green.

**Errors**

| Status | `error.code` | Trigger |
|---|---|---|
| 400 | `VALIDATION_ERROR` | `status` missing, not a string, or a value outside `preparing\|ready` |
| 401 | `UNAUTHORIZED` | Staff token missing/invalid/expired |
| 404 | `ORDER_NOT_FOUND` | Unknown `order_id` |
| 409 | `INVALID_STATUS_TRANSITION` | Skip or repeat a step (e.g. `pending → ready`, `ready → preparing`, any `→ served` here) |
| 500 | `INTERNAL_ERROR` | Unexpected |

---

#### E12. `PATCH /api/v1/kds/tickets/:order_id/prune`
**Auth:** staff · **Screen:** S5 (Ready column → "Mark Served") · **Feature:** 11 — Completed Ticket Pruning

**Path:** `order_id` — UUID v4. No request body.

**Behavior:** sets `orders.status = 'served'` (valid only from `ready`). If this was the table's last order not in `served`, the parent `restaurant_tables.status` becomes `empty`.

**Success — `200 OK`**
```json
{
  "success": true,
  "data": {
    "order_id": "99b0c2a5-4f71-477c-bc8a-d142b78aef01",
    "status": "served",
    "table_cleared": true
  }
}
```
`table_cleared: false` when the table still has another active order (multi-round service).

**Errors:** `401 UNAUTHORIZED` · `404 ORDER_NOT_FOUND` · `409 INVALID_STATUS_TRANSITION` (current status is not `ready`; carries `current_status`/`requested_status`) · `500 INTERNAL_ERROR`

---

#### E13. `POST /api/v1/kds/shift/activate`
**Auth:** staff · **Screen:** S5 ("START SHIFT & ENABLE AUDIO 🔊") · **Feature:** 13 — Screen Flash & Sounds *(in `docs/4`, missing from v1 contract)*

**Request body**

| Field | Type | Required | Rules |
|---|---|---|---|
| `device_id` | string | yes | `1 – 64` chars (e.g. `"tablet-kds-01"`) |

**Success — `200 OK`** (registers the device so browser autoplay policy allows the new-ticket chime on channel B)
```json
{
  "success": true,
  "data": {
    "device_id": "tablet-kds-01",
    "audio_armed": true,
    "message": "Audio chimes armed for this device. Incoming tickets will ping."
  }
}
```

**Errors:** `400 VALIDATION_ERROR` · `401 UNAUTHORIZED` · `500 INTERNAL_ERROR`

---

### Module 4 — Floor Operations & Real-Time Sync Protocols

---

#### E14. `PATCH /api/v1/menu/items/:menu_item_id/availability`
**Auth:** staff · **Screens:** S5 (Manage 86 drawer), S6 (Quick 86 panel) · **Feature:** 14 — Quick Menu Hide (86ing)

**Path:** `menu_item_id` — UUID v4.

**Request body**

| Field | Type | Required | Rules |
|---|---|---|---|
| `is_available` | boolean | yes | must be a real JSON boolean |

**Success — `200 OK`**
```json
{
  "success": true,
  "data": {
    "menu_item_id": "f6e5d4c3-b2a1-0f9e-8d7c-6b5a4f3e2d1c",
    "is_available": false
  }
}
```
Immediate effect: E3 greys the row on every open S1, and E5/E8 reject or 409 the item.

**Errors:** `400 VALIDATION_ERROR` (missing/non-boolean) · `401 UNAUTHORIZED` · `404 MENU_ITEM_NOT_FOUND` · `500 INTERNAL_ERROR`

---

#### E15. `GET /api/v1/orders/:order_id/status`
**Auth:** none (`order_id` **+** `table_token` together form the capability; the id alone is not a universal reader) · **Screen:** S3 (REST polling fallback before Realtime channel C locks) · **Feature:** 12 — Fallback Live Guest Progress Status Checker

**Path:** `order_id` — UUID v4.

**Query params**

| Param | Type | Required | Rules |
|---|---|---|---|
| `table_token` | string | yes | §1.7 — the scope check: the row is only returned when the order belongs to this table |


**Success — `200 OK`**
```json
{
  "success": true,
  "data": {
    "order_id": "99b0c2a5-4f71-477c-bc8a-d142b78aef01",
    "table_id": "8c3b9b4f-8012-4f35-90d1-0f796d11f181",
    "status": "preparing",
    "created_at": "2026-09-27T21:35:00Z"
  }
}
```
Clients map `pending` → grey, `preparing` → amber, `ready` → full-screen green flash, `served` → completed.

**Errors:** `400 VALIDATION_ERROR` (id not a UUID, or missing/malformed `table_token`) · `404 TABLE_NOT_FOUND` (unknown token) · `404 ORDER_NOT_FOUND` (unknown id **or** an id belonging to another table — identical answer, existence is never leaked) · `500 INTERNAL_ERROR`

---

#### E16. `GET /api/v1/orders?table_token=k7x2p&page=1&limit=20`
**Auth:** none · **Screen:** S3 (bootstrap: find the table's current order + history without polling every id) · **Feature:** 12 (bootstrap companion; `getOrdersForTable` exists in the service layer but had no endpoint in v1)

**Query params:** `table_token` (required, §1.7), `page`, `limit` (§1.5). Returns this table's orders, newest first.

**Success — `200 OK`**
```json
{
  "success": true,
  "data": [
    {
      "order_id": "99b0c2a5-4f71-477c-bc8a-d142b78aef01",
      "table_id": "8c3b9b4f-8012-4f35-90d1-0f796d11f181",
      "status": "preparing",
      "created_at": "2026-09-27T21:35:00Z",
      "total": 260,
      "items": [
        {
          "menu_item_id": "a1b2c3d4-e5f6-7a8b-9c0d-1e2f3a4b5c6d",
          "name": "Masala Dosa",
          "quantity": 2,
          "unit_price": 130,
          "request_note": "Extra butter",
          "allergy_note": "NO PEANUTS - SEVERE"
        }
      ]
    }
  ],
  "meta": { "page": 1, "limit": 20, "total": 5, "total_pages": 1 }
}
```
**v2.1 addition — `total` and `items[].unit_price`.** The bill is **frozen at fire time** by `fire_order()` (`sql/004_hardening.sql`): `total` is `sum(quantity × unit_price)` as charged, and each `unit_price` is the menu price at the instant the ticket was fired. Both are unaffected by a later menu edit (`unit_price` is a live join only for `name`). Additive — consumers that ignore the fields are unaffected.

**Errors:** `400 VALIDATION_ERROR` · `404 TABLE_NOT_FOUND` · `500 INTERNAL_ERROR`

---

#### E17. `GET /api/v1/floor/tables?page=1&limit=20`
**Auth:** staff · **Screen:** S6 (Floor View — service pacing, active tags, cart pressure per table) · **Feature:** floor companion to Features 10/11/14 *(endpoint missing from v1; `fetchFloorSummaries` exists in the service layer and `docs/6` ships the screen)*

**Query params:** `page`, `limit` (§1.5). Returns all tables, ordered by `code`.

**Success — `200 OK`**
```json
{
  "success": true,
  "data": [
    {
      "table_id": "8c3b9b4f-8012-4f35-90d1-0f796d11f181",
      "code": "k7x2p",
      "name": "Window four-top",
      "status": "active",
      "active_order": {
        "order_id": "99b0c2a5-4f71-477c-bc8a-d142b78aef01",
        "status": "preparing",
        "created_at": "2026-09-27T21:35:00Z",
        "items": [
          {
            "menu_item_id": "a1b2c3d4-e5f6-7a8b-9c0d-1e2f3a4b5c6d",
            "name": "Masala Dosa",
            "quantity": 2,
            "unit_price": 130,
            "request_note": "Extra butter",
            "allergy_note": "NO PEANUTS - SEVERE"
          }
        ]
      },
      "cart_line_count": 3
    },
    {
      "table_id": "2d4e6f80-1a3b-4c5d-8e9f-0a1b2c3d4e5f",
      "code": "m3q8z",
      "name": "Corner booth",
      "status": "empty",
      "active_order": null,
      "cart_line_count": 0
    }
  ],
  "meta": { "page": 1, "limit": 20, "total": 3, "total_pages": 1 }
}
```
`active_order` = newest order with `status ∈ {pending, preparing, ready}` or `null`. `cart_line_count` is a computed aggregate (exempt from the column rule).

**v2.1 addition — `active_order.items`.** The floor card's whole job is to tell a runner *which* table needs attention and *whether there is a food-safety alert on it*, so `items` (identical shape to E10's `items[]`) is part of the payload. Without it the floor view had to make a second call to a kitchen endpoint just to count allergy notes. This is an additive change: existing consumers that ignore the field are unaffected.

**Errors:** `400 VALIDATION_ERROR` · `401 UNAUTHORIZED` · `500 INTERNAL_ERROR`

---

## 3. Real-Time WebSocket Streaming (Supabase Realtime)

Clients subscribe from the browser using only the public `anon` key; `postgres_changes` events are RLS-filtered. `service_role` never appears client-side. Event payloads use the same field names as the REST payloads above.

### A. Shared Table Cart Room — Screens S1, S2
- **Channel:** `table_carts:{table_token}` — e.g. `table_carts:k7x2p`
- **Events:** `INSERT` | `UPDATE` | `DELETE` on `cart_items` scoped to that table
```json
{
  "event": "UPDATE",
  "table_token": "k7x2p",
  "payload": {
    "id": "77f98d72-4d2a-43d9-a78c-02cf119a9a3b",
    "menu_item_id": "a1b2c3d4-e5f6-7a8b-9c0d-1e2f3a4b5c6d",
    "quantity": 3,
    "request_note": "Extra butter",
    "allergy_note": "NO PEANUTS - SEVERE"
  }
}
```

### B. KDS Order Intake — Screen S5
- **Channel:** `kds_orders`
- **Event:** `INSERT` on `orders` → new ticket animates into the Pending column + audio chime (device must have called E13)
```json
{
  "event": "INSERT",
  "payload": {
    "order_id": "99b0c2a5-4f71-477c-bc8a-d142b78aef01",
    "code": "k7x2p",
    "status": "pending"
  }
}
```
> v2 note: `docs/4` only mandates `INSERT`. Multi-display kitchens should also subscribe to `UPDATE` (column moves) and `DELETE`/prune events; single-display MVP ships `INSERT` only.

### C. Live Progress Tracker — Screen S3
- **Channel:** `order_tracker:{order_id}`
- **Event:** `UPDATE` on that order row → client color shift + flash
```json
{ "event": "UPDATE", "order_id": "99b0c2a5-4f71-477c-bc8a-d142b78aef01", "status": "preparing" }
```
```json
{ "event": "UPDATE", "order_id": "99b0c2a5-4f71-477c-bc8a-d142b78aef01", "status": "ready" }
```
`preparing` → amber cooking screen; `ready` → full-screen green flash alert.

### D. Table Presence — Screen S1 (ActiveDinersBadge)
- **Channel:** `table_presence:{table_token}` using Supabase **Presence** (not postgres_changes)
- **Contract:** each device joins with its `device_id` and re-syncs every 15 s; entries unseen for 45 s expire (matches `use-presence` / `PRESENCE_TTL_MS` in the codebase). Presence keys are ephemeral — no REST endpoint exists for this by design.

---

## 4. Endpoint × Feature Traceability (12 core features + 2 extensions)

| Feature (`docs/4`) | Endpoints |
|---|---|
| 1. Anonymous Table Initialization | E1 |
| 2. KDS Shift Authentication | E2 |
| 3. Live Menu Browsing | E3 |
| 4. Real-Time Shared Cart (upsert + update) | E5, E6 (+ E4 read, channel A) |
| 5. Cart Item Removal | E7 |
| 6. "Review & Fire" Submission | E8 |
| 7. Anti-Duplicate Guardrail | E9 |
| 8. KDS Kanban Dashboard | E10 (+ channel B) |
| 9. Guardrailed Allergy Rendering | inside E10 `items[].allergy_note` |
| 10. One-Tap Tag State-Machine | E11 (+ channel C) |
| 11. Completed Ticket Pruning | E12 |
| 12. Live Guest Progress Tracker | E15, E16 (+ channel C) |
| 13. Screen Flash & Sounds | E13 (+ channel B) |
| 14. Quick Menu Hide (86ing) | E14 |
| Extension: Floor View screen | E17 |
| Extension: Call for the bill (request → settle → clear) | **none yet** — browser channel `frontend/lib/api/bill.ts`; see §7 |

---

## 5. Per-endpoint auth & screen index

| # | Method + Path | Auth | Screen(s) | Paginated |
|---|---|---|---|---|
| E1 | `POST /api/v1/sessions/initialize` | none | S1 | — |
| E2 | `POST /api/v1/auth/kds-login` | none | S4 | — |
| E2b | `GET /api/v1/auth/me` | staff token (header or cookie) | S4, S5 | — |
| E3 | `GET /api/v1/menu` | none | S1, S5, S6 | ✅ |
| E4 | `GET /api/v1/cart/items` | none | S1, S2 | ✅ |
| E5 | `POST /api/v1/cart/items` | none | S1, S2 | — |
| E6 | `PATCH /api/v1/cart/items/:cart_item_id` | none | S2 | — |
| E7 | `DELETE /api/v1/cart/items` | none | S2 | — |
| E8 | `POST /api/v1/orders/fire` | none | S2 | — |
| E9 | `GET /api/v1/sessions/:table_token/active-check` | none | S1, S2, S3 | — |
| E10 | `GET /api/v1/kds/tickets` | staff | S5 | ✅ |
| E11 | `PATCH /api/v1/kds/tickets/:order_id/status` | staff | S5 | — |
| E12 | `PATCH /api/v1/kds/tickets/:order_id/prune` | staff | S5 | — |
| E13 | `POST /api/v1/kds/shift/activate` | staff | S5 | — |
| E14 | `PATCH /api/v1/menu/items/:menu_item_id/availability` | staff | S5, S6 | — |
| E15 | `GET /api/v1/orders/:order_id/status` | none | S3 | — |
| E16 | `GET /api/v1/orders` | none | S3 | ✅ |
| E17 | `GET /api/v1/floor/tables` | staff | S6 | ✅ |
| E18 | `GET /api/v1/sessions/:table_token` | none (table token) | S1, S3 | — |
| E19 | `GET /api/v1/sessions/:table_token/members` | none (table token) | S1 | — |
| E20 | `POST /api/v1/orders/:order_id/retry` | none (table token) | S3 | — |
| — | `POST /api/v1/sessions/:table_token/bill-request` | none (table token) | S1, S2 | — |

---

## 6. DB blueprint gaps (must be added before the migration script is written)

The API above is field-exact against `docs/2` **except** for the following columns the product already requires. These must be added to the blueprint and carried into the SQL migration:

| Table | Missing column | Suggested definition | Required by |
|---|---|---|---|
| `restaurant_tables` | `status` | `text not null default 'empty'` + check `in ('active','empty')` | E1 (`active` on scan), E12 (`empty` when last order pruned), E17 |
| `cart_items` | `added_by` | `text not null default 'Guest'` | E4–E6; S2 wireframe "Added by Amit" (`docs/5`) |
| `menu_items` | `description` | `text` | S1 rows, existing `MenuItem` type |
| `menu_items` | `vegetarian` | `boolean not null default true` | S1 veg/non-veg mark, existing `MenuItem` type |
| `orders` | `updated_at` | `timestamptz not null default now()` (recommended) | ✅ **applied** — `004_hardening.sql`, maintained by the shared `set_updated_at()` trigger |
| `cart_items` | `created_at` | `timestamptz not null default now()` (recommended) | ✅ **applied**; `cart_items.updated_at` was added too |
| `order_items` | snapshot `item_price` at fire time | `unit_price numeric(10,2) not null default 0` | ✅ **applied** — `004_hardening.sql` writes it from `menu_items.price` inside `fire_order()`, and freezes `orders.total` with it (returned by E10/E16/E17). `item_name` is deliberately **not** snapshotted: a rename showing through on an old ticket is harmless, whereas a re-price is not. |

Enum casing note: `docs/7` v1 used `Pending/Preparing/Ready/Served`. The blueprint (`docs/2`) and the shipped frontend (`lib/api/types.ts`) both use lowercase — v2 standardizes on lowercase everywhere, including `active/empty`.

---

## 7. The bill request channel — now server-side

The “Get bill now” handoff (diner asks → floor takes payment → table clears) was a
client-side prototype in v2 and is now a server column (`restaurant_tables.bill_status`,
`sql/007_bill_and_auto_release.sql`). **The browser-local store is no longer read by any live
screen** (docs/14 #5): a diner's phone and a separate floor tablet agree because both read the
same column.

| Step | Endpoint | Notes |
|---|---|---|
| Ask | `POST /api/v1/sessions/:table_token/bill-request` | idempotent; `unrequested → requested`, never downgrades `paid` |
| Read | `GET /api/v1/sessions/:table_token` (E18) | `bill_status`, `bill_requested_at`, `bill_paid_at`, table `status`, `active_devices`, `active_orders` |
| Push | `postgres_changes` on `restaurant_tables` | the diner screen follows a settle without a reload |
| Fallback | E18 every 5 s | a deployment without Supabase is slower, never frozen |
| Pay | `PATCH /api/v1/floor/tables/:table_id/settle` | staff; stamps `paid` and asks the release engine |

`frontend/lib/api/bill.ts` remains in the tree as the offline/demo transport and its unit test,
but no diner or staff screen imports it any more.

---

## 8. Additions in v2.2 (2026-10-29)

These are additive; every existing consumer keeps working.

### E18. `GET /api/v1/sessions/:table_token`
**Auth:** none — the table token is the capability (same scope as `bill-request`). Returns the
diner's own table state, no credentials:

```json
{
  "success": true,
  "data": {
    "table_id": "8c3b9b4f-8012-4f35-90d1-0f796d11f181",
    "code": "k7x2p",
    "name": "Window 2",
    "status": "active",
    "bill_status": "requested",
    "bill_requested_at": "2026-10-29T12:40:00Z",
    "bill_paid_at": null,
    "session_started_at": "2026-10-29T12:05:11Z",
    "active_devices": 3,
    "active_orders": 1
  }
}
```

`active_devices` counts heartbeats inside the 45 s release window (the same window the release
engine uses). Errors: `404 TABLE_NOT_FOUND` (unknown or archived).

### E19. `GET /api/v1/sessions/:table_token/members`
**Auth:** none (table token). The roster recorded by E1/E1b/E1c (`table_members`), oldest first:

```json
{
  "success": true,
  "data": [
    { "user_id": "dev_9f2c", "name": "Aarav", "joined_at": "2026-10-29T12:05:11Z" }
  ]
}
```

A guest who joined but has not ordered appears here — that is the point. Rows die with the
seating when the table is cleared.

### E20. `POST /api/v1/orders/:order_id/retry?table_token=…`
**Auth:** none (table token). “Retry” as ONE transaction: move the still-available lines of a
`denied` ticket back to the cart, replace that ticket with a fresh one via `fire_order()`, or roll
the whole thing back. A failed re-fire (another 86, a network drop) leaves the refused ticket and
its explanation intact (docs/14 #23).

**Success — `201 Created`**
```json
{
  "success": true,
  "data": {
    "order_id": "99b0c2a5-4f71-477c-bc8a-d142b78aef01",
    "table_id": "8c3b9b4f-8012-4f35-90d1-0f796d11f181",
    "status": "pending",
    "created_at": "2026-10-29T12:41:03Z",
    "moved": 2,
    "omitted": ["Mango Lassi"]
  }
}
```
**Errors:** `404 ORDER_NOT_FOUND` · `409 ORDER_NOT_DENIED` · `409 NOTHING_TO_RETRY` (`omitted` in
`details`) · `409 INVENTORY_FAILURE` / `DUPLICATE_ORDER` / `EMPTY_CART` — all of which leave the
denied ticket untouched.

### Changes to existing endpoints

* `POST /api/v1/auth/kds-login` accepts an optional `surface: "kitchen" | "floor"`. It is
  **rate-limit metadata only** — the issued role is unchanged — and gives each PIN wall its own
  failed-attempt counter (docs/14 #18).
* `PATCH /api/v1/cart/items/:cart_item_id` merges instead of failing when a note edit would
  collide with another line of the same dish (docs/14 #24); the merged line is returned.
* `GET /api/v1/floor/tables` now requires role `floor` or `kitchen` (docs/14 #13).
* `GET /api/v1/orders` returns only the CURRENT seating: clearing a table removes its tickets
  (docs/14 #21), and served takings live in the `sales_day` / `sales_rollup` tables
  (`sql/012_sales_rollup_and_session_reset.sql`) that the admin analytics reads.
* Rate limits are keyed by credential (staff bearer / table token) with a high per-IP backstop
  (docs/14 #17), not by the shared restaurant IP alone.
