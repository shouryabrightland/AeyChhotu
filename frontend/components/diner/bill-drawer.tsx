"use client";

import { Drawer } from "@/components/ui/drawer";
import { EmptyState } from "@/components/ui/empty-state";
import type { LiveTableValue } from "@/hooks/use-live-table";
import { formatIstTime, formatPrice } from "@/lib/format";
import { cn } from "@/lib/utils";

/** Which slice of the bill the drawer is showing. */
export type BillScope = "total" | "mine";

export interface BillDrawerProps {
  open: boolean;
  onClose: () => void;
  scope: BillScope;
  onScopeChange: (scope: BillScope) => void;
  /** The same live snapshot the menu and cart read. */
  live: LiveTableValue;
  displayName: string;
}

interface BillLine {
  key: string;
  name: string;
  quantity: number;
  addedBy: string;
  amount: number;
}

/** An empty `added_by` (possible on older rows) must not render as the
    sentence "Added by " with nothing after it. */
function ownerName(addedBy: string | null | undefined): string {
  const name = addedBy?.trim();
  return name ? name : "Guest";
}

/** First letter of a name; "G" when the name is blank. */
function initial(name: string): string {
  return (name.trim().slice(0, 1) || "G").toUpperCase();
}

/* The running bill, opened from the one bill icon in the nav band. It is one
   drawer with a scope switch: the whole table's tab, or just this guest's —
   the icon no longer picks a slice, the tab inside does. Fired rounds are
   grouped by ticket (so the guest sees which round a dish came from), and
   whatever is still staged sits under its own heading. */
