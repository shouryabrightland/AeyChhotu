"use client";

import { useEffect } from "react";
import { sendHeartbeat, removeHeartbeat } from "@/lib/api-client";
import { getDeviceId } from "@/lib/api/session";

const HEARTBEAT_MS = 15_000;

/* Announces this device to the BACKEND presence registry (sql/007).

   A table is auto-released only when its bill is paid, no orders are open
   AND no device has been seen in the last 45 seconds. This heartbeat is the
   third condition: sending one every 15 seconds means the kitchen can tell
   "the guests are still sitting here" from "everyone has gone", and the
   window tolerates one missed beat.

   The pagehide handler sends a keepalive DELETE, so closing the tab removes
   the presence immediately instead of waiting for the row to age out. No
   Supabase Presence is involved here — that channel only powers the cosmetic
   diner count; the release engine needs a durable server-side row. */
export function usePresence(tableToken: string | null = null, enabled = true) {
  useEffect(() => {
    if (!enabled || !tableToken) return;

    const deviceId = getDeviceId();

    const beat = () => {
      void sendHeartbeat(tableToken, deviceId).catch(() => undefined);
    };

    beat();
    const timer = window.setInterval(beat, HEARTBEAT_MS);

    const handleHide = () => {
      void removeHeartbeat(tableToken, deviceId).catch(() => undefined);
    };
    window.addEventListener("pagehide", handleHide);

    return () => {
      window.clearInterval(timer);
      window.removeEventListener("pagehide", handleHide);
      /* Deliberately no DELETE here. Moving from the menu to the tracker
         unmounts this hook for a few milliseconds; pretending the device
         left would let a paid table auto-release between two screens of the
         SAME visit. A device that truly leaves fires `pagehide`; one that
         crashes ages out of the 45 s window instead. */
    };
  }, [tableToken, enabled]);
}
