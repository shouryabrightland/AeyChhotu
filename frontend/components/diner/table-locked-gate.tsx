"use client";

import { Lock, QrCode } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Container } from "@/components/ui/container";

/* The flagged table.
 *
 * After three wrong PINs the keypad is not merely disabled — it is GONE.
 * Leaving a visible-but-refusing pad on screen invites more guessing and
 * hides the one thing that still works. The only route back in is a pass
 * from somebody already at the table, which is a stronger proof than the
 * code printed on the card. */

export interface TableLockedGateProps {
  tableName: string;
  /** A failed pass scan, or any other reason the last attempt did not take. */
  error?: string | null;
  onScan: () => void;
}

export function TableLockedGate({ tableName, error, onScan }: TableLockedGateProps) {
  return (
    <main
      id="main"
      className="flex min-h-dvh flex-col justify-center bg-canvas px-4 pt-[max(1rem,env(safe-area-inset-top))] pb-[max(1rem,env(safe-area-inset-bottom))]"
    >
      <Container size="narrow" className="flex w-full max-w-sm flex-col items-center gap-6 text-center">
        <span
          aria-hidden
          className="flex size-16 items-center justify-center rounded-pill bg-alert-surface text-alert"
        >
          <Lock className="size-7" />
        </span>

        <div className="flex flex-col gap-2">
          <span className="text-label text-ink-subtle uppercase">Table {tableName}</span>
          <h1 className="font-display text-title text-ink">Table locked</h1>
        </div>

        <p className="text-sm leading-relaxed text-ink-muted">
          Table PIN locked due to 3 failed attempts. Scan a tablemate&apos;s screen to unlock and
          join.
        </p>

        {error ? (
          <p role="alert" className="text-sm font-medium text-alert">
            {error}
          </p>
        ) : null}

        <Button
          variant="ember"
          size="xl"
          fullWidth
          onClick={onScan}
          leftIcon={<QrCode className="size-5" aria-hidden />}
        >
          Scan Tablemate&apos;s QR Pass
        </Button>

        <p className="text-xs text-ink-subtle">
          A pass from someone already seated unlocks the table immediately — no waiting for staff.
        </p>
      </Container>
    </main>
  );
}
