"use client";

import {
  AnimatePresence,
  motion,
  useMotionValue,
  useReducedMotion,
  useSpring,
  useTransform,
} from "motion/react";
import Image from "next/image";
import Link from "next/link";
import QRCode from "qrcode";
import { useCallback, useEffect, useState, type CSSProperties, type ReactNode } from "react";
import styles from "./PresentationView.module.css";

/* The hackathon deck: twenty-three visual-first scenes, one feature each.

   Scenes 1–18 walk the service; scenes 19–22 are the WOW act — the three
   Gemini Live surfaces and the waiter handoff — and 23 opens the product.
   The wow slides carry a kicker so a judge can see they are the climax.

   The stage is the app's own warm canvas — cream, espresso ink, ember — and
   every scene shows the REAL product: menu, cart, tracker, bill, kitchen
   lanes, floor and console. That is the point of the deck: an investor should
   recognise the running app in every slide, on the same ground it ships on.

   The whole surface is a single 3D stage. Pointer position feeds a pair of
   springs that rotate the stage and slide three depth layers against each
   other:

     glow   translateZ(-150px)   ambient colour, furthest back
     visual translateZ(0)        the app screen itself
     copy   translateZ(80px)     title and subtitle, nearest

   Navigation is keyboard-first — Space / → advance, ← returns — with a
   minimal top HUD whose dots are also buttons. Reduced-motion visitors get
   the same scenes with the parallax and decorative animation flattened. */

/* The closing slide points at the app's front door, not at a seeded demo
   table: a k7x2p link 404s on a fresh deployment, and a judge should land on
   the product itself. */
const HOME_PATH = "/";
const SLIDE_COUNT = 23;

interface Slide {
  title: string;
  subtitle: string;
  accent: string;
  /** Optional eyebrow above the title — used by the WOW act. */
  kicker?: string;
  scene: ReactNode;
}

/* ------------------------------------------------------------------ */
/* Shared mock-UI pieces                                               */
/* ------------------------------------------------------------------ */

