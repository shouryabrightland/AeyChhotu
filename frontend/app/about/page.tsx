import {
  ArrowRight,
  BellRing,
  HeartHandshake,
  QrCode,
  ShieldAlert,
  ShoppingBasket,
  Smartphone,
  Timer,
  type LucideIcon,
} from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { LogoWatermark } from "@/components/brand/logo";
import { SiteFooter } from "@/components/layout/site-footer";
import { SiteHeader } from "@/components/layout/site-header";
import { ExpandableCard } from "@/components/marketing/expandable-card";
import { FlipCard } from "@/components/marketing/flip-card";
import { HeroVisual } from "@/components/marketing/hero-visual";
import { WorkflowTimeline } from "@/components/marketing/workflow-timeline";
import { Reveal } from "@/components/motion/reveal";
import { Badge } from "@/components/ui/badge";
import { buttonStyles } from "@/components/ui/button";
import { Container } from "@/components/ui/container";
import { Section } from "@/components/ui/section";
import { SectionHeader } from "@/components/ui/section-header";
import { Text } from "@/components/ui/text";

export const metadata: Metadata = {
  title: "Our story",
  description:
    "AeyChhotu is the QR table ordering experience built for real Indian restaurants: one shared cart, medical allergy safety, and a live kitchen tracker — with nothing to download.",
};

/* The customer story.
 *
 * Deliberately written for the person holding the phone at the table, not for
 * an operator. There is no kitchen board link, no floor view, no admin console
 * and no architecture diagram here: those are staff rooms, and a diner has no
 * business being sent into them. The product claims are the four a guest
 * actually feels — no download, one shared cart, allergy safety, live status. */

const friction = [
  {
    title: "Eight people, eight tickets",
    friction:
      "When everyone at a table orders on their own phone, the kitchen receives eight unrelated orders instead of one table's meal.",
    complaint: "Starters arrive after the mains, and nobody knows whose food is whose.",
  },
  {
    title: "“How long?” every five minutes",
    friction:
      "A QR menu that only says pending or not pending leaves the table guessing, so somebody gets up to find a server.",
    complaint: "The wait feels longer than it is, and the floor gets interrupted for answers.",
  },
  {
    title: "Allergies buried in a note box",
    friction:
      "A medical restriction typed into a small free-text field looks exactly like “extra spicy” on a kitchen ticket.",
    complaint: "A serious allergy can be missed at the busiest moment of service.",
  },
];

const steps = [
  {
    title: "Scan the stand on your table",
    body: "Your camera reads the table's QR code and the menu opens in the browser. Nothing to install, no account, no password.",
  },
  {
    title: "The table joins with a PIN",
    body: "The first phone claims the table and gets a two-digit PIN. Everyone else types it once — or scans the Table Pass from a tablemate's screen.",
  },
  {
    title: "Build one shared cart",
    body: "Every dish lands in the same cart, labelled with who added it. Your friends see it appear on their phones as you tap.",
  },
  {
    title: "Review, then fire once",
    body: "One button sends the whole table's order to the kitchen as a single ticket, after checking that every dish is still available.",
  },
  {
    title: "Watch it cook, live",
    body: "Your tracker moves from Pending to Preparing to Ready, and the screen flashes green the moment your food leaves the pass.",
  },
];

interface Promise {
  icon: LucideIcon;
  title: string;
  teaser: string;
  body: string;
}

