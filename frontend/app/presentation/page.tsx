import type { Metadata, Viewport } from "next";
import { PresentationView } from "./PresentationView";

/* The hackathon showcase is a standalone dark exhibit, so it owns its own
   browser chrome colour instead of inheriting the app's cream. */
export const viewport: Viewport = {
  themeColor: "#070a13",
  colorScheme: "dark",
};

export const metadata: Metadata = {
  title: "Hackathon showcase",
  description:
    "An 11-scene guided tour of AeyChhotu: the shared cart, table PIN, allergy guardrails, atomic order fire and live kitchen tracker.",
  robots: { index: false },
};

export default function PresentationPage() {
  return <PresentationView />;
}
