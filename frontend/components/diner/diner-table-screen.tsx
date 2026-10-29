"use client";

import { CircleCheckBig } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { BillDrawer, type BillScope } from "@/components/diner/bill-drawer";
import { ChhotuAssistant } from "@/components/diner/chhotu-assistant";
import { CartModal } from "@/components/diner/cart-modal";
import { CartStrip } from "@/components/diner/cart-strip";
import { DinerNavBar } from "@/components/diner/diner-nav-bar";
import { InactiveTableState } from "@/components/diner/inactive-table-state";
import { MenuBrowser } from "@/components/diner/menu-browser";
import { SessionEndedState } from "@/components/diner/session-ended-state";
import { TableCart } from "@/components/diner/table-cart";
import { TablePassModal } from "@/components/diner/table-pass-modal";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Container } from "@/components/ui/container";
import { EmptyState } from "@/components/ui/empty-state";
import { Skeleton } from "@/components/ui/loading-state";
import { useToast } from "@/components/ui/toast";
import { usePresence } from "@/hooks/use-presence";
import { useLiveTable } from "@/hooks/use-live-table";
import { getStoredDisplayName, storeDisplayName, storeTableToken } from "@/lib/api/session";
import { clearStoredSession, getGrantedSession } from "@/lib/api/table-session";
import type { MenuItem } from "@/lib/api/types";

export interface DinerTableScreenProps {
  tableToken: string;
}

