/* Chhotu's voice — a Gemini LIVE session that runs entirely in this browser.

   WHY LIVE AND NOTHING ELSE: the waiter is voice-to-voice. One socket carries
   the guest's microphone up and the spoken answer down, so the model hears
   tone and interruption instead of reading a transcript. Text typed into the
   sheet is sent through the SAME session (`sendClientContent`), which is why
   there is no second, text-only model anywhere in the app.

   The key is never bundled: the backend releases it with the table session
   (see lib/ai/gemini-client.ts), so only a device that has proven it belongs
   to a table can open a socket.

   TOOLS: a `toolCall` arrives over the socket and is executed here, against
   the same REST endpoints the UI uses. The result goes back up the socket as
   a `functionResponse`. The table token is bound in `ChhotuRuntime` and is
   never model-supplied, so a prompt cannot retarget another table.

   AUDIO: 16 kHz PCM16 mono up, 24 kHz PCM16 mono down, both base64 — the
   formats the Live API documents. Mic capture uses a ScriptProcessorNode
   (deprecated but universally available) and playback queues
   AudioBufferSourceNodes so chunks butt together without gaps. */

import {
  Modality,
  type FunctionCall,
  type FunctionDeclaration,
  type LiveServerMessage,
  type Session,
} from "@google/genai";
import type { GoogleGenAI } from "@google/genai";
import type { ChhotuAction, ToolExecution } from "./types";
import { containsWakePhrase, type WakePhrase } from "./wake-word";

/** The only model this app talks to: Gemini 3.8 Live. It is a native-audio
 *  Live model, so the same session takes speech and text.
 *
 *  WHY NOT `gemini-3.8-live-extended-thinking`: it is listed by the Models
 *  API, but a direct probe of the same config used here never completed the
 *  handshake (the connect promise stayed unsettled — no setup, no error).
 *  `gemini-3.8-live` answers with audio and a transcript, so that is what
 *  ships. Override per deployment with NEXT_PUBLIC_CHHOTU_LIVE_MODEL if a
 *  newer Live model is verified — never point this at a text-only model, the
 *  sheet has no path for one. */
export const CHHOTU_LIVE_MODEL =
  process.env.NEXT_PUBLIC_CHHOTU_LIVE_MODEL?.trim() || "gemini-3.8-live";

/* Voices are chosen per surface, not globally: the diner's waiter is a warm
   male voice (Puck), the manager console keeps Aoede. Both are prebuilt
   Gemini voices, so nothing has to be trained or hosted. */

const MIC_SAMPLE_RATE = 16_000;
const OUTPUT_SAMPLE_RATE = 24_000;

/** A Live handshake that has not answered by now is not going to: an
 *  unsupported model or a blocked socket leaves `connect()` pending forever,
 *  which looked to the guest like a sheet stuck on "Opening the voice line". */
const CONNECT_TIMEOUT_MS = 15_000;

/** How long a model turn may sit unaddressed while its transcript is still
 *  arriving. Passing the gate is instant (the transcript contains the wake
 *  word); this only bounds how long a non-addressed turn stays buffered before
 *  it is dropped. */
const WAKE_GATE_GRACE_MS = 3_000;

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(message));
      },
    );
  });
}

export type ChhotuPhase =
  | "idle"
  | "connecting"
  | "ready"
  | "listening"
  | "thinking"
  | "speaking"
  | "error";

export interface ChhotuLiveCallbacks {
  onPhase?: (phase: ChhotuPhase) => void;
  /** Incremental transcript of what the guest said (voice only). */
  onUserSpeech?: (delta: string) => void;
  /** Incremental transcript of Chhotu's answer. */
  onAssistantSpeech?: (delta: string) => void;
  /** The model finished a turn: flush the transcript bubbles. */
  onTurnComplete?: () => void;
  onActivity?: (label: string | null) => void;
  onActions?: (actions: ChhotuAction[]) => void;
  /** 0–1 loudness of the guest's microphone, ~12 times a second, so the sheet
      can show that the mic is actually hearing something. */
  onMicLevel?: (level: number) => void;
  /** The wake phrase was actually heard (kitchen only). Lets the UI flash
      "Aey Chhotu" without exposing every stray kitchen word. */
  onWake?: () => void;
  /** A tool wrote to the server; the caller should refresh live state. */
  onMutated?: () => void;
  onError?: (message: string) => void;
}

