// Bundle-size budget check.
//
// The point is not to track absolute bytes — it is to catch tree-shaking
// regressions. A consumer that only imports `signal` must not pay for
// `deepSignal`, the JSX runtime, or the control-flow components, and the only
// thing that makes that possible is `"sideEffects": false` plus keeping the
// entry points free of top-level side effects. Both are easy to break by
// accident, and neither fails a type check or a unit test.
//
// `alien-signals` is bundled rather than externalized: it is a peer dependency
// that ships in the consumer's bundle, so it is part of what this library
// actually costs them.

import { gzipSync, brotliCompressSync, constants } from "node:zlib";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const distDirectory = join(repositoryRoot, "dist");
const budgetPath = join(repositoryRoot, "scripts", "size-budget.json");

/** Each scenario is what one realistic consumer import graph pulls in. */
const scenarios = [
  {
    name: "core",
    description: "signal + computed + effect only",
    source: `import { signal, computed, effect, batch, untracked } from "DIST/index.js";
export default [signal, computed, effect, batch, untracked];`,
  },
  {
    name: "core+hooks",
    description: "core primitives plus the React hooks",
    source: `import { signal, computed, effect, useSignal, useSignalValue, useSignals, useComputed, useSignalEffect } from "DIST/index.js";
export default [signal, computed, effect, useSignal, useSignalValue, useSignals, useComputed, useSignalEffect];`,
  },
  {
    name: "deep",
    description: "deepSignal and its hooks",
    source: `import { deepSignal, useDeepSignal, useDeepSignalValue } from "DIST/index.js";
export default [deepSignal, useDeepSignal, useDeepSignalValue];`,
  },
  {
    name: "index-full",
    description: "every export of the main entry",
    source: `import * as everything from "DIST/index.js";
export default everything;`,
  },
  {
    name: "jsx-runtime",
    description: "the custom JSX runtime a transformed app always loads",
    source: `import * as runtime from "DIST/jsx-runtime.js";
export default runtime;`,
  },
  {
    name: "utils",
    description: "the control-flow components",
    source: `import { Show, Switch, Match, For, Index } from "DIST/utils.js";
export default [Show, Switch, Match, For, Index];`,
  },
];

// Markers are string literals a minifier cannot rename, so they survive as a
// reliable probe for whether a module made it into the bundle.
const DEEP_SIGNAL_MARKER = "deepSignal() only accepts a plain object or array root";
const REACT_STORE_MARKER = "useSyncExternalStore";

/** Code that must be absent from a bundle, proving the shake actually worked. */
const absenceChecks = {
  core: [DEEP_SIGNAL_MARKER, REACT_STORE_MARKER],
  "core+hooks": [DEEP_SIGNAL_MARKER],
};

// Positive controls. Without these an absence check would keep passing after a
// marker string is renamed or deleted, quietly turning the whole check vacuous.
const presenceChecks = {
  deep: [DEEP_SIGNAL_MARKER],
  "index-full": [DEEP_SIGNAL_MARKER, REACT_STORE_MARKER],
  "core+hooks": [REACT_STORE_MARKER],
};

const external = [
  "react",
  "react-dom",
  "react/jsx-runtime",
  "react/jsx-dev-runtime",
];

async function measure(scenario, outputRoot) {
  const entryDirectory = join(outputRoot, scenario.name);
  mkdirSync(entryDirectory, { recursive: true });
  const entryPath = join(entryDirectory, "entry.js");
  writeFileSync(
    entryPath,
    scenario.source.replaceAll("DIST", distDirectory.replaceAll("\\", "/")),
  );

  const outDir = join(entryDirectory, "out");
  await build({
    logLevel: "silent",
    configFile: false,
    build: {
      outDir,
      emptyOutDir: true,
      minify: true,
      lib: { entry: entryPath, formats: ["es"], fileName: () => "bundle.js" },
      rollupOptions: { external },
    },
  });

  const code = readFileSync(join(outDir, "bundle.js"));
  return {
    raw: code.byteLength,
    gzip: gzipSync(code, { level: 9 }).byteLength,
    brotli: brotliCompressSync(code, {
      params: { [constants.BROTLI_PARAM_QUALITY]: 11 },
    }).byteLength,
    text: code.toString("utf8"),
  };
}

