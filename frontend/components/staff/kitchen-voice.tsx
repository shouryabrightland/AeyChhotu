"use client";

import { Loader2, Mic, Square } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { buildKitchenSystemPrompt } from "@/lib/ai/kitchen-system-prompt";
import { KITCHEN_TOOL_DECLARATIONS } from "@/lib/ai/kitchen-tool-declarations";
import {
  createKitchenToolset,
  type KitchenRuntime,
  type KitchenToolset,
} from "@/lib/ai/kitchen-tools";
import { ChhotuLiveSession, type ChhotuPhase } from "@/lib/ai/live-session";
import { getChhotuClient } from "@/lib/ai/gemini-client";
import type { ChhotuAction } from "@/lib/ai/types";
import { KITCHEN_WAKE } from "@/lib/ai/wake-word";
import { getKdsAssistantKey } from "@/lib/api-client";
import type { MenuItem, Order } from "@/lib/api/types";
import { cn } from "@/lib/utils";

/* The kitchen's voice dock — hands-free control of the Kanban board.

   HOW "ALWAYS LISTENING" WORKS: the mic streams continuously to the SAME
   Gemini Live socket the diner and console use. The session (see
   live-session.ts) holds every answer and refuses every tool call until the
   turn's transcript contains "aey chhotu". So a noisy kitchen can stream
   audio without a stray "table four ready" ever moving a ticket.

   The key is released by the API to a kitchen shift token only; this
   component renders inside the unlocked board, so the PIN wall is the gate. */

export interface KitchenVoiceProps {
  tickets: Order[];
  menu: MenuItem[];
  refresh: () => Promise<void>;
  onMove: (order: Order, next: "preparing" | "ready") => Promise<{ ok: boolean; message?: string }>;
  onServe: (order: Order) => Promise<{ ok: boolean; message?: string }>;
  onDeny: (order: Order, reason: string) => Promise<{ ok: boolean; message?: string }>;
  onSetAvailability: (
    menuItemId: string,
    isAvailable: boolean,
  ) => Promise<{ ok: boolean; message?: string }>;
  onStartShift: () => Promise<{ ok: boolean; message?: string }>;
}

interface VoiceLine {
  id: string;
  role: "user" | "assistant";
  text: string;
  actions?: ChhotuAction[];
}

/** Prebuilt Gemini voice, distinct from the diner's Puck and the console's
    Aoede, so a kitchen tablet is identifiable by ear. */
const KITCHEN_VOICE = "Kore";

/** Read-only transcript, kept for the shift so a cook can look back at what
    was said. It is history, never an input: there is no text box. */
const HISTORY_KEY = "aeychhotu.kitchen_voice.history.v1";
const HISTORY_LIMIT = 20;

function statusText(enabled: boolean, phase: ChhotuPhase, wakeHeard: boolean): string {
  if (!enabled) return "Tap to wake the kitchen assistant.";
  if (wakeHeard) return "Aey Chhotu heard…";
  if (phase === "connecting") return "Opening the voice line…";
  if (phase === "thinking") return "Reading the board…";
  if (phase === "speaking") return "Answering…";
  if (phase === "error") return "The voice line dropped — tap Stop, then Enable.";
  return 'Listening — say "Aey Chhotu".';
}

function MicBars({ level, active = false }: { level: number; active?: boolean }) {
  return (
    <span aria-hidden className="relative flex size-4 items-center justify-center">
      {active ? (
        <span className="absolute inset-0 animate-ping rounded-pill bg-current opacity-25" />
      ) : null}
      <span className="flex h-4 items-end gap-[3px]">
        {[0.45, 1, 0.7].map((scale, index) => (
          <span
            key={index}
            className="w-[3px] rounded-pill bg-current transition-[height] duration-75 ease-out"
            style={{
              height: `${4 + Math.min(1, Math.max(active ? 0.22 : 0, level) * 2.2) * 12 * scale}px`,
            }}
          />
        ))}
      </span>
    </span>
  );
}

