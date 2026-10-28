"use client";

/* The home page's centrepiece: a phone hovering over a glowing wooden QR
   stand, with a laser sweeping the code and amber embers drifting up.

   Deliberately vector-only (SVG + motion) rather than a photograph or a 3D
   engine: it weighs a few kilobytes, stays crisp on every screen, and can be
   recoloured from the design tokens. Every loop is decorative, so the whole
   thing opts out under prefers-reduced-motion (useReducedMotion). */

import { motion, useReducedMotion } from "motion/react";

const PARTICLES = [
  { left: "14%", top: "64%", size: 5, delay: 0, duration: 5.6 },
  { left: "27%", top: "72%", size: 3, delay: 1.2, duration: 6.4 },
  { left: "42%", top: "60%", size: 4, delay: 2.1, duration: 7.2 },
  { left: "58%", top: "74%", size: 3, delay: 0.6, duration: 6.0 },
  { left: "71%", top: "63%", size: 6, delay: 2.8, duration: 5.2 },
  { left: "84%", top: "70%", size: 3, delay: 1.7, duration: 6.8 },
  { left: "36%", top: "80%", size: 4, delay: 3.4, duration: 7.6 },
  { left: "64%", top: "82%", size: 3, delay: 4.1, duration: 5.9 },
];

/* The stand's printed code: a hand-placed 7×7 finder-pattern-ish grid. It is
   decoration, not a scannable payload — the real QR is on the table itself. */
const QR_CELLS = [
  [0, 0], [1, 0], [2, 0], [0, 1], [2, 1], [0, 2], [1, 2], [2, 2],
  [4, 0], [5, 0], [6, 0], [4, 1], [6, 1], [4, 2], [5, 2], [6, 2],
  [0, 4], [1, 4], [2, 4], [0, 5], [2, 5], [0, 6], [1, 6], [2, 6],
  [4, 4], [5, 4], [4, 5], [6, 5], [5, 6], [6, 6],
  [3, 0], [3, 3], [3, 4], [4, 3], [1, 3], [5, 3], [2, 3], [6, 3],
];

