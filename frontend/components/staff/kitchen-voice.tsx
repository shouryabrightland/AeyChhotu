"use client";

import { Loader2, Mic } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { ChhotuAvatar } from "@/components/brand/chhotu-avatar";
import { Button } from "@/components/ui/button";
import { Drawer } from "@/components/ui/drawer";
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
import { getKdsAssistantKey } from "@/lib/api-client";
import type { MenuItem, Order } from "@/lib/api/types";
import { cn } from "@/lib/utils";

/* The kitchen's voice assistant — the same Live session the diner sheet and
   the manager console use, with the board's tools behind it.

   ONE TAP, THEN TALK: there is no wake word and no text box. The cook taps the
   mic once (browsers require that gesture before any mic can open) and from
   then on everything said is a command; tapping again pauses the mic. The
   answers arrive spoken AND written — the transcript below is the same
   sentence the cook hears.

   WHY THE TAP MATTERS: `primeAudio()` is called synchronously inside the tap,
   before any await. Chrome starts an AudioContext created outside a gesture
   SUSPENDED, and a suspended context never fires `onaudioprocess`, so the old
   panel looked connected and streamed silence. The key is fetched up front so
   the tapped handler has nothing to wait for before priming.

   READ ONLY ON THE PAGE: the transcript is history, never an input. Nothing is
   typed here — the cook is wearing gloves.

   The key is released by the API to a KITCHEN shift token only; this component
   renders inside the unlocked board, so the PIN wall is the gate. */

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

/** The shift's transcript, so a cook can look back at what was said. It is
    history, never an input: there is no text box. */
const HISTORY_KEY = "aeychhotu.kitchen_voice.history.v2";
const HISTORY_LIMIT = 20;

const INTRO: VoiceLine = {
  id: "kitchen-intro",
  role: "assistant",
  text: "Tap the mic and talk — board dekho, table four ready karo, paneer tikka 86 karo. Main bolke jawab dunga, aur wahi yahan likha rahega.",
};

/** Spoken examples, so a new cook can see the whole board is voice-reachable. */
const SPOKEN_EXAMPLES = [
  "“Board dekho” · “What's pending?”",
  "“Table four ready kar do”",
  "“Table 6 serve karo”",
  "“Table 4 deny karo — paneer khatam”",
  "“Paneer tikka 86 karo” · “wapas chalu karo”",
  "“Kya 86 hai?” · “Masala dosa available hai?”",
  "“Konsi table waiter maang rahi hai?”",
  "“Board refresh karo” · “Shift start karo”",
] as const;

function phaseLabel(phase: ChhotuPhase): string | null {
  switch (phase) {
    case "connecting":
      return "Opening the voice line…";
    case "listening":
      return "Listening — talk normally, tap the mic again to pause.";
    case "thinking":
      return "Reading the board…";
    case "speaking":
      return "Answering…";
    case "error":
      return "The line dropped — tap the mic to reconnect.";
    default:
      return null;
  }
}

