"use client";

import jsQR from "jsqr";
import { Flashlight, FlashlightOff, RotateCcw, X } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/* The in-app camera scanner — the ONLY way to read a Table Pass.
 *
 * Deliberately not a `<input type="file" capture>`: that hands the guest the
 * OS camera app and the photo library, which is both a worse experience and
 * a way to submit a screenshot instead of a live table. This component calls
 * `getUserMedia` itself, decodes frames in a canvas, and never exposes a
 * gallery picker.
 *
 * Decoding runs on a downscaled copy (~480px wide) at ~8fps. A full 1280×720
 * ImageData scan per animation frame melts a mid-range phone, and a QR code
 * is still comfortably readable at that size.
 *
 * Torch is offered only when the track reports the capability; on iOS Safari
 * it is usually absent, so the button simply does not appear. */

type ScannerStatus = "starting" | "scanning" | "denied" | "unavailable" | "error";

export interface InAppQrScannerProps {
  open: boolean;
  onClose: () => void;
  /** Raw payload from the code — validated by lib/diner/table-pass. */
  onDecode: (raw: string) => void;
}

const DECODE_INTERVAL_MS = 120;
const DECODE_WIDTH = 480;

export function InAppQrScanner({ open, onClose, onDecode }: InAppQrScannerProps) {
  const [status, setStatus] = useState<ScannerStatus>("starting");
  const [message, setMessage] = useState<string | null>(null);
  const [torchSupported, setTorchSupported] = useState(false);
  const [torchOn, setTorchOn] = useState(false);
  // Bumping this re-runs the camera effect, which is the Retry button.
  const [attempt, setAttempt] = useState(0);

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const decodeRef = useRef(onDecode);

  // The decode callback changes identity on every render of the gate; keeping
  // it in a ref means the camera is NOT torn down and re-opened each time.
  useEffect(() => {
    decodeRef.current = onDecode;
  }, [onDecode]);

  useEffect(() => {
    if (!open) return;

    let cancelled = false;
    let timer: number | undefined;
    const canvas = document.createElement("canvas");
    const context = canvas.getContext("2d", { willReadFrequently: true });

    function stop() {
      cancelled = true;
      if (timer !== undefined) window.clearTimeout(timer);
      for (const track of streamRef.current?.getTracks() ?? []) track.stop();
      streamRef.current = null;
      if (videoRef.current) videoRef.current.srcObject = null;
    }

    function fail(err: unknown) {
      stop();
      const name = err instanceof DOMException ? err.name : "";
      if (name === "NotAllowedError" || name === "PermissionDeniedError" || name === "SecurityError") {
        setStatus("denied");
        setMessage("Camera access is blocked for this site.");
        return;
      }
      if (name === "NotFoundError" || name === "DevicesNotFoundError") {
        setStatus("unavailable");
        setMessage("No camera is available on this device.");
        return;
      }
      setStatus("error");
      setMessage(err instanceof Error ? err.message : "The camera could not be started.");
    }

    function tick() {
      if (cancelled) return;

      const video = videoRef.current;
      if (video && context && video.readyState >= video.HAVE_CURRENT_DATA && video.videoWidth > 0) {
        const width = Math.min(DECODE_WIDTH, video.videoWidth);
        const height = Math.round((video.videoHeight / video.videoWidth) * width);
        canvas.width = width;
        canvas.height = height;
        context.drawImage(video, 0, 0, width, height);

        const frame = context.getImageData(0, 0, width, height);
        const found = jsQR(frame.data, width, height, { inversionAttempts: "dontInvert" });

        if (found?.data) {
          // One decode and out: the caller owns validation, and a scanner
          // that keeps firing would submit the same code repeatedly.
          decodeRef.current(found.data);
          stop();
          return;
        }
      }

      timer = window.setTimeout(tick, DECODE_INTERVAL_MS);
    }

    async function start() {
      // Resets live here rather than in the effect body: this runs as the
      // async continuation of the effect, so React sees one settled update
      // per attempt instead of a synchronous cascade on mount.
      setStatus("starting");
      setMessage(null);
      setTorchOn(false);
      setTorchSupported(false);

      if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) {
        setStatus("unavailable");
        setMessage("This browser cannot open a camera. Use the PIN instead.");
        return;
      }

      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: false,
          video: {
            // "environment" (rear camera) is the one pointed at the other
            // phone's screen; `ideal` so a laptop's only camera still works.
            facingMode: { ideal: "environment" },
            width: { ideal: 1280 },
            height: { ideal: 720 },
          },
        });

        if (cancelled) {
          for (const track of stream.getTracks()) track.stop();
          return;
        }

        streamRef.current = stream;

        const video = videoRef.current;
        if (!video) {
          fail(new Error("The scanner view is not mounted."));
          return;
        }

        video.srcObject = stream;
        await video.play().catch(() => undefined);

        const track = stream.getVideoTracks()[0];
        const capabilities = track?.getCapabilities?.() as
          | (MediaTrackCapabilities & { torch?: boolean })
          | undefined;
        setTorchSupported(Boolean(capabilities?.torch));

        setStatus("scanning");
        timer = window.setTimeout(tick, DECODE_INTERVAL_MS);
      } catch (err) {
        fail(err);
      }
    }

    void start();

    return stop;
  }, [open, attempt]);

  // Closing must release the camera immediately — a live indicator left on
  // after the sheet closes looks like spyware.
  useEffect(() => {
    if (open) return;
    for (const track of streamRef.current?.getTracks() ?? []) track.stop();
  }, [open]);

  async function toggleTorch() {
    const track = streamRef.current?.getVideoTracks()[0];
    if (!track) return;

    const next = !torchOn;
    try {
      // `torch` is a constraint browsers expose through `advanced`; the DOM
      // lib does not type it, hence the cast.
      await track.applyConstraints({
        advanced: [{ torch: next }],
      } as unknown as MediaTrackConstraints);
      setTorchOn(next);
    } catch {
      // A track can advertise torch and still refuse it (battery saver).
      setTorchSupported(false);
      setTorchOn(false);
    }
  }

  return (
    <AnimatePresence>
      {open ? (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.18 }}
          role="dialog"
          aria-modal="true"
          aria-label="Scan a tablemate's QR pass"
          // 100dvh, not 100vh: the viewfinder must not slide under the
          // browser toolbar while the guest lines the code up.
          className="fixed inset-0 z-[60] flex h-[100dvh] flex-col overflow-hidden bg-ink"
        >
          <header className="flex items-center justify-between gap-3 px-4 pt-[max(0.9rem,env(safe-area-inset-top))] pb-3">
            <div className="flex min-w-0 flex-col">
              <span className="truncate text-sm font-semibold text-ink-inverse">
                Scan a table pass
              </span>
              <span className="text-xs text-ink-inverse/60">Point at a tablemate&apos;s screen</span>
            </div>

            <div className="flex items-center gap-2">
              {torchSupported ? (
                <button
                  type="button"
                  onClick={() => void toggleTorch()}
                  aria-pressed={torchOn}
                  aria-label={torchOn ? "Turn the torch off" : "Turn the torch on"}
                  className={cn(
                    "flex size-10 cursor-pointer items-center justify-center rounded-md border transition-colors",
                    torchOn
                      ? "border-ember bg-ember text-on-ember"
                      : "border-ink-inverse/25 bg-ink-inverse/10 text-ink-inverse",
                  )}
                >
                  {torchOn ? (
                    <FlashlightOff className="size-5" aria-hidden />
                  ) : (
                    <Flashlight className="size-5" aria-hidden />
                  )}
                </button>
              ) : null}

              <button
                type="button"
                onClick={onClose}
                aria-label="Close the scanner"
                className="flex size-10 cursor-pointer items-center justify-center rounded-md border border-ink-inverse/25 bg-ink-inverse/10 text-ink-inverse"
              >
                <X className="size-5" aria-hidden />
              </button>
            </div>
          </header>

          <div className="relative flex-1 overflow-hidden">
            <video
              ref={videoRef}
              playsInline
              muted
              autoPlay
              aria-hidden
              className="absolute inset-0 size-full object-cover"
            />

            {/* Darkened surround with a clear window: the eye goes to the
                box, and what is outside it is visibly not being read. */}
            <div aria-hidden className="absolute inset-0 bg-ink/45" />
            <div className="absolute inset-0 flex items-center justify-center px-8">
              <div className="relative aspect-square w-full max-w-[18rem]">
                <div aria-hidden className="absolute inset-0 rounded-xl border-2 border-ink-inverse/25" />
                <Corner className="top-0 left-0 border-t-4 border-l-4 rounded-tl-xl" />
                <Corner className="top-0 right-0 border-t-4 border-r-4 rounded-tr-xl" />
                <Corner className="bottom-0 left-0 border-b-4 border-l-4 rounded-bl-xl" />
                <Corner className="bottom-0 right-0 border-b-4 border-r-4 rounded-br-xl" />
                {status === "scanning" ? (
                  <span aria-hidden className="absolute inset-x-2 block h-0.5 animate-laser bg-ember" />
                ) : null}
              </div>
            </div>

            {status !== "scanning" ? (
              <div className="absolute inset-0 flex items-center justify-center px-6">
                <div className="flex w-full max-w-sm flex-col items-center gap-4 rounded-xl border border-ink-inverse/15 bg-ink/90 p-6 text-center backdrop-blur-sm">
                  <p className="text-sm leading-relaxed text-ink-inverse">
                    {status === "starting" ? "Starting the camera…" : message}
                  </p>

                  {status === "starting" ? null : (
                    <Button
                      variant="ember"
                      size="md"
                      fullWidth
                      onClick={() => setAttempt((count) => count + 1)}
                      leftIcon={<RotateCcw className="size-4" aria-hidden />}
                    >
                      Try the camera again
                    </Button>
                  )}

                  <p className="text-xs text-ink-inverse/60">
                    You can always close this and type the table PIN instead.
                  </p>
                </div>
              </div>
            ) : null}

            <p
              aria-live="polite"
              className="absolute inset-x-0 bottom-[max(1rem,env(safe-area-inset-bottom))] px-6 text-center text-xs text-ink-inverse/70"
            >
              The pass is on the Table Pass screen of anyone already at your table.
            </p>
          </div>
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
}

function Corner({ className }: { className: string }) {
  return <span aria-hidden className={cn("absolute size-9 border-ember", className)} />;
}
