# Frontend Report — AeyChhotu

What has been built and verified in the AeyChhotu frontend.

## 1. Repository Layout

```
/
├── docs/        # All project documentation (source of truth)
└── frontend/    # Complete Next.js application
    ├── app/           # App Router pages, layouts, API route
    ├── components/    # ui/ layout/ motion/ diner/ staff/ brand/
    ├── hooks/         # use-db, use-presence, use-table-data, use-now, scroll lock
    ├── lib/           # api/ service layer, fonts, format, motion, site, sound, utils
    └── configs        # package.json, tsconfig, next/postcss/eslint configs, .gitignore
```

## 2. Technology

| Item | Choice |
|---|---|
| Framework | Next.js 16.3.6 (App Router, Turbopack) |
| Language | TypeScript (strict), React 19.3 |
| Styling | Tailwind CSS v4 with a single `@theme` token block |
| Animation | `motion` v13 — scroll parallax, reveals, overlays |
| Icons | Lucide React |
| Fonts | `next/font` — Fraunces (display) + Inter (body) |

No additional frameworks; no Bootstrap/MUI/UI kits.

## 3. Screens vs Documented Flows

| Documented flow | Route | Status |
|---|---|---|
| Landing / home | `/` (`(marketing)` route group) | ✅ |
| Diner: scan QR → shared menu, cart, allergy box, Review & Fire | `/table/[token]` | ✅ |
| Diner: live guest tracker (grey → amber → green flash) | `/table/[token]/tracker` | ✅ |
| Chef: PIN gate → KDS kanban (Pending/Preparing/Ready) | `/kitchen` + `POST /api/v1/auth/kds-login` | ✅ |
| Server: floor view, active table tags, quick 86ing panel | `/floor` | ✅ |
| Diner calls for the bill → floor takes payment → thank-you + table clear | `/table/[token]` + `/floor` | ✅ client-side channel |
| Error / not-found states | `app/error.tsx`, `app/not-found.tsx` | ✅ |

Every endpoint behavior from `docs/4-architectural-mapping.md` (session init, cart add/remove, fire with inventory check, anti-duplicate guardrail, KDS status machine, ticket pruning, availability toggle) is represented in the service layer.

## 4. Design System

- **Tokens:** one `@theme` block in `app/globals.css` holds the Hospitality skin — near-white ground (`#FBF8F4`), white raised surface, espresso ink (`#1C1512`), the `#9E3E14` ember accent, status colors (pending/preparing/ready/alert), type scale, radii, shadows, motion timings. A second, unlayered `[data-skin="ops"]` block enlarges only the ticket type for the kitchen and floor boards, so one selector adapts a whole surface without forking the palette. No hardcoded colors scattered across files.
- **Typography:** editorial clamp-based scale from display → label, wired through `next/font`.
- **Primitives:** reusable components in `components/ui/` (Button, IconButton, Card, Badge, Input, Textarea, Select, Field, Modal, Drawer, Overlay, Tooltip, Toast, Spinner, LoadingState, EmptyState, Container, Section, Heading, Text, PageHeader, SectionHeader…). No duplicated markup between pages.
- **Skins:** `data-skin="ops"` wraps the kitchen and floor surfaces (`kitchen-screen.tsx`, `floor-screen.tsx`). All surfaces share the one Hospitality palette; the ops wrapper only enlarges the ticket type so it reads at distance, and the viewports on both routes report the same light `themeColor`.
- **Token hygiene:** the QR table token (`restaurant_tables.code`) is a capability credential, so no diner surface renders it — the diner sees only generic copy ("Your table", "Live status tracker"). Staff surfaces label a table by its human `name`; only the PIN-gated kitchen board shows the code.
- **Removed:** the `components/landscape/` set (LandscapeScene, Sun, OrganicShape, SectionDivider) was unmounted in the palette pass — the diner header and the landing hero were rebuilt around product mocks instead — and has now been deleted along with the unreferenced `public/hero.png`.

### Diner ordering flow (`/table/[token]`)

The diner screen is a staged discovery flow over the same single cart: **menus → sections → dishes → shared cart → Review & Fire**. Nothing in it owns data — it reads `useLiveTable` and calls its `addToCart` / `updateLine` / `removeLine` / `fire` handlers, exactly as the modal did before.

