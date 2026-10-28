# 8 — Backend Build Report

**Status: ✅ PASS** (verified 2026-09-28)

## Stack
Express 5.2.1 · pg 8.23.0 · zod 4.6.5 · TypeScript 6.0.3 (tsx dev runtime) — lives in `backend/`, talks to the Supabase/Postgres cluster via SQL only.

## Build
| Check | Result |
|---|---|
| `tsc --noEmit` | ✅ 0 errors |
| `npm run build` (`tsc -p tsconfig.json`) | ✅ clean emit |
| Boot (`tsx src/index.ts`) | ✅ `[server] AeyChhotu backend listening on http://localhost:4000` |
| `GET /api/v1/health` | ✅ `{"data":{"ok":true}}` |

## Migration & seed (`backend/sql/`)
- `001_init.sql` — 5 domain tables + `staff_terminals`, indexes, **20 RLS policies** (anon: SELECT only, no INSERT/UPDATE/DELETE), `fire_order()` plpgsql RPC with `FOR UPDATE` serialization, cart freeze, `FOR UPDATE OF mi` inventory lock, cart purge on commit.
- `fire_order` **revoked from `anon`/`authenticated`** — only the service role path (Express) can call it.
- `seed.sql` is idempotent — running twice yields a stable **1 terminal / 5 tables / 20 dishes**.

## Live endpoint verification (curl vs seeded cluster)
| Check | Result |
|---|---|
| E2 `kds-login` PIN `1234` | ✅ 200 + HttpOnly cookie + shift JWT |
| E2b `/auth/me` (header and cookie) | ✅ 200 `role=kitchen` |
| Missing token on staff route | ✅ 401 `UNAUTHORIZED` |
| Diner-role token on kitchen route | ✅ 403 `FORBIDDEN` |
| Cart ownership `k7x2p` vs `m9b3x` | ✅ 404 `CART_ITEM_NOT_FOUND`, reads isolated |
| E8 fire | ✅ 201 |
| E8 duplicate fire | ✅ 409 `DUPLICATE_ORDER` |
| Sold-out fire | ✅ 409 `INVENTORY_FAILURE` + cart purged |
| RLS as anon | ✅ SELECT 12 rows / INSERT → `permission denied` |

## Security posture
- `service_role` never leaves the server; `STAFF_PIN` / `ADMIN_PIN` / `KDS_TOKEN_SECRET` never appear in payloads or logs.
- Missing/invalid env → loud `exit(1)` at boot (`src/config/env.ts`).
- `.env` and local `.pgdata/` are gitignored; only `.env.example` is tracked.

## Surface
17 endpoints + E2b (`sessions`, `auth`, `menu`, `cart`, `orders`, `kds`, `floor`, `health`), zod-validated, contract envelope `{success, data, meta?}` / `{success:false, error:{code,message,…}}` per `docs/7-api-contract.md`.
