import type { NextConfig } from "next";

/* Security headers applied to every response. The backend (Express/helmet)
   owns its own set; these cover the page shell. CSP is deliberately not set
   here yet: the app inlines Tailwind and Next's bootstrap scripts, so a
   real policy needs nonce plumbing — a wrong one blanks the whole app. */
/* `camera=(self)` rather than `camera=()`: the Table Pass scanner is an
   in-app getUserMedia surface on /table/*, and a globally closed camera
   policy silently breaks it. Multiple Permissions-Policy headers intersect
   (most restrictive wins), so scoping it per-route is not an option while
   this one base header exists. Microphone and geolocation stay closed. */
const securityHeaders = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(self), microphone=(), geolocation=()" },
];

const nextConfig: NextConfig = {
  reactStrictMode: true,
  /* Dish photography is resolved in the frontend (lib/diner/food-photos)
     because the menu contract has no image column, and every photo ships in
     public/food — so the optimiser only ever reads from disk and no remote
     pattern is needed. Hot-linking a third-party host made every plate depend
     on that CDN answering the optimiser, which is exactly how `/_next/image`
     started returning 500 for dishes whose photo would not fetch. */
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
};

export default nextConfig;
