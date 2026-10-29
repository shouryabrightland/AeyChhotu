import { createApp } from "./app.js";
import { env } from "./config/env.js";
import { pool } from "./db/pool.js";
import { logEvent } from "./observability/logger.js";
import { recordTableActivitySample } from "./services/admin.service.js";
import { checkAndAutoReleaseTable } from "./services/sessions.service.js";

/* App entry. Importing config/env.js validates required env vars and exits
   loudly if any are missing; importing db/pool.js wires the Postgres pool. */

const app = createApp();

const server = app.listen(env.port, () => {
  logEvent("info", "server_started", {
    port: env.port,
    node_env: env.nodeEnv,
    cors_origins: env.clientUrls,
  });
});

/* Auto-release sweeper (sql/007_bill_and_auto_release.sql).

   Both event paths — the floor settling a bill and the last device
   disconnecting — already ask the engine directly. This is the safety net
   for the cases neither can see: a device dies without firing pagehide, a
   process restarts between the two events, or the last ticket is pruned
   after everyone has gone. Every 20 s it re-examines the only rows that can
   possibly be eligible (bill paid), and each check re-validates all three
   conditions under a row lock. */
const AUTO_RELEASE_SWEEP_MS = 20_000;

async function sweepPaidTables(): Promise<void> {
  try {
    const res = await pool.query<{ id: string }>(
      "SELECT id FROM restaurant_tables WHERE bill_status = 'paid' AND deleted_at IS NULL",
    );

    for (const row of res.rows) {
      await checkAndAutoReleaseTable(row.id).catch((err: unknown) => {
        logEvent("error", "auto_release_failed", {
          table_id: row.id,
          error_message: err instanceof Error ? err.message : String(err),
        });
      });
    }
  } catch (err) {
    logEvent("error", "auto_release_sweep_failed", {
      error_message: err instanceof Error ? err.message : String(err),
    });
  }
}

const sweepTimer = setInterval(() => void sweepPaidTables(), AUTO_RELEASE_SWEEP_MS);
sweepTimer.unref();

/* Floor-activity sampler (sql/014).

   The console's Active Tables card draws a 24-hour average, and there is no
   event that means "one more table is open" — tables drain and are cleared
   at arbitrary moments. A cheap periodic count is the honest source. Five
   minutes gives twelve readings an hour: enough to shape the line without
   writing on every request. The first reading is taken at boot so a freshly
   started server contributes immediately. */
const TABLE_ACTIVITY_SAMPLE_MS = 5 * 60_000;

async function sampleTableActivity(): Promise<void> {
  try {
    await recordTableActivitySample();
  } catch (err) {
    logEvent("error", "table_activity_sample_failed", {
      error_message: err instanceof Error ? err.message : String(err),
    });
  }
}

void sampleTableActivity();
const activityTimer = setInterval(
  () => void sampleTableActivity(),
  TABLE_ACTIVITY_SAMPLE_MS,
);
activityTimer.unref();

/* Graceful shutdown. Render/Fly/Kubernetes kill with SIGTERM and expect the
   process to finish in-flight requests before exiting; a hard kill mid-order
   is how a diner's fire turns into a 502. Sequence:
     1. stop ACCEPTING new connections (load balancer routes elsewhere)
     2. let in-flight requests finish (bounded — a hung socket must not
        hold the process hostage past the platform's own kill timeout)
     3. close the Postgres pool so the exit is clean, not a pile of ECONNRESET */
const SHUTDOWN_TIMEOUT_MS = 10_000;
let shuttingDown = false;

function shutdown(signal: "SIGTERM" | "SIGINT"): void {
  if (shuttingDown) return;
  shuttingDown = true;
  logEvent("info", "shutdown_begin", { signal });

  clearInterval(sweepTimer);
  clearInterval(activityTimer);

  server.close(async () => {
    try {
      await pool.end();
      logEvent("info", "shutdown_complete", {});
      process.exit(0);
    } catch (err) {
      logEvent("error", "shutdown_pool_error", {
        error_message: err instanceof Error ? err.message : String(err),
      });
      process.exit(1);
    }
  });

  // Bounded drain: if sockets won't die (keep-alive clients), force it
  // before the platform's SIGKILL makes the exit look like a crash.
  setTimeout(() => {
    logEvent("warn", "shutdown_forced", { timeout_ms: SHUTDOWN_TIMEOUT_MS });
    server.closeAllConnections();
    void pool.end().finally(() => process.exit(0));
  }, SHUTDOWN_TIMEOUT_MS).unref();
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
