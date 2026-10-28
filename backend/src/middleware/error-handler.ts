import type { NextFunction, Request, Response } from "express";
import { AppError } from "../errors/app-error.js";

/* Central error handler — the only place that renders the error envelope
   (docs/7-api-contract.md §1.1):
     { "success": false, "error": { "code", "message", ...details } }
   Must be registered last and keep its 4-arg signature. */
export function errorHandler(
  err: unknown,
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  if (res.headersSent) {
    next(err);
    return;
  }

  // Malformed JSON body (express.json / body-parser parse failure).
  const bodyError = err as { type?: string } | undefined;
  if (err instanceof SyntaxError || bodyError?.type === "entity.parse.failed") {
    res.status(400).json({
      success: false,
      error: { code: "VALIDATION_ERROR", message: "Request body is not valid JSON." },
    });
    return;
  }

  /* Raw image bodies (and any other route-level parser) exceed their limit:
     answer 413 instead of collapsing into a 500. */
  if (bodyError?.type === "entity.too.large") {
    res.status(413).json({
      success: false,
      error: { code: "PAYLOAD_TOO_LARGE", message: "That file is too large for this endpoint." },
    });
    return;
  }

  if (err instanceof AppError) {
    res.status(err.status).json({
      success: false,
      error: { code: err.code, message: err.message, ...(err.details ?? {}) },
    });
    return;
  }

  // Unexpected failure: log the real cause server-side, never leak it out.
  console.error(`[error] ${req.method} ${req.originalUrl} ->`, err);
  res.status(500).json({
    success: false,
    error: { code: "INTERNAL_ERROR", message: "Unexpected server error." },
  });
}
