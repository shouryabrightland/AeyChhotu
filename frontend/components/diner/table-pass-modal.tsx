"use client";

import { Sun, Users } from "lucide-react";
import QRCode from "qrcode";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Modal } from "@/components/ui/modal";
import type { LiveTableValue } from "@/hooks/use-live-table";
import { getTableMembers } from "@/lib/api-client";
import { encodePassPayload } from "@/lib/diner/table-pass";
import { formatPrice } from "@/lib/format";
import { cn } from "@/lib/utils";

/* The Table Pass.
 *
 * Two credentials on one screen, because they answer different questions:
 *
 *   the PIN   what a guest types when they can read your screen from across
 *             the table — two digits, said out loud, nothing to scan
 *   the QR    what a guest scans when they are sitting next to you, or when
 *             the table is flagged and the keypad is withdrawn
 *
 * Under them sits the table's own summary — who is here, how much has been
 * ordered, what is running — because this is the one screen a guest holds up
 * for everyone else, and the person who opens it is usually the one keeping
 * track of the table anyway.
 *
 * The QR carries the 20-character secret, so this screen IS the credential.
 * It is only ever reachable from inside a granted session, and the secret is
 * never rendered as text — a screenshot of a QR is useless at a glance,
 * whereas a readable secret is a screenshot away from being a permanent
 * backdoor. */

export interface TablePassModalProps {
  open: boolean;
  onClose: () => void;
  tableToken: string;
  tableName: string;
  pin: string;
  secret: string;
  /** The same live snapshot the menu and cart read. */
  live: LiveTableValue;
  /** This device's guest, always counted as being at the table. */
  displayName: string;
}

/** First letter of a name; "G" when the name is blank. */
function initial(name: string): string {
  return (name.trim().slice(0, 1) || "G").toUpperCase();
}

/** An empty `added_by` (possible on older rows) reads as "Guest", never "". */
function ownerName(addedBy: string | null | undefined): string {
  const name = addedBy?.trim();
  return name ? name : "Guest";
}

