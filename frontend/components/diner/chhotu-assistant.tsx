"use client";

import type { GoogleGenAI } from "@google/genai";
import { Check, Loader2, Mic, Send, TriangleAlert } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { ChhotuAvatar } from "@/components/brand/chhotu-avatar";
import { DishPhoto } from "@/components/diner/dish-photo";
import { Button } from "@/components/ui/button";
import { Drawer } from "@/components/ui/drawer";
import { Input } from "@/components/ui/input";
import type { LiveTableValue } from "@/hooks/use-live-table";
import { getChhotuClient, isChhotuConfigured } from "@/lib/ai/gemini-client";
import { ChhotuLiveSession, type ChhotuPhase } from "@/lib/ai/live-session";
import { buildChhotuSystemPrompt } from "@/lib/ai/system-prompt";
import { TOOL_DECLARATIONS } from "@/lib/ai/tool-declarations";
import { describeToolCall, executeTool } from "@/lib/ai/tools";
import type { ChhotuAction, ChhotuMessage, ChhotuRuntime } from "@/lib/ai/types";
import {
  fireTableOrder as apiFireOrder,
  removeCartItem as apiRemoveCartItem,
  requestTableBill as apiRequestTableBill,
  submitTableFeedback as apiSubmitTableFeedback,
  updateCartItem as apiUpdateCartItem,
  upsertCartItem as apiUpsertCartItem,
} from "@/lib/api-client";
import { getStoredDisplayName } from "@/lib/api/session";
import { getGrantedSession } from "@/lib/api/table-session";
import { formatPrice } from "@/lib/format";
import { cn } from "@/lib/utils";

/* Chhotu — the floating waiter, now voice-to-voice.

   One Gemini LIVE session carries everything: the microphone goes up as PCM,
   the spoken answer comes back down, and typed text travels over the same
   socket (`sendText`). There is no text-only model anywhere in the app.

   Tool calls arrive over the socket and run HERE, against the same REST
   endpoints (and the same table token) as the rest of the diner UI. Any write
   triggers `live.refresh()` so the cart, bill and KDS-visible state follow
   without a reload.

   Confirmation for fire/bill/clear is PROMPT-ONLY by product decision: the
   system instruction forbids acting in the request turn, but the server does
   not hold a pending-action token. The database guards (fire_order RPC,
   one-active-order index, table scoping) still apply. */

const QUICK_PROMPTS = [
  "What's good tonight?",
  "Something spicy under ₹250",
  "Add 2 masala dosa",
  "Where's my order?",
  "Get the bill",
] as const;

const INTRO: ChhotuMessage = {
  id: "intro",
  role: "assistant",
  text: "Namaste! I'm Chhotu, your table's waiter. Talk to me or type — ask what's good, add dishes to the shared cart, or check on your order.",
};

export interface ChhotuAssistantProps {
  tableToken: string;
  live: LiveTableValue;
  /** Hydrated guest name on the menu screen; the tracker reads storage. */
  displayName?: string;
  /** Positioning for the floating trigger (bottom offsets differ per screen). */
  className?: string;
}

function phaseLabel(phase: ChhotuPhase): string | null {
  switch (phase) {
    case "connecting":
      return "Opening the voice line…";
    case "listening":
      return "Listening — speak, then tap the mic again when you're done.";
    case "thinking":
      return "Chhotu is thinking…";
    case "speaking":
      return "Chhotu is speaking…";
    default:
      return null;
  }
}

