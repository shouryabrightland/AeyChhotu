"use client";

import { Delete, QrCode } from "lucide-react";
import { useState } from "react";
import { Container } from "@/components/ui/container";
import { PIN_LENGTH } from "@/lib/diner/table-pass";
import { cn } from "@/lib/utils";

/* The table PIN, typed on OUR keypad — never a <input>.
 *
 * Three reasons this is a hand-built grid rather than a text field:
 *   1. Tapping an input raises the device keyboard, which covers half the
 *      screen and brings autocorrect, prediction and paste with it. A PIN
 *      read off a tablemate's phone is typed, not composed.
 *   2. A 64px key is a thumb target; a keyboard key is not, at an angle,
 *      in a dim restaurant.
 *   3. Leading zeros ('07') are real PINs, and numeric keyboards on some
 *      Android skins strip them.
 *
 * The pad auto-submits on the second digit: there is nothing else to
 * confirm, and a Submit button would just be an extra tap for every guest. */

const KEYS = ["1", "2", "3", "4", "5", "6", "7", "8", "9"];

export interface TablePinPadProps {
  tableName: string;
  /** Server-reported guesses left — never counted locally. */
  attemptsRemaining: number;
  error?: string | null;
  busy?: boolean;
  onSubmit: (pin: string) => void;
  onUseScan: () => void;
}

export function TablePinPad({
  tableName,
  attemptsRemaining,
  error,
  busy = false,
  onSubmit,
  onUseScan,
}: TablePinPadProps) {
  const [digits, setDigits] = useState("");

  function press(digit: string) {
    if (busy) return;

    // A full pair means the previous answer came back wrong: the next digit
    // starts a fresh entry instead of appending to a dead PIN.
    const base = digits.length >= PIN_LENGTH ? "" : digits;
    const next = base + digit;

    setDigits(next);
    if (next.length === PIN_LENGTH) onSubmit(next);
  }

  function backspace() {
    if (busy) return;
    setDigits((current) => current.slice(0, -1));
  }

  return (
    <main
      id="main"
      className="flex min-h-dvh flex-col justify-center bg-canvas px-4 pt-[max(1rem,env(safe-area-inset-top))] pb-[max(1rem,env(safe-area-inset-bottom))]"
    >
      <Container size="narrow" className="flex w-full max-w-sm flex-col items-center gap-7">
        <header className="flex flex-col items-center gap-2 text-center">
          <span className="text-label text-ink-subtle uppercase">Table {tableName}</span>
          <h1 className="font-display text-title text-ink">Enter table PIN</h1>
          <p className="max-w-xs text-sm text-ink-muted">
            The two-digit code is on the table card, or ask the person who opened this table.
          </p>
        </header>

        {/* Two boxes, never an input. aria-live announces progress so a
            screen-reader guest is not left guessing. */}
        <div
          role="group"
          aria-label={`Table PIN, ${digits.length} of ${PIN_LENGTH} digits entered`}
          className="flex items-center gap-4"
        >
          {Array.from({ length: PIN_LENGTH }).map((_, index) => {
            const digit = digits[index];
            return (
              <span
                key={index}
                aria-hidden
                className={cn(
                  "flex h-20 w-16 items-center justify-center rounded-xl border-2 font-display text-4xl font-semibold tabular-nums transition-colors duration-[var(--duration-fast)]",
                  digit
                    ? "border-ember bg-ember-soft text-ember"
                    : "border-line-strong bg-surface text-ink-subtle",
                  busy && "opacity-60",
                )}
              >
                {digit ?? "_"}
              </span>
            );
          })}
        </div>

        <p aria-live="polite" className="sr-only">
          {digits.length === 0
            ? "No digits entered."
            : `${digits.length} of ${PIN_LENGTH} digits entered.`}
        </p>

        {error ? (
          <p role="alert" className="-mt-2 max-w-xs text-center text-sm font-medium text-alert">
            {error}
          </p>
        ) : (
          <p className="-mt-2 text-xs text-ink-subtle">
            {attemptsRemaining === 1
              ? "One wrong PIN left before this table locks."
              : `${attemptsRemaining} tries left before this table locks.`}
          </p>
        )}

        <div
          role="group"
          aria-label="PIN keypad"
          className="grid w-full grid-cols-3 gap-2.5"
        >
          {KEYS.map((key) => (
            <Key key={key} onClick={() => press(key)} disabled={busy}>
              {key}
            </Key>
          ))}

          <Key onClick={backspace} disabled={busy || digits.length === 0} label="Delete last digit" tone="muted">
            <Delete className="size-6" aria-hidden />
          </Key>

          <Key onClick={() => press("0")} disabled={busy}>
            0
          </Key>

          <Key onClick={onUseScan} disabled={busy} label="Scan a tablemate's pass" tone="accent">
            <QrCode className="size-6" aria-hidden />
          </Key>
        </div>

        <button
          type="button"
          onClick={onUseScan}
          className="cursor-pointer text-sm font-semibold text-ember underline-offset-4 hover:underline"
        >
          Or scan a tablemate&apos;s QR pass
        </button>
      </Container>
    </main>
  );
}

function Key({
  children,
  onClick,
  disabled,
  label,
  tone = "default",
}: {
  children: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
  label?: string;
  tone?: "default" | "muted" | "accent";
}) {
  return (
    <button
      type="button"
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        // 64px tall: a thumb target, not a keyboard key.
        "flex h-16 min-h-[60px] cursor-pointer items-center justify-center rounded-lg border font-display text-2xl font-semibold",
        "transition-[transform,background-color,border-color] duration-[var(--duration-fast)] ease-gentle",
        // The press is the only confirmation the guest gets before the
        // server answers, so it has to be felt as well as seen.
        "active:scale-95 active:bg-sand",
        "disabled:pointer-events-none disabled:opacity-40",
        tone === "default" && "border-line-strong bg-surface text-ink hover:border-ember/60 hover:bg-ember-soft",
        tone === "muted" && "border-line bg-surface-sunken text-ink-muted",
        tone === "accent" && "border-ember/40 bg-ember-soft text-ember",
      )}
    >
      {children}
    </button>
  );
}
