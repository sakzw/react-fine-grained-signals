import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// Two separately bundled copies of the package share only the execution owner
// on `globalThis`. Their graphs do not interoperate, so a read that crosses
// from one copy's reactive scope into the other's signal must fail loudly
// instead of silently going stale. Each copy is a real tsdown bundle of
// src/index.ts.
interface Signal<T> { value: T }
interface Copy {
  signal<T>(value: T): Signal<T>;
  computed<T>(getter: () => T): Signal<T>;
  effect(callback: () => void): () => void;
  isSignal(value: unknown): boolean;
}

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const MULTIPLE_COPIES = /Multiple copies of react-fine-grained-signals are loaded/;
let temporaryRoot = "";
let a: Copy;
let b: Copy;

beforeAll(async () => {
  temporaryRoot = await mkdtemp(join(repositoryRoot, ".multiple-copies-"));
  const { build } = await import("tsdown");
  const loaded: Copy[] = [];
  for (const name of ["a", "b"]) {
    const outDir = join(temporaryRoot, name);
    await build({
      config: false,
      entry: { index: join(repositoryRoot, "src/index.ts") },
      outDir,
      format: "esm",
      platform: "neutral",
      dts: false,
      sourcemap: false,
      clean: true,
      logLevel: "silent",
      deps: {
        alwaysBundle: [/^alien-signals(?:\/|$)/],
        neverBundle: [/^react(?:\/|$)/, /^react-dom(?:\/|$)/],
      },
    });
    loaded.push(await import(/* @vite-ignore */ pathToFileURL(join(outDir, "index.js")).href) as Copy);
  }
  a = loaded[0]!;
  b = loaded[1]!;
}, 120_000);

afterAll(async () => {
  if (temporaryRoot !== "") await rm(temporaryRoot, { recursive: true, force: true });
});

describe("two loaded copies of the package", () => {
  it("keeps each copy working on its own signals", () => {
    const source = a.signal(1);
    const doubled = a.computed(() => source.value * 2);
    const seen: number[] = [];
    const dispose = a.effect(() => { seen.push(doubled.value); });
    source.value = 2;
    dispose();
    expect(seen).toEqual([2, 4]);
    expect(a.isSignal(source)).toBe(true);
  });

  it("throws when a computed reads another copy's signal", () => {
    const foreign = b.signal(1);
    expect(() => a.computed(() => foreign.value).value).toThrow(MULTIPLE_COPIES);
  });

  it("throws when a computed reads another copy's computed", () => {
    const foreign = b.computed(() => 1);
    expect(() => a.computed(() => foreign.value).value).toThrow(MULTIPLE_COPIES);
  });

  it("reports an effect that reads another copy's signal", () => {
    const foreign = b.signal(1);
    const reports: unknown[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => { reports.push((args[1] as { cause?: unknown } | undefined)?.cause); };
    try {
      const dispose = a.effect(() => { foreign.value; });
      dispose();
    } finally {
      console.error = original;
    }
    expect(reports).toHaveLength(1);
    expect((reports[0] as Error).message).toMatch(MULTIPLE_COPIES);
  });

  it("throws from isSignal for a signal the other copy created", () => {
    expect(() => a.isSignal(b.signal(1))).toThrow(MULTIPLE_COPIES);
    expect(() => b.isSignal(a.computed(() => 1))).toThrow(MULTIPLE_COPIES);
    expect(a.isSignal({ value: 1, peek() { return 1; } })).toBe(false);
  });

  it("cannot detect a plain read made outside any reactive scope", () => {
    // Documented limitation: with no owner on the stack, nothing marks the
    // read as crossing copies, so it returns the other copy's current value.
    const foreign = b.signal(7);
    expect(foreign.value).toBe(7);
  });
});