const promises: Promise[] = [
  {
    icon: Smartphone,
    title: "Zero downloads",
    teaser: "It is just the web page.",
    body: "No app store, no install, no sign-up. The QR opens a normal web page that happens to behave like an app — and you can add it to your home screen if you want it there.",
  },
  {
    icon: ShoppingBasket,
    title: "One shared cart",
    teaser: "The whole table, not eight tickets.",
    body: "Everybody adds to the same live cart on their own phone. You can see who added what, so splitting the bill later is a glance rather than an argument.",
  },
  {
    icon: ShieldAlert,
    title: "Allergies, not footnotes",
    teaser: "A medical note is not a preference.",
    body: "A dedicated allergy field turns your restriction into a bold red banner on the kitchen ticket. It cannot be lost between “less spicy” and “no onion”.",
  },
  {
    icon: Timer,
    title: "Live kitchen tracker",
    teaser: "No more “how long?”.",
    body: "The screen follows your ticket as the line cooks it. You know when it is queued, when it is on the fire, and when it is ready to be walked to your table.",
  },
  {
    icon: BellRing,
    title: "A green flash when it lands",
    teaser: "You will not miss it.",
    body: "The tracker fills the screen in green when the kitchen marks your food ready, so the table notices without anyone refreshing a page.",
  },
  {
    icon: HeartHandshake,
    title: "A gentler rush",
    teaser: "For the room, not just the phone.",
    body: "Grouped orders mean fewer trips to the pass, calmer servers, and a kitchen that can cook a table's meal in the order it was meant to arrive.",
  },
];

const trackerStages = ["Pending", "Preparing", "Ready", "Served"];