- **`lib/diner/menu-atlas.ts`** arranges the API's flat `category` strings into cuisine cards, then the backend's own categories, then dishes. Cuisines are a presentation layer over dish names/descriptions; unmatched dishes fall into one honest “From the kitchen” group, and a menu whose vocabulary is unknown collapses to leading with its real categories.
- **`lib/diner/food-photos.ts`** is the imagery layer. The menu contract has no image column and the schema is not ours to change, so photos are resolved frontend-side from a curated dish → photo map with a category fallback. The photos themselves are **downloaded into `public/food/`** and shipped with the app (no remote host in `next.config.ts`), so a plate never depends on a third-party CDN answering the optimiser; a dish with no photo, or a failed load, still degrades to a palette tile rather than a broken frame.
- **Deck to order:** `dish-card` owns its drag (motion's `drag="x"`, distance + velocity thresholds) and its exit animation. `menu-browser` renders **one deck per folder** (`dish-deck.tsx`): the folder's dishes stacked in a single pile with the next two peeking out as a visible stack edge, headed by the folder's name and a `1 / n` progress bar with "Up next · …". Decks sit on a responsive grid — one per row on a phone, two on a tablet, back to **one** from `lg` (the 21rem cart aside narrows the menu column to ~536px, where two cards read as columns of text) and two from `xl`. An add or skip flicks the top card out and the pile advances; when a folder runs out the deck offers **Start again** and the skipped dishes as chips. Every gesture has a plain **Add / Skip** button beside it and an `aria-live` announcement, so the gesture is the delightful path, never the only path. Reduced motion keeps the drag but drops the rotation and the exit slide.
- **Cart:** `table-cart` is the desktop sticky column and `cart-strip` the phone's compact bottom bar; both open the existing review modal. Writes are **optimistic**: an add paints into every cart surface in the same frame, and the count pill says **Syncing** (spinner, ember) until `useLiveTable` has read the server's own cart back — a refused add rolls the overlay back and shows the API message on the card. A tap never waits on a round trip to be visible. `quantity-stepper` is shared by the panel and the modal so the `quantity_delta` intent path has one implementation.
- **Bill:** `table-cart` puts a wordless receipt glyph beside *Review & fire* (tooltip “Get bill now”, disabled once asked) that raises a bill request; `floor-view` reads the same state and grows an ember “Bill requested → tap to take payment” row, which settles the bill **and** calls `settleTable()` so the table’s staged cart and orders are erased. The diner then gets a 3.6 s full-screen “Thank you!” before the event is acknowledged and dropped. All of it reads through `hooks/use-bills.ts` (`useSyncExternalStore` over `lib/api/bill.ts`, a `localStorage` + `BroadcastChannel` channel — prototype scope, one file to swap for an API endpoint); `use-live-table` clears its local frame on a settle so the diner’s screen comes back empty.
- **Tests:** `test/menu-atlas.test.mjs` pins the atlas grouping, its degradation behaviour and the photo resolver's host restriction; `test/bill.test.mjs` pins the bill handoff — request idempotency, subscriber lifecycle, settle keeping the original request, acknowledgement leaving neighbouring tables untouched, and `settleTable()` erasing one table without touching its neighbour (`npm test`).

## 5. Motion & Parallax

- Entrance reveals via `components/motion/reveal.tsx`, plus status/overlay/card transitions.
- `useReducedMotion` respected in every animated component (reveals, KDS cards, tracker, overlays) — verified in-browser with emulated `prefers-reduced-motion`.
- Transform/opacity-based animation only; no layout-shift effects, no scroll hijacking.

## 6. Data & API Layer

- **One `fetch` call in the whole app** (KDS PIN login). All UI talks to `lib/api/index.ts`, a typed async service layer whose functions mirror the documented endpoints 1:1 and return `ServiceResult` envelopes.
- Typed domain models in `lib/api/types.ts`.
- Data currently resolves from a local seeded store (`lib/api/seed.ts`, `store.ts`) behind the service boundary — ready to be swapped to Supabase without touching UI components.

## 7. Accessibility & States

- Semantic landmarks, `aria-label`s on navs/icons/keypad, `role="status"` spinners, labeled form fields, keyboard-operable PIN keypad, overlays close on Escape with focus handling.
- Loading, empty, and error states exist as dedicated components and are used across screens (e.g. tracker empty state, inactive-table state, custom 404).
- Buttons implement hover/active/disabled/loading variants.

## 8. Build Verification

| Check | Result |
|---|---|
| `npm run typecheck` (tsc --noEmit) | ✅ 0 errors |
| `npm run lint` (eslint) | ✅ 0 errors |
| `npm run build` (production) | ✅ Compiled successfully — 6 routes: `/`, `/floor`, `/kitchen`, `/table/[token]`, `/table/[token]/tracker`, `/api/v1/auth/kds-login` + `_not-found` |
| Dev server log | ✅ no errors or warnings |

## 9. Browser QA (headless Chrome against `next dev`)

**Render sweep — 6 screens × 6 widths (320, 375, 768, 1024, 1280, 1440px) = 36 combos:**

- **0px horizontal overflow on every combo** — no clipped or overlapping content
- No console errors, no page exceptions, no failed resources
- Verified rendered content on: landing, diner menu, live tracker, kitchen PIN wall, floor view, custom 404

**Interaction tests — 9/9 passed:**

- Mobile navigation drawer opens from the hamburger and closes with Escape @375px
- Add-to-cart updates the sticky cart strip; cart opens as a proper `role="dialog"` modal; Escape closes it @375px
- `prefers-reduced-motion` honored — page renders fully with zero overflow @375px
- Kitchen PIN: wrong PIN shows an inline error ("That PIN does not match."); correct PIN unlocks the live KDS board with columns, Start shift and Manage 86 controls @768px
- Floor view exposes the Quick 86 panel control @375px

**One finding:** the site has no favicon yet (no `public/` directory), so the first page load requests `/favicon.ico` and gets a 404 — harmless, browser-cached after first load. Everything else is clean.
