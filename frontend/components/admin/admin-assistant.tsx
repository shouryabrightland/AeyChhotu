"use client";

import type { GoogleGenAI } from "@google/genai";
import { Check, Loader2, Mic, Send, TriangleAlert } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { ChhotuAvatar } from "@/components/brand/chhotu-avatar";
import { Button } from "@/components/ui/button";
import { Drawer } from "@/components/ui/drawer";
import { Input } from "@/components/ui/input";
import { ADMIN_TOOL_DECLARATIONS } from "@/lib/ai/admin-tool-declarations";
import { buildAdminSystemPrompt } from "@/lib/ai/admin-system-prompt";
import { describeAdminToolCall, executeAdminTool, type AdminRuntime } from "@/lib/ai/admin-tools";
import { getChhotuClient, isChhotuConfigured } from "@/lib/ai/gemini-client";
import { ChhotuLiveSession, type ChhotuPhase } from "@/lib/ai/live-session";
import type { ChhotuAction, ChhotuMessage } from "@/lib/ai/types";
import {
  getAdminAssistantKey,
  getAdminBestSelling,
  getAdminMenuCatalog,
  getAdminFeedback,
  getAdminInventory,
  getAdminOccupancy,
  getAdminPendingOrders,
  getAdminSalesSummary,
} from "@/lib/api-client";
import { cn } from "@/lib/utils";

/* The manager console's assistant — same Gemini Live session as the diner
   side, different tools and persona.
 *
 * WHY IT IS SAFE TO PUT A MODEL HERE: it can only READ. There is no tool for
 * clearing a table, archiving a dish or changing a price, so the worst a bad
 * answer can do is say something wrong. Every read goes through the admin
 * token (role:"admin"), and the backend re-checks that role on arrival.
 *
 * This component is rendered INSIDE the unlocked console only, so a diner who
 * somehow loads /admin gets the PIN wall instead. */

const QUICK_PROMPTS = [
  "How's today going?",
  "Top 3 dishes today",
  "What's running low?",
  "Any table free?",
  "Pending orders?",
  "What did guests say?",
] as const;

const INTRO: ChhotuMessage = {
  id: "admin-intro",
  role: "assistant",
  text: "Ask me about the numbers: today's takings, best sellers, open tickets, free tables, stock or guest feedback. Voice or type.",
};

function phaseLabel(phase: ChhotuPhase): string | null {
  switch (phase) {
    case "connecting":
      return "Opening the voice line…";
    case "listening":
      return "Listening — tap the mic again when you're done.";
    case "thinking":
      return "Reading the numbers…";
    case "speaking":
      return "Answering…";
    default:
      return null;
  }
}

function MicLevelIcon({ active, level }: { active: boolean; level: number }) {
  if (!active) return <Mic className="size-4" aria-hidden />;
  return (
    <span aria-hidden className="flex h-4 items-end gap-[3px]">
      {[0, 1, 2].map((index) => (
        <span
          key={index}
          className="h-4 w-[3px] origin-bottom animate-mic-live rounded-pill bg-current"
          style={{
            animationDelay: `${index * 130}ms`,
            animationDuration: `${Math.round(950 - Math.min(1, level) * 450)}ms`,
          }}
        />
      ))}
    </span>
  );
}

/** The console's own api-client calls, bound to `AdminRuntime`. */
const ADMIN_RUNTIME: AdminRuntime = {
  salesSummary: () => getAdminSalesSummary(),
  bestSelling: async (limit, days) => (await getAdminBestSelling(days, limit)).items,
  pendingOrders: async () => (await getAdminPendingOrders()).orders,
  occupancy: () => getAdminOccupancy(),
  inventory: () => getAdminInventory(),
  feedback: async (limit) => (await getAdminFeedback(limit)).feedback,
  catalog: async () => (await getAdminMenuCatalog()).items,
};

