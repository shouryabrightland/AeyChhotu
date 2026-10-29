"use client";

import { Activity, Pencil, QrCode, Receipt, RefreshCw, UserRound } from "lucide-react";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { Container } from "@/components/ui/container";
import { Tooltip } from "@/components/ui/tooltip";
import type { LiveTableValue } from "@/hooks/use-live-table";
import { getStoredDisplayName } from "@/lib/api/session";
import { formatPrice } from "@/lib/format";
import { cn } from "@/lib/utils";

export interface DinerNavBarProps {
  tableToken: string;
  live: LiveTableValue;
  displayName: string;
  onDisplayNameChange: (name: string) => void;
  /** Opens the bill panel: the table's total and each guest's share, in one. */
  onOpenBill: () => void;
  /** Opens this table's PIN + QR pass. Absent in the offline demo, where
      there is no real session to hand out. */
  onOpenPass?: () => void;
  /** Re-reads menu, cart and orders on demand — the manual backup for when a
      realtime socket goes quiet. */
  onRefresh: () => void;
}

/* The charcoal band is this surface's whole navigation. Who you are sits on
   the left — editable, because the table reads that name beside every line
   you add — and what a guest reaches for sits on the right: the live tracker
   and the one bill (its total and this guest's share are the same panel, so
   there is one icon, not two). Amounts stay in the tooltip so the band reads
   as quiet icons rather than a dashboard. Its colours are the marketing
   header's own, so the two navbars read as one product. */