export function DinerTableScreen({ tableToken }: DinerTableScreenProps) {
  const router = useRouter();
  const { toast } = useToast();
  const live = useLiveTable(tableToken);
  const { table, menu, quantities, totals, itemErrors } = live;

  const [cartOpen, setCartOpen] = useState(false);
  // One bill entry point, two tabs inside: the whole table, or just this guest.
  // The nav icon opens the table's tab; the switch narrows it from there.
  const [billScope, setBillScope] = useState<BillScope | null>(null);
  const [pendingItemId, setPendingItemId] = useState<string | null>(null);
  // The Table Pass sheet: this device's PIN plus the QR that carries the
  // session secret to a tablemate's camera.
  const [passOpen, setPassOpen] = useState(false);
  // “Ask Chhotu” — the conversational waiter. It reads the live snapshot and
  // every write it makes goes through the same REST endpoints as the UI.
  const [assistantOpen, setAssistantOpen] = useState(false);
  /* Hydration-safe identity: the server has no localStorage, so the first
     paint is blank and the confirmed name is synced in the effect below,
     after mount — the only point where the two trees can never disagree.
     There is no "Guest" placeholder: the session gate refuses to open this
     screen without a name, so a blank here lasts one frame at most. */
  const [displayName, setDisplayName] = useState("");

  useEffect(() => {
    // Deferred a frame so this never races the first paint (and never
    // triggers React's "state update during render/hydration" warning).
    const timer = window.setTimeout(() => setDisplayName(getStoredDisplayName()), 0);
    return () => window.clearTimeout(timer);
  }, []);

  /* The bill is SERVER truth now (docs/14 #5): `bill_status` arrives from
     `GET /sessions/:token` and the table channel, not from a browser-local
     store, so two phones at the table always agree. */
  const billRequested = live.billStatus !== "unrequested";
  /* docs/14 #22 — a pre-pay or a staff settle must not hide food that is
     still being cooked. The thank-you appears once nothing is in the
     kitchen; until then the guest keeps the tracker and history. */
  const paidWhileCooking = live.billStatus === "paid" && live.hasCookingOrders;
  const settled = live.billStatus === "paid" && !live.hasCookingOrders;

  usePresence(tableToken);

  /* In-app notice for a cart change that came from ANOTHER device.

     useLiveTable raises `cartNotice` only for reloads this device did not ask
     for, so a guest is never told about their own tap — this effect just turns
     the first sighting of each id into one toast. The ref guard matters because
     `menuIndex` changes whenever the menu reloads, and a re-run must not
     announce the same change twice. */
  const cartNotice = live.cartNotice;
  const menuIndex = live.menuIndex;
  const handledNoticeRef = useRef(0);

  useEffect(() => {
    if (!cartNotice || cartNotice.id === handledNoticeRef.current) return;
    handledNoticeRef.current = cartNotice.id;

    const dishName = (menuItemId: string) => menuIndex.get(menuItemId)?.name ?? "a dish";
    const [firstAdded, ...moreAdded] = cartNotice.added;

    if (firstAdded) {
      toast({
        title: `${firstAdded.added_by} added ${dishName(firstAdded.menu_item_id)}`,
        description: moreAdded.length
          ? `${moreAdded.length + 1} dishes are now in the table's cart.`
          : "It's in the table's shared cart for everyone.",
      });
      return;
    }

    const bumped = cartNotice.increased[0];
    if (bumped) {
      toast({
        title: `${dishName(bumped.line.menu_item_id)} × ${bumped.line.quantity}`,
        description: `Someone at the table added ${bumped.delta} more.`,
      });
      return;
    }

    const takenOff = cartNotice.removed[0];
    if (takenOff) {
      toast({
        title: "The table's cart changed",
        description: `${dishName(takenOff.menu_item_id)} was taken off by someone at the table.`,
      });
    }
  }, [cartNotice, menuIndex, toast]);

  useEffect(() => {
    storeTableToken(tableToken);
  }, [tableToken]);

  function handleDisplayNameChange(name: string) {
    /* A blank edit keeps the current name: attribution is never optional. */
    if (!name.trim()) return;
    setDisplayName(name);
    storeDisplayName(name);
  }

  async function handleRequestBill() {
    if (billRequested) return;

    const result = await live.requestBill();
    // Asking for the bill closes the editor behind it: the table is done.
    setCartOpen(false);

    if (!result.ok) {
      toast({ title: result.message ?? "Could not request the bill.", tone: "error" });
      return;
    }

    toast({
      title: "Bill requested",
      description: "We've asked the server to bring your bill.",
    });
  }

  async function handleAdd(item: MenuItem) {
    setPendingItemId(item.id);

    /* The stored name, not a placeholder: hydration may still be a frame
       behind on the very first tap. */
    const result = await live.addToCart(item, displayName || getStoredDisplayName());

    setPendingItemId(null);

    if (!result.ok) {
      toast({
        title: result.message ?? `${item.name} could not be added.`,
        tone: "error",
      });
      return;
    }

    toast({ title: `${item.name} added`, description: "Everyone at the table can see it now." });
  }

  // ---- State matrix: loading ---------------------------------------------
  if (live.phase === "loading") return <DinerSkeleton />;

  // ---- State matrix: error (specific message + Retry Connection) ---------
  if (live.phase === "error") {
    if (live.error?.error === "TABLE_NOT_FOUND") return <InactiveTableState />;

    /* The server settled this table while the tab was open (or the session
       secret rotated). Say so cleanly and drop the dead credentials — a
       "lost connection" screen would suggest retrying something that can
       never succeed. */
    if (live.error?.error === "SESSION_ENDED") {
      clearStoredSession(tableToken);
      return <SessionEndedState />;
    }

    return (
      <main id="main" className="min-h-dvh">
        <Container size="narrow" className="py-16">
          <EmptyState
            tone="alert"
            titleAs="h1"
            title="We lost the connection to the kitchen"
            description={live.error?.message ?? "Please try again in a moment."}
            action={
              <Button variant="ember" size="md" onClick={live.retry}>
                Retry Connection
              </Button>
            }
          />
        </Container>
      </main>
    );
  }

  if (!table) return <InactiveTableState />;

  // Present whenever the gate granted a session; absent in the offline demo.
  const session = getGrantedSession(tableToken);

  return (
    <main id="main" className="min-h-dvh pb-32">
      {/* The diner's one band of chrome: identity and the three reach-for
          icons, pinned while the menu scrolls beneath it. */}
      <DinerNavBar
        tableToken={tableToken}
        live={live}
        displayName={displayName}
        onDisplayNameChange={handleDisplayNameChange}
        onOpenBill={() => setBillScope("total")}
        onOpenPass={session ? () => setPassOpen(true) : undefined}
        onRefresh={() => void live.refresh()}
      />

      {/* The heading block is gone on purpose: "Ready to order?" now lives on
          the menu's own search field, so the page's heading exists only for
          assistive tech and the guest lands straight on the menu. No table
          identifier either — the token in the URL is the capability
          credential. */}
      <h1 className="sr-only">Ready to order?</h1>

      <Container className="grid gap-12 py-12 lg:grid-cols-[minmax(0,1fr)_21rem] lg:items-start lg:gap-14">
        {menu.length === 0 ? (
          // ---- State matrix: empty catalog ------------------------------
          <EmptyState
            titleAs="h2"
            title="The menu is being stocked"
            description="No dishes are showing right now."
          />
        ) : (
          <MenuBrowser
            menu={menu}
            quantities={quantities}
            pendingItemId={pendingItemId}
            itemErrors={itemErrors}
            onAdd={(item) => void handleAdd(item)}
            stickyTopClass="top-[var(--diner-nav-h,3.75rem)]"
            onOpenAssistant={() => setAssistantOpen(true)}
          />
        )}

        {/* Desktop: the cart sits in view the whole time. On a phone it would
            be half the screen, so there it becomes the bar below instead. */}
        <aside className="hidden lg:sticky lg:top-28 lg:block" aria-label="Live table cart">
          <TableCart
            live={live}
            onReview={() => setCartOpen(true)}
            onRequestBill={() => void handleRequestBill()}
            billRequested={billRequested}
          />
        </aside>
      </Container>

      <CartStrip
        itemCount={totals.itemCount}
        total={totals.total}
        onView={() => setCartOpen(true)}
        billRequested={billRequested}
        onRequestBill={() => void handleRequestBill()}
        syncing={live.syncing}
      />

      <ChhotuAssistant
        tableToken={tableToken}
        live={live}
        displayName={displayName}
        className="bottom-24 lg:bottom-6"
      />

      <BillDrawer
        open={billScope !== null}
        onClose={() => setBillScope(null)}
        scope={billScope ?? "total"}
        onScopeChange={setBillScope}
        live={live}
        displayName={displayName}
      />

      <CartModal
        open={cartOpen}
        onClose={() => setCartOpen(false)}
        tableToken={tableToken}
        live={live}
        displayName={displayName}
        onDisplayNameChange={handleDisplayNameChange}
        onFired={() => {
          setCartOpen(false);
          toast({
            title: "Order fired",
            description: "The kitchen has one grouped ticket for this table.",
            tone: "success",
          });
          router.push(`/table/${tableToken}/tracker`);
        }}
      />

      {session ? (
        <TablePassModal
          open={passOpen}
          onClose={() => setPassOpen(false)}
          tableToken={tableToken}
          tableName={session.name || session.code}
          pin={session.session_pin}
          secret={session.session_secret}
          live={live}
          displayName={displayName}
        />
      ) : null}

      {/* Paid, but the kitchen still has a ticket. Keep the visit alive and
          say so plainly instead of replacing the screen (docs/14 #22). */}
      {paidWhileCooking ? (
        <div
          role="status"
          aria-live="polite"
          className="fixed inset-x-0 bottom-24 z-30 mx-auto w-fit max-w-[calc(100vw-2rem)] rounded-pill border border-ready/40 bg-ready-surface px-4 py-2 text-center text-sm font-medium text-ink shadow-sm lg:bottom-6"
        >
          Bill paid — your remaining dishes are still cooking.{" "}
          <Link
            href={`/table/${tableToken}/tracker`}
            className="font-semibold text-ready underline underline-offset-2"
          >
            Follow the tracker
          </Link>
        </div>
      ) : null}

      {/* Last in the DOM so it sits above the cart, the strip and the nav. */}
      {settled ? (
        <div
          role="status"
          aria-live="polite"
          className="fixed inset-0 z-50 flex flex-col items-center justify-center gap-5 bg-canvas/95 px-6 text-center backdrop-blur-md"
        >
          <span
            aria-hidden
            className="flex size-20 items-center justify-center rounded-pill bg-ember-soft text-ember"
          >
            <CircleCheckBig className="size-10" />
          </span>
          <h2 className="font-display text-title font-semibold text-ink">Thank you!</h2>
          <p className="max-w-md text-lead text-ink-muted">
            Your bill is settled. Thank you for dining with us.
          </p>
        </div>
      ) : null}
    </main>
  );
}

