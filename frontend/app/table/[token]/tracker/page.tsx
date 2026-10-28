import type { Metadata } from "next";
import { LiveTracker } from "@/components/diner/live-tracker";
import { TableSessionGate } from "@/components/diner/table-session-gate";

export const metadata: Metadata = {
  title: "Live order tracker",
  description:
    "Watch the kitchen move this table's order from pending to preparing to ready, live.",
};

export default async function TrackerPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;

  /* Same gate as the menu. The tracker shows what the table ordered and what
     it owes, so a URL alone must not be enough to read it — a guest who has
     not joined is sent back through the PIN (or the pass). */
  return (
    <TableSessionGate tableToken={token}>
      <LiveTracker tableToken={token} />
    </TableSessionGate>
  );
}