export function DinerNavBar({
  tableToken,
  live,
  displayName,
  onDisplayNameChange,
  onOpenBill,
  onOpenPass,
  onRefresh,
}: DinerNavBarProps) {
  const { menuIndex, orders, cart, activeOrder } = live;
  const headerRef = useRef<HTMLElement>(null);

  /* The band always starts on "Guest" and only then adopts the stored name.
     A name read during render would be present on the client and absent in
     the server HTML, which is exactly the mismatch React reports. */
  const [hydratedName, setHydratedName] = useState("Guest");

  useEffect(() => {
    const timer = window.setTimeout(() => setHydratedName(getStoredDisplayName()), 0);
    return () => window.clearTimeout(timer);
  }, []);

  /* "Guest" is the server's value, so while the prop still holds it the
     locally hydrated name is the better answer; the moment the parent syncs
     (or the guest edits), the prop wins. */
  const name = displayName === "Guest" && hydratedName ? hydratedName : displayName;

  /* Matches the landing page's navbar exactly: transparent and lineless at
     the top of the scroll, then a blurred canvas wash once content passes
     underneath it.

     Read from BOTH scrollers: globals.css locks html/body to 100dvh with
     `overflow-x: hidden`, which makes <body> the element that actually
     scrolls. `window.scrollY` therefore stays 0 for the whole page, a
     window-only listener never fires, and the band keeps NO background while
     the menu scrolls visibly behind "Ordering as". Scroll events do not
     bubble, so document needs the capture flag. */
  const [scrolled, setScrolled] = useState(false);

  useEffect(() => {
    const read = () => setScrolled((window.scrollY || document.body.scrollTop || 0) > 16);

    read();
    document.addEventListener("scroll", read, { capture: true, passive: true });
    window.addEventListener("scroll", read, { passive: true });

    return () => {
      document.removeEventListener("scroll", read, true);
      window.removeEventListener("scroll", read);
    };
  }, []);

  /* Publish the band's height so the sticky menu search can dock beneath it
     instead of sliding under it while the guest scrolls. */
  useEffect(() => {
    const node = headerRef.current;
    if (!node) return;

    const apply = () =>
      document.documentElement.style.setProperty("--diner-nav-h", `${node.offsetHeight}px`);

    apply();
    const observer = new ResizeObserver(apply);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  // Everything the table has already fired, plus whatever is staged now.
  const firedTotal = orders.reduce(
    (sum, order) => sum + order.items.reduce((line, item) => line + item.price * item.quantity, 0),
    0,
  );
  const stagedTotal = cart.reduce(
    (sum, line) => sum + (menuIndex.get(line.menu_item_id)?.price ?? 0) * line.quantity,
    0,
  );
  const totalBill = firedTotal + stagedTotal;

  // Just this guest's share: the lines they added, fired or still staged.
  const firedMine = orders.reduce(
    (sum, order) =>
      sum +
      order.items
        .filter((item) => item.added_by === name)
        .reduce((line, item) => line + item.price * item.quantity, 0),
    0,
  );
  const stagedMine = cart
    .filter((line) => line.added_by === name)
    .reduce((sum, line) => sum + (menuIndex.get(line.menu_item_id)?.price ?? 0) * line.quantity, 0);
  const myBill = firedMine + stagedMine;

  return (
    <header
      ref={headerRef}
      className={cn(
        // sticky + safe-top: the band clears a notch without the guest having
        // to scroll the menu out from under it.
        "sticky top-0 z-40 w-full border-b pt-[env(safe-area-inset-top)] text-ink transition-colors duration-[var(--duration-base)] ease-gentle",
        scrolled ? "border-line bg-canvas/85 backdrop-blur-md" : "border-transparent",
      )}
    >
      {/* NOWRAP on purpose: at 320px the identity and four icon actions used
          to wrap onto a second line, which re-flowed the whole menu under a
          band that had just changed height. The name truncates instead. */}
      <Container className="flex flex-nowrap items-center gap-2 py-2.5">
        <div className="min-w-0 flex-1">
          <DinerIdentity displayName={name} onChange={onDisplayNameChange} />
        </div>

        <div className="flex shrink-0 items-center gap-0.5 sm:gap-1">
          <Tooltip label="Live tracker" side="bottom">
            <Link
              href={`/table/${tableToken}/tracker`}
              aria-label="Open live tracker"
              className={cn(actionClass, "relative")}
            >
              <Activity className="size-5" aria-hidden />
              {activeOrder ? (
                <span
                  aria-hidden
                  className="absolute top-2.5 right-2.5 size-2 animate-pulse-soft rounded-pill bg-ember ring-2 ring-canvas"
                />
              ) : null}
            </Link>
          </Tooltip>

          {/* The bill is the one action with a number on it, so it is a pill
              rather than a bare glyph. The amount is the table's total; a
              phone's band has no room for it next to the identity, so below
              `sm` the pill collapses back to its icon (the tooltip and the
              panel still carry both numbers). */}
          <Tooltip
            label={`Bill · ${formatPrice(totalBill)} table · your part ${formatPrice(myBill)}`}
            side="bottom"
            className="max-w-56"
          >
            <button
              type="button"
              onClick={onOpenBill}
              aria-label={`Open the bill: ${formatPrice(totalBill)} for the table, your part ${formatPrice(myBill)}`}
              className="inline-flex h-9 w-9 shrink-0 items-center justify-center gap-2 rounded-pill border border-ink/12 bg-sand/70 text-ink transition-colors duration-[var(--duration-fast)] ease-gentle hover:border-ink/20 hover:bg-sand focus-visible:border-ink/25 focus-visible:bg-sand focus-visible:outline-none sm:h-10 sm:w-auto sm:px-3.5"
            >
              <Receipt className="size-5 shrink-0" aria-hidden />
              <span className="hidden text-sm font-semibold tabular-nums sm:inline">
                {formatPrice(totalBill)}
              </span>
            </button>
          </Tooltip>

          {onOpenPass ? (
            <Tooltip label="Table pass" side="bottom">
              <button
                type="button"
                onClick={onOpenPass}
                aria-label="Show the table pass"
                className={actionClass}
              >
                <QrCode className="size-5" aria-hidden />
              </button>
            </Tooltip>
          ) : null}

          {/* Deliberately last of the five: it is the utility, not the job.
              Realtime normally keeps this table current on its own; this is
              the tap that proves the app right when it does not. */}
          <Tooltip label="Refresh menu and cart" side="bottom">
            <button
              type="button"
              onClick={onRefresh}
              aria-label="Refresh menu and cart"
              className={actionClass}
            >
              <RefreshCw className="size-5" aria-hidden />
            </button>
          </Tooltip>
        </div>
      </Container>
    </header>
  );
}

/* 36px on the narrowest phones, 40px from `sm` up: four 40px targets plus a
   name do not fit a 320px viewport, and shrinking the row is better than
   wrapping it. */
const actionClass =
  "inline-flex size-9 items-center justify-center rounded-md text-ink-muted transition-colors duration-[var(--duration-fast)] ease-gentle hover:bg-sand hover:text-ink focus-visible:bg-sand focus-visible:text-ink focus-visible:outline-none sm:size-10";

/* The guest's own name, editable in place. Committing it updates the shared
   display name, so the next dish they add carries it and every other phone at
   the table (and the kitchen ticket) sees who ordered what. */
function DinerIdentity({
  displayName,
  onChange,
}: {
  displayName: string;
  onChange: (name: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(displayName);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!editing) return;
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [editing]);

  // Seed the draft from the current name only when the editor opens, so
  // edits made elsewhere (the cart modal) are picked up and no state is
  // synchronised inside an effect.
  function startEditing() {
    setDraft(displayName);
    setEditing(true);
  }

  function commit() {
    const next = draft.trim();
    onChange(next || "Guest");
    setEditing(false);
  }

  return (
    <div className="flex min-w-0 items-center gap-2.5">
      <span
        aria-hidden
        className="hidden size-10 shrink-0 items-center justify-center rounded-md bg-sand text-ink-muted sm:flex"
      >
        <UserRound className="size-5" />
      </span>

      <div className="min-w-0">
        <p className="text-label text-ink-subtle uppercase">Ordering as</p>

        {editing ? (
          <input
            ref={inputRef}
            value={draft}
            maxLength={24}
            aria-label="Your name at this table"
            onChange={(event) => setDraft(event.target.value)}
            onBlur={commit}
            onKeyDown={(event) => {
              if (event.key === "Enter") commit();
              if (event.key === "Escape") {
                setDraft(displayName);
                setEditing(false);
              }
            }}
            className="w-32 border-b border-ember/70 bg-transparent font-display text-base font-semibold text-ink outline-none placeholder:text-ink-subtle sm:w-40"
          />
        ) : (
          <button
            type="button"
            onClick={startEditing}
            aria-label={`Edit your name (currently ${displayName})`}
            className="group flex min-w-0 max-w-40 cursor-pointer items-center gap-1.5 rounded-sm text-left"
          >
            <span className="truncate font-display text-base font-semibold text-ink">
              {displayName}
            </span>
            <Pencil
              className="size-3.5 shrink-0 text-ink-subtle transition-colors duration-[var(--duration-fast)] group-hover:text-ember"
              aria-hidden
            />
          </button>
        )}
      </div>
    </div>
  );
}
