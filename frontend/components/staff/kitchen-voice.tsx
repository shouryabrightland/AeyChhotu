"use client";

import { Loader2, Mic, Sparkles, Square } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
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
import { KITCHEN_WAKE } from "@/lib/ai/wake-word";
import { getKdsAssistantKey } from "@/lib/api-client";
import type { MenuItem, Order } from "@/lib/api/types";
import { cn } from "@/lib/utils";

/* The kitchen's voice assistant — the same Live session the diner sheet and
   the manager console use, with the board's tools behind it.

   READ ONLY ON THE PAGE, VOICE ONLY IN PRACTICE: there is no text box and no
   send button. The transcript is history, never an input. The cook either taps
   the mic once (browsers require one gesture before any mic can open) or, once
   it is listening, just says "Aey Chhotu" (or "Chhotu") followed by a command.

   WHY THE MIC NOW ACTUALLY OPENS: the first version fetched the key and opened
   the socket before touching Web Audio. Chrome starts an AudioContext created
   outside a gesture SUSPENDED, and a suspended context never fires
   `onaudioprocess`, so the panel looked connected and streamed silence.
   `primeAudio()` is therefore called synchronously inside the tap, and
   `startMic()` reuses that running clock. Once the browser has remembered the
   permission, the panel also starts itself on load (see `autoStart`).

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
  /** Bumped by the board's header button to open this dock from outside. */
  openRequest?: number;
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

const INTRO: VoiceLine = {
  id: "kitchen-intro",
  role: "assistant",
  text: "Bolo “Aey Chhotu” — board dekho, table four ready karo, ya dish 86 karo. Voice only; yeh pane read-only hai.",
};

