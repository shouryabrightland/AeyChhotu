import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createNoteCommitter, NOTES_COMMIT_DELAY_MS } from "../lib/diner/note-commit.ts";

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/* Why this test exists: a note edit used to be one PATCH per keystroke, each
   followed by a full cart re-read, which made the field impossible to type in.
   These assertions pin the batching contract. */

describe("note commit batching", () => {
  it("sends ONE patch for a whole typed phrase", async () => {
    const sent = [];
    const committer = createNoteCommitter({ commit: (patch) => sent.push(patch), delayMs: 20 });

    for (const text of ["n", "no", "no ", "no p", "no pe", "no pea", "no peanuts"]) {
      committer.queue({ request_note: text });
    }

    assert.equal(sent.length, 0, "nothing is written while the guest types");
    await wait(60);

    assert.equal(sent.length, 1, "one request for the phrase, not one per character");
    assert.deepEqual(sent[0], { request_note: "no peanuts" }, "the last text wins");
  });

  it("merges both note fields into a single patch", async () => {
    const sent = [];
    const committer = createNoteCommitter({ commit: (patch) => sent.push(patch), delayMs: 20 });

    committer.queue({ request_note: "less spicy" });
    committer.queue({ allergy_note: "no peanuts" });
    await wait(60);

    assert.equal(sent.length, 1);
    assert.deepEqual(sent[0], { request_note: "less spicy", allergy_note: "no peanuts" });
  });

  it("flushes immediately on blur and does not fire again later", async () => {
    const sent = [];
    const committer = createNoteCommitter({ commit: (patch) => sent.push(patch), delayMs: 5000 });

    committer.queue({ allergy_note: "no dairy" });
    assert.equal(committer.flush(), true);
    assert.deepEqual(sent, [{ allergy_note: "no dairy" }]);
    assert.equal(committer.hasPending(), false);

    await wait(30);
    assert.equal(sent.length, 1, "the timer was cancelled by the flush");
    assert.equal(committer.flush(), false, "a second blur must not repeat the write");
  });

  it("sends nothing when the guest opened a note field and typed nothing", () => {
    const sent = [];
    const committer = createNoteCommitter({ commit: (patch) => sent.push(patch), delayMs: 5 });

    assert.equal(committer.flush(), false);
    assert.deepEqual(sent, []);
  });

  it("drops a pending patch when the line is removed", async () => {
    const sent = [];
    const committer = createNoteCommitter({ commit: (patch) => sent.push(patch), delayMs: 20 });

    committer.queue({ request_note: "extra chutney" });
    committer.cancel();

    await wait(60);
    assert.deepEqual(sent, [], "a removed line must not be patched afterwards");
  });

  it("keeps the default delay long enough that a phrase is not split", () => {
    assert.ok(NOTES_COMMIT_DELAY_MS >= 500);
  });
});