export function BillDrawer({
  open,
  onClose,
  scope,
  onScopeChange,
  live,
  displayName,
}: BillDrawerProps) {
  const { orders, cart, menuIndex } = live;
  const mineOnly = scope === "mine";
  const matches = (addedBy: string) => !mineOnly || addedBy === displayName;

  /* A DENIED round was never cooked, so it is not a line on the bill. Keeping
     it here would charge the table for food the kitchen refused — the single
     most damaging place for the wrong answer. */
  const billable = orders.filter((order) => order.status !== "denied");

  const fired = billable
    .map((order) => ({
      order,
      lines: order.items
        .filter((item) => matches(item.added_by))
        .map<BillLine>((item) => ({
          key: item.id,
          name: item.name,
          quantity: item.quantity,
          // persisted at fire time (sql/011); "Guest" for older tickets
          addedBy: ownerName(item.added_by),
          amount: item.price * item.quantity,
        })),
    }))
    .filter((group) => group.lines.length > 0);

  const staged = cart
    .filter((line) => matches(line.added_by))
    .map<BillLine>((line) => {
      const item = menuIndex.get(line.menu_item_id);
      return {
        key: line.id,
        name: item?.name ?? "Removed item",
        quantity: line.quantity,
        addedBy: ownerName(line.added_by),
        amount: (item?.price ?? 0) * line.quantity,
      };
    });

  const firedTotal = fired.reduce(
    (sum, group) => sum + group.lines.reduce((lines, line) => lines + line.amount, 0),
    0,
  );
  const stagedTotal = staged.reduce((sum, line) => sum + line.amount, 0);
  const grandTotal = firedTotal + stagedTotal;
  const empty = fired.length === 0 && staged.length === 0;

  // Every guest's running total, fired plus staged, made from the unscoped
  // data so the split always accounts for the whole table.
  const personTotals = new Map<string, number>();
  for (const order of billable) {
    for (const item of order.items) {
      const owner = ownerName(item.added_by);
      personTotals.set(owner, (personTotals.get(owner) ?? 0) + item.price * item.quantity);
    }
  }
  for (const line of cart) {
    const owner = ownerName(line.added_by);
    const price = menuIndex.get(line.menu_item_id)?.price ?? 0;
    personTotals.set(owner, (personTotals.get(owner) ?? 0) + price * line.quantity);
  }
  const split = [...personTotals.entries()]
    .map(([name, total]) => ({ name, total }))
    .sort((a, b) => b.total - a.total);

  return (
    <Drawer
      open={open}
      onClose={onClose}
      title={mineOnly ? "Your part of the bill" : "Total bill"}
      description={
        mineOnly
          ? `Only the dishes ${displayName} added, across every round.`
          : "Everything this table has ordered, plus what is staged now."
      }
      size="md"
      footer={
        empty ? null : (
          <>
            <span className="self-center text-label text-ink-subtle uppercase sm:mr-auto">
              {mineOnly ? "Your total" : "Table total"}
            </span>
            <span className="font-display text-subheading text-ink tabular-nums">
              {formatPrice(grandTotal)}
            </span>
          </>
        )
      }
    >
      <div className="flex flex-col gap-6">
        {/* The scope switch lives inside the panel, so a guest who opened the
            table's tab can narrow it to their own without leaving. */}
        <div
          role="group"
          aria-label="Which bill to show"
          className="flex h-11 items-center gap-1 rounded-md border border-line-strong bg-surface p-1"
        >
          {(
            [
              { id: "total", label: "Whole table" },
              { id: "mine", label: "Your part" },
            ] as { id: BillScope; label: string }[]
          ).map((option) => (
            <button
              key={option.id}
              type="button"
              onClick={() => onScopeChange(option.id)}
              aria-pressed={scope === option.id}
              className={cn(
                "h-full flex-1 cursor-pointer rounded-sm px-3 text-sm font-semibold transition-colors duration-[var(--duration-fast)]",
                scope === option.id
                  ? "bg-ink text-ink-inverse"
                  : "text-ink-muted hover:text-ink",
              )}
            >
              {option.label}
            </button>
          ))}
        </div>

        {empty ? (
          <EmptyState
            title={mineOnly ? "You have not ordered anything yet" : "Nothing on the bill yet"}
            description={
              mineOnly
                ? "Dishes you add to the shared cart appear here, with their own total."
                : "Add a dish from the menu and every line lands here as the table orders."
            }
          />
        ) : (
          <>
            {fired.map(({ order, lines }) => (
              <section key={order.id} className="flex flex-col">
                <header className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 border-b border-dashed border-line-strong pb-2">
                  <span className="text-label text-ink-subtle uppercase">
                    Order · <span className="capitalize">{order.status}</span>
                  </span>
                  <span className="text-xs text-ink-subtle">{formatIstTime(order.created_at)}</span>
                </header>
                <LineList lines={lines} showOwner={!mineOnly} />
              </section>
            ))}

            {staged.length > 0 ? (
              <section className="flex flex-col">
                <header className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 border-b border-dashed border-line-strong pb-2">
                  <span className="text-label text-ember uppercase">Still in the cart</span>
                  <span className="text-xs text-ink-subtle">Not fired yet</span>
                </header>
                <LineList lines={staged} showOwner={!mineOnly} />
              </section>
            ) : null}

            {fired.length > 0 && staged.length > 0 ? (
              <p className="text-xs text-ink-subtle">
                {formatPrice(firedTotal)} ordered · {formatPrice(stagedTotal)} staged
              </p>
            ) : null}

            {/* The whole-table view closes with who owes what. It is
                deliberately hidden in the "your part" view, where every line
                is already the guest's own. */}
            {!mineOnly && split.length > 0 ? (
              <section className="flex flex-col border-t border-line pt-5">
                <header className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 border-b border-dashed border-line-strong pb-2">
                  <span className="text-label text-ink-subtle uppercase">Split by person</span>
                  <span className="text-xs text-ink-subtle">
                    {split.length} {split.length === 1 ? "guest" : "guests"}
                  </span>
                </header>
                <ul className="flex flex-col divide-y divide-line/70">
                  {split.map((person) => {
                    const isYou = person.name === displayName;
                    return (
                      <li
                        key={person.name}
                        className="flex items-center justify-between gap-3 py-3"
                      >
                        <span className="flex min-w-0 items-center gap-2.5">
                          <span
                            aria-hidden
                            className={cn(
                              "flex size-7 shrink-0 items-center justify-center rounded-pill text-xs font-semibold",
                              isYou ? "bg-ember-soft text-ember" : "bg-sand text-ink-muted",
                            )}
                          >
                            {initial(person.name)}
                          </span>
                          <span className="truncate text-sm font-medium text-ink">
                            {person.name}
                            {isYou ? (
                              <span className="ml-1.5 text-xs font-semibold text-ember uppercase">
                                you
                              </span>
                            ) : null}
                          </span>
                        </span>
                        <span className="shrink-0 text-sm font-semibold text-ink tabular-nums">
                          {formatPrice(person.total)}
                        </span>
                      </li>
                    );
                  })}
                </ul>
              </section>
            ) : null}
          </>
        )}
      </div>
    </Drawer>
  );
}

function LineList({ lines, showOwner }: { lines: BillLine[]; showOwner: boolean }) {
  return (
    <ul className="flex flex-col divide-y divide-line/70">
      {lines.map((line) => (
        <li key={line.key} className="flex items-start justify-between gap-3 py-3">
          <div className="min-w-0">
            <p className="flex flex-wrap items-baseline gap-x-2 text-base font-medium text-ink">
              <span className="font-display font-semibold tabular-nums">{line.quantity}×</span>
              <span className="min-w-0">{line.name}</span>
            </p>
            {showOwner ? (
              <p className="mt-1 text-xs text-ink-subtle">Added by {line.addedBy}</p>
            ) : null}
          </div>
          <span className="shrink-0 text-sm font-semibold text-ink tabular-nums">
            {formatPrice(line.amount)}
          </span>
        </li>
      ))}
    </ul>
  );
}