export function KitchenVoice({
  tickets,
  menu,
  refresh,
  onMove,
  onServe,
  onDeny,
  onSetAvailability,
  onStartShift,
}: KitchenVoiceProps) {
  const [expanded, setExpanded] = useState(false);
  const [enabled, setEnabled] = useState(false);
  const [busy, setBusy] = useState(false);
  const [phase, setPhase] = useState<ChhotuPhase>("idle");
  const [level, setLevel] = useState(0);
  const [activity, setActivity] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [wakeHeard, setWakeHeard] = useState(false);
  const [waiting, setWaiting] = useState<string | null>(null);
  const [lines, setLines] = useState<VoiceLine[]>([]);
  const [userDraft, setUserDraft] = useState("");
  const [assistantDraft, setAssistantDraft] = useState("");

  const sessionRef = useRef<ChhotuLiveSession | null>(null);
  const userDraftRef = useRef("");
  const assistantDraftRef = useRef("");
  const actionsRef = useRef<ChhotuAction[]>([]);
  const idRef = useRef(0);
  const wakeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  /* The runtime behind the tools is refreshed after every render, so a tool
     call always reads the live board rather than a stale closure. The toolset
     itself is created on first use (an event), never during render. */
  const runtimeRef = useRef<KitchenRuntime | null>(null);
  useEffect(() => {
    runtimeRef.current = {
      tickets,
      menu,
      refresh,
      moveTicket: onMove,
      serveTicket: onServe,
      denyTicket: onDeny,
      setAvailability: onSetAvailability,
      startShift: onStartShift,
    };
  });

  const toolsetRef = useRef<KitchenToolset | null>(null);
  const ensureToolset = useCallback((): KitchenToolset => {
    if (toolsetRef.current) return toolsetRef.current;

    toolsetRef.current = createKitchenToolset({
      get tickets() {
        return runtimeRef.current?.tickets ?? [];
      },
      get menu() {
        return runtimeRef.current?.menu ?? [];
      },
      refresh: () => runtimeRef.current?.refresh() ?? Promise.resolve(),
      moveTicket: (order, next) =>
        runtimeRef.current?.moveTicket(order, next) ??
        Promise.resolve({ ok: false, message: "The board is not ready yet." }),
      serveTicket: (order) =>
        runtimeRef.current?.serveTicket(order) ??
        Promise.resolve({ ok: false, message: "The board is not ready yet." }),
      denyTicket: (order, reason) =>
        runtimeRef.current?.denyTicket(order, reason) ??
        Promise.resolve({ ok: false, message: "The board is not ready yet." }),
      setAvailability: (menuItemId, available) =>
        runtimeRef.current?.setAvailability(menuItemId, available) ??
        Promise.resolve({ ok: false, message: "The menu is still loading." }),
      startShift: () =>
        runtimeRef.current?.startShift() ??
        Promise.resolve({ ok: false, message: "The shift could not be armed." }),
    });

    return toolsetRef.current;
  }, []);

  /* Load the previous shift's transcript once, after hydration. */
  useEffect(() => {
    const timer = window.setTimeout(() => {
      try {
        const raw = window.sessionStorage.getItem(HISTORY_KEY);
        if (!raw) return;
        const parsed: unknown = JSON.parse(raw);
        if (Array.isArray(parsed) && parsed.length > 0) {
          setLines((parsed as VoiceLine[]).slice(-HISTORY_LIMIT));
        }
      } catch {
        /* Storage blocked or corrupt: an empty history is fine. */
      }
    }, 0);

    return () => window.clearTimeout(timer);
  }, []);

  /* Persist as the conversation grows, so a refresh does not erase it. */
  useEffect(() => {
    try {
      if (lines.length === 0) window.sessionStorage.removeItem(HISTORY_KEY);
      else window.sessionStorage.setItem(HISTORY_KEY, JSON.stringify(lines));
    } catch {
      /* Private mode: the on-screen copy still works. */
    }
  }, [lines]);

  const flush = useCallback(() => {
    const asked = userDraftRef.current.trim();
    const answered = assistantDraftRef.current.trim();
    const turnActions = actionsRef.current;

    userDraftRef.current = "";
    assistantDraftRef.current = "";
    actionsRef.current = [];
    setUserDraft("");
    setAssistantDraft("");

    if (!asked && !answered && turnActions.length === 0) return;

    setLines((current) => {
      const next = [...current];
      if (asked) {
        idRef.current += 1;
        next.push({ id: `kv-${idRef.current}`, role: "user", text: asked });
      }
      if (answered || turnActions.length > 0) {
        idRef.current += 1;
        next.push({
          id: `kv-${idRef.current}`,
          role: "assistant",
          text: answered || "Done.",
          ...(turnActions.length > 0 ? { actions: turnActions } : {}),
        });
      }
      return next.slice(-HISTORY_LIMIT);
    });

    setWaiting(toolsetRef.current?.pendingDescription() ?? null);
  }, []);

  const enable = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    setError(null);

    try {
      const { gemini_api_key } = await getKdsAssistantKey();
      const ai = getChhotuClient(gemini_api_key);
      if (!ai) {
        setError("Voice is off: GEMINI_API_KEY is not set on the API.");
        return;
      }

      const toolset = ensureToolset();
      const session = new ChhotuLiveSession({
        client: ai,
        systemInstruction: buildKitchenSystemPrompt(),
        voiceName: KITCHEN_VOICE,
        tools: KITCHEN_TOOL_DECLARATIONS,
        describe: toolset.describe,
        execute: (name, args) => toolset.execute(name, args),
        wakePhrase: KITCHEN_WAKE,
        callbacks: {
          onPhase: setPhase,
          onMicLevel: setLevel,
          onActivity: setActivity,
          onWake: () => {
            // A heard wake word always brings the assistant to the front.
            setExpanded(true);
            setWakeHeard(true);
            if (wakeTimer.current !== null) clearTimeout(wakeTimer.current);
            wakeTimer.current = setTimeout(() => setWakeHeard(false), 1_800);
          },
          onUserSpeech: (delta) => {
            userDraftRef.current += delta;
            setUserDraft(userDraftRef.current);
          },
          onAssistantSpeech: (delta) => {
            assistantDraftRef.current += delta;
            setAssistantDraft(assistantDraftRef.current);
          },
          onTurnComplete: flush,
          onActions: (next) => {
            actionsRef.current = [...actionsRef.current, ...next];
          },
          onError: setError,
        },
      });

      await session.connect();
      await session.startMic();

      sessionRef.current = session;
      setEnabled(true);
      // Arming the chime is part of opening the kitchen's voice line.
      void onStartShift();
    } catch {
      setError("The voice line could not open. Try again — nothing was changed.");
    } finally {
      setBusy(false);
    }
  }, [busy, ensureToolset, flush, onStartShift]);

  const stop = useCallback(() => {
    sessionRef.current?.close();
    sessionRef.current = null;
    setEnabled(false);
    setPhase("idle");
    setLevel(0);
    setActivity(null);
    setWaiting(null);
  }, []);

  useEffect(
    () => () => {
      sessionRef.current?.close();
      if (wakeTimer.current !== null) clearTimeout(wakeTimer.current);
    },
    [],
  );

  const listening = enabled && phase !== "connecting";

  return (
    <>
      {expanded ? (
        <section
          aria-label="Kitchen voice assistant"
          className="fixed right-5 bottom-24 z-40 flex w-[min(22rem,calc(100vw-2.5rem))] flex-col gap-3 rounded-lg border border-line-strong bg-surface p-4 shadow-lg"
        >
          <header className="flex items-start justify-between gap-3">
            <div className="flex flex-col gap-1">
              <h2 className="font-display text-sm font-semibold text-ink">Kitchen voice</h2>
              <p
                role={error ? "alert" : "status"}
                className={cn("text-xs leading-snug", error ? "text-alert" : "text-ink-muted")}
              >
                {error ?? statusText(enabled, phase, wakeHeard)}
              </p>
            </div>
            {listening ? (
              <span className="mt-0.5 text-ember">
                <MicBars level={level} active />
              </span>
            ) : null}
          </header>

          {lines.length > 0 ? (
            <div className="flex items-center justify-between gap-2">
              <span className="text-[10px] font-semibold tracking-[0.14em] text-ink-subtle uppercase">
                History · read only
              </span>
              <button
                type="button"
                onClick={() => setLines([])}
                className="cursor-pointer text-[10px] font-semibold text-ink-subtle underline-offset-4 hover:text-ink hover:underline"
              >
                Clear
              </button>
            </div>
          ) : null}

          {lines.length > 0 ? (
            <ul aria-live="polite" className="flex max-h-52 flex-col gap-2 overflow-y-auto pr-1">
              {lines.map((line) => (
                <li
                  key={line.id}
                  className={cn("flex flex-col gap-1.5", line.role === "user" ? "items-end" : "items-start")}
                >
                  <div
                    className={cn(
                      "max-w-[92%] rounded-md px-3 py-2 text-xs leading-relaxed",
                      line.role === "user"
                        ? "bg-ember-soft text-ink"
                        : "border border-line bg-paper text-ink",
                    )}
                  >
                    {line.text}
                  </div>
                  {line.actions && line.actions.length > 0 ? (
                    <ul className="flex flex-wrap gap-1">
                      {line.actions.map((action, index) => (
                        <li
                          key={`${line.id}-a-${index}`}
                          className={cn(
                            "rounded-pill border px-2 py-0.5 text-[11px] font-medium",
                            action.ok
                              ? "border-ready/35 bg-ready-surface text-ready"
                              : "border-pending/40 bg-pending-surface text-ink",
                          )}
                        >
                          {action.label}
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </li>
              ))}
            </ul>
          ) : null}

          {userDraft || assistantDraft ? (
            <div className="flex flex-col gap-1.5" aria-live="polite">
              {userDraft ? (
                <p className="self-end rounded-md bg-ember-soft px-3 py-2 text-xs text-ink">
                  {userDraft}
                </p>
              ) : null}
              {assistantDraft ? (
                <p className="self-start rounded-md border border-line bg-paper px-3 py-2 text-xs text-ink">
                  {assistantDraft}
                </p>
              ) : null}
            </div>
          ) : null}

          {activity ? (
            <p role="status" className="flex items-center gap-2 text-xs text-ink-muted">
              <Loader2 className="size-3.5 animate-spin text-ember" aria-hidden />
              {activity}
            </p>
          ) : null}

          {waiting ? (
            <p className="rounded-md border border-pending/40 bg-pending-surface px-3 py-2 text-xs font-medium text-ink">
              Waiting for your yes: {waiting}
            </p>
          ) : null}

          <button
            type="button"
            onClick={() => (enabled ? stop() : void enable())}
            disabled={busy}
            className="inline-flex h-11 w-full cursor-pointer items-center justify-center gap-2 rounded-md bg-ink px-4 text-sm font-semibold text-ink-inverse transition-opacity duration-[var(--duration-fast)] hover:opacity-90 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-ink/20 disabled:cursor-wait disabled:opacity-60"
          >
            {busy ? (
              <Loader2 className="size-4 animate-spin" aria-hidden />
            ) : enabled ? (
              <Square className="size-3.5" aria-hidden />
            ) : (
              <Mic className="size-4" aria-hidden />
            )}
            {busy ? "Opening…" : enabled ? "Stop voice" : "Enable voice"}
          </button>

          <p className="text-[11px] leading-snug text-ink-subtle">
            One tap starts the mic. After that it stays listening — say
            &ldquo;Aey Chhotu&rdquo; or just &ldquo;Chhotu&rdquo; before a command.
          </p>
        </section>
      ) : null}

      <button
        type="button"
        onClick={() => {
          /* One tap is required by the browser before any mic can open; after
             that, “Aey Chhotu” (or just “Chhotu”) is the only control needed. */
          setExpanded((current) => !current || !enabled);
          if (!enabled && !busy) void enable();
        }}
        aria-expanded={expanded}
        aria-label="Kitchen voice assistant"
        className="fixed right-5 bottom-5 z-40 inline-flex cursor-pointer items-center gap-2 rounded-pill bg-ink px-4 py-3 text-sm font-semibold text-ink-inverse shadow-lg transition-transform duration-[var(--duration-fast)] ease-gentle hover:-translate-y-0.5 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-ink/20"
      >            {enabled ? (
              <span className="text-on-ember">
                <MicBars level={level} active={listening} />
              </span>
            ) : (
              <Mic className="size-4" aria-hidden />
            )}
            <span>{enabled ? "Voice on" : "Start voice"}</span>
      </button>
    </>
  );
}
