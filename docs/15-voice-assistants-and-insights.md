# 15 — Voice assistants, kitchen voice and operations insights

This is the record of the **conversational layer** and the data it reads. Three
surfaces speak to Gemini Live; two of them can change state, and both are
gated. Everything here ships in the browser — the API only releases the key and
serves the facts.

---

## 1. One model, three surfaces

| Surface | Component | Persona | Voice | Can write? |
|---|---|---|---|---|
| Diner `/table/<code>` | `components/diner/chhotu-assistant.tsx` | waiter | **Puck** (warm male) | cart, fire, bill, feedback |
| Kitchen `/kitchen` | `components/staff/kitchen-voice.tsx` | line cook's right hand | **Kore** | tickets, 86, shift |
| Manager `/admin` | `components/admin/admin-assistant.tsx` | operations analyst | **Aoede** | **no** — read-only by design |

There is **no text model anywhere**. `gemini-3.8-live` is the only model the app
talks to (`frontend/lib/ai/live-session.ts`), and typed input travels over the
same socket with `sendClientContent`.

### Where the key comes from

The Gemini key is never bundled. Each surface asks the API for it, and the
route's role decides who may ask:

| Endpoint | Gate | Consumer |
|---|---|---|
| `POST /api/v1/sessions/:table_token/...` (session payload) | valid table grant | diner sheet |
| `GET /api/v1/admin/assistant/key` | `requireRole("admin")` | manager console |
| `GET /api/v1/kds/assistant/key` | `requireRole("kitchen")` | kitchen board |

A diner token cannot read the kitchen or admin key; an admin token gets `403`
on `/kds/*`. The kitchen assistant renders **inside** the unlocked board, so the
PIN wall is its real gate.

---

## 2. Kitchen voice: "Aey Chhotu"

### Audio path

- The mic streams continuously while the shift is armed — 16 kHz PCM16 mono,
  chunked by a `ScriptProcessorNode` and sent with `sendRealtimeInput`.
- Playback is 24 kHz PCM16, queued so chunks butt together.
- Mic level (RMS) is throttled to ~12 fps purely for the UI bars.

### Wake-word gate

The wake word is **not** a second speech recogniser. It is a gate on the same
Live session's `inputTranscription`:

1. Every turn's transcript accumulates in `turnUserText`.
2. `containsWakePhrase()` (`frontend/lib/ai/wake-word.ts`) matches the phrase
   and its recognition variants ("ay chhotu", "hey chhotu", "ऐ छोटू").
3. Until it matches, model **audio is buffered, not played**, and the model's
   transcript is held.
4. On a match the buffered audio is released and `onWake` fires (the dock
   flashes "Aey Chhotu heard").
5. At `turnComplete` an unaddressed turn is **dropped** and produces no bubble.

A tap on the mic is the other way in: `addressNextTurn()` lets exactly **one**
following turn through without the phrase, then the gate re-arms. So a cook can
say "Aey Chhotu, table four ready", or tap once and just say "table four ready".

Timing matters and is handled: Live's `inputTranscription` can land a second or
two after the model has already decided to call a tool, so `runTools` waits up to
2.5 s for that turn's transcript before judging it. Previously every spoken
command raced the transcript and lost, answering `NOT_ADDRESSED`.

**The hard part is tools.** In `runTools`, a `functionCall` on a turn that did
not pass the gate is answered with `NOT_ADDRESSED` and is **never executed**.
Ambient kitchen talk therefore cannot move a ticket, 86 a dish, or serve food —
even if the model decides to call something.

A typo-safe path exists for debugging: typed input (`sendText`) bypasses the
gate, but the kitchen dock is voice-only.

### What the chef can say

| Tool | Effect | Confirmation |
|---|---|---|
| `get_board_overview` | counts per lane, waiting tables, oldest ticket | — |
| `list_tickets` | lines, quantities, requests, **allergies** | — |
| `move_ticket` | pending → preparing → ready (one lane at a time) | — |
| `serve_ticket` | ready → served (records the sale) | — |
| `deny_ticket` | refuses with a reason the diner reads | **spoken yes** |
| `set_dish_availability` | 86 / back on the menu | yes for 86, no for restock |
| `confirm_action` | runs or cancels the parked action | — |
| `start_shift` | arms the chime, registers the device | — |

Tickets are addressed by **table code** ("table four", "T04"), never by uuid.
An ambiguous reference is refused with the candidate list; a missing table
returns the open tables. Illegal lane moves are refused with the current lane
and the legal next step.

### Confirmation is state, not a prompt

`deny_ticket` and an 86 do **not** execute. They park a closure in
`createKitchenToolset` and answer `CONFIRMATION_REQUIRED`. Only
`confirm_action` can run that parked closure, and only after the chef says yes.
A model hallucinating `confirm: true` cannot fire an action that was never
parked — and the park is cleared as soon as it is used or cancelled.

---

## 3. Manager console assistant

Read-only by construction: there is no archive/clear/re-price tool, so the
admin JWT's power is never behind a sentence.

