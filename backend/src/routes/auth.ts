import { Router } from "express";
import { env } from "../config/env.js";
import { requireAuth } from "../middleware/auth.js";
import { authenticateAdmin } from "../services/admin.service.js";
import { authenticateShift, sessionIdentity } from "../services/auth.service.js";
import { adminLoginSchema, kdsLoginSchema, parseOrThrow } from "../validation/schemas.js";

/* Module 1 — Shift Authentication.
   E2  POST /api/v1/auth/kds-login    (role:'kitchen' JWT + httpOnly kds_token)
   E2c POST /api/v1/auth/admin-login  (role:'admin' JWT + httpOnly admin_token)
   E2b GET  /api/v1/auth/me           (decodes header bearer or cookie) */
export const authRouter = Router();

// E2 — POST /api/v1/auth/kds-login
authRouter.post("/kds-login", async (req, res) => {
  const body = parseOrThrow(kdsLoginSchema, req.body);
  const shift = await authenticateShift(body.pin);

  /* httpOnly cookie for browser terminals: JavaScript on the page can never
     read the token. SameSite/Secure come from config so the same code works
     whether the deployment is same-site (Strict) or cross-site
     (COOKIE_SAME_SITE=none, which forces Secure automatically). */
  res.setHeader(
    "Set-Cookie",
    [
      `kds_token=${encodeURIComponent(shift.token)}`,
      "HttpOnly",
      "Path=/",
      `Max-Age=${shift.expires_in}`,
      `SameSite=${env.cookieSameSite}`,
      ...(env.cookieSecure ? ["Secure"] : []),
    ].join("; "),
  );

  res.status(200).json({
    success: true,
    data: {
      token: shift.token,
      token_type: shift.token_type,
      expires_in: shift.expires_in,
      role: shift.role,
      terminal_id: shift.terminal_id,
      realtime_token: shift.realtime_token,
      message: shift.message,
    },
  });
});

/* POST /api/v1/auth/admin-login — the owner/manager console gate.
   Same cookie mechanics as kds-login, different cookie NAME and a different
   role claim, so a kitchen session and a manager session can never be
   confused for one another by either side. */
authRouter.post("/admin-login", async (req, res) => {
  const body = parseOrThrow(adminLoginSchema, req.body);
  const session = await authenticateAdmin(body.pin);

  res.setHeader(
    "Set-Cookie",
    [
      `admin_token=${encodeURIComponent(session.token)}`,
      "HttpOnly",
      "Path=/",
      `Max-Age=${session.expires_in}`,
      `SameSite=${env.cookieSameSite}`,
      ...(env.cookieSecure ? ["Secure"] : []),
    ].join("; "),
  );

  res.status(200).json({
    success: true,
    data: {
      token: session.token,
      token_type: session.token_type,
      expires_in: session.expires_in,
      role: session.role,
      message: session.message,
    },
  });
});

// E2b — GET /api/v1/auth/me (401 via requireAuth when token missing/expired)
authRouter.get("/me", requireAuth, (req, res) => {
  const source =
    (req as typeof req & { shiftSource?: string }).shiftSource === "cookie" ? "cookie" : "header";
  const data = sessionIdentity(req.shift!, source);
  res.status(200).json({ success: true, data });
});
