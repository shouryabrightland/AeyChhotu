"use client";

import { TriangleAlert } from "lucide-react";
import { FieldShell, controlStyles } from "@/components/ui/field";
import { cn } from "@/lib/utils";

export interface AllergyInputProps {
  id: string;
  value: string;
  onChange: (value: string) => void;
  /** Lets the editor commit a debounced write the moment the guest leaves. */
  onFocus?: () => void;
  onBlur?: () => void;
  className?: string;
}

/* The allergy note is deliberately rendered in its own high-contrast container
   so it never dilutes into general kitchen instructions: only this value is
   rendered bold red on the kitchen ticket. */
export function AllergyInput({
  id,
  value,
  onChange,
  onFocus,
  onBlur,
  className,
}: AllergyInputProps) {
  return (
    <div className={cn("rounded-md border-2 border-alert/35 bg-alert-surface p-4", className)}>
      <FieldShell
        id={id}
        label={
          <span className="flex items-center gap-2 text-alert">
            <TriangleAlert className="size-3.5" aria-hidden />
            Medical allergies only
          </span>
        }
      >
        <textarea
          id={id}
          rows={2}
          value={value}
          onFocus={onFocus}
          onBlur={onBlur}
          onChange={(event) => onChange(event.target.value)}
          placeholder="No peanuts, no dairy…"
          className={cn(controlStyles(), "resize-y border-alert/40 py-3")}
        />
      </FieldShell>
      <p className="mt-2 text-xs text-alert">Alerts kitchen line directly.</p>
    </div>
  );
}