export function AdminAssistant() {
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
  /* The mic streams through the answer too, so the meter follows the mic, not
     the turn phase. */
  const [micOn, setMicOn] = useState(false);
  const [apiKey, setApiKey] = useState<string | null>(null);
  const [keyChecked, setKeyChecked] = useState(false);

  const sessionRef = useRef<ChhotuLiveSession | null>(null);
  const pendingRef = useRef<Promise<ChhotuLiveSession | null> | null>(null);
  const userDraftRef = useRef("");
  const assistantDraftRef = useRef("");
  const actionsRef = useRef<ChhotuAction[]>([]);
  const idRef = useRef(0);

  const configured = isChhotuConfigured(apiKey);

  /* The key is released by the API to an admin session, not bundled. Fetched
     once, the first time the sheet is opened. */
  useEffect(() => {
    if (!open || keyChecked) return;
    let cancelled = false;

    (async () => {
      try {
        const { gemini_api_key } = await getAdminAssistantKey();
        if (!cancelled) setApiKey(gemini_api_key);
      } catch {
        if (!cancelled) setApiKey(null);
      } finally {
        if (!cancelled) setKeyChecked(true);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [open, keyChecked]);

  const push = useCallback((message: Omit<ChhotuMessage, "id">) => {
    idRef.current += 1;
    setMessages((current) => [...current, { ...message, id: `console-${idRef.current}` }]);
  }, []);

  const flushTurn = useCallback(() => {
    const asked = userDraftRef.current.trim();
    const answered = assistantDraftRef.current.trim();
    const turnActions = actionsRef.current;

    userDraftRef.current = "";
    assistantDraftRef.current = "";
    actionsRef.current = [];
    setUserDraft("");
    setAssistantDraft("");
    setActions([]);

    if (asked) push({ role: "user", text: asked });
    /* A tool-only turn carries no spoken answer; inventing "Done." for it
       spammed the transcript once per tool round-trip. The chips say it. */
    if (answered || turnActions.length > 0) {
      push({
        role: "assistant",
        text: answered,
        ...(turnActions.length > 0 ? { actions: turnActions } : {}),
      });
    }
  }, [push]);

  const ensureSession = useCallback(async (): Promise<ChhotuLiveSession | null> => {
    if (sessionRef.current) return sessionRef.current;
    if (pendingRef.current) return pendingRef.current;

    const ai: GoogleGenAI | null = getChhotuClient(apiKey);
    if (!ai) return null;

    const connect = (async () => {
      const session = new ChhotuLiveSession({
        client: ai,
        systemInstruction: buildAdminSystemPrompt(),
        // The voice the diner sheet used before it switched to Puck.
        voiceName: "Aoede",
        tools: ADMIN_TOOL_DECLARATIONS,
        describe: describeAdminToolCall,
        execute: (name, args) => executeAdminTool(name, args, ADMIN_RUNTIME),
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
  }, [apiKey, flushTurn]);

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
    setMicOn(false);
    setPhase("idle");
  }, []);

  useEffect(() => () => teardown(), [teardown]);

  const listening = phase === "listening";
  const connecting = phase === "connecting";

  async function send(text: string) {
    const trimmed = text.trim();
    if (!trimmed || connecting) return;

    setInput("");
    setError(null);

    if (!configured) {
      push({ role: "assistant", text: "The assistant key isn't configured for this deployment." });
      return;
    }

    let session: ChhotuLiveSession | null = null;
    try {
      session = await ensureSession();
    } catch {
      push({ role: "assistant", text: "I couldn't open the voice line. Try again — nothing was changed." });
      return;
    }
    if (!session) {
      push({ role: "assistant", text: "The assistant isn't available right now." });
      return;
    }

    push({ role: "user", text: trimmed });
    session.sendText(trimmed);
  }

  async function toggleMic() {
    setError(null);
    if (!configured) {
      push({ role: "assistant", text: "The assistant key isn't configured for this deployment." });
      return;
    }

    let session: ChhotuLiveSession | null = null;
    try {
      session = await ensureSession();
    } catch {
      setError("The voice line could not be opened. Try again.");
      return;
    }
    if (!session) return;

    if (session.micActive) {
      session.stopMic();
      setMicOn(false);
      return;
    }

    await session.startMic();
    setMicOn(session.micActive);
  }

  const statusLine = error ?? phaseLabel(phase);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-haspopup="dialog"
        aria-label="Ask the console assistant"
        className="fixed right-5 bottom-5 z-40 inline-flex cursor-pointer items-center gap-2 rounded-pill bg-ink px-4 py-3 font-sans text-sm font-semibold text-ink-inverse shadow-lg transition-transform duration-[var(--duration-fast)] ease-gentle hover:-translate-y-0.5 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-ink/20"
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
        title="Console assistant"
        description="Voice or type — sales, stock, tables, tickets, feedback."
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
                aria-label="Message the console assistant"
                placeholder={listening ? "Listening…" : "Ask about today's numbers…"}
                value={input}
                maxLength={500}
                onChange={(event) => setInput(event.target.value)}
                containerClassName="min-w-0 flex-1"
              />

              <Button
                type="button"
                variant={listening ? "ember" : "soft"}
                size="md"
                aria-label={listening ? "Stop listening" : "Talk to the assistant"}
                aria-pressed={listening}
                onClick={() => void toggleMic()}
                disabled={connecting || !keyChecked}
                className={cn("h-12 shrink-0 px-3", listening && "ring-2 ring-ember/40")}
                leftIcon={<MicLevelIcon active={micOn} level={micLevel} />}
              >
                <span className="sr-only">{listening ? "Stop listening" : "Voice"}</span>
              </Button>

              <Button
                type="submit"
                variant="ember"
                size="md"
                disabled={!input.trim() || connecting}
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
          {keyChecked && !configured ? (
            <p className="rounded-md border border-pending/30 bg-pending-surface px-3 py-2 text-sm text-ink">
              GEMINI_API_KEY is not set on the API, so the assistant is off.
            </p>
          ) : null}

          <ul className="flex flex-col gap-3" aria-live="polite">
            {messages.map((message) => (
              <li
                key={message.id}
                className={cn("flex flex-col gap-1.5", message.role === "user" ? "items-end" : "items-start")}
              >
                <div
                  className={cn(
                    "flex w-full items-start gap-2",
                    message.role === "user" ? "justify-end" : "justify-start",
                  )}
                >
                  {message.role === "assistant" ? (
                    <ChhotuAvatar size="sm" className="mt-0.5" />
                  ) : null}
                  {message.text ? (
                    <div
                      className={cn(
                        "max-w-[92%] rounded-lg px-3.5 py-2.5 text-sm leading-relaxed",
                        message.role === "user"
                          ? "border border-ember/20 bg-ember-soft text-ink"
                          : "border border-line bg-paper text-ink",
                      )}
                    >
                      {message.text}
                    </div>
                  ) : null}
                </div>
                {message.actions && message.actions.length > 0 ? (
                  <ul className="flex flex-wrap gap-1.5">
                    {message.actions.map((action, index) => (
                      <li
                        key={`${message.id}-a-${index}`}
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
                  <span aria-hidden className="ml-1 inline-block size-1.5 animate-pulse-soft rounded-pill bg-ember align-middle" />
                </div>
              </li>
            ) : null}
          </ul>

          {activity ? (
            <div className="flex items-center gap-2 text-sm text-ink-muted" role="status">
              <Loader2 className="size-4 shrink-0 animate-spin text-ember" aria-hidden />
              <span>{activity}</span>
            </div>
          ) : null}

          {messages.length === 1 && !userDraft && !assistantDraft ? (
            <div role="group" aria-label="Quick questions" className="flex flex-wrap gap-2 pt-1">
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
        </div>
      </Drawer>
    </>
  );
}
