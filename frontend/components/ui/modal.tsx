"use client";

import { useId, type ReactNode } from "react";
import { Overlay, OverlayFooter, OverlayHeader } from "@/components/ui/overlay";
import { cn } from "@/lib/utils";

export type ModalSize = "sm" | "md" | "lg";

const sizes: Record<ModalSize, string> = {
  sm: "sm:max-w-md",
  md: "sm:max-w-lg",
  lg: "sm:max-w-2xl",
};

export interface ModalProps {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  size?: ModalSize;
  footer?: ReactNode;
  closeOnBackdrop?: boolean;
  className?: string;
  children?: ReactNode;
}

export function Modal({
  open,
  onClose,
  title,
  description,
  size = "md",
  footer,
  closeOnBackdrop = true,
  className,
  children,
}: ModalProps) {
  const titleId = useId();
  const descriptionId = useId();

  return (
    <Overlay
      open={open}
      onClose={onClose}
      labelledBy={titleId}
      describedBy={description ? descriptionId : undefined}
      closeOnBackdrop={closeOnBackdrop}
      className={cn("sm:max-h-[85vh]", sizes[size], className)}
    >
      <OverlayHeader
        title={title}
        description={description}
        titleId={titleId}
        descriptionId={descriptionId}
        onClose={onClose}
      />
      {children ? (
        /* The rigid column contract: header shrink-0, THIS flex-1 min-h-0
           scroll area, footer shrink-0. min-h-0 is what actually lets a flex
           child shrink instead of pushing the footer off the sheet, and
           overscroll-contain stops the scroll chaining into the page behind. */
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-6 py-5">{children}</div>
      ) : null}
      {footer ? <OverlayFooter>{footer}</OverlayFooter> : null}
    </Overlay>
  );
}
