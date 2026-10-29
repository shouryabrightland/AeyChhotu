import rateLimit from "express-rate-limit";
import { ipKeyGenerator } from "express-rate-limit";
import { createHash } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import { AppError } from "../errors/app-error.js";
import { logEvent } from "../observability/logger.js";

/* Rate limiting per docs/7 §1.8, reshaped for a real restaurant (docs/14
   #17/#18).

   THE PROBLEM: every diner phone and every staff tablet in a restaurant
   shares ONE public IP, so a single per-IP bucket of 240 req/min was tripped
   by the diners' own 5 s cart poll (~12/min each) after ~10 devices. Worse,
   one harsh login limiter covered kitchen, floor and manager PINs, so a few
   fat-fingered attempts at one wall locked every wall.

   THE SHAPE:
     apiLimiter       — budget per CREDENTIAL (staff bearer token, or the
                        table token on a diner request), falling back to IP
                        only when neither is present. A phone polling its own
                        table can never consume another table's budget.
     ipSafetyLimiter  — one deliberately high per-IP ceiling, so the shared
                        restaurant IP still has a runaway-client backstop
                        without being the normal budget.
     staffLoginLimiter — failed-attempt budget keyed by SURFACE + IP. Kitchen
                        and floor use the same endpoint, so the client states
                        its surface; whatever happens at one wall leaves the
                        other counters alone.
     adminLoginLimiter — its own counter, so manager PIN attempts can never
                        lock the staff walls.

   All four speak the contract envelope (429 RATE_LIMITED) and emit a
   structured warn line so a flood is visible in logs. */

const HANDLER = (req: Request, res: Response, next: NextFunction, options: { statusCode: number }): void => {
  const retry = res.getHeader("Retry-After");
  logEvent("warn", "rate_limited", {
    request_id: (req as Request & { requestLog?: { requestId: string } }).requestLog?.requestId,
    scope: req.originalUrl.startsWith("/api/v1/auth/kds-login") ||
      req.originalUrl.startsWith("/api/v1/auth/admin-login")
      ? "login"
      : "api",
    path: req.originalUrl.split("?")[0],
    ip: req.ip,
  });
  next(
    new AppError(options.statusCode, "RATE_LIMITED", "Too many requests. Please slow down.", {
      retry_after: typeof retry === "string" ? Number(retry) || retry : retry,
    }),
  );
};

const SKIP_PROBES = (req: Request) =>
  req.originalUrl.startsWith("/api/v1/health") || req.originalUrl === "/api/v1/ready";

/** IPv6-safe IP part. express-rate-limit requires this helper whenever a
    custom keyGenerator is supplied, or every IPv6 address would be its own
    bucket instead of its /64. */
function ipPart(req: Request): string {
  return `ip:${ipKeyGenerator(req.ip ?? "")}`;
}

/** Never put a bearer secret or a table credential in a map key in the
    clear. They are already capability tokens; hashing keeps a heap dump or a
    debug log from containing one. */
function opaque(prefix: string, value: string): string {
  const digest = createHash("sha256").update(value).digest("base64url").slice(0, 22);
  return `${prefix}:${digest}`;
}

function tableTokenOf(req: Request): string | null {
  const fromQuery = req.query?.table_token;
  if (typeof fromQuery === "string" && fromQuery.length > 0) return fromQuery;

  const body = req.body as { table_token?: unknown } | undefined;
  if (typeof body?.table_token === "string" && body.table_token.length > 0) return body.table_token;

  return null;
}

/** Diner/staff budget identity: bearer token → table token → IP. */
function credentialKey(req: Request): string {
  const header = req.header("authorization");
  if (header?.startsWith("Bearer ")) return opaque("token", header.slice(7));

  const table = tableTokenOf(req);
  if (table) return opaque("table", table);

  return ipPart(req);
}

/** Which PIN wall is asking. The kitchen and floor share kds-login, so the
    client names its surface; anything unrecognised counts as kitchen. */
function surfaceKey(req: Request): string {
  const body = req.body as { surface?: unknown } | undefined;
  return body?.surface === "floor" ? "floor" : "kitchen";
}

/** Every /api/v1 route — budget per credential, not per shared IP. */
export const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  /* A table token is shared by every phone at that table, and one phone's
     cart + state + order polls are ~28 req/min; 600 leaves headroom for a
     large party without approaching the old per-IP ceiling. */
  limit: 600,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  keyGenerator: credentialKey,
  skip: SKIP_PROBES,
  handler: HANDLER,
});

/** One high per-IP backstop, so the shared restaurant IP still has a
    runaway-client ceiling above the sum of the credential budgets. */
export const ipSafetyLimiter = rateLimit({
  windowMs: 60 * 1000,
  /* ~100 req/s for the whole venue: far above real traffic, still a ceiling
     a runaway script hits. */
  limit: 6_000,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  keyGenerator: ipPart,
  skip: SKIP_PROBES,
  handler: HANDLER,
});

/** POST /api/v1/auth/kds-login — PIN brute-force guard, one counter per
    surface per IP. `skipSuccessfulRequests` means only FAILED logins consume
    budget: a correct PIN on the first tap is never penalised. */
export const staffLoginLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  limit: 10,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  keyGenerator: (req) => `login:${surfaceKey(req)}:${ipPart(req)}`,
  handler: HANDLER,
});

/** POST /api/v1/auth/admin-login — the manager wall's own budget. */
export const adminLoginLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  limit: 10,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  keyGenerator: (req) => `login:admin:${ipPart(req)}`,
  handler: HANDLER,
});
