import Link from "next/link";
import { Logo, LogoWatermark } from "@/components/brand/logo";
import { Container } from "@/components/ui/container";
import { customerLinks, marketingNav } from "@/lib/site";

/* The footer used to be a flat charcoal block with grey links — the one place
   on the page with no colour at all. It is now the floor of the page's closing
   ramp: it opens on the exact tone the call-to-action above it fades down to
   (ember-dusk) and sinks to ember-night, so the seam between the two bands is
   invisible instead of a hard orange edge. Nothing hardcodes a hex: every stop
   and text tone comes from the token set, and white clears 16.7:1 at the
   darkest end. */
export function SiteFooter() {
  const pills = ["Zero download", "No login", "No hardware"];

  return (
    <footer className="relative isolate overflow-hidden bg-ember-dusk text-on-ember">
      <div
        aria-hidden
        className="absolute inset-0 bg-gradient-to-b from-ember-dusk via-ember-dusk to-ember-night"
      />
      <div
        aria-hidden
        className="pointer-events-none absolute -top-32 left-1/3 size-[28rem] rounded-pill bg-on-ember/8 blur-3xl"
      />
      <LogoWatermark className="absolute -top-16 right-[6%] h-56 w-auto opacity-10" />

      <Container className="relative pt-16 pb-10">
        <div className="grid gap-12 lg:grid-cols-[1.5fr_1fr_1fr]">
          <div className="flex flex-col gap-5">
            <Logo tone="inverse" />
            <p className="max-w-sm text-sm leading-relaxed text-on-ember/85">
              Scan the QR on your table, order together in one shared cart, and watch the kitchen
              cook it — live, with no app to download and no account to create.
            </p>
            <div className="flex flex-wrap gap-2">
              {pills.map((pill) => (
                <span
                  key={pill}
                  className="rounded-pill border border-on-ember/25 bg-on-ember/10 px-3 py-1 text-xs font-semibold text-on-ember"
                >
                  {pill}
                </span>
              ))}
            </div>
          </div>

          <nav aria-label="Sections" className="flex flex-col gap-3">
            <p className="text-label text-on-ember/80 uppercase">Sections</p>
            {marketingNav.map((link) => (
              <a
                key={link.href}
                href={link.href}
                className="group inline-flex w-fit items-center gap-2 text-sm text-on-ember/85 transition-colors duration-[var(--duration-fast)] hover:text-on-ember"
              >
                {/* A rule that grows out of the label on hover. */}
                <span
                  aria-hidden
                  className="h-px w-0 bg-on-ember transition-[width] duration-[var(--duration-fast)] group-hover:w-3"
                />
                {link.label}
              </a>
            ))}
          </nav>

          <nav aria-label="More" className="flex flex-col gap-3">
            <p className="text-label text-on-ember/80 uppercase">More</p>
            {customerLinks.map((link) => (
              <Link
                key={link.href}
                href={link.href}
                className="group inline-flex w-fit items-center gap-2 text-sm text-on-ember/85 transition-colors duration-[var(--duration-fast)] hover:text-on-ember"
              >
                <span
                  aria-hidden
                  className="h-px w-0 bg-on-ember transition-[width] duration-[var(--duration-fast)] group-hover:w-3"
                />
                {link.label}
              </Link>
            ))}
          </nav>
        </div>

        <div className="mt-14 flex flex-col items-start justify-between gap-3 border-t border-on-ember/25 pt-6 sm:flex-row sm:items-center">
          <p className="text-xs text-on-ember/80">
            AeyChhotu! · one table, one order, live from the kitchen.
          </p>
          <p className="text-xs text-on-ember/80">Built with Next.js, Express and Postgres.</p>
        </div>
      </Container>
    </footer>
  );
}