export function HomeQrAnimation() {
  const reduceMotion = useReducedMotion();

  const float = reduceMotion
    ? {}
    : { y: [0, -12, 0], rotateZ: [-1.5, 0.5, -1.5] };

  return (
    <div
      aria-hidden
      className="relative isolate mx-auto w-full max-w-md select-none"
    >
      {/* Warm light gathering behind the stand. */}
      <div className="pointer-events-none absolute inset-x-4 top-6 bottom-16 rounded-pill bg-ember/12 blur-3xl" />
      <div className="pointer-events-none absolute -right-6 top-24 size-40 rounded-pill bg-tan/25 blur-3xl" />

      {/* Floor shadow: grounds the phone so it reads as hovering, not pasted. */}
      <div className="pointer-events-none absolute inset-x-16 bottom-10 h-6 rounded-pill bg-ink/20 blur-xl" />

      {/* ---- Floating embers ---- */}
      {PARTICLES.map((particle, index) => (
        <motion.span
          key={index}
          className="pointer-events-none absolute rounded-pill bg-ember"
          style={{
            left: particle.left,
            top: particle.top,
            width: particle.size,
            height: particle.size,
          }}
          animate={
            reduceMotion
              ? { opacity: 0.25 }
              : { y: [0, -34, -62], opacity: [0, 0.7, 0], scale: [0.7, 1, 0.6] }
          }
          transition={{
            duration: particle.duration,
            delay: particle.delay,
            repeat: Infinity,
            ease: "easeOut",
          }}
        />
      ))}

      {/* ---- The phone ---- */}
      <motion.div
        className="relative z-20 mx-auto w-[56%] max-w-[15rem]"
        animate={float}
        transition={{ duration: 6.2, repeat: Infinity, ease: "easeInOut" }}
      >
        <div className="relative overflow-hidden rounded-[2rem] border-[3px] border-ink bg-ink p-1.5 shadow-lg">
          {/* Notch / earpiece */}
          <div className="mx-auto mb-1 h-1.5 w-10 rounded-pill bg-ink-inverse/20" />

          <div className="relative overflow-hidden rounded-[1.55rem] bg-canvas">
            {/* Screen header */}
            <div className="flex items-center justify-between px-3 pt-3">
              <span className="flex size-5 items-center justify-center rounded-md bg-ember text-[0.5rem] font-bold text-on-ember">
                A
              </span>
              <span className="h-1 w-8 rounded-pill bg-line-strong" />
            </div>

            {/* The QR being read, inside a target frame */}
            <div className="relative mx-3 mt-3 aspect-square overflow-hidden rounded-xl border border-line bg-surface p-3">
              <QrGlyph glowing />

              {/* Target corners */}
              <Corner className="top-1.5 left-1.5 border-t-2 border-l-2" />
              <Corner className="top-1.5 right-1.5 border-t-2 border-r-2" />
              <Corner className="bottom-1.5 left-1.5 border-b-2 border-l-2" />
              <Corner className="bottom-1.5 right-1.5 border-b-2 border-r-2" />

              {/* Laser sweep */}
              {reduceMotion ? (
                <span className="absolute inset-x-2 top-1/2 h-0.5 bg-ember/70" />
              ) : (
                <motion.span
                  className="absolute inset-x-2 h-0.5 bg-ember shadow-[0_0_8px_2px] shadow-ember/50"
                  animate={{ top: ["10%", "88%", "10%"] }}
                  transition={{ duration: 2.8, repeat: Infinity, ease: "easeInOut" }}
                />
              )}
            </div>

            {/* Fake menu rows under the scanner */}
            <div className="flex flex-col gap-1.5 px-3 py-3">
              <div className="flex items-center justify-between gap-2">
                <span className="h-1.5 w-14 rounded-pill bg-line-strong" />
                <span className="h-1.5 w-6 rounded-pill bg-line" />
              </div>
              <div className="flex items-center justify-between gap-2">
                <span className="h-1.5 w-10 rounded-pill bg-line" />
                <span className="h-1.5 w-8 rounded-pill bg-line" />
              </div>
              <div className="mt-1 h-5 w-full rounded-md bg-ember" />
            </div>
          </div>
        </div>
      </motion.div>

      {/* ---- The wooden stand ---- */}
      <motion.div
        className="relative z-10 mx-auto -mt-4 w-[68%] max-w-[17rem]"
        animate={reduceMotion ? {} : { y: [0, -2, 0] }}
        transition={{ duration: 6.2, repeat: Infinity, ease: "easeInOut" }}
      >
        {/* Stand face, angled back like a table tent */}
        <div className="relative overflow-hidden rounded-lg border border-brown/40 bg-gradient-to-b from-brown to-dark-brown p-3 pb-4 shadow-lg">
          <div className="pointer-events-none absolute inset-0 bg-[repeating-linear-gradient(115deg,rgba(255,255,255,0.06)_0px,rgba(255,255,255,0.06)_2px,transparent_2px,transparent_9px)]" />

          <div className="relative rounded-md bg-cream p-2.5">
            <QrGlyph />
            <p className="mt-2 text-center text-[0.55rem] font-bold tracking-[0.18em] text-ink uppercase">
              Scan to order
            </p>
          </div>

          <p className="relative mt-2 text-center font-display text-[0.65rem] font-semibold tracking-wide text-cream/85">
            Table 04 · AeyChhotu
          </p>
        </div>

        {/* The stand's base */}
        <div className="mx-auto h-2 w-[86%] rounded-b-lg bg-dark-brown/80" />
        <div className="mx-auto h-1 w-[94%] rounded-pill bg-ink/15 blur-sm" />
      </motion.div>
    </div>
  );
}

function Corner({ className }: { className: string }) {
  return <span className={`absolute size-4 rounded-[2px] border-ember ${className}`} />;
}

/** The QR pattern itself. `glowing` adds the ember halo the phone reads. */
function QrGlyph({ glowing = false }: { glowing?: boolean }) {
  return (
    <svg
      viewBox="0 0 7 7"
      className={
        glowing
          ? "size-full drop-shadow-[0_0_6px_rgba(158,62,20,0.55)]"
          : "size-full"
      }
      shapeRendering="crispEdges"
    >
      {QR_CELLS.map(([x, y], index) => (
        <rect
          key={`${x}-${y}-${index}`}
          x={x ?? 0}
          y={y ?? 0}
          width={1}
          height={1}
          fill={glowing ? "#9e3e14" : "#1c1512"}
        />
      ))}
    </svg>
  );
}