export function ChhotuAssistant({ tableToken, live, displayName, className }: ChhotuAssistantProps) {
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState<ChhotuMessage[]>([INTRO]);
  const [input, setInput] = useState("");
  const [userDraft, setUserDraft] = useState("");
  const [assistantDraft, setAssistantDraft] = useState("");
  const [actions, setActions] = useState<ChhotuAction[]>([]);
  const [phase, setPhase] = useState<ChhotuPhase>("idle");
  const [activity, setActivity] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [micLevel, setMicLevel] = useState(0);

  const sessionRef = useRef<ChhotuLiveSession | null>(null);
  const pendingRef = useRef<Promise<ChhotuLiveSession | null> | null>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const idRef = useRef(0);

  /* The session lives longer than a render, so it reads the newest snapshot
     through refs: a tool must never act on the cart as it looked when the
     drawer opened. */
  const liveRef = useRef(live);
  const userDraftRef = useRef("");
  const assistantDraftRef = useRef("");
  const actionsRef = useRef<ChhotuAction[]>([]);
  const nameRef = useRef("");

  /* Refs are written from effects, never during render: the session outlives
     a render but a tool must still see the newest snapshot. */
  useEffect(() => {
    liveRef.current = live;
  }, [live]);

  useEffect(() => {
    nameRef.current = (displayName || getStoredDisplayName()).trim();
  }, [displayName]);

  /* Released with the table credentials, never baked into the bundle: the
     gate has granted a session before this component renders. */
  const apiKey = getGrantedSession(tableToken)?.gemini_api_key ?? null;
  const configured = isChhotuConfigured(apiKey);

  const push = useCallback((message: Omit<ChhotuMessage, "id">) => {
    idRef.current += 1;
    setMessages((current) => [...current, { ...message, id: `chhotu-${idRef.current}` }]);
  }, []);

  /** Close the turn: whatever was heard/spoken becomes a pair of bubbles. */
  const flushTurn = useCallback(() => {
    const heard = userDraftRef.current.trim();
    const spoken = assistantDraftRef.current.trim();
    const turnActions = actionsRef.current;

    userDraftRef.current = "";
    assistantDraftRef.current = "";
    actionsRef.current = [];
    setUserDraft("");
    setAssistantDraft("");
    setActions([]);

    if (heard) push({ role: "user", text: heard });
    if (spoken || turnActions.length > 0) {
      push({
        role: "assistant",
        text: spoken || "Done.",
        ...(turnActions.length > 0 ? { actions: turnActions } : {}),
      });
    }
  }, [push]);

  /** Lazily open the Live socket, once, for both voice and text. */
  const ensureSession = useCallback(async (): Promise<ChhotuLiveSession | null> => {
    if (sessionRef.current) return sessionRef.current;
    if (pendingRef.current) return pendingRef.current;

    const ai: GoogleGenAI | null = getChhotuClient(apiKey);
    if (!ai) return null;

    const guestName = nameRef.current || (displayName || getStoredDisplayName()).trim();

    const connect = (async () => {
      const tableCode = liveRef.current.table?.code ?? tableToken;
      const session = new ChhotuLiveSession({
        client: ai,
        systemInstruction: buildChhotuSystemPrompt(guestName, tableCode),
        // A warm male waiter voice; the console keeps Aoede.
        voiceName: "Puck",
        tools: TOOL_DECLARATIONS,
        describe: describeToolCall,
        // Fresh snapshot per tool call, so an 86 or a tablemate's edit is seen.
        execute: (name, args) =>
          executeTool(name, args, buildRuntime(liveRef.current, tableToken, guestName)),
        callbacks: {
          onPhase: setPhase,
          onUserSpeech: (delta) => {
            userDraftRef.current += delta;
            setUserDraft(userDraftRef.current);
          },
          onAssistantSpeech: (delta) => {
            assistantDraftRef.current += delta;
            setAssistantDraft(assistantDraftRef.current);
          },
          onTurnComplete: flushTurn,
          onActivity: setActivity,
          onActions: (next) => {
            actionsRef.current = [...actionsRef.current, ...next];
            setActions(actionsRef.current);
          },
          onMicLevel: setMicLevel,
          onMutated: () => {
            void liveRef.current.refresh();
          },
          onError: setError,
        },
      });

      await session.connect();
      sessionRef.current = session;
      return session;
    })();

    pendingRef.current = connect;
    try {
      return await connect;
    } finally {
      pendingRef.current = null;
    }
  }, [apiKey, displayName, flushTurn, tableToken]);

  const teardown = useCallback(() => {
    sessionRef.current?.close();
    sessionRef.current = null;
    userDraftRef.current = "";
    assistantDraftRef.current = "";
    actionsRef.current = [];
    setUserDraft("");
    setAssistantDraft("");
    setActions([]);
    setActivity(null);
    setMicLevel(0);
    setPhase("idle");
  }, []);

  useEffect(() => () => teardown(), [teardown]);

  useEffect(() => {
    if (!open) return;
    endRef.current?.scrollIntoView({ block: "end" });
  }, [open, messages, activity, userDraft, assistantDraft]);

  const listening = phase === "listening";
  const connecting = phase === "connecting";

  async function send(text: string) {
    const trimmed = text.trim();
    if (!trimmed || connecting) return;

    setInput("");
    setError(null);

    if (!configured) {
      push({
        role: "assistant",
        text: "Chhotu isn't switched on for this build yet. You can still browse the menu and add dishes yourself.",
      });
      return;
    }

    let session: ChhotuLiveSession | null = null;
    try {
      session = await ensureSession();
    } catch {
      push({
        role: "assistant",
        text: "I couldn't open the voice line. Check your connection and try again — nothing was changed.",
      });
      return;
    }

    if (!session) {
      push({ role: "assistant", text: "Chhotu isn't available right now. Please order from the menu." });
      return;
    }

    // Typed words are not transcribed back by the server, so echo them here.
    push({ role: "user", text: trimmed });
    session.sendText(trimmed);
  }

  async function toggleMic() {
    setError(null);

    if (!configured) {
      push({
        role: "assistant",
        text: "Chhotu isn't switched on for this build yet. You can still browse the menu and add dishes yourself.",
      });
      return;
    }

    let session: ChhotuLiveSession | null = null;
    try {
      session = await ensureSession();
    } catch {
      setError("The voice line could not be opened. Check your connection and try again.");
      return;
    }

    if (!session) return;

    if (session.micActive) session.stopMic();
    else await session.startMic();
  }

  const canSend = input.trim().length > 0 && !connecting;
  const statusLine = error ?? phaseLabel(phase);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-haspopup="dialog"
        aria-label="Ask Chhotu, your AI waiter"
        className={cn(
          "fixed right-4 z-40 inline-flex cursor-pointer items-center gap-2 rounded-pill border border-ember/30 bg-ember px-4 py-3 font-sans text-sm font-semibold text-on-ember shadow-lg transition-transform duration-[var(--duration-fast)] ease-gentle hover:-translate-y-0.5 hover:bg-ember-strong focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-ember/25",
          className ?? "bottom-24 lg:bottom-6",
        )}
      >
        <ChhotuAvatar size="sm" />
        <span>Ask Chhotu</span>
      </button>

      <Drawer
        open={open}
        onClose={() => {
          teardown();
          setOpen(false);
        }}
        title="Chhotu"
        description="Your table's waiter — talk or type, ask, add, fire, track."
        size="md"
        footer={
          <div className="flex w-full flex-col gap-2">
            {statusLine ? (
              <p
                role={error ? "alert" : "status"}
                className={cn("text-xs font-medium", error ? "text-alert" : "text-ink-muted")}
              >
                {statusLine}
              </p>
            ) : null}

            <form
              className="flex items-end gap-2"
              onSubmit={(event) => {
                event.preventDefault();
                void send(input);
              }}
            >
              <Input
                aria-label="Message Chhotu"
                placeholder={listening ? "Listening…" : "Ask for a dish, or say what to add…"}
                value={input}
                maxLength={500}
                onChange={(event) => setInput(event.target.value)}
                containerClassName="min-w-0 flex-1"
              />

              <Button
                type="button"
                variant={listening ? "ember" : "soft"}
                size="md"
                aria-label={listening ? "Stop listening" : "Talk to Chhotu"}
                aria-pressed={listening}
                onClick={() => void toggleMic()}
                disabled={connecting}
                className={cn("h-12 shrink-0 px-3", listening && "ring-2 ring-ember/40")}
                leftIcon={<MicLevelIcon listening={listening} level={micLevel} />}
              >
                <span className="sr-only">{listening ? "Stop listening" : "Voice"}</span>
              </Button>

              <Button
                type="submit"
                variant="ember"
                size="md"
                disabled={!canSend}
                aria-label="Send message"
                className="h-12 shrink-0 px-3"
                leftIcon={<Send className="size-4" aria-hidden />}
              >
                <span className="sr-only">Send</span>
              </Button>
            </form>
          </div>
        }
      >
        <div className="flex flex-col gap-4">
          {!configured ? (
            <p className="rounded-md border border-pending/30 bg-pending-surface px-3 py-2 text-sm text-ink">
              Chhotu isn&apos;t configured in this build. The menu and cart still work normally.
            </p>
          ) : null}

          <ul className="flex flex-col gap-3" aria-live="polite">
            {messages.map((message) => (
              <MessageBubble key={message.id} message={message} />
            ))}

            {userDraft ? (
              <MessageBubble
                message={{ id: "draft-user", role: "user", text: userDraft }}
                live
              />
            ) : null}

            {assistantDraft ? (
              <MessageBubble
                message={{
                  id: "draft-assistant",
                  role: "assistant",
                  text: assistantDraft,
                  ...(actions.length > 0 ? { actions } : {}),
                }}
                live
              />
            ) : null}
          </ul>

          {activity ? (
            <div className="flex items-center gap-2 text-sm text-ink-muted" role="status">
              <Loader2 className="size-4 shrink-0 animate-spin text-ember" aria-hidden />
              <span>{activity}</span>
            </div>
          ) : null}

          {messages.length === 1 && !userDraft && !assistantDraft ? (
            <div role="group" aria-label="Quick requests" className="flex flex-wrap gap-2 pt-1">
              {QUICK_PROMPTS.map((prompt) => (
                <button
                  key={prompt}
                  type="button"
                  disabled={connecting}
                  onClick={() => void send(prompt)}
                  className="cursor-pointer rounded-pill border border-line-strong bg-paper px-3 py-1.5 text-xs font-medium text-ink transition-colors duration-[var(--duration-fast)] ease-gentle hover:border-ember/40 hover:bg-ember-soft/50 focus-visible:border-ember focus-visible:outline-none disabled:pointer-events-none disabled:opacity-50"
                >
                  {prompt}
                </button>
              ))}
            </div>
          ) : null}

          <div ref={endRef} />
        </div>
      </Drawer>
    </>
  );
}

