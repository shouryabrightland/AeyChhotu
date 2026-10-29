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

import { Modality, type FunctionCall, type LiveServerMessage, type Session } from "@google/genai";
import type { GoogleGenAI } from "@google/genai";
import { buildChhotuSystemPrompt } from "./system-prompt";
import { TOOL_DECLARATIONS } from "./tool-declarations";
import { describeToolCall, executeTool } from "./tools";
import type { ChhotuAction, ChhotuRuntime } from "./types";

/** The only model this app talks to: Gemini 3.8 Live with extended thinking
 *  (verified present in the Models API for this key). It is a native-audio
 *  Live model, so the same session takes speech and text.
 *
 *  Override per deployment with NEXT_PUBLIC_CHHOTU_LIVE_MODEL if Google
 *  publishes a newer Live model — but never point it at a text-only model:
 *  the sheet has no path for one. */
export const CHHOTU_LIVE_MODEL =
  process.env.NEXT_PUBLIC_CHHOTU_LIVE_MODEL?.trim() || "gemini-3.8-live-extended-thinking";

/** A warm, mid-range prebuilt voice that suits a waiter. */
const CHHOTU_VOICE = "Aoede";

const MIC_SAMPLE_RATE = 16_000;
const OUTPUT_SAMPLE_RATE = 24_000;

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
  /** A tool wrote to the server; the caller should refresh live state. */
  onMutated?: () => void;
  onError?: (message: string) => void;
}

export interface ChhotuLiveOptions {
  client: GoogleGenAI;
  /** Built per tool call so the menu/cart snapshot is never stale. */
  getRuntime: () => ChhotuRuntime;
  guestName: string;
  tableCode: string;
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

  constructor(options: ChhotuLiveOptions) {
    this.options = options;
  }

  /** Open the socket. Safe to call once; later calls are no-ops. */
  async connect(): Promise<void> {
    if (this.session) return;
    this.emitPhase("connecting");

    const { client, guestName, tableCode, callbacks } = this.options;

    this.session = await client.live.connect({
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
        systemInstruction: buildChhotuSystemPrompt(guestName, tableCode),
        tools: [{ functionDeclarations: TOOL_DECLARATIONS }],
        // Captions for both sides, so the sheet can show what was heard.
        inputAudioTranscription: {},
        outputAudioTranscription: {},
        speechConfig: {
          languageCode: "en-IN",
          voiceConfig: { prebuiltVoiceConfig: { voiceName: CHHOTU_VOICE } },
        },
      },
    });

    this.emitPhase("ready");
  }

  /** Typed input travels over the same session as speech. */
  sendText(text: string): void {
    const trimmed = text.trim();
    if (!trimmed || !this.session) return;
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

    const content = message.serverContent;

    if (content) {
      const heard = content.inputTranscription?.text;
      if (heard) callbacks?.onUserSpeech?.(heard);

      if (content.interrupted) this.stopPlayback();

      const spoken = content.outputTranscription?.text;
      if (spoken) {
        this.emitPhase("speaking");
        callbacks?.onAssistantSpeech?.(spoken);
      }

      for (const part of content.modelTurn?.parts ?? []) {
        const audio = part.inlineData?.data;
        if (audio) {
          this.emitPhase("speaking");
          this.play(audio);
        }
      }

      if (content.turnComplete) {
        this.emitPhase("ready");
        callbacks?.onTurnComplete?.();
      }
    }

    const calls = message.toolCall?.functionCalls ?? [];
    if (calls.length > 0) await this.runTools(calls);
  }

  /** Execute every requested function, then answer the socket with results. */
  private async runTools(calls: FunctionCall[]): Promise<void> {
    const { callbacks } = this.options;
    const runtime = this.options.getRuntime();
    const collected: ChhotuAction[] = [];
    let mutated = false;

    for (const call of calls) {
      const name = call.name ?? "";
      callbacks?.onActivity?.(describeToolCall(name, call.args ?? {}));

      const execution = await executeTool(name, call.args ?? {}, runtime);
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
