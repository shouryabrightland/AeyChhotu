# 11 · Free deployment

**Goal:** the app live on the public internet for **$0**, with **push-to-deploy** on both apps so a
frontend tweak goes live in about a minute.

| Piece | Host | Plan | Why this one |
|---|---|---|---|
| Next.js frontend | **Vercel** | Hobby (free) | Built for Next.js; every push to `main` redeploys automatically |
| Express API | **Render** | Free web service | Still card-free in 2026; supports a monorepo root directory and an HTTP health-check path |
| Postgres + Realtime | **Supabase** | Free | Already set up (`npm run db:setup`) |

> **✅ Live now.** This guide was followed end to end and the result was verified:</
> frontend on <https://aeychhotu.vercel.app>, API on
> <https://aeychhotu-api-bkp8.onrender.com>, Postgres on Supabase. §5 records exactly what was
> checked and how.

Two things this guide is honest about up front:

- **The free API sleeps.** Render spins a free web service down after 15 minutes without traffic and
  takes ~1 minute to wake it. Your API client already handles it: the 20 s timeout surfaces
  *"Serving line taking a moment to spin up, please try again!"*, and the production demo-fallback
  gate means it will **not** quietly serve seeded dishes instead. §4 removes the cold start for free.
- **Neither free tier is a production plan.** Render's docs say free instances are not for production,
  and Vercel's Hobby plan is **non-commercial only**. That is fine for a demo, QA, or a
  portfolio — a restaurant actually paying you needs ~$5–25/month (see §7).

---

## 1 · Backend on Render (do this first)

1. Sign up at <https://dashboard.render.com/register> with **GitHub** (no credit card for free
   instances).
2. **New +** → **Blueprint** → connect `kriti-on-git/AeyChhotu`.
3. Render reads [`render.yaml`](../render.yaml) and shows one service, `aeychhotu-api`. It prompts for
   the six `sync: false` values:

   > **Naming note:** Render makes the `onrender.com` subdomain globally unique. If the plain name
   > `aeychhotu-api` is already taken it appends a random suffix, so the *service name* and the
   > *hostname* can differ — e.g. the live example below is `aeychhotu-api-bkp8.onrender.com`.
   > Whatever the dashboard shows as the service URL is the one to use everywhere in this guide.

   | Key | Value |
   |---|---|
   | `CLIENT_URL` | `http://localhost:3000` for now — replaced in §3 (comma-separate to keep both) |
   | `DATABASE_URL` | Supabase → **Connect** → **Session pooler** URI (`aws-0-<region>.pooler.supabase.com:5432`). **Not** the direct `db.<ref>.supabase.co` host — that one is IPv6-only and Render's egress is IPv4 |
   | `STAFF_PIN` | same as local |
   | `ADMIN_PIN` | 4–6 digits, **different** from `STAFF_PIN` — gates the `/admin` console. `env.ts` refuses to boot without it |
   | `KDS_TOKEN_SECRET` | same as local |
   | `SUPABASE_JWT_SECRET` | same as local (omit/blank ⇒ REST-only, no Realtime) |

4. **Apply** → first build (~2–3 min).

The deploy is only promoted to live after `GET /api/v1/ready` returns 200. That probe runs a real
`SELECT 1` against Postgres, so **a green deploy proves the database credentials work** — if it stays
unhealthy, the `DATABASE_URL` is the thing to fix, not the app.

Your API is now at its Render URL — the Blueprint name gives `https://aeychhotu-api.onrender.com`,
but a taken name yields a suffixed host instead (the live example: `https://aeychhotu-api-bkp8.onrender.com`).

### Why the Blueprint matters

It pins the four settings that are easy to get wrong by hand:

- `rootDir: backend` — the repo is a monorepo, so the API must build from its own directory.
- `npm ci --include=dev && npm run build` — `NODE_ENV=production` also applies at build time, where
  npm would normally skip devDependencies. `tsc` lives there, so without `--include=dev` the build
  fails with `tsc: not found`.
