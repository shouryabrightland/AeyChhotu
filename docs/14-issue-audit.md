# 14 — Issue audit (routes, data flow, updates)

A list of logical route / update problems found by reading the code and
smoke-testing the running app (every page, the main endpoints, and the four
data hooks). **Nothing has been changed for these** — this file is the list to
review.

Section F holds the findings from a second review that came in from another
audit. Each of those was checked against this codebase before being kept, and
two of them could **not** be reproduced — they are recorded as such rather than
deleted.

- Severity is my read of the impact, not a promise: **High** = a guest or
  operator sees a wrong/frozen screen, **Med** = wrong behaviour in a narrow
  window or a real-deployment gap, **Low** = cosmetic or wording.
- "Verified" means observed in the running app or read directly in the code
  path; "Likely" means it follows from the code but I did not force the case.
- Tick the box when you confirm an item is real; delete the ones that are
  by design.

---

## A. Diner screen (`/table/[token]`, `/table/[token]/tracker`)

### 1. Refreshing blanks the whole screen — High — verified
The nav refresh icon (and every Retry) re-runs the initial load and puts the
page back into `loading`, so the entire menu is replaced by the skeleton. The
deck position, the skipped cards and the scroll position are lost, and any open
sheet is unmounted.

- `frontend/hooks/use-live-table.ts` — `refresh()` bumps `reloadKey`; the load
  effect calls `setPhase("loading")`.
- `frontend/components/diner/diner-table-screen.tsx` — `phase === "loading"`
  returns `<DinerSkeleton />`, so `MenuBrowser` (and `DishDeck`) unmount.
- Same path on the tracker via `live.refresh()`.

- [ ] Confirmed / real
- [ ] By design

### 2. "Review & fire" is clickable while an add is still syncing — High — verified
Firing sends whatever is in the server cart *at that moment*. A dish added a few
hundred milliseconds earlier may not be in the DB yet, so it is missing from the
order and stays in the cart after firing.

- `frontend/components/diner/cart-modal.tsx` — the fire button only checks
  `firing`, never `live.syncing`.
- `frontend/hooks/use-live-table.ts` — `fire()` reads the server cart, not the
  optimistic overlay.

- [ ] Confirmed / real
- [ ] By design

### 3. Bill / session changes never arrive without realtime — Med-High — verified
Only the cart has a poll (5 s). Table and bill status have no fallback, so on a
deployment without Supabase (or where RLS denies the channel) a table settled by
the floor never shows the "Thank you" overlay, and a cleared table never shows
"session ended", until the page is reloaded.

- `frontend/hooks/use-live-table.ts` — `CART_POLL_MS` interval polls
  `reloadCart` only; `subscribeTableUpdates` is the only table channel.

- [ ] Confirmed / real
- [ ] By design

### 4. The ± quantity buttons in the cart still wait on the round trip — Med — verified
Adding a dish is optimistic (the line appears instantly with "Syncing"), but
tapping +/− on an existing cart line still blocks until the server answers and
the cart is re-read. Same for removing a line.

- `frontend/components/diner/table-cart.tsx` — `changeQuantity` awaits.
- `frontend/hooks/use-live-table.ts` — `updateLine` / `removeLine`.

- [ ] Confirmed / real
- [ ] By design

### 5. Two phones can disagree about the bill — Med — verified
"Bill requested / paid" on the diner side is a browser-local store
(`localStorage` + `BroadcastChannel`), not the server column. Phone A asks for
the bill; phone B still offers "Get bill now" and never shows the settled
screen. The floor is correct because it reads `bill_status` from the API.

- `frontend/lib/api/bill.ts` (its own comment says prototype scope)
- `frontend/components/diner/cart-strip.tsx`, `table-cart.tsx` read
  `useBills()` instead of the server's `bill_status`.

- [ ] Confirmed / real
- [ ] By design

### 6. The 5 s cart poll can invent "someone else changed the cart" — Med — likely
A poll request that starts before your add commits can resolve after it, and the
diff then looks like a removal by another device: a wrong toast, and the line
blinking out until the next read.

- `frontend/hooks/use-live-table.ts` — `reloadCart("external", true)` runs on a
  timer with no ordering guard against this device's own writes.

- [ ] Confirmed / real
- [ ] By design

### 7. Menu folders are fetched once and never refreshed — Med — verified
`getMenuCategories()` runs on mount only, with no retry. A folder renamed or
added in the admin console is stale for open diner screens, and one failed
request leaves the flat fallback grouping for the whole visit.

- `frontend/components/diner/menu-browser.tsx` — the categories effect.

- [ ] Confirmed / real
- [ ] By design

