/* Table pass logic — the parts of the two-layer session flow that are PURE.
 *
 * Everything here is deliberately free of React, fetch and window so it can
 * be unit-tested directly (test/sessions-security.test.mjs) and so the UI can
 * never disagree with itself about what "3 attempts" or "a valid pass" means.
 *
 * Vocabulary:
 *   PIN    two digits, '00'–'99', shared out loud at the table
 *   pass   the 20-character secret, carried by the QR code and by storage
 *   lock   a table-wide flag: three wrong PINs and the keypad is withdrawn
 */

export const PIN_LENGTH = 2;
export const MAX_PIN_ATTEMPTS = 3;
export const SESSION_SECRET_LENGTH = 20;

const PIN_RE = /^\d{2}$/;
const SECRET_RE = /^[A-Za-z0-9]{20}$/;
const TABLE_TOKEN_RE = /^[a-z0-9]{4,16}$/;

/** Exactly two digits — leading zeros are significant. */
export function isValidPin(value: string): boolean {
  return PIN_RE.test(value);
}

/** Exactly 20 letters/digits, which is what the DB check enforces too. */
export function isValidSessionSecret(value: string): boolean {
  return SECRET_RE.test(value);
}

/** Wrong PINs still tolerated before the table is flagged (never negative). */
export function attemptsRemaining(failedAttempts: number): number {
  const failed = Number.isFinite(failedAttempts) ? Math.max(0, Math.floor(failedAttempts)) : 0;
  return Math.max(0, MAX_PIN_ATTEMPTS - failed);
}

export function isPinLocked(failedAttempts: number): boolean {
  return Number.isFinite(failedAttempts) && failedAttempts >= MAX_PIN_ATTEMPTS;
}

/** Which screen a table's stored state calls for. */
export type GatePhase = "pin" | "locked" | "ended";

export function gatePhase(status: string, failedAttempts: number): GatePhase {
  if (status !== "active") return "ended";
  return isPinLocked(failedAttempts) ? "locked" : "pin";
}

/** What a failed join means for the gate. */
export interface JoinFailure {
  /** `pin` keeps the keypad, `locked` swaps it for the scan CTA, `missing`
      replaces everything with "that code is not a table". */
  phase: "pin" | "locked" | "ended" | "missing" | "error";
  message: string;
  attemptsRemaining: number;
}

/**
 * Maps a join attempt's contract error onto the gate's next state.
 *
 * `details` is the raw error envelope object, so the attempts figure comes
 * from the SERVER's counter — the UI never counts locally, or a reload would
 * hand an attacker a fresh set of guesses.
 */
export function joinFailureFor(input: {
  status: number;
  code: string;
  message?: string;
  details?: Record<string, unknown>;
}): JoinFailure {
  const message = input.message ?? "That did not work. Please try again.";
  const attempts =
    typeof input.details?.["attempts_remaining"] === "number"
      ? (input.details["attempts_remaining"] as number)
      : 0;

  switch (input.code) {
    case "TABLE_PIN_LOCKED":
      return { phase: "locked", message, attemptsRemaining: 0 };
    case "INVALID_SESSION_PIN":
      return { phase: "pin", message, attemptsRemaining: attempts };
    /* The pass is unlock-only: scanned while the keypad still works, the
       server refuses it and the guest belongs on the PIN screen. */
    case "PASS_REQUIRES_PIN":
      return { phase: "pin", message, attemptsRemaining: attempts };
    case "INVALID_SESSION_SECRET":
      return { phase: "error", message, attemptsRemaining: attempts };
    case "SESSION_ENDED":
      return { phase: "ended", message, attemptsRemaining: 0 };
    /* A code that is not a table is NOT a settled table. The initialize
       path already answers "that code is not a table" (docs/14 #26); a pass
       scan against a dead code must not say "this session ended" instead. */
    case "TABLE_NOT_FOUND":
      return { phase: "missing", message, attemptsRemaining: 0 };
    default:
      return { phase: "error", message, attemptsRemaining: attempts };
  }
}

/* ------------------------------------------------------------------ QR pass */

export const PASS_QUERY_KEY = "pass";

/**
 * The QR payload: a normal table link carrying the secret.
 *
 * A URL rather than a bare secret on purpose — any phone's camera app can
 * open it as a fallback, and the in-app scanner reads the same shape. The
 * secret is the credential; the path is only there so a human scanning with
 * their own camera lands on the right screen.
 */
export function encodePassPayload(input: {
  origin: string;
  tableToken: string;
  secret: string;
}): string {
  const origin = input.origin.replace(/\/+$/, "");
  return `${origin}/table/${encodeURIComponent(input.tableToken)}?${PASS_QUERY_KEY}=${encodeURIComponent(input.secret)}`;
}

export interface ParsedPass {
  /** Present when the payload was a table link; null for a bare secret. */
  tableToken: string | null;
  secret: string;
}

/**
 * Reads either shape a tablemate's screen can produce:
 *   - a bare 20-character secret
 *   - `…/table/<token>?pass=<secret>` (absolute or path-only)
 *
 * Anything else is rejected outright — a scanner that accepts a partial
 * read is a scanner that sends garbage to the API.
 */
export function parsePassPayload(raw: string): ParsedPass | null {
  const value = raw.trim();
  if (!value) return null;
  if (isValidSessionSecret(value)) return { tableToken: null, secret: value };

  let url: URL;
  try {
    url = new URL(value, "https://table.invalid");
  } catch {
    return null;
  }

  /* Exactly one secret parameter. Duplicates are refused rather than
     "first one wins": two different parsers reading the same URL disagreeing
     about the credential is how parameter-pollution bugs start. */
  const candidates = [
    ...url.searchParams.getAll(PASS_QUERY_KEY),
    ...url.searchParams.getAll("secret"),
  ];
  if (candidates.length !== 1) return null;

  const secret = candidates[0];
  if (!secret || !isValidSessionSecret(secret)) return null;

  const match = /\/table\/([^/]+)\/?$/.exec(url.pathname);
  const candidate = match?.[1];
  return {
    tableToken: candidate && TABLE_TOKEN_RE.test(candidate) ? candidate : null,
    secret,
  };
}
