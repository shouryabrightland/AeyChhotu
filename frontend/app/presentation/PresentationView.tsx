"use client";

import {
  AnimatePresence,
  motion,
  useMotionValue,
  useReducedMotion,
  useSpring,
  useTransform,
} from "motion/react";
import Link from "next/link";
import QRCode from "qrcode";
import { useCallback, useEffect, useState, type CSSProperties, type ReactNode } from "react";
import styles from "./PresentationView.module.css";

/* The hackathon deck: eleven visual-first scenes, one idea each.

   The whole surface is a single 3D stage. Pointer position feeds a pair of
   springs that rotate the stage and slide three depth layers against each
   other:

     glow   translateZ(-150px)   ambient colour, furthest back
     visual translateZ(0)        the metaphor itself
     copy   translateZ(80px)     title and subtitle, nearest

   Navigation is keyboard-first — Space / → advance, ← returns — with a
   minimal top HUD whose dots are also buttons. Reduced-motion visitors get
   the same scenes with the parallax flattened. */

const TABLE_PATH = "/table/k7x2p";

interface Slide {
  title: string;
  subtitle: string;
  accent: string;
  scene: ReactNode;
}

/* ------------------------------------------------------------------ */
/* Tiny helpers                                                        */
/* ------------------------------------------------------------------ */

function MiniQr({ className }: { className?: string }) {
  /* A deliberately small, deterministic QR-like stamp for scenery. The real,
     scannable code is generated on the final slide. */
  const cells = [
    1, 1, 1, 0, 1, 0, 1, 1, 1,
    1, 0, 1, 0, 1, 1, 1, 0, 1,
    1, 1, 1, 0, 0, 1, 1, 1, 1,
    0, 0, 0, 1, 1, 0, 0, 1, 0,
    1, 0, 1, 0, 1, 0, 1, 0, 1,
    0, 1, 0, 1, 0, 1, 0, 1, 0,
    1, 1, 1, 0, 1, 1, 1, 0, 1,
    1, 0, 1, 1, 0, 0, 1, 0, 0,
    1, 1, 1, 0, 1, 0, 1, 1, 1,
  ];

  return (
    <span className={className} aria-hidden>
      {cells.map((cell, index) => (
        <i key={index} data-on={cell === 1 ? "true" : "false"} />
      ))}
    </span>
  );
}