function statusText(
  enabled: boolean,
  phase: ChhotuPhase,
  wakeHeard: boolean,
  busy: boolean,
): string {
  if (busy) return "Opening the kitchen line…";
  if (wakeHeard) return "Aey Chhotu heard…";
  if (!enabled) return "Tap the mic once, then just talk.";
  if (phase === "connecting") return "Opening the voice line…";
  if (phase === "thinking") return "Reading the board…";
  if (phase === "speaking") return "Answering…";
  if (phase === "error") return "The line dropped — tap Start to reconnect.";
  return 'Listening — say "Aey Chhotu".';
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
            className="w-[3px] rounded-pill bg-current transition-[height] duration-75 ease-out"
            style={{
              height: `${4 + Math.min(1, Math.max(listening ? 0.18 : 0, level) * 2.2) * 12 * scale}px`,
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
  openRequest = 0,
}: KitchenVoiceProps) {
  const [open, setOpen] = useState(false);
  const [enabled, setEnabled] = useState(false);
  const [busy, setBusy] = useState(false);
  const [phase, setPhase] = useState<ChhotuPhase>("idle");
  const [level, setLevel] = useState(0);
  const [activity, setActivity] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [wakeHeard, setWakeHeard] = useState(false);
  const [waiting, setWaiting] = useState<string | null>(null);
  const [lines, setLines] = useState<VoiceLine[]>([INTRO]);
  const [userDraft, setUserDraft] = useState("");
  const [assistantDraft, setAssistantDraft] = useState("");
  const [keyState, setKeyState] = useState<"checking" | "ready" | "missing">("checking");

  const sessionRef = useRef<ChhotuLiveSession | null>(null);
  const startingRef = useRef(false);
  const autoStartedRef = useRef(false);
  const apiKeyRef = useRef<string | null>(null);
  const userDraftRef = useRef("");
  const assistantDraftRef = useRef("");
  const actionsRef = useRef<ChhotuAction[]>([]);
  const idRef = useRef(0);
  const wakeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

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
          text: answered || "Done.",
          ...(turnActions.length > 0 ? { actions: turnActions } : {}),
        });
      }
      return next.slice(-HISTORY_LIMIT);
    });

    setWaiting(toolsetRef.current?.pendingDescription() ?? null);
  }, []);

  const start = useCallback(
    async (fromGesture: boolean) => {
      if (startingRef.current || sessionRef.current) return;

      const apiKey = apiKeyRef.current;
      if (!apiKey) {
        setOpen(true);
        setError("Voice is off: GEMINI_API_KEY is not set on the API.");
        return;
      }

      const ai = getChhotuClient(apiKey);
      if (!ai) {
        setOpen(true);
        setError("Voice is off: the assistant key was empty.");
        return;
      }

      startingRef.current = true;
      setBusy(true);
      setError(null);

      const session = new ChhotuLiveSession({
        client: ai,
        systemInstruction: buildKitchenSystemPrompt(),
        voiceName: KITCHEN_VOICE,
        tools: KITCHEN_TOOL_DECLARATIONS,
        describe: (name, args) => ensureToolset().describe(name, args),
        execute: (name, args) => ensureToolset().execute(name, args),
        wakePhrase: KITCHEN_WAKE,
        callbacks: {
          onPhase: setPhase,
          onMicLevel: setLevel,
          onActivity: setActivity,
          onWake: () => {
            // A heard wake word always brings the assistant to the front.
            setOpen(true);
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
          onError: (message) => setError(message),
        },
      });

      /* SYNCHRONOUS, inside the tap: Chrome starts any AudioContext created
         after an await suspended, and a suspended context streams silence.
         Also primed on the auto-start path (the PIN tap already grants this
         page sticky activation, so the clock usually runs there too). */
      session.primeAudio();

      sessionRef.current = session;

      try {
        await session.connect();
        await session.startMic();

        if (!session.micActive) {
          // Permission denied or the browser muted the tab; keep the panel open
          // so the cook sees why and can tap again.
          sessionRef.current = null;
          session.close();
          setEnabled(false);
          setOpen(true);
          return;
        }

        /* The tap is the address, so the first sentence needs no wake word.
           One turn only; then the wake gate re-arms. */
        if (fromGesture) session.addressNextTurn();

        setEnabled(true);
        // Arming the chime is part of opening the kitchen's voice line.
        void onStartShift();
      } catch {
        sessionRef.current = null;
        session.close();
        setEnabled(false);
        setOpen(true);
        setError("The voice line could not open. Tap the mic to try again — nothing was changed.");
      } finally {
        startingRef.current = false;
        setBusy(false);
      }
    },
    [ensureToolset, flush, onStartShift],
  );

  /* The board's header has its own "Chhotu" button: same tap, same one-turn
     address, so the assistant is discoverable without hunting for the pill. */
  useEffect(() => {
    if (!openRequest) return;

    /* Deferred by a tick so this is a subscription callback, not a cascading
       setState inside the effect body. Sticky activation from the header
       click still lets the audio clock start. */
    const timer = window.setTimeout(() => {
      setOpen(true);
      void start(true);
    }, 0);

    return () => window.clearTimeout(timer);
  }, [openRequest, start]);

  /* Once the browser remembers the mic permission, the kitchen line opens by
     itself: the cook says "Aey Chhotu" with no tap at all. Without permission
     this quietly does nothing and the pill asks for the one tap browsers
     require. */
  useEffect(() => {
    if (keyState !== "ready" || autoStartedRef.current) return;
    autoStartedRef.current = true;

    let cancelled = false;
    void (async () => {
      try {
        const query = navigator.permissions?.query({
          name: "microphone" as PermissionName,
        });
        const status = await query;
        if (!cancelled && status?.state === "granted") void start(false);
      } catch {
        /* Safari / Firefox: leave the start to the tap. */
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [keyState, start]);

  const stop = useCallback(() => {
    sessionRef.current?.close();
    sessionRef.current = null;
    setEnabled(false);
    setPhase("idle");
    setLevel(0);
    setActivity(null);
    setWaiting(null);
    setUserDraft("");
    setAssistantDraft("");
    userDraftRef.current = "";
    assistantDraftRef.current = "";
  }, []);

  useEffect(
    () => () => {
      sessionRef.current?.close();
      if (wakeTimer.current !== null) clearTimeout(wakeTimer.current);
    },
    [],
  );

  const listening = enabled && phase !== "connecting";
  const status = error ?? statusText(enabled, phase, wakeHeard, busy);

  return (
    <>
      <button
        type="button"
        onClick={() => {
          setOpen(true);
          /* One tap is required by the browser before any mic can open; after
             that, "Aey Chhotu" (or just "Chhotu") is the only control. */
          if (!enabled && !busy) void start(true);
        }}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label="Kitchen voice assistant"
        className="fixed right-5 bottom-5 z-40 inline-flex cursor-pointer items-center gap-2 rounded-pill bg-ink px-4 py-3 text-sm font-semibold text-ink-inverse shadow-lg transition-transform duration-[var(--duration-fast)] ease-gentle hover:-translate-y-0.5 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-ink/20"
      >
        {enabled ? (
          <span className="text-on-ember">
            <MicLevel level={level} listening={listening} />
          </span>
        ) : (
          <Sparkles className="size-4" aria-hidden />
        )}
        <span>{enabled ? "Voice on" : "Ask Chhotu"}</span>
      </button>

      <Drawer
        open={open}
        onClose={() => setOpen(false)}
        title="Kitchen voice"
        description="Read only — talk to it, nothing to type."
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
              variant={enabled ? "outline" : "ember"}
              size="lg"
              fullWidth
              disabled={busy || keyState === "checking"}
              onClick={() => {
                if (enabled) stop();
                else void start(true);
              }}
              leftIcon={
                busy ? (
                  <Loader2 className="size-4 animate-spin" aria-hidden />
                ) : enabled ? (
                  <Square className="size-3.5" aria-hidden />
                ) : (
                  <Mic className="size-4" aria-hidden />
                )
              }
            >
              {busy ? "Opening…" : enabled ? "Stop listening" : "Start listening"}
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
                    "max-w-[92%] rounded-lg px-3.5 py-2.5 text-sm leading-relaxed",
                    line.role === "user"
                      ? "border border-ember/20 bg-ember-soft text-ink"
                      : "border border-line bg-paper text-ink",
                  )}
                >
                  {line.text}
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

          <p className="text-xs leading-snug text-ink-subtle">
            Say &ldquo;Aey Chhotu&rdquo; or just &ldquo;Chhotu&rdquo; before a command — board
            dekho, table four ready, dish 86, shift start. Answers come back as speech, and this
            transcript is the only record.
          </p>
        </div>
      </Drawer>
    </>
  );
}
