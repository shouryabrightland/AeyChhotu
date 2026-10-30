import Image from "next/image";
import { cn } from "@/lib/utils";

/* Chhotu's face, as a chat bubble.

   The brand art lives in logo.png as an opaque square on its own dark ground.
   A profile picture must not be a sticker, so this crops the same portrait
   into a circle — same character on the diner sheet, the manager console and
   the kitchen dock, so all three assistants read as one waiter rather than
   three products.

   MINIMAL ON PURPOSE: one circle, one portrait, one hairline ring. Earlier
   versions layered a cream backing, an inset margin and a bubble tail, and at
   28px those extra shapes stopped reading as a bubble and started reading as
   a stray pale wedge / rotated element beside the face. */

const sizes = {
  sm: "size-7",
  md: "size-9",
  lg: "size-12",
} as const;

export interface ChhotuAvatarProps {
  size?: keyof typeof sizes;
  className?: string;
}

export function ChhotuAvatar({ size = "md", className }: ChhotuAvatarProps) {
  return (
    <span
      aria-hidden
      className={cn(
        "relative inline-flex shrink-0 overflow-hidden rounded-pill ring-1 ring-ember/35",
        sizes[size],
        className,
      )}
    >
      <Image
        src="/logo.png"
        alt=""
        width={1254}
        height={1254}
        sizes="48px"
        className="size-full object-cover object-[50%_38%]"
      />
    </span>
  );
}
