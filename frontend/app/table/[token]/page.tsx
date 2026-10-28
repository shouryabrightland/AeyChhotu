import type { Metadata } from "next";
import { DinerTableScreen } from "@/components/diner/diner-table-screen";
import { TableSessionGate } from "@/components/diner/table-session-gate";

export const metadata: Metadata = {
  title: "Table session",
  description: "Add dishes to the shared table cart and fire one grouped order to the kitchen.",
};

export default async function TablePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;

  /* The gate, not the screen, decides whether this device belongs to the
     table. Everything below it (menu, cart, bill, pass) assumes a granted
     session and never asks "am I allowed in?" again. */
  return (
    <TableSessionGate tableToken={token}>
      <DinerTableScreen tableToken={token} />
    </TableSessionGate>
  );
}
