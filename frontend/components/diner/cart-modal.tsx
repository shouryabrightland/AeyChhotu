"use client";

import { Flame, TriangleAlert } from "lucide-react";
import { useState } from "react";
import { CartLineRow } from "@/components/diner/cart-line-row";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Input } from "@/components/ui/input";
import { Modal } from "@/components/ui/modal";
import { Text } from "@/components/ui/text";
import type { FireFailure, LiveTableValue } from "@/hooks/use-live-table";
import { formatPrice } from "@/lib/format";
import type { CartLine } from "@/lib/api/types";

export interface CartModalProps {
  open: boolean;
  onClose: () => void;
  tableToken: string;
  /** Shared live snapshot from useLiveTable — one source for every view. */
  live: LiveTableValue;
  displayName: string;
  onDisplayNameChange: (name: string) => void;
  onFired: () => void;
}

export function CartModal({
  open,
  onClose,
  tableToken,
  live,
  displayName,
  onDisplayNameChange,
  onFired,
}: CartModalProps) {
  const { table, cart, menuIndex, totals, updateLine, removeLine, fire, syncing } = live;
  const [firing, setFiring] = useState(false);
  const [failure, setFailure] = useState<FireFailure | null>(null);

  async function handleFire() {
    /* docs/14 #2 — firing reads the SERVER cart at that instant, so a dish
       added a few hundred milliseconds ago would be missing from the ticket
       and left behind in the cart. Wait for the in-flight add: the button is
       disabled and this guard covers Enter-key re-entry. */
    if (firing || syncing) return;
    setFiring(true);
    setFailure(null);

    // live.fire() resets the table room cart state and pulls a clean
    // refreshed snapshot from the server on success (spec §3).
    const result = await live.fire();

    setFiring(false);

    if (!result.ok) {
      setFailure(result.failure);
      return;
    }

    onFired();
  }

  function handleQuantity(line: CartLine, quantity: number) {
    /* No local busy lock: the ± paints at once (the hook applies the delta
       optimistically) and reconciles behind it (docs/14 #4). */
    if (quantity < 1) {
      void removeLine(line.id);
      return;
    }

    // The steppers send INTENT (+1 / -1), not an absolute copy of local
    // state. The server applies the delta atomically, so a second phone
    // tapping at the same moment can no longer overwrite this one.
    const delta = quantity - line.quantity;
    if (delta !== 0) void updateLine(line.id, { quantity_delta: delta });
  }

  const isDuplicate =
    failure?.code === "DUPLICATE_ORDER" || failure?.code === "duplicate_order";
  const isInventory =
    failure?.code === "INVENTORY_FAILURE" || failure?.code === "inventory_conflict";

  return (
    <Modal
      open={open}
      onClose={onClose}
      size="lg"
      title="Review table cart"
      description={
        table ? "This table's order fires as one grouped ticket for the kitchen." : undefined
      }
      footer={
        cart.length > 0 ? (
          <>
            <Button
              variant="ember"
              size="xl"
              loading={firing}
              disabled={firing || syncing}
              onClick={() => void handleFire()}
              leftIcon={<Flame className="size-5" aria-hidden />}
            >
              {firing ? "Firing order…" : syncing ? "Syncing the cart…" : "Fire order for the table"}
            </Button>
            <Button variant="ghost" size="lg" onClick={onClose} disabled={firing}>
              Keep editing
            </Button>
          </>
        ) : (
          <Button variant="ghost" size="lg" onClick={onClose}>
            Back to the menu
          </Button>
        )
      }
    >
      <div className="flex flex-col gap-5">
        <Input
          label="Ordering as"
          hint="Shown next to the lines you add so the table knows who ordered what."
          value={displayName}
          maxLength={24}
          onChange={(event) => onDisplayNameChange(event.target.value)}
        />

        {failure ? (
          <div
            role="alert"
            className="flex items-start gap-3 rounded-md border-2 border-alert/35 bg-alert-surface p-4"
          >
            <TriangleAlert className="mt-0.5 size-4 shrink-0 text-alert" aria-hidden />
            <div className="flex flex-col gap-1">
              <p className="text-sm font-medium text-alert">{failure.message}</p>
              {isInventory && failure.soldOut.length > 0 ? (
                <Text variant="small" className="text-alert">
                  Sold out: {failure.soldOut.join(", ")}. The menu is now updated.
                </Text>
              ) : null}
              {isDuplicate ? (
                <Text variant="small" className="text-alert">
                  Open the live tracker to follow the order already in the kitchen.
                </Text>
              ) : null}
              {/* Inline validation vectors piped from the API error envelope. */}
              {Object.entries(failure.fields).map(([field, message]) => (
                <p key={field} className="text-xs text-alert">
                  <span className="font-medium">{field}</span>: {message}
                </p>
              ))}
            </div>
          </div>
        ) : null}

        {cart.length === 0 ? (
          <EmptyState
            title="The table cart is empty"
            description="Add a dish from the menu and it appears here instantly for everyone at the table."
            action={
              <Button variant="outline" size="sm" onClick={onClose}>
                Browse the menu
              </Button>
            }
          />
        ) : (
          <ul className="flex flex-col gap-3">
            {cart.map((line) => (
              <CartLineRow
                key={line.id}
                line={line}
                item={menuIndex.get(line.menu_item_id)}
                onQuantityChange={(quantity) => handleQuantity(line, quantity)}
                onNotesChange={(notes) => void updateLine(line.id, notes)}
                onRemove={() => handleQuantity(line, 0)}
              />
            ))}
          </ul>
        )}

        <div className="flex items-center justify-between border-t border-line pt-5">
          <Text variant="small" tone="muted">
            {totals.itemCount} {totals.itemCount === 1 ? "item" : "items"} · shared cart
            {syncing ? " · syncing" : ""}
          </Text>
          <span className="font-display text-subheading text-ink">{formatPrice(totals.total)}</span>
        </div>
      </div>
    </Modal>
  );
}
