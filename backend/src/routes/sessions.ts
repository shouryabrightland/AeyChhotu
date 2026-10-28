import { Router } from "express";
import {
  activeCheck,
  initializeSession,
  joinWithPass,
  joinWithPin,
  reconnectSession,
} from "../services/sessions.service.js";
import {
  activeCheckParamsSchema,
  initializeSchema,
  joinPassSchema,
  joinPinSchema,
  parseOrThrow,
  reconnectSchema,
} from "../validation/schemas.js";

/* Module 1+2 routes.
 *
 *   E1   initialize  first scan of an empty table claims it; an active table
 *                    answers `locked` and releases nothing
 *   E1b  join-pin    the 2-digit keypad; 3 wrong PINs flag the table (423)
 *   E1c  join-pass   the 20-character QR pass; also unflags a locked table
 *   E1d  reconnect   a returning device, no keypad, 403 once settled
 *   E9   active-check the anti-duplicate-fire guardrail
 *
 * None of these is staff-gated: the table token is the capability, and the
 * credentials they return are the diner's own. */
export const sessionsRouter = Router();

// E1 — POST /api/v1/sessions/initialize
sessionsRouter.post("/initialize", async (req, res) => {
  const body = parseOrThrow(initializeSchema, req.body);
  const data = await initializeSession(body.table_token);
  res.status(200).json({ success: true, data });
});

// E1b — POST /api/v1/sessions/join-pin
sessionsRouter.post("/join-pin", async (req, res) => {
  const body = parseOrThrow(joinPinSchema, req.body);
  const data = await joinWithPin(body);
  res.status(200).json({ success: true, data });
});

// E1c — POST /api/v1/sessions/join-pass
sessionsRouter.post("/join-pass", async (req, res) => {
  const body = parseOrThrow(joinPassSchema, req.body);
  const data = await joinWithPass(body);
  res.status(200).json({ success: true, data });
});

// E1d — POST /api/v1/sessions/reconnect
sessionsRouter.post("/reconnect", async (req, res) => {
  const body = parseOrThrow(reconnectSchema, req.body);
  const data = await reconnectSession(body);
  res.status(200).json({ success: true, data });
});

// E9 — GET /api/v1/sessions/:table_token/active-check
sessionsRouter.get("/:table_token/active-check", async (req, res) => {
  const params = parseOrThrow(activeCheckParamsSchema, req.params);
  const data = await activeCheck(params.table_token);
  res.status(200).json({ success: true, data });
});