function formatBytes(value) {
  return `${(value / 1024).toFixed(2)} kB`;
}

// Measuring a stale `dist` reports sizes for code that is no longer in the tree,
// and budgets recorded from one are wrong in a way nothing downstream can
// detect. Both checks below exist because that already happened once.
if (!existsSync(join(distDirectory, "index.js"))) {
  console.error(`No build found at ${distDirectory}. Run \`pnpm build:runtime\` first.`);
  process.exit(1);
}

function newestModification(directory) {
  let newest = 0;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    newest = Math.max(
      newest,
      entry.isDirectory() ? newestModification(path) : statSync(path).mtimeMs,
    );
  }
  return newest;
}

if (newestModification(join(repositoryRoot, "src")) > newestModification(distDirectory)) {
  console.error(
    `The build at ${distDirectory} is older than src/. Run \`pnpm build:runtime\` first.`,
  );
  process.exit(1);
}

const shouldUpdate = process.argv.includes("--update");
const outputRoot = mkdtempSync(join(tmpdir(), "ras-size-"));
const budget = shouldUpdate
  ? {}
  : JSON.parse(readFileSync(budgetPath, "utf8"));
const results = {};
// Structural failures mean a tree-shaking guarantee broke; they are always
// fatal. Budget failures are only growth, so `--update` may accept them.
const failures = [];
const budgetFailures = [];

try {
  for (const scenario of scenarios) {
    const measured = await measure(scenario, outputRoot);
    results[scenario.name] = { gzip: measured.gzip, brotli: measured.brotli };

    for (const forbidden of absenceChecks[scenario.name] ?? []) {
      if (measured.text.includes(forbidden)) {
        failures.push(
          `${scenario.name}: expected tree-shaking to drop code containing ${JSON.stringify(forbidden)}`,
        );
      }
    }

    for (const expected of presenceChecks[scenario.name] ?? []) {
      if (!measured.text.includes(expected)) {
        failures.push(
          `${scenario.name}: marker ${JSON.stringify(expected)} is gone, so the matching absence check no longer proves anything — update the markers`,
        );
      }
    }

    const limit = budget[scenario.name]?.gzip;
    const status =
      limit === undefined
        ? ""
        : measured.gzip > limit
          ? ` OVER budget ${formatBytes(limit)}`
          : ` (budget ${formatBytes(limit)})`;
    if (limit !== undefined && measured.gzip > limit) {
      budgetFailures.push(
        `${scenario.name}: ${formatBytes(measured.gzip)} gzip exceeds the ${formatBytes(limit)} budget`,
      );
    }

    console.log(
      `${scenario.name.padEnd(12)} ${formatBytes(measured.gzip).padStart(9)} gzip  ${formatBytes(measured.brotli).padStart(9)} br  ${formatBytes(measured.raw).padStart(9)} raw${status}`,
    );
    console.log(`${"".padEnd(12)} ${scenario.description}`);
  }

  const fatal = shouldUpdate ? failures : [...failures, ...budgetFailures];

  if (fatal.length > 0) {
    console.error(`\n${fatal.length} size check failure(s):`);
    for (const failure of fatal) console.error(`  - ${failure}`);
    if (budgetFailures.length > 0) {
      console.error("\nRun `pnpm size:update` if the growth is intentional.");
    }
    process.exitCode = 1;
  }

  if (shouldUpdate) {
    if (fatal.length > 0) {
      console.error("\nRefusing to rewrite budgets while a guarantee is broken.");
    } else {
      // Budgets are the measured size plus headroom, so ordinary changes do not
      // churn this file and only a real regression trips it.
      const updated = Object.fromEntries(
        Object.entries(results).map(([name, sizes]) => [
          name,
          { gzip: Math.ceil((sizes.gzip * 1.1) / 64) * 64 },
        ]),
      );
      writeFileSync(budgetPath, `${JSON.stringify(updated, null, 2)}\n`);
      console.log(`\nWrote budgets to ${budgetPath}`);
    }
  } else if (fatal.length === 0) {
    console.log("\nAll size budgets satisfied.");
  }
} finally {
  rmSync(outputRoot, { recursive: true, force: true });
}