- `healthCheckPath: /api/v1/ready` — the readiness probe, not liveness.
- `COOKIE_SAME_SITE=none` — frontend and API are on different sites; `env.ts` forces `Secure` for it.
- the `envVars:` list matches what `src/config/env.ts` hard-requires. `env.ts` exits(1) at boot
  when a required variable is absent and Render only sets what the Blueprint declares, so the two
  silently drifting apart is exactly the crash-loop this guide's §1 warns about. CI guards it:
  `cd backend && npm run check:render-env` fails when a required var is not declared here.

---

## 2 · Frontend on Vercel

1. Sign up at <https://vercel.com/signup> → **Continue with GitHub**.
2. **Add New → Project** → import `kriti-on-git/AeyChhotu`.
3. Set **Root Directory** to `frontend` (Edit → Root Directory). Framework auto-detects Next.js.
4. **Environment Variables** (tick Production *and* Preview):

   | Key | Value |
   |---|---|
   | `NEXT_PUBLIC_API_URL` | your Render service URL, e.g. `https://aeychhotu-api-bkp8.onrender.com` — no trailing slash |
   | `NEXT_PUBLIC_SUPABASE_URL` | `https://aqqexhkvidoykdlthwfj.supabase.co` |
   | `NEXT_PUBLIC_SUPABASE_ANON_KEY` | your public anon key |

   Leave `NEXT_PUBLIC_ENABLE_DEMO_FALLBACK` **unset** — a production build must never render seeded
   data as real orders.

5. **Deploy** → note the URL, `https://<something>.vercel.app`.

---

## 3 · Close the CORS loop (~30 s)

Render → your service (`aeychhotu-api`, or the suffixed name Render assigned) → **Environment** → set:

```
CLIENT_URL=https://<your-vercel-url>,http://localhost:3000
```

Save. Render redeploys the service automatically — **no code change, no rebuild of the frontend.**
Without this the browser blocks every API call (the allow-list is exact-match, `credentials: true`,
so a wildcard is impossible by design).

---

## 4 · Optional: keep the free API awake

**The exact window is 15 minutes.** Render's docs: it "spins down a Free web service that goes **15
minutes without receiving any inbound traffic**. This includes both HTTP requests and WebSocket
messages from existing connections." Spinning back up "takes about one minute". So for a live demo
you must generate *some* inbound request at least once every 15 minutes — budget for every 10 to
absorb a slow poll or a delayed pinger.

