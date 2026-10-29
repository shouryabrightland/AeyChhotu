"use client";

import { ChevronDown } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { AllergyInput } from "@/components/diner/allergy-input";
import { QuantityStepper } from "@/components/diner/quantity-stepper";
import { Input } from "@/components/ui/input";
import { Text } from "@/components/ui/text";
import type { CartLine, MenuItem } from "@/lib/api/types";
import {
  createNoteCommitter,
  type NoteCommitter,
  type NotesPatch,
} from "@/lib/diner/note-commit";
import { formatPrice } from "@/lib/format";
import { cn } from "@/lib/utils";

export interface CartLineRowProps {
  line: CartLine;
  item: MenuItem | undefined;
  busy?: boolean;
  onQuantityChange: (quantity: number) => void;
  onNotesChange: (notes: NotesPatch) => void;
  onRemove: () => void;
}

export function CartLineRow({
  line,
  item,
  busy = false,
  onQuantityChange,
  onNotesChange,
  onRemove,
}: CartLineRowProps) {
  const [notesOpen, setNotesOpen] = useState(Boolean(line.request_note || line.allergy_note));

  /* The text the guest is typing. It starts from the server value and is the
     ONLY thing the inputs render, so a keystroke never waits on the network
     and a realtime echo can never move the caret mid-word. */
  const [draft, setDraft] = useState({
    request_note: line.request_note,
    allergy_note: line.allergy_note,
  });

  /** The parent's handler changes identity every render; the debounce and the
      unmount flush must always call the latest one. */
  const handlerRef = useRef(onNotesChange);
  useEffect(() => {
    handlerRef.current = onNotesChange;
  }, [onNotesChange]);

  /** One committer for the life of the row: a burst of keystrokes is ONE
      PATCH (see lib/diner/note-commit), never one request per character.

      It is built on FIRST USE, not during render: constructing it while
      rendering would read a ref, and assigning its emit target from an effect
      would mutate a value held in state. Neither is allowed here, and nothing
      needs the committer until the guest actually types. */
  const committerRef = useRef<NoteCommitter | null>(null);
  const getCommitter = useCallback(() => {
    if (committerRef.current === null) {
      committerRef.current = createNoteCommitter({
        commit: (patch) => handlerRef.current(patch),
      });
    }
    return committerRef.current;
  }, []);

  /** Note fields the guest is currently in — never adopt over a live cursor. */
  const focusedRef = useRef(0);

  /* Closing the sheet (or the row going away) commits whatever was typed —
     a note must never be lost because the guest tapped "Back to the menu"
     inside the debounce window. */
  useEffect(() => {
    return () => {
      committerRef.current?.flush();
    };
  }, []);

  /* Adopt server truth (a tablemate's edit, or the echo of our own write)
     only while this device has neither a pending write nor a focused field. */
  useEffect(() => {
    if (committerRef.current?.hasPending() || focusedRef.current > 0) return;
    setDraft((current) =>
      current.request_note === line.request_note && current.allergy_note === line.allergy_note
        ? current
        : { request_note: line.request_note, allergy_note: line.allergy_note },
    );
  }, [line.request_note, line.allergy_note]);

  const unavailable = item ? !item.is_available : false;

  return (
    <li className="rounded-md border border-line bg-surface-sunken/60 p-4">
      <div className="flex items-start justify-between gap-4">
        <div className="flex flex-col gap-1">
          <p className="font-display text-base text-ink">{item?.name ?? "Removed item"}</p>
          <Text variant="caption" tone="subtle">
            Added by {line.added_by} · {formatPrice(item?.price ?? 0)} each
          </Text>
          {unavailable ? (
            <Text variant="caption" tone="alert">
              Ran out while you were ordering — remove it to keep firing.
            </Text>
          ) : null}
        </div>

        <QuantityStepper
          quantity={line.quantity}
          label={item?.name ?? "item"}
          busy={busy}
          onChange={onQuantityChange}
        />
      </div>

      <div className="mt-3 flex items-center justify-between gap-4">
        <button
          type="button"
          onClick={() => setNotesOpen((open) => !open)}
          aria-expanded={notesOpen}
          className="flex cursor-pointer items-center gap-1.5 rounded-sm text-sm font-medium text-ink-muted transition-colors duration-[var(--duration-fast)] hover:text-ember"
        >
          <ChevronDown
            className={cn(
              "size-4 transition-transform duration-[var(--duration-fast)]",
              notesOpen && "rotate-180",
            )}
            aria-hidden
          />
          {draft.request_note || draft.allergy_note ? "Notes added" : "Add a note or allergy"}
        </button>

        <button
          type="button"
          onClick={() => {
            // Whatever was typed is committed before the line disappears.
            getCommitter().flush();
            onRemove();
          }}
          disabled={busy}
          className="cursor-pointer rounded-sm text-sm font-medium text-ink-subtle transition-colors duration-[var(--duration-fast)] hover:text-alert disabled:opacity-50"
        >
          Remove
        </button>
      </div>

      {notesOpen ? (
        <div className="mt-4 flex flex-col gap-4">
          <Input
            label="Kitchen note"
            placeholder="Extra sauce, no onions…"
            value={draft.request_note}
            maxLength={120}
            onFocus={() => {
              focusedRef.current += 1;
            }}
            onBlur={() => {
              focusedRef.current = Math.max(0, focusedRef.current - 1);
              // Commit on the way out instead of waiting for the timer.
              getCommitter().flush();
            }}
            onChange={(event) => {
              const value = event.target.value;
              setDraft((current) => ({ ...current, request_note: value }));
              getCommitter().queue({ request_note: value });
            }}
          />
          <AllergyInput
            id={`${line.id}-allergy`}
            value={draft.allergy_note}
            onFocus={() => {
              focusedRef.current += 1;
            }}
            onBlur={() => {
              focusedRef.current = Math.max(0, focusedRef.current - 1);
              getCommitter().flush();
            }}
            onChange={(value) => {
              setDraft((current) => ({ ...current, allergy_note: value }));
              getCommitter().queue({ allergy_note: value });
            }}
          />
        </div>
      ) : null}
    </li>
  );
}
