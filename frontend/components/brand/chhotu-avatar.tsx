import Image from "next/image";
import { cn } from "@/lib/utils";

/* Chhotu's face, as a chat bubble.

   The brand art lives in logo.png as an opaque square on its own dark ground.
   A profile picture must not be a sticker, so this crops the same portrait
   into a circle and sets it in a speech bubble — same character on the diner
   sheet, the manager console and the kitchen dock, so all three assistants
   read as one waiter rather than three products. */

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
      className={cn("relative inline-flex shrink-0", sizes[size], className)}
    >
      {/* The bubble body and its tail, drawn behind the portrait. */}
      <span className="absolute inset-0 rounded-pill bg-ember-soft ring-1 ring-ember/25" />
      <span className="absolute bottom-0 left-1.5 size-2 rotate-45 rounded-[2px] bg-ember-soft ring-1 ring-ember/25" />

      <span className="relative m-[2px] overflow-hidden rounded-pill">
        <Image
          src="/logo.png"
          alt=""
          width={1254}
          height={1254}
          sizes="48px"
          className="size-full object-cover object-[50%_36%]"
        />
      </span>
    </span>
  );
}
