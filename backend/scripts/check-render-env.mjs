#!/usr/bin/env node
/* Guard against the crash-loop that a new required env var causes on Render.

   src/config/env.ts exits(1) at boot when a required variable is missing, and
   Render only sets what render.yaml declares (there is no .env on the server).
   So a var added to env.ts but not to the Blueprint means: the service starts,
   dies immediately, restarts, and healthCheckPath /api/v1/ready never answers —
   a red deploy with no obvious cause.

   This script fails the build when that drift exists. Zero dependencies: it
   reads the two files and compares names, no YAML parser needed (render.yaml is
   pinned by this repo and its env keys are plain `- key: NAME` lines).

   Run: npm run check:render-env   (also a step in .github/workflows/ci.yml) */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const ENV_TS = join(here, "..", "src", "config", "env.ts");
const RENDER_YAML = join(here, "..", "..", "render.yaml");

/** Every call site must be a double-quoted literal, or this scan can't see it. */
const CALL = /require(?:Env|Pin)\(\s*([^)]*)\)/g;
const LITERAL = /^"([A-Za-z0-9_]+)"$/;

function fail(message) {
  console.error(`\n[check:render-env] FAIL — ${message}\n`);
  process.exit(1);
}

const source = readFileSync(ENV_TS, "utf8");

/* Drop the `function requireEnv(` / `function requirePin(` definitions first —
   they also match the call pattern, and their parameter list (`name: string`)
   is not a variable name. */
const callsiteSource = source.replace(/function\s+require(?:Env|Pin)\s*\(/g, "");

const required = new Set();
for (const [, argsRaw] of callsiteSource.matchAll(CALL)) {
  const args = argsRaw.trim();
  const literal = LITERAL.exec(args);
  if (!literal) {
    fail(
      `src/config/env.ts calls requireEnv/requirePin with a non-literal argument ` +
        `(${args.replace(/\s+/g, " ")}). The check only understands a quoted ` +
        `variable name — use a literal so the Blueprint stays in sync.`,
    );
  }
  required.add(literal[1]);
}
if (required.size === 0) {
  fail(
    "found no requireEnv(...) / requirePin(...) calls in src/config/env.ts. " +
      "The pattern is stale — nothing was compared, so this check would pass vacuously.",
  );
}

const yaml = readFileSync(RENDER_YAML, "utf8");
const declared = new Set([...yaml.matchAll(/^\s*-\s*key:\s*([A-Za-z0-9_]+)\s*$/gm)].map((m) => m[1]));
if (declared.size === 0) {
  fail(`found no \`- key: NAME\` entries in render.yaml — the pattern is stale.`);
}

const missing = [...required].filter((name) => !declared.has(name)).sort();
if (missing.length > 0) {
  fail(
    [
      `src/config/env.ts hard-requires ${missing.length} variable(s) that render.yaml does not declare:`,
      ...missing.map((name) => `    - ${name}`),
      "",
      "  On Render those vars are never set, so the service exits(1) at boot and the",
      "  health check never passes. Add each one under `envVars:` in render.yaml",
      '  (use `sync: false` for secrets) and re-sync the Blueprint.',
    ].join("\n"),
  );
}

const optional = [...declared].filter((name) => !required.has(name)).length;
console.log(
  `[check:render-env] OK — ${required.size} boot-required var(s) all declared in render.yaml ` +
    `(${optional} declared var(s) are optional or build-time).`,
);