export function TablePassModal({
  open,
  onClose,
  tableToken,
  tableName,
  pin,
  secret,
  live,
  displayName,
}: TablePassModalProps) {
  /* One state object KEYED by the payload it belongs to. That is what lets
     the effect stay free of synchronous resets: a stale drawing from a
     previous secret simply does not match the current key, so it is ignored
     until the new one lands. */
  const payloadKey = `${tableToken}:${secret}`;
  const [qr, setQr] = useState<{ key: string; svg: string | null; failed: boolean } | null>(null);

  useEffect(() => {
    if (!open) return;

    let cancelled = false;

    // Rendered here rather than in an <img> so the pass works offline and
    // carries no network dependency: the SVG is generated from the secret
    // we already hold.
    void QRCode.toString(
      encodePassPayload({
        origin: typeof window === "undefined" ? "" : window.location.origin,
        tableToken,
        secret,
      }),
      {
        type: "svg",
        margin: 1,
        width: 260,
        errorCorrectionLevel: "M",
        color: { dark: "#1c1512", light: "#ffffff" },
      },
    )
      .then((markup) => {
        if (!cancelled) setQr({ key: payloadKey, svg: markup, failed: false });
      })
      .catch(() => {
        if (!cancelled) setQr({ key: payloadKey, svg: null, failed: true });
      });

    return () => {
      cancelled = true;
    };
  }, [open, tableToken, secret, payloadKey]);

  const drawing = qr?.key === payloadKey ? qr : null;

  /* The ROSTER is read from the server (docs/14 #16): table_members records
     every guest who joined, including one who has not ordered yet. It is
     refreshed while the pass is open, so a tablemate who joins now appears.
     If the read fails the derived names (from order/cart attribution) are
     still shown — the pass must not go blank because one request failed. */
  const [roster, setRoster] = useState<string[] | null>(null);

  useEffect(() => {
    if (!open) return;

    let cancelled = false;

    const load = () => {
      getTableMembers(tableToken)
        .then((rows) => {
          if (cancelled) return;
          setRoster(rows.map((row) => row.name.trim() || "Guest"));
        })
        .catch(() => {
          /* keep the derived fallback that is already on screen */
        });
    };

    load();
    const timer = window.setInterval(load, 15_000);

    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [open, tableToken]);

  /* A refused round is still shown as a round the table placed, but it never
     contributes food or money. */
  const { orders, cart, menuIndex } = live;
  const billable = orders.filter((order) => order.status !== "denied");

  const derivedNames = new Set<string>();
  let orderedDishes = 0;
  let runningTotal = 0;

  for (const order of billable) {
    for (const item of order.items) {
      derivedNames.add(ownerName(item.added_by));
      orderedDishes += item.quantity;
      runningTotal += item.price * item.quantity;
    }
  }

  let stagedDishes = 0;
  for (const line of cart) {
    derivedNames.add(ownerName(line.added_by));
    stagedDishes += line.quantity;
    runningTotal += (menuIndex.get(line.menu_item_id)?.price ?? 0) * line.quantity;
  }

  const knownNames = new Set<string>(roster && roster.length > 0 ? roster : derivedNames);
  knownNames.add(displayName);
  const members = [
    displayName,
    ...[...knownNames].filter((name) => name !== displayName).sort(),
  ];
  const rounds = billable.length;

  return (
    <Modal
      open={open}
      onClose={onClose}
      size="md"
      title={`Table ${tableName} pass`}
      description="Show this to anyone at your table — it is how they join."
      footer={
        <Button variant="soft" size="lg" onClick={onClose}>
          Done
        </Button>
      }
    >
      <div className="flex flex-col gap-5">
        {/* Two columns from `sm`: the credentials on the left, the table's own
            card on the right, so the whole pass fits on one screen without
            scrolling. A phone stacks them. */}
        <div className="flex flex-col items-center gap-5 sm:flex-row sm:items-start sm:gap-6">
          <div className="flex w-full flex-col items-center gap-3 sm:w-[13.5rem] sm:shrink-0">
            <div className="flex flex-col items-center gap-0.5">
              <span className="text-label text-ink-subtle uppercase">Table PIN</span>
              <span className="font-display text-[3.25rem] leading-none font-semibold tracking-[0.06em] text-ember tabular-nums">
                {pin}
              </span>
              <span className="text-center text-xs text-ink-subtle">
                Type this on the table screen to join.
              </span>
            </div>

            <div className="w-full border-t border-dashed border-line-strong" />

            <div className="flex flex-col items-center gap-2">
              <span className="text-label text-ink-subtle uppercase">Or scan this pass</span>

              <div className="flex size-44 items-center justify-center rounded-xl border border-line bg-surface p-3">
                {drawing?.svg ? (
                  // The markup is generated locally by `qrcode` from our own
                  // secret — there is no user-controlled HTML in it.
                  <div
                    aria-label="QR code containing this table's pass"
                    role="img"
                    className="[&>svg]:size-full"
                    dangerouslySetInnerHTML={{ __html: drawing.svg }}
                  />
                ) : drawing?.failed ? (
                  <p className="px-4 text-center text-xs text-alert">
                    The QR could not be drawn. Read the PIN out instead.
                  </p>
                ) : (
                  <span className="text-xs text-ink-subtle">Drawing the pass…</span>
                )}
              </div>
            </div>
          </div>

        {/* The table's own card: who is here, what has been ordered, what it
            comes to. Read live, so it is the truth at the moment the pass is
            held up — not a snapshot taken when the modal opened. */}
          <section className="flex w-full flex-col gap-3 sm:flex-1" aria-label="This table">
          <div className="flex items-baseline justify-between gap-3">
            <span className="flex items-center gap-1.5 text-label text-ink-subtle uppercase">
              <Users className="size-3.5" aria-hidden />
              At the table
            </span>
            <span className="text-sm font-semibold text-ink tabular-nums">
              {members.length} {members.length === 1 ? "guest" : "guests"}
            </span>
          </div>

          <ul className="flex flex-wrap gap-1.5">
            {members.map((name) => {
              const isYou = name === displayName;
              return (
                <li
                  key={name}
                  className={cn(
                    "inline-flex items-center gap-1.5 rounded-pill border px-2.5 py-1 text-xs font-medium",
                    isYou
                      ? "border-ember/25 bg-ember-soft text-ember"
                      : "border-line-strong bg-surface text-ink-muted",
                  )}
                >
                  <span
                    aria-hidden
                    className={cn(
                      "flex size-4 items-center justify-center rounded-pill text-[0.55rem] font-semibold",
                      isYou ? "bg-ember text-on-ember" : "bg-sand text-ink-muted",
                    )}
                  >
                    {initial(name)}
                  </span>
                  <span className="truncate">{name}</span>
                  {isYou ? <span className="text-[0.55rem] font-bold uppercase">you</span> : null}
                </li>
              );
            })}
          </ul>
          <p className="text-xs leading-relaxed text-ink-subtle">
            Everyone who has joined this table, whether they have ordered yet or not.
          </p>

          {/* Rows, not a three-across strip: the details column is narrow, and
              "Rs. 310.00" wrapping onto two lines reads as a broken number. */}
          <dl className="flex flex-col gap-1.5 rounded-lg border border-line bg-surface-sunken/60 px-3 py-2.5">
            <div className="flex items-baseline justify-between gap-3">
              <dt className="text-xs text-ink-muted">
                {rounds === 0 ? "Dishes chosen" : "Dishes ordered"}
              </dt>
              <dd className="text-sm font-semibold text-ink tabular-nums">
                {orderedDishes + stagedDishes}
              </dd>
            </div>
            {/* docs/14 #20 — "3 dishes / 0 rounds" read as a contradiction.
                An unfired cart simply has no rounds row. */}
            {rounds > 0 ? (
              <div className="flex items-baseline justify-between gap-3">
                <dt className="text-xs text-ink-muted">Rounds fired</dt>
                <dd className="text-sm font-semibold text-ink tabular-nums">{rounds}</dd>
              </div>
            ) : null}
            <div className="flex items-baseline justify-between gap-3">
              <dt className="text-xs text-ink-muted">Running total</dt>
              <dd className="font-display text-sm font-semibold text-ink tabular-nums">
                {formatPrice(runningTotal)}
              </dd>
            </div>
          </dl>
            {stagedDishes > 0 ? (
              <p className="text-xs text-ember">
                {rounds === 0
                  ? `${stagedDishes} ${stagedDishes === 1 ? "dish" : "dishes"} ordered, none sent to the kitchen yet.`
                  : `${stagedDishes} ${stagedDishes === 1 ? "dish is" : "dishes are"} still in the cart, not fired yet.`}
              </p>
            ) : null}
          </section>
        </div>

        <p className="flex items-start gap-2 rounded-md bg-surface-sunken px-4 py-3 text-xs leading-relaxed text-ink-muted">
          <Sun className="mt-0.5 size-4 shrink-0 text-ember" aria-hidden />
          Turn your screen brightness up so a tablemate&apos;s camera can read the pass.
        </p>
      </div>
    </Modal>
  );
}
