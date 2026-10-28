"use client";

import { ArrowRight, BellRing, QrCode, ShieldAlert, ShoppingBasket, Sparkles } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState, useSyncExternalStore, type FormEvent } from "react";
import { Logo } from "@/components/brand/logo";
import { BaawarchiHero } from "@/components/brand/baawarchi-hero";
import { InAppQrScanner } from "@/components/diner/in-app-qr-scanner";
import { InstallPrompt } from "@/components/pwa/install-prompt";
import { Button } from "@/components/ui/button";
import { FieldShell, controlStyles, useFieldControl } from "@/components/ui/field";
import { Modal } from "@/components/ui/modal";
import { useToast } from "@/components/ui/toast";
import { cn } from "@/lib/utils";

/* The diner's front door.
 *
 * This is NOT the product pitch any more (that lives at /about) and it is not
 * the hackathon showcase (that lives at /presentation). It is the screen a
 * guest sees before they scan: one promise, one action, and the two ways in
 * (camera or typed code). Everything here is client-side; the only network
 * call happens after a table token is resolved, on /table/<token>. */

const TABLE_TOKEN_RE = /^[a-z0-9]{4,16}$/;

/** The hooks the copy rotates through — the real sentences a Indian table
    shouts across a restaurant, which is the whole product insight. */
const SHOUTS = [
  "Ek cutting chai aur do butter naan!",
  "Chutney khatam ho gayi!",
  "Bill lana!",
  "Ek plate biryani, extra raita!",
];

const TYPE_MS = 55;
const DELETE_MS = 28;
const HOLD_MS = 1900;

/** Reads the OS motion preference without writing state in an effect: the
    browser is the store, so React subscribes and re-renders on change. */
function usePrefersReducedMotion(): boolean {
  return useSyncExternalStore(
    (onChange) => {
      const media = window.matchMedia("(prefers-reduced-motion: reduce)");
      media.addEventListener("change", onChange);
      return () => media.removeEventListener("change", onChange);
    },
    () => window.matchMedia("(prefers-reduced-motion: reduce)").matches,
    () => false,
  );
}

/** Types a phrase, holds it, deletes it, moves on — forever. Reduced motion
    skips the per-character animation and just rotates whole sentences. */
function useTypewriter(phrases: string[]) {
  const [index, setIndex] = useState(0);
  const [text, setText] = useState("");
  const [deleting, setDeleting] = useState(false);
  const reduced = usePrefersReducedMotion();

  useEffect(() => {
    const phrase = phrases[index] ?? "";

    if (reduced) {
      // No characters to animate: only the phrase index advances.
      const hold = window.setTimeout(
        () => setIndex((current) => (current + 1) % phrases.length),
        HOLD_MS + 1200,
      );
      return () => window.clearTimeout(hold);
    }

    let timer: number;

    if (!deleting && text === phrase) {
      timer = window.setTimeout(() => setDeleting(true), HOLD_MS);
    } else if (deleting && text === "") {
      // Advance on an empty string, never mid-character: the next phrase is
      // then typed from zero instead of visibly swapping.
      timer = window.setTimeout(() => {
        setDeleting(false);
        setIndex((current) => (current + 1) % phrases.length);
      }, 180);
    } else {
      const next = deleting ? phrase.slice(0, text.length - 1) : phrase.slice(0, text.length + 1);
      timer = window.setTimeout(() => setText(next), deleting ? DELETE_MS : TYPE_MS);
    }

    return () => window.clearTimeout(timer);
  }, [text, deleting, index, phrases, reduced]);

  return reduced ? (phrases[index] ?? "") : text;
}

/** A scanned table QR is normally a URL (`…/table/k7x2p`), but the same
    scanner may hand us a bare code; both are accepted, anything else is not. */
function parseTableToken(raw: string): string | null {
  const value = raw.trim();
  if (!value) return null;
  if (TABLE_TOKEN_RE.test(value)) return value;

  try {
    const url = new URL(value, "https://table.invalid");
    const match = /\/table\/([^/]+)\/?$/.exec(url.pathname);
    const token = match?.[1];
    return token && TABLE_TOKEN_RE.test(token) ? token : null;
  } catch {
    return null;
  }
}

