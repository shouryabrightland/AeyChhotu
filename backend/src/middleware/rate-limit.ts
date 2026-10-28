import rateLimit from "express-rate-limit";
import type { NextFunction, Request, Response } from "express";
import { AppError } from "../errors/app-error.js";
import { logEvent } from "../observability/logger.js";

/* Rate limiting per docs/7 §1.8. Two tiers:
     loginLimiter  — both login doors (kds-login and admin-login). A PIN is a
                     single shared secret, so brute force is the realistic
                     attack; this limiter is deliberately harsh (10 tries / 10
                     min) and counts ONLY failures, so a busy kitchen tapping
                     the COOK button all shift never trips it.
     apiLimiter    — broad safety net against a runaway client or script,
                     sized far above real diner traffic.

   Both speak the contract envelope (429 with the standard error frame) and
   emit a structured warn line so a flood is visible in logs. */

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

/** POST /api/v1/auth/kds-login — PIN brute-force guard.
    `skipSuccessfulRequests` means only FAILED logins consume budget: a
    correct PIN on the first tap is never penalised, but a script cycling
    PINs gets 10 guesses per 10 minutes (2^30 6-digit space ⇒ years). */
export const loginLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  limit: 10,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  handler: HANDLER,
});

/** Every /api/v1 route — runaway-client safety net, not a business rule. */
export const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 240,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  // Health/readiness probes are exempt: monitoring must stay truthful.
  skip: (req) => req.originalUrl.startsWith("/api/v1/health") || req.originalUrl === "/api/v1/ready",
  handler: HANDLER,
});
