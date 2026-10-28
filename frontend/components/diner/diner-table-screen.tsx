"use client";

import { CircleCheckBig } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { acknowledgeSettlement, requestBill } from "@/lib/api/bill";
import { BillDrawer, type BillScope } from "@/components/diner/bill-drawer";
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
import { useBills } from "@/hooks/use-bills";
import { useLiveTable } from "@/hooks/use-live-table";
import { ApiError, requestTableBill } from "@/lib/api-client";
import { getStoredDisplayName, storeDisplayName, storeTableToken } from "@/lib/api/session";
import { clearStoredSession, getGrantedSession } from "@/lib/api/table-session";
import type { MenuItem } from "@/lib/api/types";

export interface DinerTableScreenProps {
  tableToken: string;
}

/* How long the diner gets to read the thank-you before the table clears. */
const SETTLED_THANKS_MS = 3600;

export function DinerTableScreen({ tableToken }: DinerTableScreenProps) {
  const router = useRouter();
  const { toast } = useToast();
  const live = useLiveTable(tableToken);
  const { table, menu, quantities, totals, itemErrors } = live;

  const [cartOpen, setCartOpen] = useState(false);
  // The bill drawer is open whenever a scope is set, so the icon that opened
  // it also decides which slice shows first.
  const [billScope, setBillScope] = useState<BillScope | null>(null);
  const [pendingItemId, setPendingItemId] = useState<string | null>(null);
  // The Table Pass sheet: this device's PIN plus the QR that carries the
  // session secret to a tablemate's camera.
  const [passOpen, setPassOpen] = useState(false);
  /* Hydration-safe identity: the server has no localStorage, so it renders
     "Guest" and so does the first client paint. The stored name is synced in
     the effect below, after mount, which is the only point where the two
     trees can never disagree. */
  const [displayName, setDisplayName] = useState("Guest");

  useEffect(() => {
    // Deferred a frame so this never races the first paint (and never
    // triggers React's "state update during render/hydration" warning).
    const timer = window.setTimeout(() => setDisplayName(getStoredDisplayName()), 0);
    return () => window.clearTimeout(timer);
  }, []);

  const bills = useBills();
  const settledAt = bills[tableToken]?.settled_at ?? null;

  usePresence(tableToken);

  useEffect(() => {
    storeTableToken(tableToken);
  }, [tableToken]);

  /* The server settled the bill: hold the thank-you for a beat, then drop the
     event so nothing lingers for the next guests. The clear itself happens in
     useLiveTable and in the shared demo store. */
  useEffect(() => {
    if (!settledAt) return;
    const timer = window.setTimeout(() => acknowledgeSettlement(tableToken), SETTLED_THANKS_MS);
    return () => window.clearTimeout(timer);
  }, [settledAt, tableToken]);

  function handleDisplayNameChange(name: string) {
    setDisplayName(name);
    storeDisplayName(name);
  }

  async function handleRequestBill() {
    if (bills[tableToken]) return;

    try {
      // The server state is what the floor board reads; the local bill store
      // mirrors it so this device's own icons update instantly.
      await requestTableBill(tableToken);
      requestBill(tableToken);
      // Asking for the bill closes the editor behind it: the table is done.
      setCartOpen(false);
      toast({
        title: "Bill requested",
        description: "We've asked the server to bring your bill.",
      });
    } catch (err) {
      setCartOpen(false);
      toast({
        title: err instanceof ApiError ? err.message : "Could not request the bill.",
        tone: "error",
      });
    }
  }

  async function handleAdd(item: MenuItem) {
    setPendingItemId(item.id);

    const result = await live.addToCart(item, displayName);

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
        onOpenBill={(scope) => setBillScope(scope)}
        onOpenPass={session ? () => setPassOpen(true) : undefined}
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
            onReview={() => setCartOpen(true)}
            cartItemCount={totals.itemCount}
            stickyTopClass="top-[var(--diner-nav-h,3.75rem)]"
          />
        )}

        {/* Desktop: the cart sits in view the whole time. On a phone it would
            be half the screen, so there it becomes the bar below instead. */}
        <aside className="hidden lg:sticky lg:top-28 lg:block" aria-label="Live table cart">
          <TableCart
            live={live}
            onReview={() => setCartOpen(true)}
            onRequestBill={() => void handleRequestBill()}
            billRequested={Boolean(bills[tableToken])}
          />
        </aside>
      </Container>

      <CartStrip
        itemCount={totals.itemCount}
        total={totals.total}
        onView={() => setCartOpen(true)}
      />

      <BillDrawer
        open={billScope !== null}
        onClose={() => setBillScope(null)}
        scope={billScope ?? "total"}
        onScopeChange={(scope) => setBillScope(scope)}
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
        />
      ) : null}

      {/* Last in the DOM so it sits above the cart, the strip and the nav. */}
      {settledAt ? (
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
            Your bill is settled. This table has been cleared and is ready for its next guests.
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
