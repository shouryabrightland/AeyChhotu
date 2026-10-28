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
  icons: { icon: "/icon.svg", apple: "/icon.svg" },
  manifest: "/site.webmanifest",
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
    <html lang="en" className={cn(displayFont.variable, sansFont.variable)}>
      <body className="min-h-dvh bg-canvas font-sans text-base text-ink antialiased">
        <ToastProvider>{children}</ToastProvider>
      </body>
    </html>
  );
}
