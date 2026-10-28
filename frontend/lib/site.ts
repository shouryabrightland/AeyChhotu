export interface NavLink {
  label: string;
  href: string;
}

/** Section anchors on the customer story (/about). The kitchen, floor and
    admin consoles are operator surfaces: a diner-facing page never links to
    them, and they are not in this list. */
export const marketingNav: NavLink[] = [
  { label: "Why we built it", href: "#why" },
  { label: "How it works", href: "#how-it-works" },
  { label: "Food safety", href: "#safety" },
  { label: "Your table", href: "#your-table" },
];

/** The customer-facing rooms of the product. */
export const customerLinks: NavLink[] = [
  { label: "Our story", href: "/about" },
  { label: "Hackathon showcase", href: "/presentation" },
  { label: "Scan a table", href: "/" },
];

/** The example token printed in the docs and on the demo QR stand. */
export const demoTableToken = "k7x2p";
