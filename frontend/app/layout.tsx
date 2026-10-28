import type { Metadata, Viewport } from "next";
import { ToastProvider } from "@/components/ui/toast";
import { displayFont, sansFont } from "@/lib/fonts";
import { cn } from "@/lib/utils";
import "./globals.css";

export const metadata: Metadata = {
  title: {
    default: "AeyChhotu — one table, one order, live from the kitchen",
    template: "%s · AeyChhotu",
  },
  description:
    "A zero-download, real-time operational bridge that groups individual table requests into a single unified cart and streams two-way status updates between diners and the kitchen.",
  icons: { icon: "/icon.svg", apple: "/icon-192.png" },
  manifest: "/site.webmanifest",
  /* iOS ignores the web manifest's display mode when launched from the home
     screen, so the shell tags are emitted explicitly. Next turns `appleWebApp`
     into <meta name="apple-mobile-web-app-capable"> plus the status-bar style
     and the home-screen title. */
  appleWebApp: {
    capable: true,
    statusBarStyle: "default",
    title: "AeyChhotu",
  },
};

/* The app shell is locked at 1×: this is not a document to be read at
   arm's length, it is a hand-held surface. Zoom is disabled (`maximumScale`
   + `userScalable`), and `viewportFit: "cover"` is what makes
   env(safe-area-inset-*) resolve to real values so the nav band clears the
   notch and the cart strip clears the home indicator. */
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  viewportFit: "cover",
  themeColor: "#fbf8f4",
  colorScheme: "light",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    /* `suppressHydrationWarning` is intentional and scoped to this element:
       browser extensions (password managers, translating tools, the Pi Lens
       overlay) inject attributes such as `data-pi-lens-extension` onto <html>
       before React hydrates. The server cannot know about them, and React
       cannot patch them — which would otherwise surface as a hydration error
       on every page, the admin console included. It silences only attribute
       mismatches on this tag, not the app's own tree. */
    <html
      lang="en"
      className={cn(displayFont.variable, sansFont.variable)}
      suppressHydrationWarning
    >
      <body className="min-h-dvh bg-canvas font-sans text-base text-ink antialiased">
        <ToastProvider>{children}</ToastProvider>
      </body>
    </html>
  );
}
