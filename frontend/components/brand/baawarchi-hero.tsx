"use client";

/* The home page's hero: Mr. Baawarchi — the line chef — checking the kitchen
   tablet. The artwork is the brand illustration that ships with the app
   (/ref.png), not a redrawn vector, so the hero matches the chef exactly as
   he appears in marketing and in the product.

   The only motion is a slow float and a breathing ember glow behind him: the
   illustration already carries the personality, so the page adds life without
   animating the character's anatomy. Both stop under prefers-reduced-motion. */

import { motion, useReducedMotion } from "motion/react";
import Image from "next/image";

export function BaawarchiHero() {
  const reduceMotion = useReducedMotion();

  return (
    <div className="relative isolate mx-auto w-full max-w-[27rem] select-none">
      {/* Warm halo: the chef stands in kitchen light, not on a pasted card. */}
      <div className="pointer-events-none absolute inset-x-10 top-12 bottom-14 rounded-pill bg-ember/12 blur-3xl" />
      <div className="pointer-events-none absolute -right-4 top-20 size-36 rounded-full bg-tan/25 blur-3xl" />

      {/* Grounding shadow, kept wider than the figure so it reads as a floor. */}
      <div className="pointer-events-none absolute inset-x-16 bottom-4 h-7 rounded-pill bg-ink/15 blur-xl" />

      <motion.div
        animate={reduceMotion ? {} : { y: [0, -10, 0] }}
        transition={{ duration: 7, repeat: Infinity, ease: "easeInOut" }}
        className="relative"
      >
        <Image
          src="/ref.png"
          alt="Mr. Baawarchi, the AeyChhotu line chef, checking an order on the kitchen tablet"
          width={1672}
          height={941}
          priority
          sizes="(min-width: 1024px) 42vw, 88vw"
          className="h-auto w-full drop-shadow-[0_22px_30px_rgba(28,21,18,0.18)]"
        />
      </motion.div>
    </div>
  );
}
