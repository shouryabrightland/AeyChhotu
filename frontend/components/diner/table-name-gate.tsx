"use client";

import { UserRound } from "lucide-react";
import { useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Container } from "@/components/ui/container";
import { Input } from "@/components/ui/input";

/* The one question asked before a table session starts.
 *
 * The table's QR used to open straight onto the menu with the guest labelled
 * "Guest" until they chose to edit the name. In practice nobody did, so every
 * cart line, ticket and split-bill tab read "Guest": the kitchen could not
 * call a dish at a crowded table and the bill merged several people into one
 * anonymous balance. One first name fixes all three, costs no account, and is
 * remembered on this device so it is asked once, not once per visit.
 *
 * Nothing is written here that could fail: the name is confirmed locally and
 * handed to the gate, which sends it with the session call. */

export interface TableNameGateProps {
  /** The table's name once known, otherwise its code. */
  tableName: string;
  /** Pre-filled from the last confirmed name; empty on a first visit. */
  initialName: string;
  busy?: boolean;
  onConfirm: (name: string) => void;
}

export function TableNameGate({
  tableName,
  initialName,
  busy = false,
  onConfirm,
}: TableNameGateProps) {
  const [name, setName] = useState(initialName);

  const trimmed = name.trim();
  const valid = trimmed.length > 0;

  function submit(event: FormEvent) {
    event.preventDefault();
    if (!valid || busy) return;
    onConfirm(trimmed);
  }

  return (
    <main
      id="main"
      className="flex min-h-dvh flex-col justify-center bg-canvas px-4 pt-[max(1rem,env(safe-area-inset-top))] pb-[max(1rem,env(safe-area-inset-bottom))]"
    >
      <Container size="narrow" className="flex w-full max-w-sm flex-col gap-7">
        <header className="flex flex-col gap-2">
          <span className="text-label text-ink-subtle uppercase">Table {tableName}</span>
          <h1 className="font-display text-title text-ink">What should we call you?</h1>
          <p className="max-w-xs text-sm text-ink-muted">
            Just your first name — no account, no password. The kitchen and your
            tablemates use it on the dishes you order, and it keeps your part of
            the bill separate.
          </p>
        </header>

        <form onSubmit={submit} className="flex flex-col gap-4">
          <Input
            label="Your name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="e.g. Amit"
            autoComplete="given-name"
            autoCapitalize="words"
            enterKeyHint="done"
            maxLength={40}
            required
            autoFocus
            leadingIcon={<UserRound className="size-4" aria-hidden />}
            hint="Saved on this phone for your next visit."
          />

          <Button type="submit" variant="ember" size="lg" fullWidth disabled={!valid || busy}>
            {busy ? "Opening your table…" : "Continue"}
          </Button>
        </form>
      </Container>
    </main>
  );
}