export default function HomePage() {
  const router = useRouter();
  const { toast } = useToast();

  const [scannerOpen, setScannerOpen] = useState(false);
  const [codeOpen, setCodeOpen] = useState(false);
  const [code, setCode] = useState("");
  const [codeError, setCodeError] = useState<string | undefined>();
  const [entering, setEntering] = useState(false);

  const shouted = useTypewriter(SHOUTS);
  const { fieldId, describedBy, invalid } = useFieldControl({ error: codeError });

  function openTable(token: string) {
    setScannerOpen(false);
    setCodeOpen(false);
    setEntering(true);
    router.push(`/table/${token}`);
  }

  function handleScanned(raw: string) {
    const token = parseTableToken(raw);
    if (!token) {
      setScannerOpen(false);
      toast({
        title: "That is not a table code",
        description: "Point the camera at the QR stand on your table, then try again.",
        tone: "error",
      });
      return;
    }
    openTable(token);
  }

  function submitCode(event: FormEvent) {
    event.preventDefault();
    const token = code.trim().toLowerCase();

    if (!TABLE_TOKEN_RE.test(token)) {
      setCodeError("A table code is 5 letters or digits, like k7x2p.");
      return;
    }

    setCodeError(undefined);
    openTable(token);
  }

  return (
    <main id="main" className="relative isolate flex min-h-dvh flex-col bg-canvas">
      <InstallPrompt />

      {/* Ambient warmth. Two low-opacity fields, no hard shapes, so the page
          reads as one lit room instead of a poster. */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 -z-10 bg-[radial-gradient(ellipse_70%_55%_at_50%_-10%,var(--color-ember-soft),transparent_70%)]"
      />
      <div
        aria-hidden
        className="hairline-grid pointer-events-none absolute inset-0 -z-10 opacity-40 [mask-image:radial-gradient(ellipse_60%_45%_at_50%_0%,black,transparent)]"
      />

      {/* ---- Top bar: brand + the two other rooms --------------------- */}
      <header className="mx-auto flex w-full max-w-page items-center justify-between gap-4 px-4 pt-[max(1rem,env(safe-area-inset-top))] pb-2 sm:px-6">
        <Link href="/" aria-label="AeyChhotu — home" className="shrink-0">
          <Logo />
        </Link>

        <nav aria-label="More" className="flex items-center gap-1 text-sm">
          <Link
            href="/about"
            className="rounded-md px-3 py-2 font-medium text-ink-muted transition-colors duration-[var(--duration-fast)] hover:text-ink"
          >
            Our story
          </Link>
          <Link
            href="/presentation"
            className="hidden rounded-md px-3 py-2 font-medium text-ink-muted transition-colors duration-[var(--duration-fast)] hover:text-ink sm:inline-flex"
          >
            Showcase
          </Link>
        </nav>
      </header>

      {/* ---- Hero ------------------------------------------------------ */}
      <section className="mx-auto grid w-full max-w-page flex-1 items-center gap-10 px-4 py-8 sm:px-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,0.95fr)] lg:gap-14 lg:py-12">
        <div className="flex flex-col items-start">
          <span className="inline-flex items-center gap-2 rounded-pill border border-ember/25 bg-ember-soft px-3 py-1.5 text-label text-ember uppercase">
            <Sparkles className="size-3.5" aria-hidden />
            No app · no login · one shared cart
          </span>

          {/* The hook. The first line is the brand shout; the second is the
              rotating sentence a real table would actually say. */}
          <h1 className="mt-6 font-display text-display font-semibold tracking-[-0.03em] text-ink text-balance">
            Aey Chhotuuuu!
          </h1>

          <p
            aria-live="polite"
            className="mt-2 min-h-[2.2em] font-display text-[clamp(1.15rem,4.6vw,1.75rem)] leading-snug font-semibold text-ember"
          >
            {shouted}
            <span
              aria-hidden
              className="ml-0.5 inline-block h-[1.05em] w-[2px] translate-y-[0.15em] animate-pulse-soft bg-ember align-middle"
            />
          </p>

          <p className="mt-6 max-w-xl text-lead text-ink-muted">
            Ab Chhotu ko aawaz lagane ki zaroorat nahi. Table ka QR scan karo, pura table ek cart
            mein order karo!
          </p>

          {/* ---- Primary action ---- */}
          <div className="mt-8 flex w-full flex-col gap-3 sm:w-auto sm:flex-row sm:items-center">
            <button
              type="button"
              onClick={() => setScannerOpen(true)}
              className={cn(
                "group inline-flex h-14 w-full items-center justify-center gap-2.5 rounded-lg bg-ember px-7 text-base font-semibold text-on-ember",
                "shadow-[0_0_0_0_rgba(158,62,20,0.45)] transition-[background-color,box-shadow,transform] duration-[var(--duration-fast)]",
                "hover:bg-ember-strong hover:shadow-[0_0_34px_6px_rgba(158,62,20,0.28)] active:translate-y-px sm:w-auto",
                "animate-pulse-soft",
              )}
            >
              <QrCode className="size-5" aria-hidden />
              Scan Table QR Code
            </button>

            <Button
              type="button"
              variant="outline"
              size="lg"
              className="h-14 w-full sm:w-auto"
              onClick={() => setCodeOpen(true)}
              rightIcon={<ArrowRight className="size-4" aria-hidden />}
            >
              Enter Table Code Manually
            </Button>
          </div>

          {/* ---- Three promises, three glyphs --------------------------- */}
          <ul className="mt-9 grid w-full gap-3 sm:grid-cols-3">
            {[
              { icon: ShoppingBasket, label: "One shared cart", copy: "The whole table, not eight tickets." },
              { icon: ShieldAlert, label: "Allergy safe", copy: "Medical notes reach the kitchen in red." },
              { icon: BellRing, label: "Live tracker", copy: "Cooking, ready, served — as it happens." },
            ].map((item) => (
              <li key={item.label} className="rounded-lg border border-line bg-surface/80 p-3">
                <item.icon className="size-4 text-ember" aria-hidden />
                <p className="mt-2 text-sm font-semibold text-ink">{item.label}</p>
                <p className="mt-0.5 text-xs leading-snug text-ink-muted">{item.copy}</p>
              </li>
            ))}
          </ul>
        </div>

        <div className="order-first w-full lg:order-none">
          <BaawarchiHero />
        </div>
      </section>

      {/* ---- Footer navigation ---------------------------------------- */}
      <footer className="border-t border-line bg-surface/60">
        <div className="mx-auto flex w-full max-w-page flex-col gap-3 px-4 py-6 pb-[max(1.5rem,env(safe-area-inset-bottom))] sm:flex-row sm:items-center sm:justify-between sm:px-6">
          <p className="text-xs text-ink-subtle">
            Scan, order together, watch it cook. AeyChhotu! — one table, one order.
          </p>

          <nav aria-label="Footer" className="flex flex-wrap items-center gap-x-5 gap-y-2 text-sm">
            <Link
              href="/about"
              className="group inline-flex items-center gap-1.5 font-medium text-ink-muted transition-colors duration-[var(--duration-fast)] hover:text-ember"
            >
              Customer story
              <ArrowRight
                aria-hidden
                className="size-3.5 transition-transform duration-[var(--duration-fast)] group-hover:translate-x-0.5"
              />
            </Link>
            <Link
              href="/presentation"
              className="group inline-flex items-center gap-1.5 font-medium text-ink-muted transition-colors duration-[var(--duration-fast)] hover:text-ember"
            >
              Hackathon showcase
              <ArrowRight
                aria-hidden
                className="size-3.5 transition-transform duration-[var(--duration-fast)] group-hover:translate-x-0.5"
              />
            </Link>
          </nav>
        </div>
      </footer>

      {/* ---- The camera, full viewport -------------------------------- */}
      <InAppQrScanner
        open={scannerOpen}
        onClose={() => setScannerOpen(false)}
        onDecode={handleScanned}
      />

      {/* ---- Manual code ---------------------------------------------- */}
      <Modal
        open={codeOpen}
        onClose={() => setCodeOpen(false)}
        title="Enter your table code"
        description="It is printed under the QR stand on your table — five letters or digits."
        size="sm"
        footer={
          <>
            <Button variant="soft" size="lg" onClick={() => setCodeOpen(false)}>
              Cancel
            </Button>
            <Button
              variant="ember"
              size="lg"
              type="submit"
              form="table-code-form"
              loading={entering}
            >
              Open table
            </Button>
          </>
        }
      >
        <form id="table-code-form" onSubmit={submitCode} noValidate className="flex flex-col gap-5">
          <FieldShell id={fieldId} label="Table code" hint="Example: k7x2p" error={codeError}>
            <input
              id={fieldId}
              value={code}
              onChange={(event) => {
                setCodeError(undefined);
                setCode(event.target.value.replace(/\s/g, "").toLowerCase().slice(0, 16));
              }}
              aria-describedby={describedBy}
              aria-invalid={invalid || undefined}
              autoComplete="off"
              autoCapitalize="none"
              spellCheck={false}
              inputMode="text"
              placeholder="k7x2p"
              className={cn(
                controlStyles({ invalid }),
                "h-16 text-center font-display text-3xl font-semibold tracking-[0.28em] text-ink uppercase",
              )}
            />
          </FieldShell>

          <p className="text-xs leading-relaxed text-ink-subtle">
            The code is the table&apos;s identity. Ask a tablemate to show their Table Pass if you
            cannot read the stand.
          </p>
        </form>
      </Modal>
    </main>
  );
}