function MiniQr({ className }: { className?: string }) {
  /* A small, deterministic QR-like stamp for scenery. The real, scannable
     code is generated on the final slide. */
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

/** A phone bezel with the app's cream screen inside. */
function Phone({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={[styles.phone, className].filter(Boolean).join(" ")}>
      <span className={styles.phoneIsland} aria-hidden />
      <div className={styles.phoneScreen}>{children}</div>
    </div>
  );
}

function AppTop({
  eyebrow,
  title,
  meta,
}: {
  eyebrow: string;
  title: string;
  meta?: string;
}) {
  return (
    <div className={styles.appTop}>
      <span className={styles.appEyebrow}>{eyebrow}</span>
      <strong className={styles.appHeading}>{title}</strong>
      {meta ? <span className={styles.appMeta}>{meta}</span> : null}
    </div>
  );
}

/** Zero-based sparkline for the cockpit stat cards. */
function Spark({ values }: { values: number[] }) {
  const width = 96;
  const height = 26;
  const max = Math.max(...values, 1);
  const step = width / (values.length - 1);
  const line = values
    .map(
      (value, index) =>
        `${index === 0 ? "M" : "L"} ${(index * step).toFixed(1)} ${(height - (value / max) * (height - 4) - 2).toFixed(1)}`,
    )
    .join(" ");

  return (
    <svg className={styles.spark} viewBox={`0 0 ${width} ${height}`} aria-hidden>
      <path d={`${line} L ${width} ${height} L 0 ${height} Z`} fill="currentColor" opacity="0.12" />
      <path d={line} fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

/* ------------------------------------------------------------------ */
/* Scenes — one per feature                                            */
/* ------------------------------------------------------------------ */

/* 1 — the problem: four people, four bills */
function ChaosScene() {
  const bills = [
    { who: "Aarav", line: "Masala Dosa ×1", total: "₹180" },
    { who: "Meera", line: "Paneer Butter Masala ×1", total: "₹320" },
    { who: "Ravi", line: "Veg Noodles ×2", total: "₹480" },
    { who: "Paper bill", line: "4 separate receipts", total: "₹1,180" },
  ];

  return (
    <Scene accent="#9e3e14">
      <div className={styles.fan}>
        <span className={styles.fanTable} aria-hidden />
        {bills.map((bill, index) => (
          <div key={bill.who} className={styles.fanSlot} data-i={index}>
            <Phone>
              <span className={styles.billWho}>{bill.who}</span>
              <span className={styles.billLine}>{bill.line}</span>
              <span className={styles.billTotal}>{bill.total}</span>
              <span className={styles.billStamp}>SEPARATE BILL</span>
            </Phone>
          </div>
        ))}
      </div>
    </Scene>
  );
}

/* 2 — scan the QR, give a name, no install */
function ScanScene() {
  return (
    <Scene accent="#c9a87c">
      <div className={styles.scanPair}>
        <div className={styles.standCard}>
          <span className={styles.standBrand}>AeyChhotu!</span>
          <div className={styles.standQr}>
            <MiniQr className={styles.qrCells} />
          </div>
          <strong className={styles.standTable}>Table k7x2p</strong>
          <span className={styles.standHint}>Scan to open the menu</span>
        </div>

        <Phone className={styles.tiltRight}>
          <AppTop eyebrow="Table k7x2p" title="What should we call you?" />
          <div className={styles.nameField}>Ravi</div>
          <span className={styles.emberButton}>Continue</span>
          <span className={styles.appNote}>
            Just a first name. No account, no password, no download.
          </span>
        </Phone>
      </div>
    </Scene>
  );
}

/* 3 — the two-layer table lock and the pass */
function SecurityScene() {
  return (
    <Scene accent="#7c563b">
      <div className={styles.securityPair}>
        <Phone>
          <AppTop eyebrow="Window four-top" title="Enter table PIN" />
          <div className={styles.pinDots} aria-hidden>
            <i />
            <i />
          </div>
          <div className={styles.pinPad}>
            {["1", "2", "3", "4", "5", "6", "7", "8", "9", "", "0", "⌫"].map((key, index) =>
              key ? <span key={index}>{key}</span> : <span key={index} aria-hidden />,
            )}
          </div>
          <span className={styles.appWarn}>2 tries left before this table locks.</span>
        </Phone>

        <div className={styles.passCard}>
          <span className={styles.passEyebrow}>Table pass</span>
          <strong className={styles.passPin}>07</strong>
          <div className={styles.passQr}>
            <MiniQr className={styles.qrCells} />
          </div>
          <span className={styles.passHint}>Share the pass, never the PIN.</span>
          <div className={styles.peopleChips}>
            <span>Aarav</span>
            <span>Meera</span>
            <span>Ravi</span>
          </div>
          <span className={styles.passNote}>3 phones at this table</span>
        </div>
      </div>
    </Scene>
  );
}

/* 4 — search, diet filters, one-tap add */
function MenuScene() {
  const dishes = [
    {
      name: "Masala Dosa",
      desc: "Crisp, ghee-roasted · coconut chutney",
      price: "₹180",
      photo: "/food/dosa.jpg",
      veg: true,
    },
    {
      name: "Paneer Butter Masala",
      desc: "Slow-cooked tomato, cream, garlic naan",
      price: "₹320",
      photo: "/food/paneer.jpg",
      veg: true,
    },
    {
      name: "Hyderabadi Biryani",
      desc: "Dum-cooked · saffron · mirchi ka salan",
      price: "₹380",
      photo: "/food/biryani.jpg",
      veg: false,
    },
  ];

  return (
    <Scene accent="#8a4a0b">
      <div className={styles.menuBoard}>
        <div className={styles.menuSearchRow}>
          <span className={styles.searchField}>
            <i aria-hidden>⌕</i>
            Ready to order? Dosa, biryani, chai…
          </span>
          <div className={styles.dietTabs}>
            <span data-on="true">All</span>
            <span>Veg</span>
            <span>Vegan</span>
            <span>Jain</span>
          </div>
        </div>

        <div className={styles.menuSectionHead}>
          <strong>South Indian</strong>
          <span>3 dishes · tap to add</span>
        </div>

        <div className={styles.dishGrid}>
          {dishes.map((dish) => (
            <article key={dish.name} className={styles.dishCard}>
              <div className={styles.dishPhoto}>
                <Image
                  src={dish.photo}
                  alt=""
                  width={240}
                  height={150}
                  sizes="220px"
                  className={styles.dishImg}
                />
                <span className={styles.vegMark} data-veg={dish.veg ? "true" : "false"}>
                  <i />
                </span>
              </div>
              <div className={styles.dishBody}>
                <strong>{dish.name}</strong>
                <span className={styles.dishDesc}>{dish.desc}</span>
                <div className={styles.dishFoot}>
                  <span>{dish.price}</span>
                  <span className={styles.dishAdd}>Add</span>
                </div>
              </div>
            </article>
          ))}
        </div>
      </div>
    </Scene>
  );
}

/* 5 — reconnect without the PIN, and see who is at the table */
function ResumeScene() {
  const diners = [
    { name: "Aarav", meta: "ordering now", initial: "A" },
    { name: "Meera", meta: "browsing the menu", initial: "M" },
    { name: "Ravi", meta: "joined 2 min ago", initial: "R" },
  ];

  return (
    <Scene accent="#7c563b">
      <div className={styles.resumePair}>
        <Phone>
          <AppTop eyebrow="Window four-top" title="Aarav, you’re back" />
          <span className={styles.restoredPill}>Session restored</span>
          <div className={styles.statusCard} data-tone="ready">
            <strong>No PIN needed</strong>
            <span>This phone still holds the table pass.</span>
          </div>
          <span className={styles.sittingLabel}>At this table</span>
          <div className={styles.peopleChips}>
            {diners.map((person) => (
              <span key={person.name}>{person.name}</span>
            ))}
          </div>
          <span className={styles.appNote}>
            Lost the tab? Reconnect with the pass, or the 2-digit PIN.
          </span>
        </Phone>

        <div className={styles.panel}>
          <header className={styles.panelHead}>
            <span className={styles.panelEyebrow}>Table pass</span>
            <strong className={styles.panelTitle}>3 phones · live</strong>
            <span className={styles.panelMeta}>Window four-top · Table k7x2p</span>
          </header>
          <div className={styles.passCode}>R4V9 · K2M8</div>
          <div className={styles.splitRows}>
            {diners.map((person) => (
              <div key={person.name} className={styles.splitRow}>
                <span className={styles.avatar}>{person.initial}</span>
                <span className={styles.splitName}>{person.name}</span>
                <span className={styles.dinerMeta}>{person.meta}</span>
              </div>
            ))}
          </div>
          <span className={styles.emberButton}>Share pass</span>
          <span className={styles.appNote}>Share the pass, never the PIN.</span>
        </div>
      </div>
    </Scene>
  );
}

/* 6 — the shared cart: everyone adds, everything merges */
function BasketScene() {
  const adders = [
    { name: "Aarav", dish: "Masala Dosa", price: "₹180" },
    { name: "Meera", dish: "Paneer Butter Masala", price: "₹320" },
    { name: "Ravi", dish: "Veg Noodles", price: "₹240" },
  ];
  const lines = [
    { name: "Masala Dosa", meta: "×1 · Aarav", price: "₹180" },
    { name: "Paneer Butter Masala", meta: "×1 · Meera", price: "₹320" },
    { name: "Veg Noodles", meta: "×1 · Ravi", price: "₹240" },
  ];

  return (
    <Scene accent="#8a4a0b">
      <div className={styles.basketPair}>
        <div className={styles.adders}>
          {adders.map((person, index) => (
            <div key={person.name} className={styles.adderSlot} data-i={index}>
              <Phone className={styles.phoneMini}>
                <span className={styles.dishWho}>{person.name}</span>
                <strong className={styles.dishName}>{person.dish}</strong>
                <span className={styles.dishPrice}>{person.price}</span>
                <span className={styles.addChip}>Add</span>
              </Phone>
            </div>
          ))}
        </div>

        <span className={styles.flowArrow} aria-hidden>
          →
        </span>

        <div className={[styles.panel, styles.cartPanel].join(" ")}>
          <header className={styles.panelHead}>
            <span className={styles.panelEyebrow}>Table k7x2p</span>
            <strong className={styles.panelTitle}>Table cart</strong>
            <span className={styles.panelMeta}>3 phones · live</span>
          </header>
          {lines.map((line) => (
            <div key={line.name} className={styles.cartLine}>
              <div>
                <strong>{line.name}</strong>
                <span>{line.meta}</span>
              </div>
              <span className={styles.linePrice}>{line.price}</span>
            </div>
          ))}
          <div className={styles.totalRow}>
            <span>Table total</span>
            <strong>₹840</strong>
          </div>
          <span className={styles.emberButton}>Review &amp; fire</span>
        </div>
      </div>
    </Scene>
  );
}

/* 5 — allergy notes travel to the kitchen ticket */
function AllergyScene() {
  return (
    <Scene accent="#a31b10">
      <div className={styles.pairWide}>
        <div className={styles.panel}>
          <header className={styles.panelHead}>
            <span className={styles.panelEyebrow}>Review table cart</span>
            <strong className={styles.panelTitle}>Aarav’s Masala Dosa</strong>
          </header>
          <div className={styles.cartLine}>
            <div>
              <strong>Masala Dosa</strong>
              <span>×1 · Aarav</span>
            </div>
            <span className={styles.linePrice}>₹180</span>
          </div>
          <div className={styles.allergyNote}>
            <strong>Peanut allergy</strong>
            <span>Separate pan · no chutney</span>
          </div>
          <span className={styles.emberButton}>Review &amp; fire</span>
        </div>

        <span className={styles.flowArrow} aria-hidden>
          →
        </span>

        <div className={styles.ticket}>
          <header className={styles.ticketHead}>
            <strong>#1042</strong>
            <span>Table k7x2p</span>
          </header>
          <div className={styles.ticketItem}>
            <span>Masala Dosa</span>
            <span>×1</span>
          </div>
          <div className={styles.ticketItem}>
            <span>Filter coffee</span>
            <span>×2</span>
          </div>
          <div className={styles.allergyBanner}>MEDICAL ALLERGY · PEANUTS</div>
          <footer className={styles.ticketFoot}>
            <span className={styles.pillPending}>Pending</span>
            <span>00:12</span>
          </footer>
        </div>
      </div>
    </Scene>
  );
}

/* 6 — atomic fire and a safe retry for a refused round */
function FireScene() {
  return (
    <Scene accent="#8a4a0b">
      <div className={styles.pairWide}>
        <div className={styles.panel}>
          <header className={styles.panelHead}>
            <span className={styles.panelEyebrow}>Table k7x2p</span>
            <strong className={styles.panelTitle}>Review table cart</strong>
            <span className={styles.panelMeta}>4 items</span>
          </header>
          <div className={styles.cartLine}>
            <div>
              <strong>Masala Dosa</strong>
              <span>×2 · Aarav</span>
            </div>
            <span className={styles.linePrice}>₹360</span>
          </div>
          <div className={styles.cartLine}>
            <div>
              <strong>Paneer Butter Masala</strong>
              <span>×1 · Meera</span>
            </div>
            <span className={styles.linePrice}>₹320</span>
          </div>
          <div className={styles.totalRow}>
            <span>Table total</span>
            <strong>₹840</strong>
          </div>
          <span className={styles.emberButton}>Fire 4 dishes</span>
        </div>

        <span className={styles.flowArrow} aria-hidden>
          →
        </span>

        <div className={styles.ticketStack}>
          <div className={styles.ticket}>
            <header className={styles.ticketHead}>
              <strong>#1042</strong>
              <span>Table k7x2p</span>
            </header>
            <div className={styles.ticketItem}>
              <span>Masala Dosa</span>
              <span>×2</span>
            </div>
            <div className={styles.ticketItem}>
              <span>Paneer Butter Masala</span>
              <span>×1</span>
            </div>
            <footer className={styles.ticketFoot}>
              <span className={styles.pillPending}>Pending</span>
              <span>one transaction</span>
            </footer>
          </div>

          <div className={styles.deniedCard}>
            <span className={styles.pillAlert}>Kitchen said</span>
            <strong>Paneer is 86’d</strong>
            <span className={styles.deniedText}>
              Retry moves and re-fires the round in one transaction. The refused ticket stays
              until the new one lands.
            </span>
            <span className={styles.retryButton}>Retry round</span>
          </div>
        </div>
      </div>
    </Scene>
  );
}

/* 7 — the live tracker, without asking a waiter */
function TrackerScene() {
  return (
    <Scene accent="#2c6631">
      <div className={styles.waitPair}>
        <Phone>
          <AppTop eyebrow="Live order" title="Cooking on the line" meta="≈ 12 min" />
          <div className={styles.stepper}>
            <span data-on="true">Sent</span>
            <i />
            <span data-on="true">Cooking</span>
            <i />
            <span>Ready</span>
          </div>
          <div className={styles.statusCard} data-tone="preparing">
            <strong>Preparing</strong>
            <span>Masala Dosa ×2 · Paneer ×1</span>
          </div>
          <span className={styles.appNote}>The chef moves it. Your screen follows.</span>
        </Phone>

        <Phone className={styles.tiltLeft}>
          <AppTop eyebrow="Live order" title="Ready at the pass" meta="now" />
          <div className={styles.stepper}>
            <span data-on="true">Sent</span>
            <i />
            <span data-on="true">Cooking</span>
            <i />
            <span data-on="true">Ready</span>
          </div>
          <div className={styles.statusCard} data-tone="ready">
            <strong>Ready</strong>
            <span>Runner inbound · Table k7x2p</span>
          </div>
          <span className={styles.appNote}>Served by the kitchen, not by asking twice.</span>
        </Phone>
      </div>
    </Scene>
  );
}

/* 10 — a second round on the same session */
function RoundScene() {
  return (
    <Scene accent="#c9a87c">
      <div className={styles.pairWide}>
        <Phone>
          <AppTop eyebrow="Live order" title="Round 1 served" meta="just now" />
          <div className={styles.stepper}>
            <span data-on="true">Sent</span>
            <i />
            <span data-on="true">Cooking</span>
            <i />
            <span data-on="true">Ready</span>
          </div>
          <div className={styles.roundCard}>
            <strong>3 dishes · ₹840</strong>
            <span>Masala Dosa ×2 · Paneer ×1</span>
          </div>
          <div className={styles.roundDivider}>
            <span>Round 2</span>
            <i />
          </div>
          <span className={styles.appNote}>
            Dessert is staged — fire it without starting a new session.
          </span>
        </Phone>

        <span className={styles.flowArrow} aria-hidden>
          →
        </span>

        <div className={styles.panel}>
          <header className={styles.panelHead}>
            <span className={styles.panelEyebrow}>Table k7x2p · shared cart</span>
            <strong className={styles.panelTitle}>Round 2</strong>
            <span className={styles.panelMeta}>Nothing fired yet</span>
          </header>
          <div className={styles.cartLine}>
            <div>
              <strong>Gulab Jamun</strong>
              <span>×2 · Meera</span>
            </div>
            <span className={styles.linePrice}>₹160</span>
          </div>
          <div className={styles.cartLine}>
            <div>
              <strong>Filter coffee</strong>
              <span>×2 · Aarav</span>
            </div>
            <span className={styles.linePrice}>₹120</span>
          </div>
          <div className={styles.totalRow}>
            <span>This round</span>
            <strong>₹280</strong>
          </div>
          <span className={styles.emberButton}>Fire this round</span>
        </div>
      </div>
    </Scene>
  );
}

/* 11 — split bill by person, request the bill */
function BillScene() {
  const people = [
    { name: "Aarav", amount: "₹180", initial: "A" },
    { name: "Meera", amount: "₹320", initial: "M" },
    { name: "Ravi", amount: "₹340", initial: "R" },
  ];

  return (
    <Scene accent="#8a4a0b">
      <div className={[styles.panel, styles.billPanel].join(" ")}>
        <header className={styles.panelHead}>
          <span className={styles.panelEyebrow}>Window four-top · Table k7x2p</span>
          <strong className={styles.panelTitle}>Total bill</strong>
        </header>
        <div className={styles.billTabs}>
          <span data-on="true">Everyone</span>
          <span>Just mine</span>
        </div>
        <div className={styles.billTotal}>
          <span>Ordered</span>
          <strong>₹840</strong>
        </div>
        <span className={styles.splitLabel}>Split by person</span>
        <div className={styles.splitRows}>
          {people.map((person) => (
            <div key={person.name} className={styles.splitRow}>
              <span className={styles.avatar}>{person.initial}</span>
              <span className={styles.splitName}>{person.name}</span>
              <span className={styles.splitAmount}>{person.amount}</span>
            </div>
          ))}
        </div>
        <span className={styles.emberButton}>Request bill</span>
        <span className={styles.appNote}>Staged lines stay separate until they’re fired.</span>
      </div>
    </Scene>
  );
}

/* 9 — the kitchen display: three lanes, live timers */
function KitchenScene() {
  const columns = [
    {
      title: "Pending",
      tone: "pending",
      count: 2,
      tickets: [
        { id: "1042", table: "k7x2p", time: "00:12", items: ["Masala Dosa ×2", "Filter coffee ×2"] },
        { id: "1043", table: "m3q8z", time: "00:38", items: ["Veg Noodles ×1"], allergy: true },
      ],
    },
    {
      title: "Preparing",
      tone: "preparing",
      count: 2,
      tickets: [
        { id: "1041", table: "m9b3x", time: "04:18", items: ["Paneer Butter Masala ×1", "Garlic Naan ×3"] },
        { id: "1040", table: "t6r4y", time: "06:02", items: ["Hyderabadi Biryani ×2"] },
      ],
    },
    {
      title: "Ready",
      tone: "ready",
      count: 1,
      tickets: [{ id: "1039", table: "v9w1s", time: "Ready 1m", items: ["Masala Dosa ×3"] }],
    },
  ];

  return (
    <Scene accent="#9e3e14">
      <div className={styles.kdsBoard}>
        <header className={styles.kdsHead}>
          <strong>Kitchen display</strong>
          <span>Shift live · 5 tickets</span>
        </header>
        <div className={styles.kdsColumns}>
          {columns.map((column) => (
            <div key={column.title} className={styles.kdsColumn} data-tone={column.tone}>
              <div className={styles.kdsColHead}>
                <span>{column.title}</span>
                <span>{column.count}</span>
              </div>
              {column.tickets.map((ticket) => (
                <div key={ticket.id} className={styles.kdsTicket}>
                  <div className={styles.kdsTicketTop}>
                    <strong>Table {ticket.table}</strong>
                    <span>{ticket.time}</span>
                  </div>
                  {ticket.items.map((item) => (
                    <span key={item} className={styles.kdsItem}>
                      {item}
                    </span>
                  ))}
                  {ticket.allergy ? (
                    <span className={styles.kdsAllergy}>PEANUT ALLERGY</span>
                  ) : null}
                </div>
              ))}
            </div>
          ))}
        </div>
      </div>
    </Scene>
  );
}

/* 10 — the floor board: settle, notify, clear */
function FloorScene() {
  const tables = [
    {
      name: "Window four-top",
      status: "Active",
      tone: "active",
      meta: "2 phones · ₹840 · Aarav, Meera",
      actions: ["Settle", "Notify"],
    },
    {
      name: "Corner booth",
      status: "Bill requested",
      tone: "alert",
      meta: "₹1,240 · 1 phone",
      actions: ["Settle"],
    },
    {
      name: "Garden six-top",
      status: "Needs a look",
      tone: "warn",
      meta: "No device · no open orders",
      actions: ["Clear"],
    },
    {
      name: "High-top two",
      status: "Empty",
      tone: "idle",
      meta: "Next scan claims it",
      actions: ["QR"],
    },
  ];

  return (
    <Scene accent="#7c563b">
      <div className={styles.floorBoard}>
        <header className={styles.floorHead}>
          <strong>Floor</strong>
          <span>5 tables · 3 seated · live</span>
        </header>
        <div className={styles.floorGrid}>
          {tables.map((table) => (
            <div key={table.name} className={styles.floorCard} data-tone={table.tone}>
              <div className={styles.floorTop}>
                <strong>{table.name}</strong>
                <span className={styles.floorStatus}>{table.status}</span>
              </div>
              <span className={styles.floorMeta}>{table.meta}</span>
              <div className={styles.floorActions}>
                {table.actions.map((action) => (
                  <span key={action}>{action}</span>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    </Scene>
  );
}

/* 11 — 86 one dish, it leaves every screen */
function ControlScene() {
  return (
    <Scene accent="#a31b10">
      <div className={styles.controlPair}>
        <div className={styles.panel}>
          <header className={styles.panelHead}>
            <span className={styles.panelEyebrow}>Manager console</span>
            <strong className={styles.panelTitle}>Menu catalog</strong>
            <span className={styles.panelMeta}>Main course</span>
          </header>
          <div className={styles.menuRow}>
            <span>Masala Dosa</span>
            <span className={styles.toggle} data-on="true">
              <i />
            </span>
          </div>
          <div className={styles.menuRow} data-off="true">
            <span>Rava Dosa</span>
            <span className={styles.toggle} data-on="false">
              <i />
            </span>
          </div>
          <div className={styles.menuRow}>
            <span>Idli Sambar</span>
            <span className={styles.toggle} data-on="true">
              <i />
            </span>
          </div>
          <span className={styles.appNote}>Flip one toggle. The floor and every phone update.</span>
        </div>

        <span className={styles.flowArrow} aria-hidden>
          →
        </span>

        <Phone>
          <AppTop eyebrow="Today’s menu" title="Main course" />
          <div className={styles.menuDish}>
            <strong>Masala Dosa</strong>
            <span>₹180</span>
          </div>
          <div className={styles.menuDish} data-off="true">
            <strong>Rava Dosa</strong>
            <span>Sold out</span>
          </div>
          <div className={styles.menuDish}>
            <strong>Idli Sambar</strong>
            <span>₹120</span>
          </div>
        </Phone>
      </div>
    </Scene>
  );
}

/* 15 — the menu catalog: prices, photos, categories */
function MenuAdminScene() {
  const dishes = [
    {
      name: "Masala Dosa",
      category: "South Indian · ₹180",
      photo: "/food/dosa.jpg",
      veg: true,
      off: false,
    },
    {
      name: "Paneer Butter Masala",
      category: "Main course · ₹320",
      photo: "/food/paneer.jpg",
      veg: true,
      off: false,
    },
    {
      name: "Hyderabadi Biryani",
      category: "Biryani · ₹380",
      photo: "/food/biryani.jpg",
      veg: false,
      off: false,
    },
    {
      name: "Rava Dosa",
      category: "South Indian · ₹160",
      photo: "/food/dosa.jpg",
      veg: true,
      off: true,
    },
  ];

  return (
    <Scene accent="#8a4a0b">
      <div className={styles.menuAdminBoard}>
        <header className={styles.menuAdminHead}>
          <div>
            <span className={styles.panelEyebrow}>Manager console</span>
            <strong className={styles.menuAdminTitle}>Menu catalog</strong>
          </div>
          <span className={styles.newDishButton}>+ New dish</span>
        </header>

        <div className={styles.menuAdminTabs}>
          <span data-on="true">All · 24</span>
          <span>Veg · 16</span>
          <span>Non-veg · 8</span>
          <span>Out of stock · 1</span>
        </div>

        <div className={styles.menuAdminList}>
          {dishes.map((dish) => (
            <div key={dish.name} className={styles.menuAdminRow} data-off={dish.off}>
              <Image
                src={dish.photo}
                alt=""
                width={44}
                height={44}
                sizes="44px"
                className={styles.menuAdminThumb}
              />
              <span
                className={styles.vegMark}
                data-veg={dish.veg ? "true" : "false"}
                aria-hidden
              >
                <i />
              </span>
              <div className={styles.menuAdminName}>
                <strong>{dish.name}</strong>
                <span>{dish.category}</span>
              </div>
              <span className={styles.toggle} data-on={dish.off ? "false" : "true"}>
                <i />
              </span>
              <span className={styles.editChip}>Edit</span>
            </div>
          ))}
        </div>

        <span className={styles.menuAdminNote}>
          Price, photo, category — one save, every phone and the floor update.
        </span>
      </div>
    </Scene>
  );
}

/* 16 — the three-key release */
function ReleaseScene() {
  return (
    <Scene accent="#7c563b">
      <div className={styles.releasePair}>
        <div className={styles.panel}>
          <header className={styles.panelHead}>
            <span className={styles.panelEyebrow}>Window four-top · active</span>
            <strong className={styles.panelTitle}>Release checks</strong>
          </header>
          <div className={styles.checkRow}>
            <span>✓</span>
            Bill is paid
          </div>
          <div className={styles.checkRow}>
            <span>✓</span>
            No open orders
          </div>
          <div className={styles.checkRow}>
            <span>✓</span>
            No devices still connected
          </div>
          <span className={styles.appNote}>All three are re-checked under a row lock.</span>
        </div>

        <span className={styles.flowArrow} aria-hidden>
          →
        </span>

        <div className={[styles.panel, styles.releasedCard].join(" ")}>
          <span className={styles.pillReady}>Released</span>
          <strong className={styles.releasedTitle}>Table is empty</strong>
          <span className={styles.releasedText}>
            The PIN and pass are wiped. The next scan starts a fresh party.
          </span>
          <div className={styles.credentialRow}>
            <span>PIN ••</span>
            <span>PASS ••••••••</span>
          </div>
        </div>
      </div>
    </Scene>
  );
}

/* 13 — the owner’s cockpit */
function CockpitScene() {
  return (
    <Scene accent="#8a4a0b">
      <div className={styles.cockpit}>
        <div className={styles.statGrid}>
          <div className={styles.statCard}>
            <span className={styles.statLabel}>Revenue collected</span>
            <strong className={styles.statValue}>₹66,540</strong>
            <Spark values={[12, 18, 14, 26, 22, 34, 30, 44, 38, 52, 48, 62]} />
          </div>
          <div className={styles.statCard}>
            <span className={styles.statLabel}>Orders completed</span>
            <strong className={styles.statValue}>49</strong>
            <Spark values={[6, 9, 7, 12, 10, 15, 12, 18, 16, 22, 19, 24]} />
          </div>
          <div className={styles.statCard}>
            <span className={styles.statLabel}>Active tables</span>
            <strong className={styles.statValue}>3</strong>
            <Spark values={[2, 3, 2, 4, 3, 5, 4, 3, 4, 3, 4, 3]} />
          </div>
        </div>

        <div className={[styles.panel, styles.bestCard].join(" ")}>
          <header className={styles.panelHead}>
            <span className={styles.panelEyebrow}>24-hour pulse</span>
            <strong className={styles.panelTitle}>Best sellers</strong>
          </header>
          {[
            ["Masala Dosa", "32", "₹5,760"],
            ["Paneer Butter Masala", "21", "₹6,720"],
            ["Hyderabadi Biryani", "18", "₹6,840"],
            ["Veg Noodles", "14", "₹3,360"],
          ].map(([name, units, revenue]) => (
            <div key={name} className={styles.bestRow}>
              <span>{name}</span>
              <span>{units} sold</span>
              <strong>{revenue}</strong>
            </div>
          ))}
        </div>
      </div>
    </Scene>
  );
}

/* 14 — admin tables: QR, session and the seated roster */
function TablesScene() {
  const tables = [
    {
      name: "Window four-top",
      code: "k7x2p",
      people: ["Aarav", "Meera", "Ravi"],
      since: "Session since 7:42 PM",
    },
    {
      name: "Corner booth",
      code: "m3q8z",
      people: ["Nisha", "Kabir"],
      since: "Session since 8:05 PM",
    },
  ];

  return (
    <Scene accent="#7c563b">
      <div className={styles.adminTables}>
        {tables.map((table) => (
          <div key={table.code} className={[styles.panel, styles.adminTableCard].join(" ")}>
            <div className={styles.adminTableTop}>
              <strong>{table.name}</strong>
              <span className={styles.pillReady}>active</span>
            </div>
            <div className={styles.codeStrip}>
              <span>{table.code}</span>
              <span>QR</span>
            </div>
            <span className={styles.sittingLabel}>
              Sitting · {table.people.length}
            </span>
            <div className={styles.sittingChips}>
              {table.people.map((person) => (
                <span key={person}>{person}</span>
              ))}
            </div>
            <span className={styles.adminMeta}>{table.since}</span>
            <div className={styles.adminActions}>
              <span>Edit name</span>
              <span>Edit ID</span>
              <span>Regenerate</span>
            </div>
          </div>
        ))}
      </div>
    </Scene>
  );
}

/* ------------------------------------------------------------------ */
/* WOW act — the three Live surfaces + the waiter handoff               */
/* ------------------------------------------------------------------ */

/* WOW 01 — the guest talks to the table */
function GuestVoiceScene() {
  return (
    <Scene accent="#9e3e14">
      <div className={styles.voicePair}>
        <Phone>
          <AppTop eyebrow="Chhotu · live" title="What can I get you?" meta="voice + text" />
          <span className={styles.wakePill}>
            <span className={styles.micBars} aria-hidden>
              <i />
              <i />
              <i />
            </span>
            Listening
          </span>
          <div className={styles.transcript}>
            <span className={styles.bubbleUser}>
              “do creamy, not too spicy — and I’m allergic to peanuts”
            </span>
            <span className={styles.bubbleAi}>
              Paneer Butter Masala then. Added one — peanut allergy printed on the ticket.
            </span>
          </div>
          <span className={styles.allergyNote}>
            <strong>Peanut allergy</strong>
            <span>Carried to the kitchen ticket, not just the chat.</span>
          </span>
          <span className={styles.appNote}>Interrupt it. Correct it. Type instead. Same session.</span>
        </Phone>

        <div className={styles.voicePanel}>
          <header className={styles.panelHead}>
            <span className={styles.panelEyebrow}>Table cart · changed by voice</span>
            <strong className={styles.panelTitle}>Paneer Butter Masala</strong>
            <span className={styles.panelMeta}>×1 · Aarav · ₹320</span>
          </header>
          <div className={styles.metricRow}>
            <span>Understood</span>
            <strong>“creamy, not too spicy”</strong>
          </div>
          <div className={styles.metricRow}>
            <span>Corrected</span>
            <strong>“actually make that two”</strong>
          </div>
          <div className={styles.metricRow}>
            <span>Allergy</span>
            <strong>flagged, never “safe”</strong>
          </div>
          <span className={styles.emberButton}>Fires as one table ticket</span>
        </div>
      </div>
    </Scene>
  );
}

/* WOW 02 — the kitchen is voice-first: one tap opens the mic, then talk */
function KitchenVoiceScene() {
  return (
    <Scene accent="#a31b10">
      <div className={styles.voicePair}>
        <div className={styles.voicePanel}>
          <span className={styles.wakePill}>
            <span className={styles.micBars} aria-hidden>
              <i />
              <i />
              <i />
            </span>
            Mic open · tap once, then talk
          </span>
          <div className={styles.transcript}>
            <span className={styles.bubbleUser}>“table four ready, aur T09 serve kar do”</span>
            <span className={styles.bubbleAi}>T04 ready. T09 served.</span>
            <span className={styles.bubbleUser}>“paneer tikka 86 karo”</span>
            <span className={styles.bubbleAi}>Confirm karo — paneer tikka 86?</span>
          </div>
          <span className={styles.refusedChip}>Spoken yes · nothing changes on “nahi”</span>
          <span className={styles.appNote}>
            Two jobs in one breath. The destructive one still waits for a yes.
          </span>
        </div>

        <span className={styles.flowArrow} aria-hidden>
          →
        </span>

        <div className={styles.ticket}>
          <header className={styles.ticketHead}>
            <strong>T04</strong>
            <span>Table k7x2p</span>
          </header>
          <div className={styles.ticketItem}>
            <span>Masala Dosa</span>
            <span>×2</span>
          </div>
          <div className={styles.ticketItem}>
            <span>Filter Coffee</span>
            <span>×2</span>
          </div>
          <div className={styles.kdsAllergy}>PEANUT ALLERGY</div>
          <footer className={styles.ticketFoot}>
            <span className={styles.pillReady}>Ready</span>
            <span>voice · tap once</span>
          </footer>
        </div>
      </div>
    </Scene>
  );
}

/* WOW 03 — the owner asks the restaurant */
function ConsoleVoiceScene() {
  return (
    <Scene accent="#8a4a0b">
      <div className={styles.voicePair}>
        <div className={styles.voicePanel}>
          <span className={styles.wakePill}>Manager console · read only</span>
          <div className={styles.transcript}>
            <span className={styles.bubbleUser}>“aaj kitna hua? aur top dish?”</span>
            <span className={styles.bubbleAi}>
              ₹1,01,780 from 58 orders. Masala Dosa led with 48 — two tables are free.
            </span>
            <span className={styles.bubbleUser}>“paneer mein kya hai?”</span>
            <span className={styles.bubbleAi}>
              Paneer, tomato, cashew, butter, cream. Allergens: dairy, tree nuts.
            </span>
          </div>
          <span className={styles.appNote}>
            8 tools. Not one of them can clear a table or change a price.
          </span>
        </div>

        <div className={styles.voicePanel}>
          <header className={styles.panelHead}>
            <span className={styles.panelEyebrow}>Today · since 5 am</span>
            <strong className={styles.panelTitle}>₹1,01,780</strong>
            <span className={styles.panelMeta}>58 orders served</span>
          </header>
          <div className={styles.metricRow}>
            <span>Top dish</span>
            <strong>Masala Dosa · 48</strong>
          </div>
          <div className={styles.metricRow}>
            <span>Free tables</span>
            <strong>2 of 5</strong>
          </div>
          <div className={styles.metricRow}>
            <span>Low stock</span>
            <strong>untracked — and it says so</strong>
          </div>
          <div className={styles.metricRow}>
            <span>Model power</span>
            <strong>read only by design</strong>
          </div>
        </div>
      </div>
    </Scene>
  );
}

/* WOW 04 — the floor tells the kitchen someone is walking over */
function WaiterPingScene() {
  return (
    <Scene accent="#2c6631">
      <div className={styles.voicePair}>
        <div className={styles.panel}>
          <header className={styles.panelHead}>
            <span className={styles.panelEyebrow}>Floor · Window four-top</span>
            <strong className={styles.panelTitle}>Ready at the pass</strong>
            <span className={styles.panelMeta}>Masala Dosa ×2 · Filter Coffee ×2</span>
          </header>
          <div className={styles.statusCard} data-tone="ready">
            <strong>Ready</strong>
            <span>Nobody has picked it up yet.</span>
          </div>
          <span className={styles.emberButton}>I’ll serve this</span>
          <span className={styles.appNote}>One tap. No call across the room.</span>
        </div>

        <span className={styles.flowArrow} aria-hidden>
          →
        </span>

        <div className={styles.panel}>
          <header className={styles.panelHead}>
            <span className={styles.panelEyebrow}>Kitchen display</span>
            <strong className={styles.panelTitle}>Live service</strong>
          </header>
          <div className={styles.waiterStrip}>
            <i aria-hidden />
            Waiter coming · T04
          </div>
          <div className={styles.kdsTicket}>
            <div className={styles.kdsTicketTop}>
              <strong>Table T04</strong>
              <span>Ready 1m</span>
            </div>
            <span className={styles.kdsItem}>Masala Dosa ×2</span>
            <span className={styles.kdsItem}>Filter Coffee ×2</span>
          </div>
          <span className={styles.appNote}>
            The pass stops double-running it; serving clears the flag.
          </span>
        </div>
      </div>
    </Scene>
  );
}

/* 15 — try it live */
function LiveScene({ qrMarkup }: { qrMarkup: string | null }) {
  return (
    <Scene accent="#9e3e14">
      <div className={styles.livePair}>
        <div className={styles.qrCard}>
          {qrMarkup ? (
            <div
              className={styles.qrSvg}
              // Generated locally by the `qrcode` package from our own origin.
              dangerouslySetInnerHTML={{ __html: qrMarkup }}
            />
          ) : (
            <MiniQr className={styles.qrCells} />
          )}
          <span className={styles.qrTable}>AEYCHHOTU</span>
          <span className={styles.qrHint}>Scan to open the home page</span>
        </div>

        <div className={styles.liveCopy}>
          <strong className={styles.liveTitle}>AeyChhotu!</strong>
          <span className={styles.liveSub}>
            One table. One cart. One live kitchen — from the first scan to the settled bill.
          </span>
          <div className={styles.launchButtons}>
            <Link href={HOME_PATH} className={styles.launchPrimary}>
              Open home page
            </Link>
            <Link href="/kitchen" className={styles.launchSecondary}>
              Open kitchen
            </Link>
            <Link href="/floor" className={styles.launchGhost}>
              Open floor
            </Link>
            <Link href="/admin" className={styles.launchGhost}>
              Open manager console
            </Link>
          </div>
        </div>
      </div>
    </Scene>
  );
}

/* ------------------------------------------------------------------ */
/* Slide definitions                                                   */
/* ------------------------------------------------------------------ */

function slides(qrMarkup: string | null): Slide[] {
  return [
    {
      title: "Four phones. Four bills. One table.",
      subtitle: "The food is shared. The receipts are not.",
      accent: "#9e3e14",
      scene: <ChaosScene />,
    },
    {
      title: "Tap the table. You’re in.",
      subtitle: "No download, no sign-up — a name is all the table asks.",
      accent: "#c9a87c",
      scene: <ScanScene />,
    },
    {
      title: "Two keys. One table.",
      subtitle: "A 2-digit PIN for the table, a private pass for each phone. Three misses and it locks.",
      accent: "#7c563b",
      scene: <SecurityScene />,
    },
    {
      title: "The menu answers to you.",
      subtitle: "Search it, filter by diet, add in one tap.",
      accent: "#8a4a0b",
      scene: <MenuScene />,
    },
    {
      title: "Refresh. You’re still at the table.",
      subtitle: "The pass reconnects silently, and every diner stays on the list.",
      accent: "#7c563b",
      scene: <ResumeScene />,
    },
    {
      title: "One table. One cart.",
      subtitle: "Everyone adds from their own phone. The basket merges live.",
      accent: "#8a4a0b",
      scene: <BasketScene />,
    },
    {
      title: "An allergy is an alarm.",
      subtitle: "It prints on the kitchen ticket, every single time.",
      accent: "#a31b10",
      scene: <AllergyScene />,
    },
    {
      title: "Fire once. Lose nothing.",
      subtitle: "A round lands as one ticket — or not at all.",
      accent: "#8a4a0b",
      scene: <FireScene />,
    },
    {
      title: "Watch it cook, not the waiter.",
      subtitle: "Sent, cooking, ready — the kitchen moves your screen.",
      accent: "#2c6631",
      scene: <TrackerScene />,
    },
    {
      title: "Dessert is just another round.",
      subtitle: "A fresh ticket on the same table, without a new session.",
      accent: "#c9a87c",
      scene: <RoundScene />,
    },
    {
      title: "Split the bill, not the friendship.",
      subtitle: "Every dish carries a name, so everyone pays their part.",
      accent: "#8a4a0b",
      scene: <BillScene />,
    },
    {
      title: "The line, without the shouting.",
      subtitle: "Three lanes, live timers, allergies in red.",
      accent: "#9e3e14",
      scene: <KitchenScene />,
    },
    {
      title: "The whole floor, one screen.",
      subtitle: "Who’s seated, who’s waiting, who’s paid.",
      accent: "#7c563b",
      scene: <FloorScene />,
    },
    {
      title: "Sold out in one tap.",
      subtitle: "86 a dish and it leaves every phone before the next order.",
      accent: "#a31b10",
      scene: <ControlScene />,
    },
    {
      title: "The menu, edited live.",
      subtitle: "Price, photo, category — one save updates every table.",
      accent: "#8a4a0b",
      scene: <MenuAdminScene />,
    },
    {
      title: "The table clears itself.",
      subtitle: "Paid, served, disconnected — the session releases on its own.",
      accent: "#7c563b",
      scene: <ReleaseScene />,
    },
    {
      title: "Your night, in one glance.",
      subtitle: "Revenue, orders and tables on a rolling 24-hour pulse.",
      accent: "#8a4a0b",
      scene: <CockpitScene />,
    },
    {
      title: "Every table. Every guest.",
      subtitle: "The QR, the session, and exactly who is sitting there.",
      accent: "#7c563b",
      scene: <TablesScene />,
    },
    {
      kicker: "WOW 01 · THE GUEST",
      title: "You can just talk to the table.",
      subtitle:
        "Hinglish, corrections, allergies — the cart changes while you speak, and the ticket follows.",
      accent: "#9e3e14",
      scene: <GuestVoiceScene />,
    },
    {
      kicker: "WOW 02 · THE KITCHEN",
      title: "The chef never touches the screen.",
      subtitle:
        "One tap opens the mic. Two jobs in one breath, and nothing destructive without a spoken yes.",
      accent: "#a31b10",
      scene: <KitchenVoiceScene />,
    },
    {
      kicker: "WOW 03 · THE OWNER",
      title: "Ask the restaurant how it’s doing.",
      subtitle:
        "Revenue, best sellers, free tables, and what is inside a dish — answered out loud from real data.",
      accent: "#8a4a0b",
      scene: <ConsoleVoiceScene />,
    },
    {
      kicker: "WOW 04 · THE HANDOFF",
      title: "The plate knows someone is coming.",
      subtitle:
        "A waiter’s tap appears at the pass before the food goes cold — and clears itself when it is served.",
      accent: "#2c6631",
      scene: <WaiterPingScene />,
    },
    {
      title: "Now open a table.",
      subtitle: "Scan the code, or walk through every screen yourself.",
      accent: "#9e3e14",
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
        ? HOME_PATH
        : `${window.location.origin}${HOME_PATH}`;

    void QRCode.toString(target, {
      type: "svg",
      margin: 1,
      width: 280,
      errorCorrectionLevel: "M",
      color: { dark: "#1c1512", light: "#fbf8f4" },
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
                : {
                    x: glowX,
                    y: glowY,
                    z: -150,
                    background: `radial-gradient(circle at 50% 50%, ${active.accent}2e, transparent 62%)`,
                  }
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
                {active.kicker ? <span className={styles.kicker}>{active.kicker}</span> : null}
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