The cold start is mostly cosmetic — the client's "spin up" message covers it — but you can remove it
for free with any uptime pinger (UptimeRobot's free tier, cron-job.org, …) pointed at:

```
https://<your-render-service-url>/api/v1/ready
```

every 5–10 minutes.

### The bounded option: awake for exactly as long as you need

A permanent pinger is the wrong shape — see the hours math below — so the repo ships a script that
buys a **fixed window** instead:

```bash
cd backend

# default: 3 hours, a ping every 10 minutes, then it stops by itself
npm run keep-alive -- https://<your-render-service-url>

# tune the window
KEEP_ALIVE_HOURS=2 KEEP_ALIVE_INTERVAL_MIN=12 npm run keep-alive -- https://<your-render-service-url>
```

It hits `/api/v1/ready` — a real `SELECT 1`, so every ping also proves the database link — and it
**refuses an interval of 15 minutes or more**, because that would let the service fall asleep between
pings. Ctrl-C stops it early and prints a summary.

Closing the terminal kills it with the terminal. For a genuinely hands-off window, detach it:

```bash
cd backend
nohup npm run keep-alive -- https://<your-render-service-url> > /tmp/aeychhotu-keepalive.log 2>&1 &
```

**No third-party service is needed at all** if you are presenting: leaving the **`/floor`** screen open
in a tab also holds the API awake, because `use-live-floor.ts` polls it every 15 seconds
unconditionally. Note that `/kitchen` and the diner screens do **not** — with Realtime healthy their
updates arrive over Supabase WebSockets, which never touch Render, so an idle kitchen board generates
zero inbound traffic and the API still sleeps.

Render grants **750 free instance hours per workspace per calendar month**, and one always-on service
costs at most 744 h in a 31-day month — so this fits, **but only if that free service is the only one
you run.** Run a second free web service and the hours run out mid-month, at which point Render
suspends all of them until the 1st.

---

## 5 · Verify

```bash
API=https://aeychhotu-api-bkp8.onrender.com
WEB=https://aeychhotu.vercel.app

curl -s $API/api/v1/health
curl -s -o /dev/null -w '%{http_code}\n' $API/api/v1/ready          # 200

# CORS preflight for the deployed frontend
curl -si -X OPTIONS $API/api/v1/menu \
  -H "Origin: $WEB" -H "Access-Control-Request-Method: GET" | grep -i access-control

# Cross-site cookie flags (expect SameSite=None; Secure; HttpOnly)
curl -si -X POST $API/api/v1/auth/kds-login \
  -H 'Content-Type: application/json' -H "Origin: $WEB" \
  -d '{"pin":"<your STAFF_PIN>"}' | grep -i set-cookie
```

Then walk the real surfaces in a browser: `$WEB/table/k7x2p` → fire an order → `$WEB/kitchen` (PIN) →
move it through `pending → preparing → ready`, and watch `$WEB/table/k7x2p/tracker` update live.

If Realtime stays silent, check the three-way requirement: both `NEXT_PUBLIC_SUPABASE_*` in Vercel
**and** `SUPABASE_JWT_SECRET` in Render. Missing either one degrades to REST + 5 s polling by design.

### Verified on the live stack (27/27)

Run against `https://aeychhotu-api-bkp8.onrender.com` with `Origin: https://aeychhotu.vercel.app`:

| Area | Result |
|---|---|
| `GET /health` · `GET /ready` | ✅ `{"ok":true}` · `200` (proves the Supabase pooler credentials work) |
| CORS preflight | ✅ `204` + `access-control-allow-origin: https://aeychhotu.vercel.app` + `allow-credentials: true` |
| Cookie flags (E2) | ✅ `HttpOnly; Path=/; Max-Age=28800; SameSite=None; Secure` |
| Frontend bundle | ✅ correct API host inlined; **no** `localhost:4000` leaked into the production chunks |
| Realtime | ✅ `SUPABASE_JWT_SECRET` set — E1 issues a real 248-char `realtime_token` |
| Journey E1→E17 | ✅ initialize → menu → cart → **fire 201** → duplicate **409** → KDS ticket (allergy note renders) → preparing → ready → `served` **400** → tracker `ready` → prune → history (frozen bill `total == qty × unit_price`) → floor |
| Boundaries | ✅ E10 without a token → `401`; E15 with the wrong `table_token` → `404`; wrong PIN → `401` |

> **Note on E5:** `POST /api/v1/cart/items` answers **`200`**, not `201` — the upsert route returns `200`
> deliberately (`cart.ts`). Only E8 (fire) is a `201`.

> **Preview deployments:** each Vercel preview gets a fresh generated URL that is *not* in the
> allow-list, so its API calls fail CORS until you temporarily add that origin to `CLIENT_URL`. Test on
> the production URL, or add the preview origin when you need it.

---

## 6 · Everyday workflow: push to deploy

Both services watch `main`. To ship a change:

```bash
git add -A
git commit -m "…"
git push            # Vercel ~1 min · Render ~2–3 min (runs npm ci && npm run build)
```

**The one thing to remember:** `NEXT_PUBLIC_*` values are inlined into the frontend at **build** time.
If the API URL ever changes, update `NEXT_PUBLIC_API_URL` in Vercel, update `CLIENT_URL` in Render,
and **redeploy the frontend** — editing environment variables alone will not update an already-built
bundle.

Vercel **preview** deployments get a fresh generated URL per branch, which will not be in the API's
allow-list, so their API calls fail CORS until you temporarily add that origin to `CLIENT_URL`.
Test on the production URL, or add the preview origin when you need it.

---

## 7 · When free is no longer enough

| Symptom | Fix |
|---|---|
| Cold starts are unacceptable during service | Render → API → plan `0.5c-512mb` (~$7/mo), or any always-on host |
| Both apps need to be commercial | Vercel → Pro ($20/mo) |
| Realtime must not depend on optional env | Set `SUPABASE_JWT_SECRET` and assert it with `npm run realtime:check` |

Nothing in the codebase changes for any of these — the app was built for both hosting shapes
(same-site and cross-site), which is why `CLIENT_URL`, `COOKIE_SAME_SITE` and `credentials: include`
already exist.
