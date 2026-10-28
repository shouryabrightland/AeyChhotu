"use client";

import { Sun } from "lucide-react";
import QRCode from "qrcode";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Modal } from "@/components/ui/modal";
import { encodePassPayload } from "@/lib/diner/table-pass";

/* The Table Pass.
 *
 * Two credentials on one screen, because they answer different questions:
 *
 *   the PIN   what a guest types when they can read your screen from across
 *             the table — two digits, said out loud, nothing to scan
 *   the QR    what a guest scans when they are sitting next to you, or when
 *             the table is flagged and the keypad is withdrawn
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
}

export function TablePassModal({
  open,
  onClose,
  tableToken,
  tableName,
  pin,
  secret,
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

  return (
    <Modal
      open={open}
      onClose={onClose}
      size="sm"
      title={`Table ${tableName} pass`}
      description="Show this to anyone at your table — it is how they join."
      footer={
        <Button variant="soft" size="lg" onClick={onClose}>
          Done
        </Button>
      }
    >
      <div className="flex flex-col items-center gap-5">
        <div className="flex flex-col items-center gap-1">
          <span className="text-label text-ink-subtle uppercase">Table PIN</span>
          <span className="font-display text-[4rem] leading-none font-semibold tracking-[0.06em] text-ember tabular-nums">
            {pin}
          </span>
          <span className="text-xs text-ink-subtle">Type this on the table screen to join.</span>
        </div>

        <div className="w-full border-t border-dashed border-line-strong" />

        <div className="flex flex-col items-center gap-3">
          <span className="text-label text-ink-subtle uppercase">Or scan this pass</span>

          <div className="flex size-56 items-center justify-center rounded-xl border border-line bg-surface p-3">
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

        <p className="flex items-start gap-2 rounded-md bg-surface-sunken px-4 py-3 text-xs leading-relaxed text-ink-muted">
          <Sun className="mt-0.5 size-4 shrink-0 text-ember" aria-hidden />
          Turn your screen brightness up so a tablemate&apos;s camera can read the pass.
        </p>
      </div>
    </Modal>
  );
}
