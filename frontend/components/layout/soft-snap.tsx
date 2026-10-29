"use client";

import { useEffect } from "react";

/* Soft section snapping for long editorial pages.

   The document itself is the scroller (globals locks html/body to one
   viewport), so the snap container has to be the root element, not a wrapper
   inside <main>. `proximity` — never `mandatory` — is what keeps it soft: a
   section only settles into place when the reader already stopped near its
   top, so a tall hero or a half-read paragraph never gets yanked away. */
export function SoftSnap() {
  useEffect(() => {
    const root = document.documentElement;
    root.classList.add("soft-snap");

    return () => root.classList.remove("soft-snap");
  }, []);

  return null;
}
