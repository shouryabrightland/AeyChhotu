"use client";

import { useId, type ReactNode } from "react";
import { Overlay, OverlayFooter, OverlayHeader } from "@/components/ui/overlay";
import { cn } from "@/lib/utils";

export type DrawerSize = "sm" | "md" | "lg";

const sizes: Record<DrawerSize, string> = {
  sm: "sm:max-w-sm",
  md: "sm:max-w-md",
  lg: "sm:max-w-xl",
};

export interface DrawerProps {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  size?: DrawerSize;
  footer?: ReactNode;
  className?: string;
  children?: ReactNode;
}

export function Drawer({
  open,
  onClose,
  title,
  description,
  size = "md",
  footer,
  className,
  children,
}: DrawerProps) {
  const titleId = useId();
  const descriptionId = useId();

  return (
    <Overlay
      open={open}
      onClose={onClose}
      position="right"
      labelledBy={titleId}
      describedBy={description ? descriptionId : undefined}
      className={cn("border-y-0 border-r-0 shadow-lg", sizes[size], className)}
    >
      <OverlayHeader
        title={title}
        description={description}
        titleId={titleId}
        descriptionId={descriptionId}
        onClose={onClose}
      />
      {children ? (
        /* Same rigid column as Modal: without min-h-0 the body refused to
           shrink and the footer fell off the bottom of the sheet on a phone. */
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-6 py-5">
          {children}
        </div>
      ) : null}
      {footer ? <OverlayFooter>{footer}</OverlayFooter> : null}
    </Overlay>
  );
}