function MessageBubble({ message, live = false }: { message: ChhotuMessage; live?: boolean }) {
  const fromChhotu = message.role === "assistant";

  return (
    <li className={cn("flex flex-col gap-1.5", fromChhotu ? "items-start" : "items-end")}>
      <div className={cn("flex w-full items-start gap-2", fromChhotu ? "justify-start" : "justify-end")}>
        {fromChhotu ? <ChhotuAvatar size="sm" className="mt-0.5" /> : null}

        <div
          className={cn(
            "max-w-[92%] rounded-lg px-3.5 py-2.5 text-sm leading-relaxed",
            fromChhotu
              ? "border border-line bg-paper text-ink"
              : "border border-ember/20 bg-ember-soft text-ink",
          )}
        >
          {message.text}
          {live ? (
            <span aria-hidden className="ml-1 inline-block size-1.5 animate-pulse-soft rounded-pill bg-ember align-middle" />
          ) : null}
        </div>
      </div>

      {message.actions && message.actions.length > 0 ? (
        <ul className="flex w-full flex-wrap gap-1.5">
          {message.actions.map((action, index) =>
            action.dishes && action.dishes.length > 0 ? (
              /* A dish result is shown, not just announced: the same plate
                 treatment the menu uses, so a recommendation reads like the
                 menu instead of a list of names. */
              <li key={`${message.id}-dishes-${index}`} className="w-full">
                <p className="mb-1.5 text-xs font-medium text-ink-muted">{action.label}</p>
                <ul className="flex gap-2 overflow-x-auto pb-1">
                  {action.dishes.map((dish) => (
                    <li key={dish.id} className="w-32 shrink-0">
                      <DishPhoto item={dish} sizes="128px" muted={!dish.is_available} />
                      <p className="mt-1 truncate font-display text-xs text-ink">{dish.name}</p>
                      <p className="text-[11px] text-ink-subtle">
                        {formatPrice(dish.price)}
                        {dish.is_available ? "" : " · ran out"}
                      </p>
                    </li>
                  ))}
                </ul>
              </li>
            ) : (
              <li
                key={`${message.id}-action-${index}`}
                className={cn(
                  "inline-flex items-center gap-1.5 rounded-pill border px-2.5 py-1 text-xs font-medium",
                  action.ok
                    ? "border-ready/35 bg-ready-surface text-ready"
                    : "border-alert/35 bg-alert-surface text-alert",
                )}
              >
                {action.ok ? (
                  <Check className="size-3" aria-hidden />
                ) : (
                  <TriangleAlert className="size-3" aria-hidden />
                )}
                {action.label}
              </li>
            ),
          )}
        </ul>
      ) : null}
    </li>
  );
}

