"use client";

import { CircleSlash, QrCode } from "lucide-react";
import Link from "next/link";
import { buttonStyles } from "@/components/ui/button";
import { Container } from "@/components/ui/container";

/* The clean end of a session.
 *
 * A settled table keeps its QR on the wall but its credentials are gone
 * (kds prune → sql/005 columns nulled), so a stale tab or a bookmarked link
 * gets 403 SESSION_ENDED. That is not an error to apologise for — it is the
 * system working — so this screen states the fact and offers the one useful
 * next step: rescan the table's code to open a fresh session. */

export function SessionEndedState() {
  return (
    <main
      id="main"
      className="flex min-h-dvh flex-col justify-center bg-canvas px-4 pt-[max(1rem,env(safe-area-inset-top))] pb-[max(1rem,env(safe-area-inset-bottom))]"
    >
      <Container size="narrow" className="flex w-full max-w-sm flex-col items-center gap-6 text-center">
        <span
          aria-hidden
          className="flex size-16 items-center justify-center rounded-pill bg-sand text-ink-muted"
        >
          <CircleSlash className="size-7" />
        </span>

        <div className="flex flex-col gap-2">
          <h1 className="font-display text-title text-ink">Table cleared</h1>
          <p className="text-sm leading-relaxed text-ink-muted">
            This session has ended — the bill was settled, so the table&apos;s cart and codes are
            gone. Scan the QR code on the table to start fresh.
          </p>
        </div>

        <span className="flex items-center gap-2 rounded-pill border border-line bg-surface px-4 py-2 text-label text-ink-subtle uppercase">
          <QrCode className="size-4" aria-hidden />
          Scan the code on your table
        </span>

        <Link href="/" className={buttonStyles({ variant: "outline", size: "md" })}>
          Back to home
        </Link>
      </Container>
    </main>
  );
}