function Scene({
  children,
  accent,
  className,
}: {
  children: ReactNode;
  accent: string;
  className?: string;
}) {
  return (
    <div
      className={[styles.scene, className].filter(Boolean).join(" ")}
      style={{ "--accent": accent } as CSSProperties}
    >
      {children}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Scenes                                                              */
/* ------------------------------------------------------------------ */

function ChaosScene() {
  return (
    <Scene accent="#ff6a3d">
      <div className={styles.chaos}>
        <div className={styles.chaosTable} />
        {[0, 1, 2, 3, 4, 5].map((index) => (
          <span key={index} className={styles.plate} data-i={index} />
        ))}
        {[0, 1, 2, 3].map((index) => (
          <span key={index} className={styles.receiptWire} data-i={index}>
            <i />
            <i />
            <i />
          </span>
        ))}
        <span className={styles.chaosFork} />
      </div>
    </Scene>
  );
}

function DownloadsScene() {
  return (
    <Scene accent="#ffc857">
      <div className={styles.scanScene}>
        <div className={styles.qrStand}>
          <div className={styles.standBoard}>
            <MiniQr className={styles.miniQr} />
            <span className={styles.pinChip}>07</span>
          </div>
          <span className={styles.standPost} />
        </div>

        <div className={styles.phone}>
          <span className={styles.phoneNotch} />
          <div className={styles.phoneScreen}>
            <span className={styles.scanCorner} data-corner="tl" />
            <span className={styles.scanCorner} data-corner="tr" />
            <span className={styles.scanCorner} data-corner="bl" />
            <span className={styles.scanCorner} data-corner="br" />
            <span className={styles.scanLine} />
          </div>
        </div>
      </div>
    </Scene>
  );
}

function BasketScene() {
  return (
    <Scene accent="#5eead4">
      <div className={styles.basketScene}>
        {[0, 1, 2].map((index) => (
          <div key={index} className={styles.miniPhone} data-i={index}>
            <span className={styles.miniScreen} />
          </div>
        ))}

        {[0, 1, 2].map((index) => (
          <span key={index} className={styles.dropDot} data-i={index} />
        ))}

        <div className={styles.basket}>
          <span className={styles.basketGlow} />
          <span className={styles.basketHandle} />
          {[0, 1, 2, 3].map((index) => (
            <span key={index} className={styles.basketDish} data-i={index} />
          ))}
        </div>
      </div>
    </Scene>
  );
}

function AllergyScene() {
  return (
    <Scene accent="#ff3b52">
      <div className={styles.allergyScene}>
        <div className={styles.receiptMorph}>
          <span />
          <span />
          <span />
          <span />
        </div>

        <div className={styles.alertBanner}>
          <span className={styles.alertTag}>MEDICAL ALLERGY</span>
          <strong>PEANUTS</strong>
          <span className={styles.alertPulse} />
        </div>
      </div>
    </Scene>
  );
}

function AtomicScene() {
  return (
    <Scene accent="#a78bfa">
      <div className={styles.lockScene}>
        <span className={styles.lockHalo} />
        <div className={styles.padlock}>
          <span className={styles.shackle} />
          <span className={styles.lockBody}>
            <span className={styles.keyhole} />
          </span>
        </div>
        <span className={styles.transactionTag}>BEGIN · SELECT … FOR UPDATE · COMMIT</span>
      </div>
    </Scene>
  );
}

function KitchenScene() {
  return (
    <Scene accent="#ffb020">
      <div className={styles.kdsScene}>
        <div className={styles.tablet}>
          <span className={styles.tabletBar} />
          <div className={styles.kdsCols}>
            {[
              { label: "PENDING", tone: "pending", lines: 2 },
              { label: "PREPARING", tone: "preparing", lines: 3 },
              { label: "READY", tone: "ready", lines: 1 },
            ].map((column) => (
              <div key={column.label} className={styles.kdsCol} data-tone={column.tone}>
                <span className={styles.kdsLabel}>{column.label}</span>
                <span className={styles.kdsClock}>04:12</span>
                {Array.from({ length: column.lines }, (_, index) => (
                  <span key={index} className={styles.kdsLine} data-i={index} />
                ))}
              </div>
            ))}
          </div>
        </div>
      </div>
    </Scene>
  );
}

function WaitingScene() {
  return (
    <Scene accent="#34d399">
      <div className={styles.waitScene}>
        <div className={styles.statePhone}>
          <span className={styles.stateLayer} data-state="grey" />
          <span className={styles.stateLayer} data-state="amber" />
          <span className={styles.stateLayer} data-state="green" />
          <span className={styles.stateBolt} />
        </div>
        <span className={styles.emeraldFlash} />
      </div>
    </Scene>
  );
}

function ControlScene() {
  return (
    <Scene accent="#60a5fa">
      <div className={styles.controlScene}>
        <div className={styles.handheld}>
          <span className={styles.hhBadge}>86</span>
          <div className={styles.hhRow} data-off="false">
            <span>Masala Dosa</span>
            <span className={styles.toggle} data-on="true">
              <i />
            </span>
          </div>
          <div className={styles.hhRow} data-off="true">
            <span>Rava Dosa</span>
            <span className={styles.toggle} data-on="false">
              <i />
            </span>
          </div>
          <div className={styles.hhRow} data-off="false">
            <span>Idli Sambar</span>
            <span className={styles.toggle} data-on="true">
              <i />
            </span>
          </div>
        </div>

        <div className={styles.dinerGrid}>
          {[0, 1, 2, 3, 4, 5].map((index) => (
            <span key={index} className={styles.dinerTile} data-off={index === 1 || index === 4}>
              <i />
              <i />
              <i />
            </span>
          ))}
        </div>
      </div>
    </Scene>
  );
}

function ReleaseScene() {
  return (
    <Scene accent="#f472b6">
      <div className={styles.releaseScene}>
        <div className={styles.releaseLock}>
          <span className={styles.releaseBody}>
            {[0, 1, 2].map((index) => (
              <span key={index} className={styles.tumbler} data-on="true">
                <i />
              </span>
            ))}
          </span>
        </div>

        <div className={styles.tumblerLabels}>
          {["BILL PAID", "0 ORDERS", "0 DEVICES"].map((label) => (
            <span key={label}>{label}</span>
          ))}
        </div>

        <div className={styles.ghostCredentials}>
          <span>PIN ••</span>
          <span>PASS ••••••••</span>
        </div>
        <span className={styles.spark} data-i="0" />
        <span className={styles.spark} data-i="1" />
        <span className={styles.spark} data-i="2" />
      </div>
    </Scene>
  );
}

function CockpitScene() {
  return (
    <Scene accent="#fbbf24">
      <div className={styles.cockpit}>
        <div className={styles.dashPanel}>
          <span className={styles.dashLabel}>LIVE REVENUE</span>
          <strong className={styles.dashCounter}>₹1,24,580</strong>
          <div className={styles.bars}>
            {[38, 62, 48, 78, 96, 70, 88, 58, 74].map((height, index) => (
              <span key={index} style={{ height: `${height}%` }} />
            ))}
          </div>
        </div>

        <div className={styles.dashPanel} data-small="true">
          <span className={styles.dashLabel}>TABLES</span>
          <strong className={styles.dashCounter}>24</strong>
          <div className={styles.sparkLine}>
            {[22, 34, 28, 48, 40, 58, 52, 66].map((point, index) => (
              <i key={index} style={{ height: `${point}%` }} />
            ))}
          </div>
        </div>
      </div>
    </Scene>
  );
}

function LiveScene({ qrMarkup }: { qrMarkup: string | null }) {
  return (
    <Scene accent="#f97316">
      <div className={styles.liveScene}>
        <div className={styles.qrCard}>
          {qrMarkup ? (
            <div
              className={styles.qrSvg}
              // Generated locally by the `qrcode` package from our own origin.
              dangerouslySetInnerHTML={{ __html: qrMarkup }}
            />
          ) : (
            <MiniQr className={styles.miniQr} />
          )}
          <span className={styles.qrLabel}>TABLE 07</span>
        </div>

        <div className={styles.launchButtons}>
          <Link href={TABLE_PATH} className={styles.launchPrimary}>
            Open diner table
          </Link>
          <Link href="/kitchen" className={styles.launchSecondary}>
            Open kitchen
          </Link>
        </div>
      </div>
    </Scene>
  );
}

/* ------------------------------------------------------------------ */
/* Slide definitions                                                   */
/* ------------------------------------------------------------------ */

const SLIDE_COUNT = 11;

function slides(qrMarkup: string | null): Slide[] {
  return [
    {
      title: "THE DINNER CHAOS",
      subtitle: "Four phones. Four receipts. One table.",
      accent: "#ff6a3d",
      scene: <ChaosScene />,
    },
    {
      title: "ZERO DOWNLOADS",
      subtitle: "Scan. Order. No install.",
      accent: "#ffc857",
      scene: <DownloadsScene />,
    },
    {
      title: "ONE TABLE. ONE BASKET.",
      subtitle: "Everyone adds. Everything merges.",
      accent: "#5eead4",
      scene: <BasketScene />,
    },
    {
      title: "ALLERGIES ARE NOT FOOTNOTES",
      subtitle: "An allergy is an instruction.",
      accent: "#ff3b52",
      scene: <AllergyScene />,
    },
    {
      title: "ATOMIC ORDER FIRE",
      subtitle: "One transaction. No split tickets.",
      accent: "#a78bfa",
      scene: <AtomicScene />,
    },
    {
      title: "CHEF'S COMMAND CENTER",
      subtitle: "Pending, cooking, ready — live.",
      accent: "#ffb020",
      scene: <KitchenScene />,
    },
    {
      title: "ZERO WAITING ANXIETY",
      subtitle: "Grey, amber, emerald. Always know.",
      accent: "#34d399",
      scene: <WaitingScene />,
    },
    {
      title: "REAL-TIME CONTROL",
      subtitle: "86 it once. It vanishes everywhere.",
      accent: "#60a5fa",
      scene: <ControlScene />,
    },
    {
      title: "3-KEY AUTO RELEASE",
      subtitle: "Paid, served, disconnected — released.",
      accent: "#f472b6",
      scene: <ReleaseScene />,
    },
    {
      title: "OWNER'S COCKPIT",
      subtitle: "Every rupee. Every table.",
      accent: "#fbbf24",
      scene: <CockpitScene />,
    },
    {
      title: "TRY IT LIVE",
      subtitle: "Scan the table. Or open the console.",
      accent: "#f97316",
      scene: <LiveScene qrMarkup={qrMarkup} />,
    },
  ];
}

/* ------------------------------------------------------------------ */
/* View                                                                */
/* ------------------------------------------------------------------ */

export function PresentationView() {
  const [index, setIndex] = useState(0);
  const [qrMarkup, setQrMarkup] = useState<string | null>(null);
  const reduceMotion = useReducedMotion();

  const pointerX = useMotionValue(0);
  const pointerY = useMotionValue(0);

  const smoothX = useSpring(pointerX, { stiffness: 70, damping: 20, mass: 0.6 });
  const smoothY = useSpring(pointerY, { stiffness: 70, damping: 20, mass: 0.6 });

  const rotateY = useTransform(smoothX, [-1, 1], [-7, 7]);
  const rotateX = useTransform(smoothY, [-1, 1], [6, -6]);
  const glowX = useTransform(smoothX, [-1, 1], [50, -50]);
  const glowY = useTransform(smoothY, [-1, 1], [30, -30]);
  const visualX = useTransform(smoothX, [-1, 1], [22, -22]);
  const visualY = useTransform(smoothY, [-1, 1], [14, -14]);
  const copyX = useTransform(smoothX, [-1, 1], [-12, 12]);
  const copyY = useTransform(smoothY, [-1, 1], [-8, 8]);

  const goNext = useCallback(() => {
    setIndex((current) => Math.min(current + 1, SLIDE_COUNT - 1));
  }, []);

  const goPrev = useCallback(() => {
    setIndex((current) => Math.max(current - 1, 0));
  }, []);

  // Keyboard navigation: Space / → advance, ← returns.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const interactive = target?.closest("a, button, input, textarea, select");

      if (event.key === "ArrowRight" || (event.code === "Space" && !interactive)) {
        event.preventDefault();
        goNext();
        return;
      }
      if (event.key === "ArrowLeft") {
        event.preventDefault();
        goPrev();
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [goNext, goPrev]);

  // The final slide's QR points at this deployment, generated client-side.
  useEffect(() => {
    let cancelled = false;
    const target =
      typeof window === "undefined"
        ? TABLE_PATH
        : `${window.location.origin}${TABLE_PATH}`;

    void QRCode.toString(target, {
      type: "svg",
      margin: 1,
      width: 280,
      errorCorrectionLevel: "M",
      color: { dark: "#0b1020", light: "#f7faff" },
    })
      .then((markup) => {
        if (!cancelled) setQrMarkup(markup);
      })
      .catch(() => {
        if (!cancelled) setQrMarkup(null);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  const deck = slides(qrMarkup);
  const active = (deck[index] ?? deck[0])!;

  const handlePointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    if (reduceMotion) return;
    const x = (event.clientX / window.innerWidth) * 2 - 1;
    const y = (event.clientY / window.innerHeight) * 2 - 1;
    pointerX.set(Math.max(-1, Math.min(1, x)));
    pointerY.set(Math.max(-1, Math.min(1, y)));
  };

  const handlePointerLeave = () => {
    pointerX.set(0);
    pointerY.set(0);
  };

  return (
    <div
      className={styles.root}
      onPointerMove={handlePointerMove}
      onPointerLeave={handlePointerLeave}
    >
      <div className={styles.hud}>
        <span className={styles.hudLabel}>AEYCHHOTU · LIVE SERVICE</span>

        <div className={styles.hudDots} role="tablist" aria-label="Slides">
          {deck.map((slide, slideIndex) => (
            <button
              key={slide.title}
              type="button"
              role="tab"
              aria-selected={slideIndex === index}
              aria-label={`Slide ${slideIndex + 1}: ${slide.title}`}
              className={styles.dot}
              data-active={slideIndex === index}
              onClick={() => setIndex(slideIndex)}
            />
          ))}
        </div>

        <span className={styles.hudCount}>
          Slide {index + 1} of {SLIDE_COUNT}
        </span>
      </div>

      <div className={styles.stage}>
        <motion.div
          className={styles.parallax}
          style={
            reduceMotion
              ? undefined
              : { rotateX, rotateY, transformStyle: "preserve-3d" }
          }
        >
          <motion.span
            aria-hidden
            className={styles.glow}
            style={
              reduceMotion
                ? undefined
                : { x: glowX, y: glowY, z: -150, background: `radial-gradient(circle at 50% 50%, ${active.accent}45, transparent 62%)` }
            }
          />

          <motion.div
            className={styles.visual}
            style={reduceMotion ? undefined : { x: visualX, y: visualY, z: 0 }}
          >
            <AnimatePresence mode="wait" initial={false}>
              <motion.div
                key={`scene-${index}`}
                className={styles.sceneFrame}
                initial={
                  reduceMotion
                    ? { opacity: 0 }
                    : { opacity: 0, z: -80, rotateX: 6, scale: 0.96 }
                }
                animate={{ opacity: 1, z: 0, rotateX: 0, scale: 1 }}
                exit={
                  reduceMotion
                    ? { opacity: 0 }
                    : { opacity: 0, z: 60, rotateX: -4, scale: 0.97 }
                }
                transition={{ duration: 0.55, ease: [0.22, 1, 0.36, 1] }}
              >
                {active.scene}
              </motion.div>
            </AnimatePresence>
          </motion.div>

          <motion.div
            className={styles.copy}
            style={reduceMotion ? undefined : { x: copyX, y: copyY, z: 80 }}
          >
            <AnimatePresence mode="wait" initial={false}>
              <motion.div
                key={`copy-${index}`}
                initial={reduceMotion ? { opacity: 0 } : { opacity: 0, y: 24 }}
                animate={{ opacity: 1, y: 0 }}
                exit={reduceMotion ? { opacity: 0 } : { opacity: 0, y: -18 }}
                transition={{ duration: 0.45, ease: [0.22, 1, 0.36, 1] }}
              >
                <h1 className={styles.title}>{active.title}</h1>
                <p className={styles.subtitle}>{active.subtitle}</p>
              </motion.div>
            </AnimatePresence>
          </motion.div>
        </motion.div>
      </div>

      <div className={styles.hint}>
        <span>
          <kbd>←</kbd>
          <kbd>→</kbd>
          <kbd>space</kbd>
        </span>
        <span className={styles.progress} aria-hidden>
          <i style={{ width: `${((index + 1) / SLIDE_COUNT) * 100}%` }} />
        </span>
      </div>
    </div>
  );
}
