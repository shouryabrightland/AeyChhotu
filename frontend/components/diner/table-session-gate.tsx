"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { InAppQrScanner } from "@/components/diner/in-app-qr-scanner";
import { SessionEndedState } from "@/components/diner/session-ended-state";
import { TableLockedGate } from "@/components/diner/table-locked-gate";
import { TablePinPad } from "@/components/diner/table-pin-pad";
import { Button } from "@/components/ui/button";
import { Container } from "@/components/ui/container";
import { ErrorState } from "@/components/ui/empty-state";
import { Spinner } from "@/components/ui/spinner";
import {
  ApiError,
  joinTableWithPass,
  joinTableWithPin,
  reconnectTableSession,
  startTableSession,
  type TableSessionGrant,
} from "@/lib/api-client";
import { getDeviceId, getStoredDisplayName } from "@/lib/api/session";
import {
  clearStoredSession,
  readStoredSession,
  rememberGrantedSession,
  storeSession,
} from "@/lib/api/table-session";
import {
  joinFailureFor,
  MAX_PIN_ATTEMPTS,
  parsePassPayload,
  PASS_QUERY_KEY,
} from "@/lib/diner/table-pass";

/* The one door into a table's menu and tracker.
 *
 * Both diner routes are wrapped in this, because the token in the URL is no
 * longer enough on its own: anyone who photographs the QR on the table has
 * the token. The gate answers, in order:
 *
 *   1. Does this device already hold the pass for THIS table?
 *      → POST /sessions/reconnect. No keypad, no flash. A 403 means the
 *        table was settled or the secret was replaced, so storage is
 *        dropped and the guest starts at step 2.
 *   2. Otherwise scan: POST /sessions/initialize. An EMPTY table is claimed
 *      by the first device and the gate opens. A LIVE table answers
 *      `locked`, and the guest must join.
 *   3. Join: the 2-digit PIN, or a tablemate's QR pass if the table is
 *      flagged or the guest cannot read the code.
 *
 * Nothing here renders a child until a session has been GRANTED, which is
 * what makes `useLiveTable` free of authentication logic. */

type Phase = "checking" | "pin" | "locked" | "ready" | "ended" | "error";

/** The `?pass=` / `?secret=` value from the URL, if exactly one is present.
    A native camera app can open the QR as a plain link, so the gate has to
    read the same credential the in-app scanner would have decoded. */
function readPassFromUrl(): string | null {
  if (typeof window === "undefined") return null;

  const params = new URLSearchParams(window.location.search);
  const candidates = [
    ...params.getAll(PASS_QUERY_KEY),
    ...params.getAll("secret"),
  ];
  // Two different values is ambiguous — refuse rather than pick one.
  if (candidates.length !== 1) return null;
  return candidates[0] ?? null;
}

/** Removes the secret from the address bar after it has been consumed, so it
    is not left in history or a screenshot of the URL. */
function stripPassFromUrl(): void {
  if (typeof window === "undefined") return;

  const url = new URL(window.location.href);
  url.searchParams.delete(PASS_QUERY_KEY);
  url.searchParams.delete("secret");
  window.history.replaceState(null, "", url.toString());
}

export interface TableSessionGateProps {
  tableToken: string;
  children: ReactNode;
}

