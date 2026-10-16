import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// Two separately bundled copies of the package share no module state. They
// meet only through the readable-interop protocol, so graphs spanning both are
// the case where a copy's flush, bridge subscription, and revision polling
// interleave. Each copy is a real tsdown bundle of src/index.ts.
interface Signal<T> { value: T }
interface Copy {
  signal<T>(value: T): Signal<T>;
  computed<T>(getter: () => T): Signal<T>;
  effect(callback: () => void): () => void;
}

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
let temporaryRoot = "";
let copies: Record<"A" | "B", Copy>;

beforeAll(async () => {
  temporaryRoot = await mkdtemp(join(repositoryRoot, ".cross-copy-effects-"));
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
  copies = { A: loaded[0]!, B: loaded[1]! };
}, 120_000);

afterAll(async () => {
  if (temporaryRoot !== "") await rm(temporaryRoot, { recursive: true, force: true });
});

function captureReports<T>(callback: () => T): { result: T; reports: string[] } {
  const reports: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => {
    const cause = (args[1] as { cause?: { message?: string } } | undefined)?.cause;
    reports.push(`${String(args[0]).slice(0, 60)} ${cause?.message ?? ""}`);
  };
  try { return { result: callback(), reports }; }
  finally { console.error = original; }
}

describe("effects across two copies of the package", () => {
  // C1: a revision a copy learns by reading, while it is already checking an
  // effect's dependencies, used to leave a computed Dirty behind an effect that
  // was never notified again.
  it("keeps an effect alive when a bridged computed stops reading a bridged branch (every placement)", () => {
    const placements: string[] = [];
    for (let mask = 0; mask < 32; mask += 1) {
      const placement = Array.from({ length: 5 }, (_, bit) => ((mask >> bit) & 1 ? "B" : "A")).join("");
      const [ps, pc0, pc1, pc2, pe] = [...placement].map((letter) => copies[letter as "A" | "B"]) as [Copy, Copy, Copy, Copy, Copy];
      const s = ps.signal(0);
      const c0 = pc0.computed(() => s.value + 1);
      const c1 = pc1.computed(() => (s.value === 0 ? c0.value : 1));
      const c2 = pc2.computed(() => s.value * 10 + c1.value);
      const seen: number[] = [];
      const { reports } = captureReports(() => {
        const dispose = pe.effect(() => { seen.push(c2.value); });
        for (const value of [1, 2, 3, 4]) s.value = value;
        dispose();
      });
      if (seen.join() !== "1,11,21,31,41" || reports.length > 0) placements.push(`${placement}: ${seen.join()} ${reports.join("|")}`);
    }
    expect(placements).toEqual([]);
  });

  // C2: creating the bridge subscription for one copy flushed the other copy's
  // queue while that copy had a computed mid-evaluation, so an effect that read
  // the evaluating computed reported "Computed cycle detected".
  it("does not report a false computed cycle while a bridge subscription is created", () => {
    const { A, B } = copies;
    const s = A.signal(0);
    const n1 = B.computed(() => (s.value + 1) + s.value * 3 + s.value);
    const n2 = A.computed(() => (s.value + 1) + n1.value * 3 + s.value);
    const n3 = A.computed(() => (s.value % 2 === 0 ? n2.value + s.value + 1 : s.value * 2));
    const n4 = A.computed(() => (s.value + 1) + n3.value * 3 + s.value);
    const seen: number[] = [];
    const { reports } = captureReports(() => {
      const dispose = B.effect(() => { seen.push(n4.value * 100 + n1.value); });
      s.value = 3;
      s.value = 2;
      dispose();
    });
    expect(reports).toEqual([]);
    expect(seen).toEqual([1601, 2516, 12_811]);
  });

  // Randomized graphs with fixed seeds: the same graph placed across the two
  // copies must settle on the values, and show the effect-visible history, of
  // the single-copy run.
  it("matches single-copy behavior for seeded random graphs spread over both copies", () => {
    const random = (seed: number) => {
      let state = seed >>> 0;
      return () => { state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0; return state / 4_294_967_296; };
    };
    interface NodeSpec { kind: "source" | "computed"; cond: number; a: number; b: number; c: number; mode: number }
    interface Spec {
      nodes: NodeSpec[];
      effects: Array<{ reads: [number, number]; at: number }>;
      writes: Array<{ src: number; v: number }>;
    }
    const makeSpec = (seed: number): Spec => {
      const next = random(seed);
      const pick = (n: number) => Math.floor(next() * n);
      const sources = 1 + pick(4);
      const computeds = 2 + pick(8);
      const nodes: NodeSpec[] = [];
      for (let index = 0; index < sources; index += 1) nodes.push({ kind: "source", cond: 0, a: 0, b: 0, c: 0, mode: 0 });
      for (let index = 0; index < computeds; index += 1) {
        const at = nodes.length;
        nodes.push({ kind: "computed", cond: pick(at), a: pick(at), b: pick(at), c: pick(at), mode: pick(3) });
      }
      const effects = Array.from({ length: 1 + pick(3) }, () => ({ reads: [sources + pick(computeds), pick(nodes.length)] as [number, number], at: pick(4) }));
      const writes = Array.from({ length: 10 }, () => ({ src: pick(sources), v: pick(4) }));
      return { nodes, effects, writes };
    };
    const run = (spec: Spec, placement: string[]) => {
      const nodes: Array<Signal<number>> = [];
      const traces: number[][] = spec.effects.map(() => []);
      const disposers: Array<() => void> = [];
      const { reports } = captureReports(() => {
        spec.nodes.forEach((node, index) => {
          const copy = copies[placement[index] as "A" | "B"];
          if (node.kind === "source") { nodes.push(copy.signal(0)); return; }
          nodes.push(copy.computed(() => {
            const cond = nodes[node.cond]!.value;
            const base = cond + 1;
            if (node.mode === 0) return base + nodes[node.a]!.value * 3 + nodes[node.b]!.value;
            if (node.mode === 1) return cond % 2 === 0 ? nodes[node.a]!.value + base : nodes[node.b]!.value * 2;
            return (cond > 1 ? nodes[node.c]!.value : 0) + nodes[node.a]!.value;
          }));
        });
        const start = (index: number) => {
          const effect = spec.effects[index]!;
          const copy = copies[placement[spec.nodes.length + index] as "A" | "B"];
          disposers.push(copy.effect(() => {
            traces[index]!.push(nodes[effect.reads[0]]!.value * 100 + (effect.reads[1] % 2 === 1 ? nodes[effect.reads[1]]!.value : 0));
          }));
        };
        spec.effects.forEach((effect, index) => { if (effect.at === 0) start(index); });
        spec.writes.forEach((write, step) => {
          spec.effects.forEach((effect, index) => { if (effect.at === step + 1) start(index); });
          nodes[write.src]!.value = write.v;
        });
      });
      const final = nodes.map((node) => node.value);
      for (const dispose of disposers) dispose();
      const collapse = (trace: number[]) => trace.filter((value, index) => index === 0 || value !== trace[index - 1]);
      return { traces: traces.map(collapse), reports, final };
    };

    const mismatches: string[] = [];
    for (let seed = 1; seed <= 250; seed += 1) {
      const spec = makeSpec(seed);
      const total = spec.nodes.length + spec.effects.length;
      const reference = run(spec, Array.from({ length: total }, () => "A"));
      const next = random(seed * 7919);
      for (let trial = 0; trial < 6; trial += 1) {
        const placement = Array.from({ length: total }, () => (next() < 0.5 ? "A" : "B"));
        const actual = run(spec, placement);
        if (actual.reports.length > 0 || JSON.stringify(actual.traces) !== JSON.stringify(reference.traces) || JSON.stringify(actual.final) !== JSON.stringify(reference.final)) {
          mismatches.push(`seed ${seed} placement ${placement.join("")}: ${JSON.stringify(actual.traces)} vs ${JSON.stringify(reference.traces)} ${actual.reports.join("|")}`);
        }
      }
    }
    expect(mismatches).toEqual([]);
  });
});
