"use client";

import { Delete, KeyRound, LogIn } from "lucide-react";
import { useState, type FormEvent } from "react";
import { Logo } from "@/components/brand/logo";
import { Button } from "@/components/ui/button";
import { Container } from "@/components/ui/container";
import { FieldShell, controlStyles, useFieldControl } from "@/components/ui/field";
import { Spinner } from "@/components/ui/spinner";
import { ApiError, loginKDS } from "@/lib/api-client";
import { cn } from "@/lib/utils";

const keys = ["1", "2", "3", "4", "5", "6", "7", "8", "9"];

/* Touch targets here are sized for a thumb on a wall-mounted tablet, not a
   mouse: every key is 4rem tall with a visible press state. */
const keyClass =
  "flex h-16 cursor-pointer items-center justify-center rounded-md border border-line-strong bg-paper font-display text-2xl font-semibold text-ink transition-colors duration-[var(--duration-fast)] hover:border-ember hover:bg-ember-soft active:translate-y-px disabled:pointer-events-none disabled:opacity-45";

export interface KitchenPinWallProps {
  onSuccess: () => void;
  /** Which back-of-house surface is asking, e.g. "kitchen" or "floor".
      Only changes the copy — one shared PIN guards every staff screen. */
  surface?: string;
}

export function KitchenPinWall({ onSuccess, surface = "kitchen" }: KitchenPinWallProps) {
  const [pin, setPin] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const { fieldId, describedBy, invalid } = useFieldControl({ error: error ?? undefined });

  async function submit(value: string) {
    if (busy) return;

    if (!value) {
      setError("Enter the kitchen PIN.");
      return;
    }

    setBusy(true);
    setError(null);

    // E2 issues the shift JWT and stores it for every authenticated KDS call
    // (and the 401 redirect guard). There is no offline substitute: an
    // unauthenticated board is not a safer board, it is a fictional one.
    // `surface` only feeds the rate limiter: kitchen and floor share this
    // endpoint, so each wall keeps its own failed-attempt budget (#18).
    try {
      await loginKDS(value, surface === "floor" ? "floor" : "kitchen");
      onSuccess();
      return;
    } catch (err) {
      if (err instanceof ApiError) {
        setError(err.message || "That PIN does not match.");
      } else {
        setError("Could not reach the kitchen service. Try again.");
      }
      setBusy(false);
      setPin("");
    }
  }

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    void submit(pin);
  }

  function append(key: string) {
    if (busy) return;
    setError(null);
    setPin((current) => (current.length >= 8 ? current : current + key));
  }

  return (
    <main id="main" className="flex min-h-dvh flex-col items-center justify-center gap-8 px-5 py-14">
      <Container size="narrow" className="flex flex-col items-center gap-8">
        <div className="flex flex-col items-center gap-3 text-center">
          <Logo />
          <p className="text-sm text-ink-muted">Staff-only screens for the {surface} line.</p>
        </div>

        <form
          onSubmit={handleSubmit}
          className="flex w-full max-w-sm flex-col gap-6 rounded-xl border border-line-strong bg-surface p-6 shadow-lg sm:p-8"
          noValidate
        >
          <div className="flex flex-col items-center gap-3 text-center">
            <span className="flex size-12 items-center justify-center rounded-md bg-ember text-on-ember">
              <KeyRound className="size-6" aria-hidden />
            </span>
            <h1 className="font-display text-subheading text-ink">Enter {surface} staff PIN</h1>
            <p className="text-sm text-ink-muted">The board stays hidden until the PIN matches.</p>
          </div>

          <FieldShell id={fieldId} error={error ?? undefined}>
            <input
              id={fieldId}
              type="password"
              inputMode="numeric"
              autoComplete="off"
              aria-describedby={describedBy}
              aria-label="Kitchen staff PIN"
              aria-invalid={invalid || undefined}
              value={pin}
              maxLength={8}
              onChange={(event) => {
                setError(null);
                setPin(event.target.value.replace(/\D/g, "").slice(0, 8));
              }}
              placeholder="••••"
              className={cn(
                controlStyles({ invalid }),
                "h-16 text-center font-display text-3xl tracking-[0.4em]",
              )}
            />
          </FieldShell>

          <div className="grid grid-cols-3 gap-3" role="group" aria-label="PIN keypad">
            {keys.map((key) => (
              <button key={key} type="button" disabled={busy} onClick={() => append(key)} className={keyClass}>
                {key}
              </button>
            ))}

            <button
              type="button"
              disabled={busy}
              aria-label="Delete last digit"
              onClick={() => setPin((current) => current.slice(0, -1))}
              className={cn(keyClass, "text-ink-muted")}
            >
              <Delete className="size-6" aria-hidden />
            </button>

            <button type="button" disabled={busy} onClick={() => append("0")} className={keyClass}>
              0
            </button>

            <button
              type="button"
              disabled={busy}
              aria-label="Unlock board"
              className="flex h-16 cursor-pointer items-center justify-center rounded-md bg-ember text-on-ember transition-colors duration-[var(--duration-fast)] hover:bg-ember-strong active:translate-y-px disabled:pointer-events-none disabled:opacity-45"
            >
              {busy ? <Spinner size="sm" label="Checking PIN" /> : <LogIn className="size-6" aria-hidden />}
            </button>
          </div>

          <Button type="submit" variant="ember" size="lg" fullWidth loading={busy}>
            Unlock board
          </Button>
        </form>
      </Container>
    </main>
  );
}
