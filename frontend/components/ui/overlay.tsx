"use client";

import { AnimatePresence, motion } from "motion/react";
import { X } from "lucide-react";
import {
  useEffect,
  useRef,
  type HTMLAttributes,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { IconButton } from "@/components/ui/icon-button";
import { useBodyScrollLock } from "@/hooks/use-body-scroll-lock";
import { easeGentle, transitionBase } from "@/lib/motion";
import { cn } from "@/lib/utils";

export type OverlayPosition = "center" | "right";

const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
].join(",");

const positions: Record<OverlayPosition, string> = {
  center: "items-end justify-center sm:items-center",
  right: "items-stretch justify-end",
};

export interface OverlayProps {
  open: boolean;
  onClose: () => void;
  position?: OverlayPosition;
  labelledBy?: string;
  describedBy?: string;
  closeOnBackdrop?: boolean;
  className?: string;
  children: ReactNode;
}

export function Overlay({
  open,
  onClose,
  position = "center",
  labelledBy,
  describedBy,
  closeOnBackdrop = true,
  className,
  children,
}: OverlayProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);

  /* The latest onClose, held in a ref so the focus effect below can stay keyed
     to `open` alone. Callers pass an inline arrow (`onClose={() => setOpen(false)}`),
     which gets a NEW identity on every render — with `onClose` in the deps,
     every keystroke in a field inside the dialog re-ran the effect, and its
     cleanup/`panelRef.focus()` pair pulled focus back out of that field after
     the first character. That is the "I can type one letter and then the box
     stops accepting input" bug. */
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useBodyScrollLock(open);

  useEffect(() => {
    if (!open) return;

    restoreFocusRef.current = document.activeElement as HTMLElement | null;
    panelRef.current?.focus();

    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") onCloseRef.current();
    };

    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      restoreFocusRef.current?.focus();
    };
  }, [open]);

  function handleTab(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key !== "Tab") return;

    const panel = panelRef.current;
    if (!panel) return;

    const focusable = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR));
    const first = focusable.at(0);
    const last = focusable.at(-1);

    if (!first || !last) {
      event.preventDefault();
      return;
    }

    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  return (
    <AnimatePresence>
      {open ? (
        <div key="overlay" className="fixed inset-0 z-50 flex overflow-hidden">
          <motion.button
            type="button"
            tabIndex={-1}
            aria-label="Close overlay"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2, ease: easeGentle }}
            onClick={closeOnBackdrop ? onClose : undefined}
            className="absolute inset-0 h-full w-full cursor-default bg-scrim"
          />

          <div
            className={cn(
              "pointer-events-none absolute inset-0 flex p-0 sm:p-6",
              positions[position],
            )}
          >
            <motion.div
              ref={panelRef}
              role="dialog"
              aria-modal="true"
              aria-labelledby={labelledBy}
              aria-describedby={describedBy}
              tabIndex={-1}
              onKeyDown={handleTab}
              initial={
                position === "center"
                  ? { opacity: 0, scale: 0.97, y: 16 }
                  : { opacity: 0, x: 40 }
              }
              animate={position === "center" ? { opacity: 1, scale: 1, y: 0 } : { opacity: 1, x: 0 }}
              exit={
                position === "center"
                  ? { opacity: 0, scale: 0.98, y: 12 }
                  : { opacity: 0, x: 40 }
              }
              transition={transitionBase}
              /* A centre sheet is capped against the DYNAMIC viewport, not
                 the panel's containing block: on a phone the sheet is a
                 bottom sheet, and its last row has to stay above Safari's
                 collapsing toolbar. 85vh is the desktop cap it replaces. */
              className={cn(
                "pointer-events-auto relative flex w-full flex-col overflow-hidden border border-line-strong bg-surface shadow-lg outline-none",
                position === "center"
                  ? "max-h-[calc(100dvh-2rem)] rounded-t-2xl sm:max-h-[85vh] sm:rounded-xl"
                  : "h-full max-h-full rounded-none",
                className,
              )}
            >
              {children}
            </motion.div>
          </div>
        </div>
      ) : null}
    </AnimatePresence>
  );
}

export interface OverlayHeaderProps {
  title: string;
  description?: string;
  titleId: string;
  descriptionId?: string;
  onClose: () => void;
  className?: string;
}

export function OverlayHeader({
  title,
  description,
  titleId,
  descriptionId,
  onClose,
  className,
}: OverlayHeaderProps) {
  return (
    <header
      className={cn(
        /* shrink-0: the header is a fixed band. Without it a long body pushed
           the title row up and out of the rounded corner. */
        "flex shrink-0 items-start justify-between gap-4 border-b border-line bg-surface-sunken/60 px-6 py-5",
        className,
      )}
    >
      <div className="flex flex-col gap-1">
        <h2 id={titleId} className="font-display text-subheading text-ink">
          {title}
        </h2>
        {description ? (
          <p id={descriptionId} className="text-sm text-ink-muted">
            {description}
          </p>
        ) : null}
      </div>
      <IconButton label="Close" size="sm" tone="ghost" onClick={onClose}>
        <X className="size-4" aria-hidden />
      </IconButton>
    </header>
  );
}

export function OverlayFooter({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        /* shrink-0: the footer must never be squeezed out by a tall body —
           that was the "buttons clipped below the fold" bug. The bottom pad
           resolves the home indicator and still keeps a 1rem minimum, so a
           device without insets does not lose the gutter. Only BUTTONS
           stretch on a phone; `[&>*]` used to widen every child, so a
           price/total span became a full-width block and its text drifted
           away from the action it described. */
        "flex shrink-0 flex-col gap-3 border-t border-line bg-surface px-6 pt-4 pb-[max(1rem,env(safe-area-inset-bottom))] [&>button]:w-full sm:flex-row sm:justify-end sm:[&>button]:w-auto",
        className,
      )}
      {...props}
    />
  );
}