function MicLevel({ level, listening }: { level: number; listening: boolean }) {
  return (
    <span aria-hidden className="relative flex size-4 items-center justify-center">
      {listening ? (
        <span className="absolute inset-0 animate-ping rounded-pill bg-current opacity-20" />
      ) : null}
      <span className="flex h-4 items-end gap-[3px]">
        {[0.45, 1, 0.7].map((scale, index) => (
          <span
            key={index}
            className={cn(
              "w-[3px] rounded-pill bg-current",
              // While the line is open the bars breathe on their own, so the
              // icon never looks dead between words.
              listening
                ? "h-4 origin-bottom animate-mic-live"
                : "transition-[height] duration-75 ease-out",
            )}
            style={
              listening
                ? {
                    animationDelay: `${index * 130}ms`,
                    animationDuration: `${Math.round(950 - Math.min(1, level) * 450)}ms`,
                  }
                : { height: `${4 + Math.min(1, level) * 12 * scale}px` }
            }
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
  const [open, setOpen] = useState(false);
  const [listening, setListening] = useState(false);
  const [busy, setBusy] = useState(false);
  const [phase, setPhase] = useState<ChhotuPhase>("idle");
  const [level, setLevel] = useState(0);
  const [activity, setActivity] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [waiting, setWaiting] = useState<string | null>(null);
  const [lines, setLines] = useState<VoiceLine[]>([INTRO]);
  const [userDraft, setUserDraft] = useState("");
  const [assistantDraft, setAssistantDraft] = useState("");
  const [keyState, setKeyState] = useState<"checking" | "ready" | "missing">("checking");

  const sessionRef = useRef<ChhotuLiveSession | null>(null);
  const startingRef = useRef(false);
  const shiftArmedRef = useRef(false);
  const apiKeyRef = useRef<string | null>(null);
  const userDraftRef = useRef("");
  const assistantDraftRef = useRef("");
  const actionsRef = useRef<ChhotuAction[]>([]);
  const idRef = useRef(0);

  /* The runtime behind the tools is refreshed after every render, so a tool
     call always reads the live board rather than a stale closure. */
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

  /* The key is released by the API to a kitchen shift token, so it is fetched
     once here — before any tap — which lets the tap open the mic immediately
     instead of waiting on the network first. */
  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        const { gemini_api_key } = await getKdsAssistantKey();
        if (cancelled) return;
        apiKeyRef.current = gemini_api_key;
        setKeyState(gemini_api_key ? "ready" : "missing");
      } catch {
        if (!cancelled) setKeyState("missing");
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  /* Restore the shift's transcript once, after hydration. */
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
      if (lines.length <= 1) window.sessionStorage.removeItem(HISTORY_KEY);
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
          // No invented "Done.": a tool-only turn carries its result chips
          // and nothing else, so the transcript stays truthful.
          text: answered,
          ...(turnActions.length > 0 ? { actions: turnActions } : {}),
        });
      }
      return next.slice(-HISTORY_LIMIT);
    });

    setWaiting(toolsetRef.current?.pendingDescription() ?? null);
  }, []);

  /* Arming the chime is part of opening the kitchen's voice line, but only
     once per mount — the cook did not ask for a toast on every tap. */
  const armShiftOnce = useCallback(() => {
    if (shiftArmedRef.current) return;
    shiftArmedRef.current = true;
    void onStartShift();
  }, [onStartShift]);

  /** One session per open dock, built synchronously so the tap can prime the
      audio clocks before anything is awaited. */
  const buildSession = useCallback((): ChhotuLiveSession | null => {
    const apiKey = apiKeyRef.current;
    if (!apiKey) return null;

    const ai = getChhotuClient(apiKey);
    if (!ai) return null;

    return new ChhotuLiveSession({
      client: ai,
      systemInstruction: buildKitchenSystemPrompt(),
      voiceName: KITCHEN_VOICE,
      tools: KITCHEN_TOOL_DECLARATIONS,
      describe: (name, args) => ensureToolset().describe(name, args),
      execute: (name, args) => ensureToolset().execute(name, args),
      callbacks: {
        onPhase: setPhase,
        onMicLevel: setLevel,
        onActivity: setActivity,
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
        // A write must show up on the board behind the dock immediately.
        onMutated: () => {
          void runtimeRef.current?.refresh();
        },
        onError: (message) => setError(message),
      },
    });
  }, [ensureToolset, flush]);

  const startListening = useCallback(async () => {
    if (startingRef.current) return;
    setError(null);

    const existing = sessionRef.current;
    if (existing) {
      await existing.startMic();
      if (existing.micActive) {
        setListening(true);
        armShiftOnce();
      }
      return;
    }

    if (!apiKeyRef.current) {
      setOpen(true);
      setError("Voice is off: GEMINI_API_KEY is not set on the API.");
      return;
    }

    const session = buildSession();
    if (!session) {
      setOpen(true);
      setError("Voice is off: the assistant key was empty.");
      return;
    }

    /* SYNCHRONOUS, inside the tap: Chrome starts any AudioContext created after
       an await suspended, and a suspended context streams silence. */
    session.primeAudio();

    startingRef.current = true;
    setBusy(true);
    sessionRef.current = session;

    try {
      await session.connect();
      await session.startMic();

      if (!session.micActive) {
        // Permission denied or the browser muted the tab; keep the panel open
        // so the cook sees why and can tap again.
        sessionRef.current = null;
        session.close();
        setListening(false);
        setOpen(true);
        return;
      }

      setListening(true);
      armShiftOnce();
    } catch {
      sessionRef.current = null;
      session.close();
      setListening(false);
      setOpen(true);
      setError("The voice line could not open. Tap the mic to try again — nothing was changed.");
    } finally {
      startingRef.current = false;
      setBusy(false);
    }
  }, [armShiftOnce, buildSession]);

  /** Pause the mic but keep the conversation, so the next tap continues it. */
  const stopListening = useCallback(() => {
    sessionRef.current?.stopMic();
    setListening(false);
    setLevel(0);
  }, []);

  const teardown = useCallback(() => {
    sessionRef.current?.close();
    sessionRef.current = null;
    userDraftRef.current = "";
    assistantDraftRef.current = "";
    actionsRef.current = [];
    setUserDraft("");
    setAssistantDraft("");
    setListening(false);
    setLevel(0);
    setActivity(null);
    setWaiting(null);
    setPhase("idle");
  }, []);

  useEffect(() => () => teardown(), [teardown]);

  /* Closing the dock pauses the mic but KEEPS the session: the cook can shut
     the panel mid-service and come back to the same conversation, with the
     model's context and any parked confirmation still waiting. Only unmount
     tears the voice line down. */
  const closeDrawer = useCallback(() => {
    flush();
    stopListening();
    setOpen(false);
  }, [flush, stopListening]);

  const status =
    error ??
    (busy ? "Opening the kitchen line…" : phaseLabel(phase)) ??
    (listening ? "Listening — talk normally." : "Tap the mic once, then just talk.");

  return (
    <>
      <button
        type="button"
        onClick={() => {
          setOpen(true);
          if (!listening && !busy) void startListening();
        }}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label="Kitchen voice assistant"
        className="fixed right-5 bottom-5 z-40 inline-flex cursor-pointer items-center gap-2 rounded-pill bg-ink px-4 py-3 text-sm font-semibold text-ink-inverse shadow-lg transition-transform duration-[var(--duration-fast)] ease-gentle hover:-translate-y-0.5 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-ink/20"
      >
        {listening ? (
          <span className="text-on-ember">
            <MicLevel level={level} listening />
          </span>
        ) : (
          <ChhotuAvatar size="sm" />
        )}
        <span>{listening ? "Voice on" : "Ask Chhotu"}</span>
      </button>

      <Drawer
        open={open}
        onClose={closeDrawer}
        title="Kitchen voice"
        description="Tap the mic and talk — answers come back spoken and written."
        size="md"
        footer={
          <div className="flex w-full flex-col gap-2">
            <p
              role={error ? "alert" : "status"}
              className={cn("text-xs font-medium", error ? "text-alert" : "text-ink-muted")}
            >
              {status}
            </p>

            <Button
              type="button"
              variant={listening ? "outline" : "ember"}
              size="lg"
              fullWidth
              disabled={busy || keyState === "checking"}
              onClick={() => {
                if (busy) return;
                if (listening) stopListening();
                else void startListening();
              }}
              leftIcon={
                busy ? (
                  <Loader2 className="size-4 animate-spin" aria-hidden />
                ) : listening ? (
                  <MicLevel level={level} listening />
                ) : (
                  <Mic className="size-4" aria-hidden />
                )
              }
            >
              {busy ? "Opening…" : listening ? "Stop listening" : "Start listening"}
            </Button>
          </div>
        }
      >
        <div className="flex flex-col gap-4">
          {keyState === "missing" ? (
            <p className="rounded-md border border-pending/30 bg-pending-surface px-3 py-2 text-sm text-ink">
              GEMINI_API_KEY is not set on the API, so the kitchen assistant is off.
            </p>
          ) : null}

          <div className="flex items-center justify-between gap-2">
            <span className="text-[10px] font-semibold tracking-[0.14em] text-ink-subtle uppercase">
              History · read only
            </span>
            <div className="flex items-center gap-3">
              {listening ? (
                <span className="inline-flex items-center gap-1.5 text-ember">
                  <MicLevel level={level} listening />
                  <span className="text-[10px] font-semibold uppercase tracking-[0.12em]">
                    Live
                  </span>
                </span>
              ) : null}
              {lines.length > 1 ? (
                <button
                  type="button"
                  onClick={() => {
                    setLines([INTRO]);
                    setWaiting(null);
                  }}
                  className="cursor-pointer text-[10px] font-semibold text-ink-subtle underline-offset-4 hover:text-ink hover:underline"
                >
                  Clear
                </button>
              ) : null}
            </div>
          </div>

          <ul aria-live="polite" className="flex flex-col gap-3">
            {lines.map((line) => (
              <li
                key={line.id}
                className={cn(
                  "flex flex-col gap-1.5",
                  line.role === "user" ? "items-end" : "items-start",
                )}
              >
                <div
                  className={cn(
                    "flex w-full items-start gap-2",
                    line.role === "user" ? "justify-end" : "justify-start",
                  )}
                >
                  {line.role === "assistant" ? (
                    <ChhotuAvatar size="sm" className="mt-0.5" />
                  ) : null}
                  {line.text ? (
                    <div
                      className={cn(
                        "max-w-[92%] rounded-lg px-3.5 py-2.5 text-sm leading-relaxed",
                        line.role === "user"
                          ? "border border-ember/20 bg-ember-soft text-ink"
                          : "border border-line bg-paper text-ink",
                      )}
                    >
                      {line.text}
                    </div>
                  ) : null}
                </div>
                {line.actions && line.actions.length > 0 ? (
                  <ul className="flex flex-wrap gap-1.5">
                    {line.actions.map((action, index) => (
                      <li
                        key={`${line.id}-a-${index}`}
                        className={cn(
                          "rounded-pill border px-2.5 py-1 text-xs font-medium",
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

            {userDraft ? (
              <li className="flex flex-col items-end gap-1.5">
                <div className="max-w-[92%] rounded-lg border border-ember/20 bg-ember-soft px-3.5 py-2.5 text-sm leading-relaxed text-ink">
                  {userDraft}
                </div>
              </li>
            ) : null}

            {assistantDraft ? (
              <li className="flex flex-col items-start gap-1.5">
                <div className="max-w-[92%] rounded-lg border border-line bg-paper px-3.5 py-2.5 text-sm leading-relaxed text-ink">
                  {assistantDraft}
                  <span
                    aria-hidden
                    className="ml-1 inline-block size-1.5 animate-pulse-soft rounded-pill bg-ember align-middle"
                  />
                </div>
              </li>
            ) : null}
          </ul>

          {activity ? (
            <div role="status" className="flex items-center gap-2 text-sm text-ink-muted">
              <Loader2 className="size-4 shrink-0 animate-spin text-ember" aria-hidden />
              <span>{activity}</span>
            </div>
          ) : null}

          {waiting ? (
            <p className="rounded-md border border-pending/40 bg-pending-surface px-3 py-2 text-sm font-medium text-ink">
              Waiting for your yes: {waiting}
            </p>
          ) : null}

          <div className="flex flex-col gap-2 border-t border-line pt-3">
            <p className="text-[10px] font-semibold tracking-[0.14em] text-ink-subtle uppercase">
              Say it out loud
            </p>
            <ul className="grid gap-1 text-xs leading-snug text-ink-subtle">
              {SPOKEN_EXAMPLES.map((example) => (
                <li key={example}>{example}</li>
              ))}
            </ul>
          </div>
        </div>
      </Drawer>
    </>
  );
}
