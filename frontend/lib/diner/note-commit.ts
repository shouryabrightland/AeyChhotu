/* Batching for cart-line note edits.
 *
 * THE PROBLEM THIS SOLVES: the kitchen note and the allergy note used to be
 * PATCHed on every keystroke — one request per character, each one followed by
 * a full cart re-read. Typing "no peanuts" was eight round trips, the caret
 * jumped every time an echo landed, and the cart badge said "Syncing" the
 * whole time. A guest could not type freely.
 *
 * So typing is LOCAL and the write is BULK: changes are merged into one patch
 * and sent once the guest pauses (or leaves the field, or closes the sheet).
 * Nothing here touches React, so the batching is unit-tested directly.
 */

export type NotesPatch = { request_note?: string; allergy_note?: string };

/** Quiet time before a paused edit is written. */
export const NOTES_COMMIT_DELAY_MS = 700;

export interface NoteCommitterOptions {
  /** Where the merged patch goes: at most one call per burst. */
  commit: (patch: NotesPatch) => void;
  delayMs?: number;
}

export interface NoteCommitter {
  /** Merge a change and (re)start the quiet timer. */
  queue: (patch: NotesPatch) => void;
  /** Send whatever is pending NOW (blur, sheet close). True if it sent. */
  flush: () => boolean;
  /** A write is waiting to be sent. */
  hasPending: () => boolean;
  /** Drop the pending patch without sending it (the line is gone). */
  cancel: () => void;
}

export function createNoteCommitter({
  commit,
  delayMs = NOTES_COMMIT_DELAY_MS,
}: NoteCommitterOptions): NoteCommitter {
  let pending: NotesPatch | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;

  function clearTimer() {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  }

  function flush(): boolean {
    clearTimer();
    const patch = pending;
    pending = null;
    if (!patch) return false;
    commit(patch);
    return true;
  }

  return {
    queue(patch) {
      // One merged patch per burst: typing then editing the allergy field
      // before the pause still costs a single request.
      pending = { ...(pending ?? {}), ...patch };
      clearTimer();
      timer = setTimeout(flush, delayMs);
    },
    flush,
    hasPending: () => pending !== null,
    cancel() {
      clearTimer();
      pending = null;
    },
  };
}