/** Bind the table and guest name OUTSIDE the model's reach. */
function buildRuntime(live: LiveTableValue, tableToken: string, userName: string): ChhotuRuntime {
  return {
    userName,
    menu: live.menu,
    cart: live.cart,
    orders: live.orders,
    billStatus: live.billStatus,
    addCartItem: (input) => apiUpsertCartItem({ table_token: tableToken, ...input }),
    updateCartItem: (cartItemId, patch) =>
      apiUpdateCartItem(cartItemId, { table_token: tableToken, ...patch }),
    removeCartItem: (cartItemId) =>
      apiRemoveCartItem({ table_token: tableToken, cart_item_id: cartItemId }),
    fireOrder: () => apiFireOrder(tableToken),
    requestBill: () => apiRequestTableBill(tableToken),
    leaveFeedback: (input) => apiSubmitTableFeedback(tableToken, input),
    refresh: () => live.refresh(),
    now: Date.now,
  };
}

/** The mic's own feedback: three bars that move with the guest's voice, so it
    is obvious the phone is hearing them. Minimal by design — no waveform. */
function MicLevelIcon({ listening, level }: { listening: boolean; level: number }) {
  if (!listening) return <Mic className="size-4" aria-hidden />;
  return (
    <span aria-hidden className="flex h-4 items-end gap-[3px]">
      {[0.45, 1, 0.7].map((scale, index) => (
        <span
          key={index}
          className="w-[3px] rounded-pill bg-current transition-[height] duration-75 ease-out"
          style={{ height: `${4 + Math.min(1, level * 2.2) * 12 * scale}px` }}
        />
      ))}
    </span>
  );
}