export default function AboutPage() {
  return (
    <div className="flex min-h-dvh flex-col">
      <SiteHeader />

      <main id="main" className="flex-1">
        {/* ============================ HERO ============================ */}
        <section className="relative isolate overflow-hidden border-b border-line bg-canvas">
          <div
            aria-hidden
            className="hairline-grid pointer-events-none absolute inset-0 opacity-60 [mask-image:radial-gradient(ellipse_60%_50%_at_50%_0%,black,transparent)]"
          />
          <div
            aria-hidden
            className="pointer-events-none absolute -bottom-48 -left-40 size-[44rem] rounded-pill bg-tan/25 blur-3xl"
          />

          <Container className="relative py-20 lg:pt-24 lg:pb-0">
            <div className="grid items-center gap-14 lg:grid-cols-[minmax(0,0.9fr)_minmax(0,1fr)] lg:items-end lg:gap-20">
              <div className="lg:order-2 lg:self-center">
                <Reveal>
                  <Badge tone="accent" size="md">
                    No download · no account · live updates
                  </Badge>
                </Reveal>

                <Reveal delay={0.06}>
                  <h1 className="mt-7 text-display font-display font-semibold text-balance text-ink">
                    Your table.
                    <br className="hidden sm:block" />{" "}
                    <span className="text-ember">One order</span> for the kitchen.
                  </h1>
                </Reveal>

                <Reveal delay={0.12}>
                  <Text variant="lead" tone="muted" className="mt-6 max-w-xl">
                    AeyChhotu is what should happen after you sit down: scan the QR on the table,
                    order together in one shared cart, flag a real allergy without it getting lost,
                    and watch the kitchen cook your food in real time.
                  </Text>
                </Reveal>

                <Reveal delay={0.18}>
                  <div className="mt-9 flex flex-wrap items-center gap-3">
                    <Link href="/" className={buttonStyles({ variant: "ember", size: "lg" })}>
                      <QrCode className="size-5" aria-hidden />
                      Scan your table
                    </Link>
                    <a
                      href="#how-it-works"
                      className="group inline-flex items-center gap-2 text-sm font-semibold text-ember transition-colors duration-[var(--duration-fast)] hover:text-ember-strong"
                    >
                      See how it works
                      <ArrowRight
                        aria-hidden
                        className="size-4 transition-transform duration-[var(--duration-base)] ease-organic group-hover:translate-x-1"
                      />
                    </a>
                  </div>
                </Reveal>
              </div>

              <Reveal delay={0.16} className="order-first lg:order-1">
                <HeroVisual />
              </Reveal>
            </div>
          </Container>
        </section>

        {/* ============================ WHY ============================= */}
        <Section id="why" spacing="lg" tone="surface" className="scroll-mt-20">
          <Container>
            <SectionHeader
              align="center"
              size="heading"
              title="What usually goes wrong at a table?"
            />

            <div className="mt-14 grid gap-5 md:grid-cols-3">
              {friction.map((item, index) => (
                <Reveal key={item.title} delay={index * 0.08}>
                  <ExpandableCard
                    meta={String(index + 1).padStart(2, "0")}
                    title={item.title}
                    teaser="Tap to see what breaks in a rush"
                  >
                    <p className="text-sm leading-relaxed text-ink-muted">{item.friction}</p>
                    <p className="mt-4 border-t border-line pt-4 text-sm leading-relaxed font-medium text-alert">
                      {item.complaint}
                    </p>
                  </ExpandableCard>
                </Reveal>
              ))}
            </div>
          </Container>
        </Section>

        {/* ======================== HOW IT WORKS ======================== */}
        <Section id="how-it-works" spacing="lg" className="scroll-mt-20">
          <Container>
            <SectionHeader align="center" size="heading" title="Five taps, start to finish" />
            <div className="mt-14">
              <Reveal>
                <WorkflowTimeline steps={steps} />
              </Reveal>
            </div>
          </Container>
        </Section>

        {/* =========================== SAFETY =========================== */}
        <Section id="safety" spacing="lg" tone="surface" className="scroll-mt-20">
          <Container>
            <div className="grid items-center gap-12 lg:grid-cols-[minmax(0,1fr)_minmax(0,0.9fr)] lg:gap-16">
              <Reveal>
                <SectionHeader
                  eyebrow="Food safety"
                  size="heading"
                  title="An allergy is not a preference."
                  description="Most ordering apps give you one small box for “special requests”, where a peanut allergy sits next to a request for extra sauce. We separated them on purpose."
                />

                <ul className="mt-8 flex flex-col gap-4">
                  {[
                    "A dedicated allergy field, separate from ordinary requests.",
                    "The kitchen ticket prints it as a bold red banner, not grey body text.",
                    "The warning travels with the ticket through cooking, not just at intake.",
                  ].map((line) => (
                    <li key={line} className="flex items-start gap-3">
                      <span
                        aria-hidden
                        className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-pill bg-alert-surface text-alert"
                      >
                        <ShieldAlert className="size-3.5" />
                      </span>
                      <span className="text-sm leading-relaxed text-ink-muted">{line}</span>
                    </li>
                  ))}
                </ul>
              </Reveal>

              <Reveal delay={0.1}>
                {/* A real kitchen pass, rendered from the same tokens as the
                    product, so the claim above is visible rather than implied. */}
                <div className="rounded-xl border border-line-strong bg-paper p-5 shadow-lg sm:p-6">
                  <div className="flex items-center justify-between gap-3 border-b border-line pb-3">
                    <span className="font-display text-base font-semibold text-ink">
                      Table 07 · Order
                    </span>
                    <span className="rounded-pill bg-preparing-surface px-2.5 py-1 text-[0.6875rem] font-semibold tracking-wide text-preparing uppercase">
                      Preparing
                    </span>
                  </div>

                  <ul className="mt-4 flex flex-col gap-3">
                    <li className="flex items-baseline gap-2 text-sm text-ink">
                      <span className="font-display font-semibold tabular-nums">1×</span>
                      Paneer Butter Masala
                    </li>
                    <li className="flex items-baseline gap-2 text-sm text-ink">
                      <span className="font-display font-semibold tabular-nums">2×</span>
                      Butter Naan
                    </li>
                  </ul>

                  <p className="mt-4 flex items-start gap-2 rounded-md border-2 border-alert/50 bg-alert-surface px-3 py-2 text-xs font-bold tracking-wide text-alert uppercase">
                    <ShieldAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
                    <span>Allergy · No peanuts — severe</span>
                  </p>
                </div>
              </Reveal>
            </div>
          </Container>
        </Section>

        {/* ========================= YOUR TABLE ========================= */}
        <Section id="your-table" spacing="lg" className="scroll-mt-20">
          <Container>
            <SectionHeader
              align="center"
              size="heading"
              title="What you actually get at the table"
              description="Six things, all of them one tap away from the QR stand."
            />

            <div className="mt-14 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {promises.map((promise, index) => (
                <Reveal key={promise.title} delay={(index % 3) * 0.06}>
                  <FlipCard
                    icon={<promise.icon className="size-5" aria-hidden />}
                    title={promise.title}
                    teaser={promise.teaser}
                  >
                    <p className="text-sm leading-relaxed">{promise.body}</p>
                  </FlipCard>
                </Reveal>
              ))}
            </div>

            {/* The tracker, shown as the four milestones the diner sees. */}
            <Reveal delay={0.08}>
              <div className="mt-14 rounded-xl border border-line bg-surface p-6 sm:p-8">
                <p className="text-label text-ink-subtle uppercase">Your live order</p>
                <ol className="mt-6 grid gap-4 sm:grid-cols-4">
                  {trackerStages.map((stage, index) => (
                    <li key={stage} className="flex items-center gap-3 sm:flex-col sm:items-start">
                      <span
                        aria-hidden
                        className={`flex size-8 shrink-0 items-center justify-center rounded-pill text-xs font-bold ${
                          index < 2
                            ? "bg-ember text-on-ember"
                            : "border border-line-strong bg-surface text-ink-subtle"
                        }`}
                      >
                        {index < 2 ? "✓" : index + 1}
                      </span>
                      <span
                        className={`text-sm font-semibold ${
                          index < 2 ? "text-ink" : "text-ink-subtle"
                        }`}
                      >
                        {stage}
                      </span>
                    </li>
                  ))}
                </ol>
                <p className="mt-6 text-sm leading-relaxed text-ink-muted">
                  Pending while it waits for the line, Preparing while it cooks, Ready the moment it
                  leaves the pass, Served once it reaches your table.
                </p>
              </div>
            </Reveal>
          </Container>
        </Section>

        {/* ============================ CLOSE =========================== */}
        <Section spacing="lg" className="scroll-mt-20">
          <Container className="relative">
            <Reveal>
              <div className="relative isolate overflow-hidden rounded-2xl border border-on-ember/15 bg-gradient-to-br from-ember-strong to-ember-dusk px-7 py-14 text-on-ember sm:px-12 sm:py-16">
                <span
                  aria-hidden
                  className="pointer-events-none absolute inset-0 opacity-15 [background-image:linear-gradient(to_right,currentColor_1px,transparent_1px),linear-gradient(to_bottom,currentColor_1px,transparent_1px)] [background-size:3rem_3rem]"
                />
                <span
                  aria-hidden
                  className="pointer-events-none absolute -top-24 -right-16 size-80 rounded-pill bg-on-ember/10 blur-3xl"
                />
                <LogoWatermark className="absolute -right-10 -bottom-14 h-64 w-auto opacity-10" />

                <div className="relative max-w-2xl">
                  <h2 className="text-title font-display font-semibold text-balance">
                    Sitting down already?
                  </h2>
                  <p className="mt-4 text-lead text-on-ember/85">
                    Scan the QR on your table, or type the five-character code printed under it.
                    Your table&apos;s menu opens in this browser — nothing to install.
                  </p>
                </div>

                <div className="relative mt-10 flex flex-wrap gap-3">
                  <Link
                    href="/"
                    className="inline-flex h-12 items-center gap-2 rounded-lg bg-on-ember px-6 text-sm font-semibold text-ember-strong transition-transform duration-[var(--duration-fast)] hover:-translate-y-0.5"
                  >
                    <QrCode className="size-4" aria-hidden />
                    Open the table scanner
                  </Link>
                  <Link
                    href="/presentation"
                    className="inline-flex h-12 items-center gap-2 rounded-lg border border-on-ember/30 bg-on-ember/10 px-6 text-sm font-semibold text-on-ember transition-transform duration-[var(--duration-fast)] hover:-translate-y-0.5"
                  >
                    See the hackathon showcase
                  </Link>
                </div>
              </div>
            </Reveal>
          </Container>
        </Section>
      </main>

      <SiteFooter />
    </div>
  );
}
