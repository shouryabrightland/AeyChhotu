"use client";

import { UtensilsCrossed } from "lucide-react";
import Image from "next/image";
import { useState } from "react";
import { resolveApiAssetUrl } from "@/lib/api-client";
import type { MenuItem } from "@/lib/api/types";
import {
  dishFallbackWash,
  dishPhotoAlt,
  resolveDishPhoto,
} from "@/lib/diner/food-photos";
import { cn } from "@/lib/utils";

export interface DishPhotoProps {
  item: MenuItem;
  /** next/image sizes hint — the card is rendered at several widths. */
  sizes: string;
  /** Marks the plate sold out: the photo desaturates rather than vanishing. */
  muted?: boolean;
  className?: string;
}

/* One photo treatment for every dish in the product: a fixed 4:3 plate, a
   single corner radius, a warm wash behind it while it loads.

   If the photo cannot be fetched — the demo runs offline on purpose — the
   card degrades to a designed palette tile instead of a broken frame, so the
   layout and the reading order never move. */
export function DishPhoto({ item, sizes, muted = false, className }: DishPhotoProps) {
  const [failed, setFailed] = useState(false);

  /* An uploaded photo wins over the curated map. The 480px small variant is
     the card image; the 50px tiny is inlined as the blur so a slow phone sees
     the dish immediately instead of an empty box. */
  const uploaded = resolveApiAssetUrl(item.image_small_url ?? item.image_url ?? null);
  const src = uploaded ?? resolveDishPhoto(item);
  const blur = item.blur_data_url ?? null;
  const showPhoto = Boolean(src) && !failed;

  // Spans, not divs: the same plate has to be legal inside a card that is
  // itself one big button (the discovery cards).
  return (
    <span
      className={cn(
        "relative block aspect-[4/3] w-full overflow-hidden rounded-lg bg-surface-sunken",
        className,
      )}
    >
      {showPhoto && src ? (
        <Image
          src={src}
          alt={dishPhotoAlt(item)}
          fill
          sizes={sizes}
          /* The API already serves three pre-sized derivatives, so the Next
             optimiser would only add a hop. */
          unoptimized={Boolean(uploaded)}
          {...(blur ? { placeholder: "blur" as const, blurDataURL: blur } : {})}
          onError={() => setFailed(true)}
          className={cn(
            "object-cover transition-[filter,transform] duration-[var(--duration-slow)] ease-organic",
            muted ? "scale-100 opacity-60 grayscale-[0.65]" : "group-hover:scale-[1.03]",
          )}
        />
      ) : (
        <span
          role="img"
          aria-label={dishPhotoAlt(item)}
          className={cn(
            "absolute inset-0 flex items-center justify-center bg-gradient-to-br",
            dishFallbackWash(item),
            muted && "opacity-60 grayscale-[0.65]",
          )}
        >
          <span className="flex size-12 items-center justify-center rounded-pill bg-canvas/70 text-ember">
            <UtensilsCrossed className="size-5" aria-hidden />
          </span>
        </span>
      )}

      {/* The plate sits under a hairline so a pale photo still reads as a
          framed object on the cream canvas. */}
      <span aria-hidden className="absolute inset-0 rounded-lg ring-1 ring-ink/8 ring-inset" />
    </span>
  );
}