### 8. The "live order" dot pulses for a refused order — Low — verified
`activeOrder` filters only `served`, so a `denied` ticket counts as active and
the nav dot keeps pulsing for a ticket that no longer exists.

- `frontend/hooks/use-live-table.ts` — `activeOrder` memo.
- `frontend/components/diner/diner-nav-bar.tsx`.

- [ ] Confirmed / real
- [ ] By design

### 9. The optimistic "Syncing" overlay is not cleared by fire/refresh — Low — verified
`pendingAdds` survives a fire or a manual refresh, so in a rare race a
just-added line can reappear for a moment after the cart was emptied.

- `frontend/hooks/use-live-table.ts` — `fire()` and the reload effect do not
  reset `pendingAdds`.

- [ ] Confirmed / real
- [ ] By design

---

## B. Staff screens (`/kitchen`, `/floor`, `/admin`)

### 10. The kitchen board never updates by itself if realtime is down — High — verified
No polling fallback: `subscribeKdsOrders` / `subscribeOrdersFeed` are the only
update paths once the board has loaded. The floor (15 s) and the admin console
(15 s) both poll; the kitchen board has only the manual refresh icon.

- `frontend/hooks/use-live-kds.ts` — no interval in the success phase.

- [ ] Confirmed / real
- [ ] By design

### 11. The floor unlock flag and the real token can drift apart — Med — verified
The PIN wall only sets a `sessionStorage` flag. If the shift token is missing or
expired, the floor still renders, gets a 401, and the API client's global guard
sends the operator to **/kitchen** (the kitchen PIN wall) — not back to the
floor wall. The flag stays "unlocked", so returning to /floor repeats the bounce.

- `frontend/components/staff/staff-gate.tsx`
- `frontend/lib/api-client/apiClient.ts` — `KDS_LOGIN_PATH = "/kitchen"`,
  `handleUnauthorized`.

- [ ] Confirmed / real
- [ ] By design

### 12. `/floor` and `/admin` are unreachable from the UI — Low — verified
Only `/kitchen` is linked anywhere (from the presentation page). Operators must
know the URLs. Fine if these are meant to be URL-only routes.

- `frontend/app/presentation/PresentationView.tsx` is the only link.

- [ ] Confirmed / real
- [ ] By design

### 13. `GET /floor/tables` has no role check — Low/Med — verified
It requires a valid token but no role, while settle/notify/clear require
`floor` or `kitchen`. Any valid shift/admin token can read the whole floor feed.

- `backend/src/routes/floor.ts` — `floorRouter.get("/tables", requireAuth, …)`.

- [ ] Confirmed / real
- [ ] By design

---

## C. Presence and table lifecycle

### 14. "N phones live" is broken without Supabase — Med — verified
The badge falls back to a browser-local store, but the local heartbeat writer is
no longer called anywhere (heartbeats now go to the API registry). The count is
therefore always 0 (or 1) when realtime is not configured.

- `frontend/components/diner/active-diners-badge.tsx` — `countActiveDiners(db, …)`
- `frontend/lib/api/store.ts` — `heartbeat()` is defined and never called.
- `frontend/hooks/use-presence.ts` — posts to the API instead.

- [ ] Confirmed / real
- [ ] By design

### 15. An abandoned unpaid table never frees itself — Med — verified
Auto-release only runs when `bill_status = 'paid'` and no devices remain. Guests
who leave without paying (or never ask for the bill) leave the table `active`
forever; the next party hits the PIN wall and only staff can clear it.

- `backend/src/services/sessions.service.ts` — `checkAndAutoReleaseTable`.

- [ ] Confirmed / real
- [ ] By design

### 16. The Table Pass can only list guests who ordered — Low/Med — verified
The backend already records real members in `table_members` on join, but no
endpoint exposes them, so the pass derives names from order/cart `added_by`.
A guest who joined but has not ordered is missing (except the current device).

- `frontend/components/diner/table-pass-modal.tsx`
- `backend/src/services/sessions.service.ts` — `upsertTableMember` (no read route).

- [ ] Confirmed / real
- [ ] By design

---

## D. Load limits (will bite in a real restaurant)

### 17. Rate limits are per IP, and a restaurant is one IP — High in production — verified in code
`apiLimiter` allows 240 requests/min **per IP**. The diner cart poll alone is
12/min per phone; ~10 devices plus KDS refreshes is enough to trip 429s and push
screens into their error states.

- `backend/src/middleware/rate-limit.ts` — `apiLimiter`.

- [ ] Confirmed / real
- [ ] By design

