"use client";

/* The in-app install prompt.
 *
 * Two platforms, two mechanisms:
 *   Android/Chrome — `beforeinstallprompt` fires a stashed event that MUST be
 *                    kept and replayed from a user gesture; calling
 *                    prompt() later than the event is why most banners never
 *                    work.
 *   iOS Safari     — there is no prompt API at all, so the banner explains
 *                    the two taps a guest has to make (Share → Add to Home
 *                    Screen). Showing them an install button would be a lie.
 *
 * Dismissal is remembered in localStorage. It is a courtesy banner, so a
 * remembered "no" is respected forever rather than nagged on every visit. */

import { useEffect, useState } from "react";
import { Share, Smartphone, X } from "lucide-react";

const DISMISS_KEY = "aeychhotu.install-banner.dismissed";

/** Chrome's install event, which is not in the DOM lib. */
interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed"; platform: string }>;
}

type Platform = "android" | "ios" | "none";

function detectPlatform(): Platform {
  if (typeof navigator === "undefined") return "none";

  const ua = navigator.userAgent;
  const ios =
    /iPad|iPhone|iPod/.test(ua) ||
    // iPadOS 13+ reports a desktop Mac UA but keeps touch points.
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);

  if (ios) return "ios";
  if (/Android/.test(ua)) return "android";
  return "none";
}

function isStandalone(): boolean {
  if (typeof window === "undefined") return false;
  return (
    window.matchMedia("(display-mode: standalone)").matches ||
    // iOS Safari's own flag, which is not in the standard typings.
    (window.navigator as Navigator & { standalone?: boolean }).standalone === true
  );
}

export function InstallPrompt() {
  const [deferred, setDeferred] = useState<BeforeInstallPromptEvent | null>(null);
  const [platform, setPlatform] = useState<Platform>("none");
  const [visible, setVisible] = useState(false);
  const [iosGuideOpen, setIosGuideOpen] = useState(false);

  useEffect(() => {
    // Everything below is browser-only, so it all lives after mount: the
    // server renders nothing, which is also what keeps hydration identical.
    let dismissed = false;
    try {
      dismissed = window.localStorage.getItem(DISMISS_KEY) === "1";
    } catch {
      dismissed = false;
    }
    if (dismissed || isStandalone()) return;

    const detected = detectPlatform();

    /* Deferred a frame: the effect body must not write state synchronously
       (it cascades a second render before the banner has painted). */
    const timer = window.setTimeout(() => {
      setPlatform(detected);
      // iOS never fires beforeinstallprompt, so its guide stands alone.
      if (detected === "ios") setVisible(true);
    }, 0);

    // Android may fire the event after this effect: keep the listener.
    const onBeforeInstall = (event: Event) => {
      event.preventDefault();
      setDeferred(event as BeforeInstallPromptEvent);
      if (detected === "android") setVisible(true);
    };

    window.addEventListener("beforeinstallprompt", onBeforeInstall);

    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("beforeinstallprompt", onBeforeInstall);
    };
  }, []);

  function dismiss() {
    setVisible(false);
    setIosGuideOpen(false);
    try {
      window.localStorage.setItem(DISMISS_KEY, "1");
    } catch {
      /* Storage blocked: the banner simply reappears next visit. */
    }
  }

  async function install() {
    if (!deferred) {
      if (platform === "ios") setIosGuideOpen(true);
      return;
    }

    await deferred.prompt();
    const choice = await deferred.userChoice.catch(() => null);
    // The event is single-use; a declined prompt must not be replayed.
    setDeferred(null);
    if (choice?.outcome === "accepted") dismiss();
  }

  if (!visible) return null;

  return (
    <div className="relative z-30 border-b border-line bg-surface">
      <div className="mx-auto flex w-full max-w-page items-center gap-3 px-3.5 py-2.5 sm:px-6">
        <span
          aria-hidden
          className="flex size-9 shrink-0 items-center justify-center rounded-md bg-ember-soft text-ember"
        >
          <Smartphone className="size-4" />
        </span>

        <div className="min-w-0 flex-1">
          <p className="text-xs leading-snug font-semibold text-ink">
            Install AeyChhotu on your home screen for 1-tap table ordering
          </p>

          {iosGuideOpen ? (
            <p className="mt-1 flex items-center gap-1.5 text-xs leading-snug text-ink-muted">
              Tap
              <Share className="inline size-3.5 shrink-0 text-ember" aria-hidden />
              Share, then <span className="font-semibold">Add to Home Screen</span>.
            </p>
          ) : (
            <p className="mt-0.5 text-xs leading-snug text-ink-muted">
              {platform === "ios"
                ? "Two taps in Safari — no app store, no download."
                : "Opens directly to your table, with no address bar."}
            </p>
          )}
        </div>

        <button
          type="button"
          onClick={() => void install()}
          className="shrink-0 cursor-pointer rounded-md bg-ember px-3 py-2 text-xs font-semibold text-on-ember transition-colors duration-[var(--duration-fast)] hover:bg-ember-strong"
        >
          {platform === "ios" ? "Show me" : "Install"}
        </button>

        <button
          type="button"
          onClick={dismiss}
          aria-label="Dismiss the install banner"
          className="shrink-0 cursor-pointer rounded-md p-1.5 text-ink-subtle transition-colors duration-[var(--duration-fast)] hover:text-ink"
        >
          <X className="size-4" aria-hidden />
        </button>
      </div>
    </div>
  );
}