| Endpoint (all `requireRole("admin")`) | Tool |
|---|---|
| `GET /admin/insights/sales` | `get_daily_sales_summary` |
| `GET /admin/insights/best-selling?days&limit` | `get_best_selling_dishes` |
| `GET /admin/insights/pending-orders` | `get_pending_orders` |
| `GET /admin/insights/tables` | `get_table_occupancy` (guest names included) |
| `GET /admin/insights/inventory` | `get_inventory_status` / `get_low_stock_items` |
| `GET /admin/insights/feedback?limit` | `get_guest_feedback` |
| `GET /admin/insights/menu` | `get_menu_catalog` — ingredients, allergens, spice, diet tags, portion |

`get_menu_catalog` filters server-fetched records in the browser by free text
(name, category, description, ingredients, allergens, diet tags), category and
availability. Empty fields are reported as "not recorded" — the persona is told
never to invent an ingredient or an allergen.

`days` and `limit` are clamped server-side (1–90 and 1–20): those values come
from a language model.

---

## 4. The business day runs 05:00 → 05:00 IST

`sql/017_business_day_rollup.sql` rewrites `record_served_order_sale()` so
`sales_rollup.day` and `sales_day.day` use

```sql
((created_at AT TIME ZONE 'Asia/Kolkata') - interval '5 hours')::date
```

One expression, shared by the writer and every reader, so a 2 am order belongs
to the night that just ended instead of a fresh UTC date. `sales_hour` stays a
clock-hour bucket because it only draws the trend.

**Revenue means served tickets only.** The rollup fires on the transition into
`served`; a fired-but-cooking ticket is on the floor board and not in revenue.
That is the design, not a bug.

---

## 5. Waiter → kitchen ping

The floor's **"I'll serve this"** used to be a browser-only flag. It now writes
`restaurant_tables.serve_requested_at` (`sql/018`):

1. `POST /api/v1/floor/tables/:table_id/serve-request` (staff roles) — refused
   with `409 NO_READY_TICKET` when nothing is at the pass.
2. The KDS ticket payload carries `table.serve_requested_at`.
3. The board shows a **"Waiter coming"** strip with the table codes, chimes if
   audio is armed, and toasts once per new ping.
4. Serving or denying the ticket clears the flag in the same transaction.
   **Release** on the floor calls `DELETE …/serve-request`.
5. The board subscribes to `restaurant_tables`, so the ping lands immediately;
   pings older than 20 minutes are hidden as a crash-safe guard.

---

## 6. Schema added for the AI surfaces

| Migration | Adds |
|---|---|
| `015_menu_item_metadata.sql` | `ingredients`, `spice_level`, `allergens`, `diet_tags`, `portion_description` |
| `016_stock_and_feedback.sql` | `menu_items.stock_quantity`, `low_stock_threshold` (NULL = untracked) + `guest_feedback` |
| `017_business_day_rollup.sql` | the 05:00 IST business-day definition in the rollup trigger |
| `018_waiter_serve_request.sql` | `restaurant_tables.serve_requested_at` + partial index |

`guest_feedback` is backend-only (RLS on, no browser grants). The diner writes
through `POST /api/v1/sessions/:table_token/feedback`; only the admin console
reads it.

---

## 7. Known limits

- **Stock is mostly untracked.** `NULL` means the kitchen keeps no count; the
  assistant is told never to read that as zero. There is no UI yet to set counts.
- **Feedback starts empty.** The console is told not to invent themes from it.
- **The wake gate depends on transcription.** If the transcript never arrives
  within the wait, the turn is refused (safe) rather than acted on. A tap is the
  fallback when recognition is slow. The mic is browser-only: Chrome/Edge are
  the reliable targets.
- **The mic needs one real tap the first time.** Browsers will not open an
  `AudioContext` or capture audio without a gesture, and a suspended context
  streams silence. After the permission is remembered the dock starts itself on
  load; `primeAudio()` is what makes that first tap work.
- **No wake word on the diner sheet or console** — those are tap-to-talk.
- **Rollup rows written before 017** keep their UTC-calendar day keys; the
  migration documents that they age out.

---

## 8. Files

```
frontend/lib/ai/
  live-session.ts            Live socket, mic, playback, wake gate, tool loop
  wake-word.ts               phrase + variants, normalisation
  system-prompt.ts           diner persona
  kitchen-system-prompt.ts   chef persona (wake word + confirmation rules)
  admin-system-prompt.ts     console persona
  tools.ts                   diner executors
  kitchen-tools.ts           chef executors + parked confirmations
  admin-tools.ts             read-only console executors
  *-tool-declarations.ts     the function schemas
frontend/components/
  diner/chhotu-assistant.tsx diner voice sheet
  staff/kitchen-voice.tsx    kitchen dock (always listening)
  admin/admin-assistant.tsx  console assistant
frontend/test/
  ai-tools.test.mjs          diner tool behaviours
  kitchen-ai-tools.test.mjs  chef tools, confirmations, wake matching
  admin-catalog-tool.test.mjs catalogue queries
backend/src/services/
  insights.service.ts        sales, best sellers, tickets, tables, stock, feedback, catalogue
  kds.service.ts             tickets + serving (clears the waiter ping)
  floor.service.ts           floor feed + serve-request
```