### 18. The login limiter is shared across every PIN wall per IP — Med-High — verified in code
10 failed logins per 10 minutes per IP, across kitchen, floor and manager PINs.
A few fat-fingered attempts from several devices lock all PIN walls for ten
minutes.

- `backend/src/middleware/rate-limit.ts` — `loginLimiter`
  (`skipSuccessfulRequests` only spares correct PINs).

- [ ] Confirmed / real
- [ ] By design

---

## E. Wording / small logic

### 19. The bill's "table total" includes food that has not been ordered yet — Low — verified
Staged cart lines are added into the total, so the number can read as money owed
when nothing has been fired.

- `frontend/components/diner/bill-drawer.tsx`.

- [ ] Confirmed / real
- [ ] By design

### 20. The pass shows "3 dishes / 0 rounds" for an unfired cart — Low — verified
Accurate but reads as a contradiction; "3 dishes ordered, none sent yet" would
say the same thing without the confusion.

- `frontend/components/diner/table-pass-modal.tsx`.

- [ ] Confirmed / real
- [ ] By design

---

## F. Findings from the second review (checked, then kept or ruled out)

These arrived as a separate audit. Every one was verified against the code here;
the verdict is in the heading. Their list was cut off mid-item 11, so anything
after that was never received.

### 21. A new party inherits the previous party's orders — High — verified
`GET /api/v1/orders` filters on `table_id` only. `clearTableRows` deliberately
keeps `orders` (they are billing history), and `session_started_at` is reset on
clear, so nothing scopes an order list to the current seating.

What a guest actually sees at a freshly claimed table: the running total in the
bill and the nav pill includes food previous diners ate; the tracker's
`orders.sort(...).at(0)` picks the previous party's last ticket and can open on
"Served / start a new round" before they order anything; "Split by person" lists
people who left hours ago.

- `backend/src/services/orders.service.ts` — `listOrders` (and its count query).
- `frontend/hooks/use-live-table.ts` — `loadLive` and `activeOrder`.
- Fix shape: scope both to `o.created_at >= t.session_started_at` (or archive
  orders per session id).

- [ ] Confirmed / real
- [ ] By design

### 22. Settling a bill empties the guest's orders immediately — Med — verified, mostly by design
On `bill_status = paid` the hook clears cart, orders and the optimistic overlay
and the screen goes behind the "Thank you!" overlay. If the table paid before
the food left the line (pre-pay, or a staff settle), the diner loses the tracker
and the order history while their dishes are still being cooked.

- `frontend/hooks/use-live-table.ts` — the `settledAt` effect.
- `frontend/components/diner/diner-table-screen.tsx` — the overlay.

- [ ] Confirmed / real
- [ ] By design

### 23. "Retry" on a refused round deletes the ticket before re-firing it — Med — verified
`requeueDeniedOrder` moves the still-available lines back into the cart and then
`DELETE FROM orders`, and `retryDenied()` fires straight after. If that fire
fails (another 86, a network drop), the refused ticket is already gone from
history, the items sit in the cart, and the tracker drops the refused-round
panel — the guest gets one toast and is left on a tracker with nothing to look
at until they go back to the menu themselves.

- `backend/src/services/orders.service.ts` — `requeueDeniedOrder`.
- `frontend/hooks/use-live-table.ts` — `retryDenied`.
- `frontend/components/diner/live-tracker.tsx` — the retry handler.

- [ ] Confirmed / real
- [ ] By design

### 24. Editing a duplicate dish's note can 500 — Med — verified in code
`cart_items` is unique on `(table_id, menu_item_id, request_note, allergy_note)`.
`updateCartItem` performs a plain `UPDATE ... SET request_note = ...` with no
`ON CONFLICT` and no 23505 handling, so editing or clearing the note on the
second of two identical dishes collides with the first row and comes back as a
500 `INTERNAL_ERROR` instead of merging the two lines.

- `backend/sql/001_init.sql` — `cart_items_upsert_uq`.
- `backend/src/services/cart.service.ts` — `updateCartItem`.

- [ ] Confirmed / real
- [ ] By design

### 25. A deck keeps showing a dish after the kitchen 86's it — Med — verified
`DishDeck` seeds its pile with `useState(items)`, which only reads the prop on
mount, and the browser's remount key is built from item **ids** (plus the diet)
— not from availability or price. So a realtime menu reload with the same ids
leaves the old item objects in the pile: the card still looks orderable and the
add fails with `ITEM_UNAVAILABLE`.

- `frontend/components/diner/dish-deck.tsx` — the `queue` state.
- `frontend/components/diner/menu-browser.tsx` — the remount key.
- Fix shape: reconcile the queue when `items` changes, or include availability in
  the key.

