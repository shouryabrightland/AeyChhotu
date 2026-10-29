"use client";

import { Menu, QrCode, Sparkles } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";
import { Logo } from "@/components/brand/logo";
import { buttonStyles } from "@/components/ui/button";
import { Container } from "@/components/ui/container";
import { Drawer } from "@/components/ui/drawer";
import { IconButton } from "@/components/ui/icon-button";
import { Tooltip } from "@/components/ui/tooltip";
import { customerLinks, marketingNav } from "@/lib/site";
import { cn } from "@/lib/utils";

export function SiteHeader() {
  const [scrolled, setScrolled] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);

  /* Same body-scroller gotcha as the table session's nav band: globals.css
     locks html/body to 100dvh with `overflow-x: hidden`, so <body> is what
     scrolls and `window.scrollY` never leaves 0 — a window-only listener
     leaves this band permanently see-through with the page running behind
     the logo. Capture on document, because scroll events do not bubble. */
  useEffect(() => {
    const onScroll = () => setScrolled((window.scrollY || document.body.scrollTop || 0) > 16);
    onScroll();

    document.addEventListener("scroll", onScroll, { capture: true, passive: true });
    window.addEventListener("scroll", onScroll, { passive: true });

    return () => {
      document.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("scroll", onScroll);
    };
  }, []);

  return (
    <header
      className={cn(
        "sticky top-0 z-40 w-full transition-colors duration-[var(--duration-base)] ease-gentle",
        scrolled
          ? "border-b border-line bg-canvas/85 backdrop-blur-md"
          : "border-b border-transparent",
      )}
    >
      <Container className="flex h-18 items-center justify-between gap-6">
        <Link href="/" aria-label="AeyChhotu — home" className="shrink-0">
          <Logo />
        </Link>

        <nav aria-label="Sections" className="hidden items-center gap-7 lg:flex">
          {marketingNav.map((link) => (
            <a
              key={link.href}
              href={link.href}
              className="text-sm font-medium text-ink-muted transition-colors duration-[var(--duration-fast)] hover:text-ember"
            >
              {link.label}
            </a>
          ))}
        </nav>

        {/* Desktop-only actions, icon-only on purpose: the labels lived here
            as words and crowded the bar, so each action is now its glyph with
            the name carried by the tooltip and the accessible label. */}
        <div className="hidden items-center gap-2 lg:flex">
          <Tooltip label="Hackathon showcase" side="bottom">
            <Link
              href="/presentation"
              aria-label="Hackathon showcase"
              className={cn(buttonStyles({ variant: "ghost", size: "sm" }), "aspect-square px-0")}
            >
              <Sparkles className="size-4" aria-hidden />
            </Link>
          </Tooltip>
          <Tooltip label="Scan a table" side="bottom">
            <Link
              href="/"
              aria-label="Scan a table"
              className={cn(buttonStyles({ variant: "ember", size: "sm" }), "aspect-square px-0")}
            >
              <QrCode className="size-4" aria-hidden />
            </Link>
          </Tooltip>
        </div>

        <IconButton
          label="Open navigation"
          tone="outline"
          className="lg:hidden"
          onClick={() => setMenuOpen(true)}
        >
          <Menu className="size-5" aria-hidden />
        </IconButton>
      </Container>

      <Drawer
        open={menuOpen}
        onClose={() => setMenuOpen(false)}
        title="AeyChhotu"
        description="Real-time table and kitchen operations."
      >
        <nav aria-label="Mobile" className="flex flex-col gap-8">
          <ul className="flex flex-col gap-1">
            {marketingNav.map((link) => (
              <li key={link.href}>
                <a
                  href={link.href}
                  onClick={() => setMenuOpen(false)}
                  className="block rounded-md px-3 py-3 text-base font-medium text-ink transition-colors duration-[var(--duration-fast)] hover:bg-sand"
                >
                  {link.label}
                </a>
              </li>
            ))}
          </ul>

          <div className="flex flex-col gap-3 border-t border-line pt-6">
            <p className="text-label text-ember uppercase">More</p>
            {customerLinks.map((link) => (
              <Link
                key={link.href}
                href={link.href}
                onClick={() => setMenuOpen(false)}
                className={buttonStyles({ variant: "soft", size: "md", fullWidth: true })}
              >
                {link.label}
              </Link>
            ))}
          </div>
        </nav>
      </Drawer>
    </header>
  );
}
