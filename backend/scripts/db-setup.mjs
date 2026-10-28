#!/usr/bin/env node
/* AeyChhotu! — database setup runner.
 *
 * Applies every file in sql/ in filename order, so the whole schema +
 * seed + realtime wiring is ONE repeatable command instead of three
 * hand-typed psql invocations:
 *
 *     001_init.sql      tables, indexes, RLS, fire_order()
 *     002_review_fixes.sql  FK RESTRICT, one-active-order index, scoped RLS
 *     003_realtime.sql  Realtime publication + REPLICA IDENTITY
 *     004_hardening.sql  audit timestamps, price snapshot, status guard
 *     005_table_session_security.sql  PIN/pass columns + column privileges
 *     006_admin_and_soft_deletes.sql  archive columns + partial indexes
 *     007_bill_and_auto_release.sql   bill columns + device presence registry
 *     008_realtime_expansion.sql      menu_items / restaurant_tables publication
 *     009_table_clear_alerts.sql      staff clear-request flag for the admin
 *     seed.sql          1 terminal / 5 tables / 20 dishes (idempotent)
 *
 * The list above is documentation only: the runner reads the directory, so a
 * new migration is picked up by its filename and never needs a code change.
 *
 * Usage (from backend/):
 *   npm run db:setup            # everything
 *   npm run db:setup -- --no-seed
 *   npm run db:setup -- --dry-run
 *
 * Reads DATABASE_URL from backend/.env (dotenv/config) or the environment.
 * Every SQL file in this project is written to be idempotent, so re-running
 * the runner is safe.
 */

import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import "dotenv/config";
import pg from "pg";

const here = dirname(fileURLToPath(import.meta.url));
const sqlDir = join(here, "..", "sql");

const args = new Set(process.argv.slice(2));
const noSeed = args.has("--no-seed");
const dryRun = args.has("--dry-run");

const databaseUrl = process.env.DATABASE_URL?.trim();
if (!databaseUrl) {
  console.error(
    [
      "[db:setup] FATAL: DATABASE_URL is missing or empty.",
      "[db:setup] Copy backend/.env.example to backend/.env and fill it in.",
    ].join("\n"),
  );
  process.exit(1);
}

// Filename order == apply order. seed.sql sorts after 00* alphabetically.
const files = readdirSync(sqlDir)
  .filter((name) => name.endsWith(".sql"))
  .sort();

if (files.length === 0) {
  console.error(`[db:setup] FATAL: no .sql files found in ${sqlDir}`);
  process.exit(1);
}

const toRun = files.filter((name) => !(noSeed && name === "seed.sql"));

if (dryRun) {
  console.log("[db:setup] dry run — would apply, in order:");
  for (const name of toRun) console.log(`  • ${name}`);
  process.exit(0);
}

const client = new pg.Client({ connectionString: databaseUrl });

// The migrations report what they skipped/changed via RAISE NOTICE. Without
// this listener those messages are swallowed and every run looks identical.
client.on("notice", (notice) => {
  if (notice.message) console.log(`    ↳ ${notice.message}`);
});

await client.connect();

try {
  const version = await client.query("SELECT version() AS v");
  console.log(`[db:setup] connected: ${version.rows[0].v.split(",")[0]}`);

  for (const name of toRun) {
    const sql = readFileSync(join(sqlDir, name), "utf8");
    process.stdout.write(`[db:setup] applying ${name} … `);
    try {
      // Simple query protocol: each file runs as one multi-statement batch,
      // so DO $$ … $$; blocks and plpgsql bodies work unchanged.
      await client.query(sql);
      console.log("ok");
    } catch (err) {
      console.log("FAILED");
      console.error(`\n[db:setup] ${name} did not apply: ${err.message}`);
      if (name === "002_review_fixes.sql") {
        console.error(
          "[db:setup] Hint: step 0 of 002 blocks when a table already has more\n" +
            "[db:setup] than one active order. Run the cleanup UPDATE printed in\n" +
            "[db:setup] that file's header, then re-run.",
        );
      }
      process.exitCode = 1;
      throw err;
    }
  }

  // Quick sanity report so a green run is provable, not assumed.
  const counts = await client.query(`
    SELECT
      (SELECT count(*)::int FROM restaurant_tables) AS tables,
      (SELECT count(*)::int FROM menu_items)        AS menu,
      (SELECT count(*)::int FROM staff_terminals)   AS terminals
  `);
  const { tables, menu, terminals } = counts.rows[0];
  console.log(
    `[db:setup] done — ${terminals} terminal(s) / ${tables} tables / ${menu} dishes`,
  );
} finally {
  await client.end();
}