- [ ] Confirmed / real
- [ ] By design

### 26. A mistyped table code says the bill was settled — Low — verified
`TABLE_NOT_FOUND` from `startTableSession` sets the gate to `ended`, which
renders the "Table cleared — the bill was settled, scan the QR to start fresh"
screen. A wrong code on the home page should say the code is not a table.

- `frontend/components/diner/table-session-gate.tsx` — `catch` in the load
  effect, and `SessionEndedState`.

- [ ] Confirmed / real
- [ ] By design

### 27. Only one round can be open per table — Med — verified, by design (decision needed)
The partial unique index `orders_one_active_uq` plus the `checkActiveOrder`
pre-check mean a second round (mains, extra rotis, another round of drinks)
cannot be fired until the kitchen serves the first ticket. The intent is the
double-tap guard, but the effect is 20–40 minutes of locked ordering.

- `backend/sql/001_init.sql` — `orders_one_active_uq`.
- `frontend/hooks/use-live-table.ts` — `fire()` calls `checkActiveOrder`.
- Decision: keep one round at a time (documented) or narrow the guard to "the
  same cart within N seconds".

- [ ] Confirmed / real
- [ ] By design

### 28. Unfiltered realtime table handler — Low — **not reproduced** (hardening only)
The report said any table going empty or paid would kick every other table. That
does not happen: `restaurant_tables` is claim-scoped by RLS
(`002_review_fixes.sql`), and the diner's realtime token carries only its own
`table_token`, so it never receives another table's row. The handler still does
not compare `change.code` to the current table, so a misconfigured policy or a
staff token would act on foreign events — worth a one-line guard, not a bug
report.

- `frontend/lib/api-client/realtime.ts` — `subscribeTableUpdates` (no filter).
- `frontend/hooks/use-live-table.ts` — the table-updates handler.
- `backend/sql/002_review_fixes.sql` — `restaurant_tables_select_public`.

- [ ] Confirmed / real
- [ ] No action

### 29. Floor staff blocked from 86-ing — **not reproduced** (latent)
`PATCH /menu/items/:id/availability` demands `role: "kitchen"`, and the floor
board's PIN wall uses the same `kds-login`, which always mints `role: "kitchen"`.
So floor operators already hold the kitchen role and the request passes. The
mismatch only becomes real if a `"floor"`-role token is ever introduced, at
which point the guard needs `requireRole("kitchen", "floor")`.

- `backend/src/routes/menu.ts` — `requireRole("kitchen")`.
- `backend/src/services/auth.service.ts` — login always issues `kitchen`.
- `backend/src/routes/floor.ts` — `FLOOR_ROLES = ["floor", "kitchen"]`.

- [ ] Confirmed / real
- [ ] No action

### 30. Duplicate of #15, with one extra detail
The report's "abandoned table never released" is item 15 above. The addition
worth keeping: the background sweeper also only selects `bill_status = 'paid'`,
so there is no path at all — timer or event — that releases a table which never
asked for a bill.

- `backend/src/index.ts` — the sweeper query.
- `backend/src/services/sessions.service.ts` — `checkAndAutoReleaseTable`.

- [ ] Confirmed / real
- [ ] By design

---

## What I checked (so you know the coverage)

- Every page route returns 200 and renders: `/`, `/about`, `/presentation`,
  `/floor`, `/kitchen`, `/admin`, `/table/[token]`, `/table/[token]/tracker`;
  unknown paths 404.
- Every endpoint the frontend calls exists on the backend with the same method
  and path (sessions, auth, menu, cart, orders, kds, floor, admin, health,
  ready) — no missing-route mismatches found.
- Mappings in `frontend/lib/api-client/normalize.ts` match the backend payload
  shapes for tables, menu, cart, orders, floor summaries and KDS tickets.
- The KDS action map (`pending → preparing → ready → served`) matches the
  backend state machine, including serving via prune.
- Session flows (initialize / join-pin / join-pass / reconnect) handle the
  documented codes (`STALE_SESSION`, `SESSION_ENDED`, `TABLE_PIN_LOCKED`) on
  both sides, and `scan_time` is sent.

## Suggested fix order (my ranking)

**21 → 1 → 2 → 3 → 10 → 23 → 25 → 14 → 15 → 17 → 18**, then 5 (needs a server
field on the diner payload), 24 (cart merge on conflict) and 13/16 (small backend
additions). 22 and 27 are product decisions more than bugs; 4, 12, 19, 20, 26 are
polish. 28 and 29 need no work today.

---

## Decisions & outcome (2026-10-29)

