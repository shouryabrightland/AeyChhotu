"use client";

import { useEffect, useState } from "react";
import { Users } from "lucide-react";
import { getDeviceId } from "@/lib/api/session";
import { Badge } from "@/components/ui/badge";
import { getSupabase, trackTablePresence } from "@/lib/api-client";

export interface ActiveDinersBadgeProps {
  tableToken: string;
  /** Devices that beat inside the release window, read from the server
      presence registry (`GET /sessions/:token`). */
  serverCount: number;
}

/* "N phones at this table".

   THE SERVER is the baseline (docs/14 #14): the local demo heartbeat writer
   is no longer called by anything, so the old localStorage count was always
   0/1 without Supabase. Every diner posts a heartbeat to the API registry,
   and the table state read exposes the live count — that works on every
   deployment.

   Supabase Presence, when configured, is the more immediate number (it knows
   the moment a tab joins or closes), so it is used when it is larger. Neither
   path ever turns a missing signal into a number: an unknown count reads
   "Syncing" rather than inventing zero. */
export function ActiveDinersBadge({ tableToken, serverCount }: ActiveDinersBadgeProps) {
  const [presenceCount, setPresenceCount] = useState<number | null>(null);
  const live = getSupabase() !== null;

  useEffect(() => {
    if (!live) return;
    return trackTablePresence(tableToken, getDeviceId(), setPresenceCount);
  }, [live, tableToken]);

  const count = Math.max(serverCount, presenceCount ?? 0);

  return (
    <Badge tone="neutral" className="gap-1.5">
      <Users className="size-3.5" aria-hidden />
      {count === 0 ? "No phones live" : count === 1 ? "1 phone live" : `${count} phones live`}
    </Badge>
  );
}
