"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { InAppQrScanner } from "@/components/diner/in-app-qr-scanner";
import { SessionEndedState } from "@/components/diner/session-ended-state";
import { TableLockedGate } from "@/components/diner/table-locked-gate";
import { TableNameGate } from "@/components/diner/table-name-gate";
import { TablePinPad } from "@/components/diner/table-pin-pad";
import { Button, buttonStyles } from "@/components/ui/button";
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
import { getDeviceId, getStoredDisplayName, storeDisplayName } from "@/lib/api/session";
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
 *   0. Who is this? A name, once, before ANY session call. Every endpoint
 *      below refuses an unnamed guest, because an unnamed diner becomes an
 *      anonymous "Guest" line on the ticket and in the split bill. The name
 *      is remembered on the device, and a device that already holds this
 *      table's pass reconnects with it silently — a refresh never re-asks.
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

type Phase = "checking" | "name" | "pin" | "locked" | "ready" | "ended" | "missing" | "error";

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

  /* The name confirmed on the gate screen. Empty until the guest has one, and
     every session call below refuses to run without it. */
  const [confirmedName, setConfirmedName] = useState("");
  /* What the name screen starts with: the last name this device used. */
  const [nameDraft, setNameDraft] = useState("");

  /** The device identity + scan time every entry point carries. The identity
      is what puts this guest on the table's roster (table_members), and the
      name is what the ticket and the split bill show. */
  const sessionEntry = useCallback(
    () => ({
      scan_time: scanTime(),
      user_id: getDeviceId(),
      name: confirmedName,
    }),
    [scanTime, confirmedName],
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

  // ---- Step 0 ⇢ 4: name, reconnect, URL pass, scan, join ----------------
  useEffect(() => {
    let cancelled = false;

    // No state reset here: the effect only SUBSCRIBES to the (async) answer.
    // A retry goes through the button below, which sets the phase first.
    (async () => {
      /* 0. Who is this? A device that already holds THIS table's pass and a
            saved name adopts it and continues to the reconnect path, so a
            refresh or a tracker load never asks again. Everything else — a
            first scan, a tablemate joining, a device whose name was cleared
            — stops at the name screen before any endpoint is called. The
            decision is deferred out of the effect body so the first paint
            stays "checking" and hydration can never disagree. */
      if (!confirmedName) {
        const stored = readStoredSession(tableToken);
        const saved = getStoredDisplayName();

        if (stored && saved) {
          if (!cancelled) setConfirmedName(saved);
          return;
        }

        if (!cancelled) {
          setNameDraft(saved);
          setPhase("name");
        }
        return;
      }

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
            sessionEntry(),
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
            /* docs/14 #26 — a code that is not a table is NOT a settled
               table: saying "the bill was settled" for a typo was worse than
               saying nothing. */
            clearStoredSession(tableToken);
            setPhase("missing");
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
            clearStoredSession(tableToken);
            setPhase("missing");
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
  }, [tableToken, reloadKey, confirmedName, grant, exitToHome, scanTime, sessionEntry]);

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

  /** The name is confirmed: save it on this device, then let the normal
      reconnect → claim → join sequence run with it attached. */
  function handleName(name: string) {
    storeDisplayName(name);
    setNameDraft(name);
    setConfirmedName(name);
    setPhase("checking");
  }

  // ---- Render ----------------------------------------------------------

  if (phase === "name") {
    return (
      <TableNameGate
        tableName={tableName || tableToken}
        initialName={nameDraft}
        onConfirm={handleName}
      />
    );
  }

  if (phase === "checking") {
    return (
      <main id="main" className="flex min-h-dvh items-center justify-center bg-canvas">
        <Spinner size="lg" label="Opening table session" />
      </main>
    );
  }

  if (phase === "ended") return <SessionEndedState />;

  /* A wrong code should say so, with a way back to the scanner. It must not
     render the settled-table screen (docs/14 #26). */
  if (phase === "missing") {
    return (
      <main id="main" className="min-h-dvh">
        <Container size="narrow" className="py-16">
          <ErrorState
            titleAs="h1"
            title="That code is not a table"
            description="Check the code on your table's QR stand, or scan the QR code again."
            action={
              <Link href="/" className={buttonStyles({ size: "md" })}>
                Enter the code again
              </Link>
            }
          />
        </Container>
      </main>
    );
  }

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