The architecture-affecting items were decided before any code was changed; the
rest were fixed in place. `docs/7-api-contract.md` §7–8 records the contract
changes.

| # | Decision | Outcome |
|---|---|---|
| 1 | — | Refresh is **soft**: it swaps the snapshot in place, so the deck, skipped cards, scroll and open sheets survive. Only Retry (from the error screen) resets `loading`. |
| 2 | — | Fire is disabled while any cart write is in flight (`syncing`), plus a handler guard for Enter-key re-entry. |
| 3 | — | New `GET /sessions/:token` (E18) polled every 5 s; the diner poll now covers table status **and** `bill_status`. |
| 4 | — | ± and remove are optimistic (`lineAdjustments` / `removedLines` over the server cart), with rollback on failure. No per-line busy lock. |
| 5 | **Server `bill_status` only** | Diner reads the server column via E18 + the table channel; `requestBill` goes through the API. The localStorage store is no longer imported by any live screen. |
| 6 | — | A poll that overlapped a local write (write sequence counter) never raises a "someone else changed the cart" diff. |
| 7 | — | Folder tree re-reads on every menu reload and retries after 10 s on failure. |
| 8 | — | `activeOrder` is only `pending / preparing / ready`, so a denied ticket no longer pulses the nav dot. |
| 9 | — | Fire and soft refresh clear `pendingAdds`, line adjustments and removals. |
| 10 | — | KDS board polls every 15 s in the success phase (matches the floor). |
| 11 | — | The 401 guard clears the staff unlock flags and redirects to the gate of the **current** surface (`/floor` → `/floor`, `/kitchen` → `/kitchen`); admin keeps its own wall. |
| 12 | **By design** | `/floor` and `/admin` stay URL-only routes; no new navigation was added. |
| 13 | — | `GET /floor/tables` now requires role `floor` or `kitchen`. |
| 14 | — | Presence badge uses the server registry count (`active_devices` from E18), with Supabase Presence as the faster number when configured. The dead local heartbeat path is no longer read. |
| 15 / 30 | **Keep paid-only release** | No server change. The floor's `needs_attention` flag plus staff/manager clear remain the answer for a walk-out; documented as intentional. |
| 16 | **New members endpoint** | `GET /sessions/:token/members` (E19); the Table Pass reads it while open (15 s) and falls back to order-derived names if the read fails. |
| 17 | **Credential-keyed budgets** | `apiLimiter` keys on staff bearer / table token with an IP fallback (600/min per credential); a separate 6 000/min per-IP backstop remains. |
| 18 | **Per-surface login counters** | Kitchen and floor share `kds-login` with an optional `surface` field; admin has its own limiter. Fat-fingering one wall cannot lock another. |
| 19 | — | The bill footer shows **ordered** total (fired, denied excluded) and lists staged lines separately; "split by person" is ordered-only. |
| 20 | — | An unfired cart says "Dishes chosen … ordered, none sent to the kitchen yet" and omits the "0 rounds" row. |
| 21 | **Wipe the seating on clear** | Clearing (staff, auto-release, admin clear/deactivate/regenerate/archive) now deletes that table's orders as well as cart/roster/presence. Served takings survive in `sales_day` / `sales_rollup` (sql/012), which is what admin analytics reads — no revenue history is lost and no previous party's food can appear on a new party's tracker. |
| 22 | **Thank-you only when nothing is cooking** | Paid while a ticket is active shows a "Bill paid — still cooking" banner and keeps tracker/history; the overlay appears once no ticket is pending/preparing/ready. Settling no longer wipes the diner's orders. |
| 23 | — | `POST /orders/:id/retry` (E20) does move → replace → fire in ONE transaction; a failed re-fire rolls back, so the refused ticket is preserved. |
| 24 | **Merge colliding note edits** | E6 runs in a transaction; if the new note pair already exists it adds the quantity to that line (capped at 99) and removes the edited row. |
| 25 | — | Deck remount key includes availability and price, so an 86 with unchanged ids refreshes the pile. |
| 26 | — | `TABLE_NOT_FOUND` at the gate renders "That code is not a table" with a link back to the scanner, never the settled-table screen. |
| 27 | **Keep one open round, documented** | The partial unique index and E9 pre-check stay. This is intentional: one grouped ticket at a time simplifies the KDS; the next round unlocks when the kitchen serves it. |
| 28 | — | The table-updates handler ignores rows whose `table_id`/`code` is not this table (one-line hardening). |
| 29 | **No action** | Latent only; floor tokens still carry the `kitchen` role. If a real `floor` role is introduced, widen E14 to `requireRole("kitchen", "floor")`. |
