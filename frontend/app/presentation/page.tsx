import type { Metadata, Viewport } from "next";
import { PresentationView } from "./PresentationView";

/* The showcase sits on the app's own canvas, so the browser chrome is the
   same warm cream as every product screen. */
export const viewport: Viewport = {
  themeColor: "#fbf8f4",
  colorScheme: "light",
};

export const metadata: Metadata = {
  title: "Hackathon showcase",
  description:
    "A 19-scene tour of AeyChhotu: shared cart, table PIN and pass, diet-aware menu, allergy guardrails, atomic order fire, live kitchen, split bill, floor board and the manager console.",
  robots: { index: false },
};

export default function PresentationPage() {
  return <PresentationView />;
}