/* Loading state: same page shell and grid columns as the real screen so the
   layout shift stays stable while the first snapshot streams in. */
function DinerSkeleton() {
  return (
    <main id="main" className="min-h-dvh pb-32">
      <div className="border-b border-line bg-canvas/85 backdrop-blur-md">
        <Container className="flex items-center gap-3 py-3">
          <Skeleton className="size-10 shrink-0 rounded-md" />
          <Skeleton className="h-4 w-32" />
          <div className="ml-auto flex items-center gap-1.5">
            {Array.from({ length: 3 }).map((_, index) => (
              <Skeleton key={index} className="size-10 rounded-md" />
            ))}
          </div>
        </Container>
      </div>

      <Container className="grid gap-12 py-12 lg:grid-cols-[minmax(0,1fr)_21rem] lg:items-start lg:gap-14">
        <div className="flex flex-col gap-6">
          <Skeleton className="h-12 w-full rounded-md" />
          <div className="grid gap-5 sm:grid-cols-2">
            {Array.from({ length: 4 }).map((_, index) => (
              <div key={index} className="flex flex-col gap-4 rounded-xl border border-line p-3">
                <Skeleton className="aspect-[4/3] w-full rounded-lg" />
                <Skeleton className="h-5 w-36" />
                <Skeleton className="h-4 w-full" />
                <Skeleton className="h-9 w-24" />
              </div>
            ))}
          </div>
        </div>

        <div className="hidden rounded-lg border border-line bg-surface p-6 lg:block">
          <Skeleton className="h-5 w-40" />
          <Skeleton className="mt-3 h-4 w-56" />
          <Skeleton className="mt-6 h-13 w-full rounded-md" />
        </div>
      </Container>
    </main>
  );
}