export interface ChhotuLiveOptions {
  client: GoogleGenAI;
  /** The persona. The diner sheet and the manager console each bring one. */
  systemInstruction: string;
  /** Exactly the functions this surface may call — nothing shared. */
  tools: FunctionDeclaration[];
  /** Runs one call in this browser. The table/admin credential is bound in
      the caller's closure and is never model-supplied. */
  execute: (name: string, args: Record<string, unknown>) => Promise<ToolExecution>;
  /** Activity label for the sheet while a tool is running. */
  describe?: (name: string, args: Record<string, unknown>) => string;
  /** Prebuilt voice name (Puck, Aoede, Kore…). Chosen per surface. */
  voiceName: string;
  /** KITCHEN ONLY. When set, the session stays silent until this phrase is
      heard, and no tool runs for a turn that did not contain it. The mic keeps
      streaming (a cook has no free hands); the gate is on the transcript. */
  wakePhrase?: WakePhrase;
  callbacks?: ChhotuLiveCallbacks;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x2000;
  for (let offset = 0; offset < bytes.length; offset += chunk) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunk));
  }
  return btoa(binary);
}

function base64ToBytes(data: string): Uint8Array {
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

/** Average decimation from the browser's rate down to 16 kHz. */
function downsample(input: Float32Array, from: number, to: number): Float32Array {
  if (from === to) return input;
  const ratio = from / to;
  const length = Math.floor(input.length / ratio);
  const output = new Float32Array(length);
  for (let index = 0; index < length; index += 1) {
    const start = Math.floor(index * ratio);
    const end = Math.min(Math.floor((index + 1) * ratio), input.length);
    let sum = 0;
    for (let cursor = start; cursor < end; cursor += 1) sum += input[cursor] as number;
    output[index] = sum / Math.max(1, end - start);
  }
  return output;
}

function toPcm16(samples: Float32Array): Uint8Array {
  const view = new DataView(new ArrayBuffer(samples.length * 2));
  for (let index = 0; index < samples.length; index += 1) {
    const clamped = Math.max(-1, Math.min(1, samples[index] as number));
    view.setInt16(index * 2, clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff, true);
  }
  return new Uint8Array(view.buffer);
}

export class ChhotuLiveSession {
  private readonly options: ChhotuLiveOptions;
  private session: Session | null = null;

  private micContext: AudioContext | null = null;
  private micStream: MediaStream | null = null;
  private micSource: MediaStreamAudioSourceNode | null = null;
  private micProcessor: ScriptProcessorNode | null = null;

  private outputContext: AudioContext | null = null;
  private playingUntil = 0;

  private closed = false;
  private lastLevelAt = 0;

  /* Wake-word gate state, reset at every turn boundary. `unknown` means the
     model has started answering but the transcript has not yet proved the
     turn was addressed — its audio is held, never played. */
  private turnUserText = "";
  private gate: "unknown" | "pass" | "block" = "unknown";
  private heldAudio: string[] = [];
  private heldText = "";
  private gateTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(options: ChhotuLiveOptions) {
    this.options = options;
  }

  /** Open the socket. Safe to call once; later calls are no-ops. */
  async connect(): Promise<void> {
    if (this.session) return;
    this.emitPhase("connecting");

    const { client, callbacks } = this.options;

    const connect = client.live.connect({
      model: CHHOTU_LIVE_MODEL,
      callbacks: {
        onmessage: (message: LiveServerMessage) => {
          void this.handleMessage(message);
        },
        onerror: () => {
          this.emitPhase("error");
          callbacks?.onError?.("The voice line dropped. Tap to try again or type instead.");
        },
        onclose: () => {
          this.session = null;
          if (!this.closed) this.emitPhase("ready");
        },
      },
      config: {
        responseModalities: [Modality.AUDIO],
        systemInstruction: this.options.systemInstruction,
        tools: [{ functionDeclarations: this.options.tools }],
        // Captions for both sides, so the sheet can show what was heard.
        inputAudioTranscription: {},
        outputAudioTranscription: {},
        speechConfig: {
          languageCode: "en-IN",
          voiceConfig: { prebuiltVoiceConfig: { voiceName: this.options.voiceName } },
        },
      },
    });

    try {
      this.session = await withTimeout(
        connect,
        CONNECT_TIMEOUT_MS,
        "The voice line did not open in time.",
      );
    } catch (error) {
      this.emitPhase("error");
      throw error instanceof Error ? error : new Error("The voice line did not open.");
    }

    this.emitPhase("ready");
  }

  /** Typed input travels over the same session as speech. */
  sendText(text: string): void {
    const trimmed = text.trim();
    if (!trimmed || !this.session) return;

    // Typing is a deliberate act, so it is never gated by the wake word.
    this.clearGateTimer();
    this.turnUserText = "";
    this.heldAudio = [];
    this.heldText = "";
    this.gate = "pass";

    this.emitPhase("thinking");
    this.session.sendClientContent({
      turns: [{ role: "user", parts: [{ text: trimmed }] }],
      turnComplete: true,
    });
  }

  /** Start streaming the microphone. Call from a user gesture (permission). */
  async startMic(): Promise<void> {
    if (this.micStream) return;
    if (!this.session) await this.connect();

    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
    } catch {
      this.options.callbacks?.onError?.(
        "Microphone permission was denied. Allow it in your browser, or type instead.",
      );
      return;
    }

    const context = new AudioContext();
    const source = context.createMediaStreamSource(stream);
    const processor = context.createScriptProcessor(4096, 1, 1);

    processor.onaudioprocess = (event) => {
      if (!this.session) return;
      const channel = event.inputBuffer.getChannelData(0);

      /* Level for the UI: RMS of this block, throttled to ~12 fps so the
         sheet re-renders a handful of times a second, not 60. */
      const now = Date.now();
      if (now - this.lastLevelAt > 80) {
        this.lastLevelAt = now;
        let sum = 0;
        for (let index = 0; index < channel.length; index += 1) {
          const sample = channel[index] as number;
          sum += sample * sample;
        }
        const rms = Math.sqrt(sum / Math.max(1, channel.length));
        // Speech sits around 0.05–0.3 RMS; scale it into a usable 0–1.
        this.options.callbacks?.onMicLevel?.(Math.min(1, rms * 5));
      }

      const pcm = toPcm16(downsample(channel, context.sampleRate, MIC_SAMPLE_RATE));
      this.session.sendRealtimeInput({
        audio: {
          data: bytesToBase64(pcm),
          mimeType: `audio/pcm;rate=${MIC_SAMPLE_RATE}`,
        },
      });
    };

    source.connect(processor);
    // A ScriptProcessorNode only runs while connected to a destination; it
    // emits silence, so nothing is actually played back.
    processor.connect(context.destination);

    this.micStream = stream;
    this.micContext = context;
    this.micSource = source;
    this.micProcessor = processor;
    this.emitPhase("listening");
  }

  /** Stop streaming and tell the server the stream ended, so it answers. */
  stopMic(): void {
    this.micProcessor?.disconnect();
    this.micSource?.disconnect();
    for (const track of this.micStream?.getTracks() ?? []) track.stop();
    void this.micContext?.close();

    this.micProcessor = null;
    this.micSource = null;
    this.micStream = null;
    this.micContext = null;

    this.session?.sendRealtimeInput({ audioStreamEnd: true });
    this.options.callbacks?.onMicLevel?.(0);
    if (this.session) this.emitPhase("thinking");
  }

  get micActive(): boolean {
    return this.micStream !== null;
  }

  /** Tear everything down; the sheet calls this when it closes. */
  close(): void {
    this.closed = true;
    this.stopMic();
    this.outputContext?.close();
    this.outputContext = null;
    this.session?.close();
    this.session = null;
    this.emitPhase("idle");
  }

  private emitPhase(phase: ChhotuPhase) {
    this.options.callbacks?.onPhase?.(phase);
  }

  private async handleMessage(message: LiveServerMessage): Promise<void> {
    const { callbacks } = this.options;
    const wakeEnabled = Boolean(this.options.wakePhrase);
    const content = message.serverContent;

    if (content) {
      const heard = content.inputTranscription?.text;

      if (heard) {
        this.turnUserText += heard;

        if (!wakeEnabled || this.gate === "pass") {
          callbacks?.onUserSpeech?.(heard);
        } else if (this.heardWakeWord()) {
          // Nothing before the phrase was shown, so the whole turn is shown
          // at once rather than a fragment of it.
          this.passGate(this.turnUserText);
        }
      }

      if (content.interrupted) {
        this.stopPlayback();
        this.endGateTurn();
      }

      const spoken = content.outputTranscription?.text;
      if (spoken) {
        if (!wakeEnabled || this.gate === "pass") {
          this.emitPhase("speaking");
          callbacks?.onAssistantSpeech?.(spoken);
        } else if (this.gate === "unknown") {
          this.heldText += spoken;
        }
      }

      for (const part of content.modelTurn?.parts ?? []) {
        const audio = part.inlineData?.data;
        if (!audio) continue;

        if (!wakeEnabled || this.gate === "pass") {
          this.emitPhase("speaking");
          this.play(audio);
        } else if (this.gate === "unknown") {
          // Held, not played: a turn nobody asked for must not be heard.
          this.heldAudio.push(audio);
          this.armGateTimeout();
        }
      }

      if (content.turnComplete) {
        if (wakeEnabled && this.gate === "unknown") {
          if (this.heardWakeWord()) this.passGate(this.turnUserText);
          else this.gate = "block";
        }

        if (!wakeEnabled || this.gate !== "block") {
          this.emitPhase("ready");
          callbacks?.onTurnComplete?.();
        }

        this.endGateTurn();
      }
    }

    const calls = message.toolCall?.functionCalls ?? [];
    if (calls.length > 0) await this.runTools(calls);
  }

  /** Execute every requested function, then answer the socket with results. */
  private async runTools(calls: FunctionCall[]): Promise<void> {
    const { callbacks, describe } = this.options;
    const collected: ChhotuAction[] = [];
    let mutated = false;

    for (const call of calls) {
      const name = call.name ?? "";

      /* THE SAFETY PROPERTY OF THE KITCHEN ASSISTANT: a turn that did not
         contain the wake phrase may not touch anything, even though the model
         decided to call a tool. Ambient kitchen talk can move no ticket. */
      if (this.options.wakePhrase && this.gate !== "pass") {
        this.session?.sendToolResponse({
          functionResponses: [
            {
              ...(call.id ? { id: call.id } : {}),
              name,
              response: {
                ok: false,
                error: {
                  code: "NOT_ADDRESSED",
                  message:
                    "They did not say the wake phrase, so nothing was changed. Ask them to start with Aey Chhotu.",
                },
              },
            },
          ],
        });
        continue;
      }

      if (describe) callbacks?.onActivity?.(describe(name, call.args ?? {}));

      const execution = await this.options.execute(name, call.args ?? {});
      collected.push(...execution.actions);
      mutated = mutated || execution.mutated;

      // Sent per call so one bad tool cannot strand the others' responses.
      this.session?.sendToolResponse({
        functionResponses: [
          {
            ...(call.id ? { id: call.id } : {}),
            name,
            response: execution.response,
          },
        ],
      });
    }

    callbacks?.onActivity?.(null);
    if (collected.length > 0) callbacks?.onActions?.(collected);
    if (mutated) callbacks?.onMutated?.();
  }

  private get wakeEnabled(): boolean {
    return Boolean(this.options.wakePhrase?.phrase);
  }

  /** Did this turn contain the kitchen's wake phrase? */
  private heardWakeWord(): boolean {
    const wake = this.options.wakePhrase;
    if (!wake) return false;
    return containsWakePhrase(this.turnUserText, wake);
  }

  /** The turn was addressed: release everything held for it. */
  private passGate(userText?: string): void {
    if (this.gate === "pass") return;
    this.gate = "pass";
    this.clearGateTimer();

    const { callbacks } = this.options;
    callbacks?.onWake?.();
    if (userText) callbacks?.onUserSpeech?.(userText);

    if (this.heldText) {
      const text = this.heldText;
      this.heldText = "";
      this.emitPhase("speaking");
      callbacks?.onAssistantSpeech?.(text);
    }

    if (this.heldAudio.length > 0) {
      const chunks = this.heldAudio;
      this.heldAudio = [];
      this.emitPhase("speaking");
      for (const chunk of chunks) this.play(chunk);
    }
  }

  /** Bound how long an unproven turn may keep audio buffered. */
  private armGateTimeout(): void {
    if (this.gateTimer !== null) return;
    this.gateTimer = setTimeout(() => {
      this.gateTimer = null;
      if (this.gate !== "unknown") return;
      this.heldAudio = [];
      this.heldText = "";
      this.gate = "block";
    }, WAKE_GATE_GRACE_MS);
  }

  private clearGateTimer(): void {
    if (this.gateTimer === null) return;
    clearTimeout(this.gateTimer);
    this.gateTimer = null;
  }

  private endGateTurn(): void {
    this.clearGateTimer();
    this.turnUserText = "";
    this.heldAudio = [];
    this.heldText = "";
    this.gate = "unknown";
  }

  /** Queue one PCM16 chunk so consecutive chunks play back-to-back. */
  private play(base64: string): void {
    const context = (this.outputContext ??= new AudioContext({ sampleRate: OUTPUT_SAMPLE_RATE }));
    const bytes = base64ToBytes(base64);
    const sampleCount = Math.floor(bytes.byteLength / 2);
    if (sampleCount === 0) return;

    const buffer = context.createBuffer(1, sampleCount, OUTPUT_SAMPLE_RATE);
    const channel = buffer.getChannelData(0);
    const view = new DataView(bytes.buffer, bytes.byteOffset, sampleCount * 2);
    for (let index = 0; index < sampleCount; index += 1) {
      channel[index] = view.getInt16(index * 2, true) / 0x8000;
    }

    const source = context.createBufferSource();
    source.buffer = buffer;
    source.connect(context.destination);

    const startAt = Math.max(context.currentTime, this.playingUntil);
    source.start(startAt);
    this.playingUntil = startAt + buffer.duration;
  }

  private stopPlayback(): void {
    if (!this.outputContext) return;
    void this.outputContext.close();
    this.outputContext = null;
    this.playingUntil = 0;
  }
}
