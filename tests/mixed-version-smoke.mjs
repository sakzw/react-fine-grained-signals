// Mixed-generation smoke: the published v0.1.1 package next to this build.
//
// v0.1.x and v0.2 signals cannot track each other (v0.2 reads go through the
// shared v2 execution owner and ReadableInterop V1, neither of which v0.1.x
// knows), so v0.2 brands its signals under a new key and the two generations
// must refuse each other's signals instead of silently rendering stale values.
// This runs the real published v0.1.1 artifact (installed under the
// `react-fine-grained-signals-v0.1` alias) against `dist/`, so run
// `pnpm build:runtime` first.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const repoRoot = resolve(import.meta.dirname, "..");
// v0.1.1 exports no "./package.json" subpath, so read the installed directory.
const legacyRoot = join(repoRoot, "node_modules", "react-fine-grained-signals-v0.1");
const legacyVersion = JSON.parse(readFileSync(join(legacyRoot, "package.json"), "utf8")).version;
assert.equal(legacyVersion, "0.1.1", "the mixed-version fixture must exercise the published v0.1.1 artifact");

const load = (root, entry) => import(pathToFileURL(join(root, "dist", entry)).href);
const current = await load(repoRoot, "index.js");
const currentJsx = await load(repoRoot, "jsx-runtime.js");
const legacy = await load(legacyRoot, "index.js");
const legacyJsx = await load(legacyRoot, "jsx-runtime.js");
const { renderToString } = await import("react-dom/server");

const results = [];
const record = (name, outcome) => results.push(`${name}: ${outcome}`);

// Identity: neither generation recognizes the other's signals.
assert.equal(current.isSignal(legacy.signal(0)), false, "v0.2 must not recognize a v0.1.1 signal");
assert.equal(current.isSignal(legacy.computed(() => 0)), false, "v0.2 must not recognize a v0.1.1 computed");
assert.equal(legacy.isSignal(current.signal(0)), false, "v0.1.1 must not recognize a v0.2 signal");
assert.equal(legacy.isSignal(current.computed(() => 0)), false, "v0.1.1 must not recognize a v0.2 computed");
assert.equal(legacy.isSignal(current.deepSignal({})), false, "v0.1.1 must not recognize a v0.2 deep signal");
record("isSignal across generations", "rejected in both directions");

// JSX: a foreign-generation signal child fails loudly instead of rendering a
// leaf that never updates.
assert.throws(
  () => renderToString(currentJsx.jsx("p", { children: legacy.signal("old") })),
  /Objects are not valid as a React child/,
  "v0.2 JSX must refuse a v0.1.1 signal child",
);
assert.throws(
  () => renderToString(legacyJsx.jsx("p", { children: current.signal("new") })),
  /Objects are not valid as a React child/,
  "v0.1.1 JSX must refuse a v0.2 signal child",
);
record("JSX child across generations", "throws in both directions");

// Direct reads across generations: unsupported, recorded for the report.
// Neither runtime can observe the other's reads, so these never re-run.
{
  const old = legacy.signal(0);
  const seen = [];
  const stop = current.effect(() => { seen.push(old.value); });
  old.value = 1;
  stop();
  assert.deepEqual(seen, [0]);
  record("v0.2 effect reading a v0.1.1 signal", "not reactive (unsupported)");
}
{
  const fresh = current.signal(0);
  const seen = [];
  const stop = legacy.effect(() => { seen.push(fresh.value); });
  fresh.value = 1;
  stop();
  assert.deepEqual(seen, [0]);
  record("v0.1.1 effect reading a v0.2 signal", "not reactive (unsupported)");
}
{
  const old = legacy.signal(1);
  const derived = current.computed(() => old.value * 2);
  assert.equal(derived.value, 2);
  old.value = 5;
  record("v0.2 computed reading a v0.1.1 signal", `stays ${derived.value} after the write (unsupported)`);
}

console.log(`Mixed-version smoke against react-fine-grained-signals@${legacyVersion}:`);
for (const line of results) console.log(`  ${line}`);