export function TableSessionGate({ tableToken, children }: TableSessionGateProps) {
  const router = useRouter();
  /* When THIS page was opened. Captured once per mount and sent with every
     session request, so the backend can tell "a guest scanning now" from "a
     page that has been sitting in a cached tab since before the table was
     cleared" (STALE_SESSION). */
  const scanTimeRef = useRef<string | null>(null);
  const scanTime = useCallback(() => {
    if (scanTimeRef.current === null) scanTimeRef.current = new Date().toISOString();
    return scanTimeRef.current;
  }, []);

  /** The device identity + scan time every entry point carries. The identity
      is what puts this guest on the table's roster (table_members). */
  const sessionEntry = useCallback(
    () => ({
      scan_time: scanTime(),
      user_id: getDeviceId(),
      name: getStoredDisplayName(),
    }),
    [scanTime],
  );

  /* A cleared / stale table is not a screen to linger on: wipe the dead
     credentials and send the guest home, where scanning the real QR starts
     a clean session. */
  const exitToHome = useCallback(() => {
    clearStoredSession(tableToken);
    router.replace("/");
  }, [router, tableToken]);

  const [phase, setPhase] = useState<Phase>("checking");
  const [tableName, setTableName] = useState("");
  const [attempts, setAttempts] = useState(MAX_PIN_ATTEMPTS);
  const [notice, setNotice] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState("");
  const [scanOpen, setScanOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);

  const grant = useCallback((granted: TableSessionGrant) => {
    rememberGrantedSession({
      table_id: granted.table_id,
      code: granted.code,
      name: granted.name,
      session_pin: granted.session_pin,
      session_secret: granted.session_secret,
    });
    // Persist exactly the pair the QR pass carries — see lib/api/table-session.
    storeSession({
      table_id: granted.table_id,
      code: granted.code,
      name: granted.name,
      session_pin: granted.session_pin,
      session_secret: granted.session_secret,
    });

    setTableName(granted.name || granted.code);
    setNotice(null);
    setPhase("ready");
  }, []);

  // ---- Step 1 ⇢ 4: reconnect, URL pass, scan, join ----------------------
  useEffect(() => {
    let cancelled = false;

    // No state reset here: the effect only SUBSCRIBES to the (async) answer.
    // A retry goes through the button below, which sets the phase first.
    (async () => {
      /* 1. This device already belongs to the table? A refresh must never
            show the keypad again. A rejection means the session is GONE —
            the table was settled or cleared — and per the stale-refresh rule
            the right move is home with clean storage, not claiming the next
            party's table by initializing it. */
      const stored = readStoredSession(tableToken);

      if (stored) {
        try {
          const granted = await reconnectTableSession(
            tableToken,
            stored.session_secret,
            scanTime(),
          );
          if (!cancelled) grant(granted);
          return;
        } catch (err) {
          if (cancelled) return;

          if (
            err instanceof ApiError &&
            (err.error === "SESSION_ENDED" || err.error === "STALE_SESSION")
          ) {
            exitToHome();
            return;
          }

          if (err instanceof ApiError && err.error === "TABLE_NOT_FOUND") {
            clearStoredSession(tableToken);
            setPhase("ended");
            return;
          }

          setErrorMessage(
            err instanceof ApiError
              ? err.message
              : "Something went wrong reopening this table.",
          );
          setPhase("error");
          return;
        }
      }

      /* 2. A native camera app can open the QR as a plain link. Consume the
            pass it carries before asking to initialize, or the guest would
            be shown a keypad for a table they already hold the key to. */
      const rawPass = readPassFromUrl();
      if (rawPass) {
        const parsed = parsePassPayload(rawPass);

        if (parsed && (!parsed.tableToken || parsed.tableToken === tableToken)) {
          try {
            const granted = await joinTableWithPass(
              tableToken,
              parsed.secret,
              sessionEntry(),
            );
            if (cancelled) return;
            stripPassFromUrl();
            grant(granted);
            return;
          } catch (err) {
            if (cancelled) return;

            if (
              err instanceof ApiError &&
              (err.error === "SESSION_ENDED" || err.error === "STALE_SESSION")
            ) {
              exitToHome();
              return;
            }

            // Any other failure (wrong table, dead secret) falls through to
            // the normal scan → PIN path below; nothing is trusted blindly.
            clearStoredSession(tableToken);
          }
        }
      }

      try {
        const scan = await startTableSession(tableToken, sessionEntry());
        if (cancelled) return;

        setTableName(scan.name || scan.code);

        if (scan.status === "active") {
          grant(scan);
          return;
        }

        setAttempts(Math.max(0, scan.attempts_remaining));
        setPhase(scan.pin_locked ? "locked" : "pin");
      } catch (err) {
        if (cancelled) return;

        if (err instanceof ApiError) {
          /* The table was cleared after this page opened: nothing here can
             succeed, so do not offer a Retry that would mint a session for
             the next party. */
          if (err.error === "STALE_SESSION" || err.error === "SESSION_ENDED") {
            exitToHome();
            return;
          }

          if (err.error === "TABLE_NOT_FOUND") {
            setPhase("ended");
            return;
          }
          setErrorMessage(err.message);
          setPhase("error");
          return;
        }

        setErrorMessage("Something went wrong opening this table.");
        setPhase("error");
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [tableToken, reloadKey, grant, exitToHome, scanTime, sessionEntry]);

  /** Turns a join failure into the next gate state (server owns the count). */
  function applyJoinFailure(err: unknown) {
    if (!(err instanceof ApiError)) {
      setNotice("We could not reach the table. Check your connection and try again.");
      return;
    }

    const failure = joinFailureFor({
      status: err.status,
      code: err.error,
      message: err.message,
      details: err.details,
    });

    setNotice(failure.message);

    if (failure.phase === "locked") {
      setAttempts(0);
      setPhase("locked");
      return;
    }
    if (failure.phase === "ended") {
      // A settled/cleared table (or a rotated secret) is not a dead end to
      // retry from — go home with clean storage.
      exitToHome();
      return;
    }
    if (failure.phase === "pin") {
      setAttempts(failure.attemptsRemaining);
      setPhase("pin");
    }
    // failure.phase === "error": stay put; the notice explains why.
  }

  async function handlePin(pin: string) {
    if (busy) return;
    setBusy(true);
    setNotice(null);

    try {
      grant(await joinTableWithPin(tableToken, pin, sessionEntry()));
    } catch (err) {
      applyJoinFailure(err);
    } finally {
      setBusy(false);
    }
  }

  async function handleScanned(raw: string) {
    setScanOpen(false);

    const parsed = parsePassPayload(raw);
    if (!parsed) {
      setNotice("That code is not a table pass. Ask a tablemate to show their pass again.");
      return;
    }
    if (parsed.tableToken && parsed.tableToken !== tableToken) {
      setNotice("That pass belongs to a different table.");
      return;
    }

    setBusy(true);
    setNotice(null);

    try {
      grant(await joinTableWithPass(tableToken, parsed.secret, sessionEntry()));
    } catch (err) {
      applyJoinFailure(err);
    } finally {
      setBusy(false);
    }
  }

  function openScanner() {
    setNotice(null);
    setScanOpen(true);
  }

  // ---- Render ----------------------------------------------------------

  if (phase === "checking") {
    return (
      <main id="main" className="flex min-h-dvh items-center justify-center bg-canvas">
        <Spinner size="lg" label="Opening table session" />
      </main>
    );
  }

  if (phase === "ended") return <SessionEndedState />;

  if (phase === "error") {
    return (
      <main id="main" className="min-h-dvh">
        <Container size="narrow" className="py-16">
          <ErrorState
            titleAs="h1"
            title="This table could not be opened"
            description={errorMessage}
            action={
              <Button
                size="md"
                variant="ember"
                onClick={() => {
                  setPhase("checking");
                  setNotice(null);
                  setReloadKey((key) => key + 1);
                }}
              >
                Try again
              </Button>
            }
          />
        </Container>
      </main>
    );
  }

  if (phase === "locked") {
    return (
      <>
        <TableLockedGate tableName={tableName} error={notice} onScan={openScanner} />
        <InAppQrScanner
          open={scanOpen}
          onClose={() => setScanOpen(false)}
          onDecode={(raw) => void handleScanned(raw)}
        />
      </>
    );
  }

  if (phase === "pin") {
    return (
      <>
        <TablePinPad
          tableName={tableName}
          attemptsRemaining={attempts}
          error={notice}
          busy={busy}
          onSubmit={(pin) => void handlePin(pin)}
          onUseScan={openScanner}
        />
        <InAppQrScanner
          open={scanOpen}
          onClose={() => setScanOpen(false)}
          onDecode={(raw) => void handleScanned(raw)}
        />
      </>
    );
  }

  return <>{children}</>;
}
