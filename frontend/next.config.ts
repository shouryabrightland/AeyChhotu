import type { NextConfig } from "next";

/* Security headers applied to every response. The backend (Express/helmet)
   owns its own set; these cover the page shell. CSP is deliberately not set
   here yet: the app inlines Tailwind and Next's bootstrap scripts, so a
   real policy needs nonce plumbing — a wrong one blanks the whole app. */
/* `camera=(self)` and `microphone=(self)` rather than `()`: the Table Pass
   scanner is an in-app getUserMedia surface on /table/*, and Chhotu's voice
   input uses the Web Speech API on the same routes. A globally closed policy
   silently breaks both. Multiple Permissions-Policy headers intersect (most
   restrictive wins), so scoping it per-route is not an option while this one
   base header exists. Geolocation stays closed. */
const securityHeaders = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(self), microphone=(self), geolocation=()" },
];

const nextConfig: NextConfig = {
  reactStrictMode: true,
  /* Next's dev server blocks its own script chunks when the page is opened
     from a host it does not know, which looks like a blank page with dead
     buttons rather than a network error. A phone on the restaurant Wi-Fi
     opens the dev build at a LAN IP, so each private-range host is allowed
     here. Development only — next start ignores this entirely. */
  allowedDevOrigins: [
    "192.168.*.*",
    "10.*.*.*",
    "172.16.*.*",
    "172.17.*.*",
    "172.18.*.*",
    "172.19.*.*",
    "172.20.*.*",
    "172.21.*.*",
    "172.22.*.*",
    "172.23.*.*",
    "172.24.*.*",
    "172.25.*.*",
    "172.26.*.*",
    "172.27.*.*",
    "172.28.*.*",
    "172.29.*.*",
    "172.30.*.*",
    "172.31.*.*",
  ],
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
