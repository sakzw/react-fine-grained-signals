import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, describe, expect, it, vi } from "vitest";
import loader from "../src/loader.js";
import esbuildAdapter from "../src/esbuild.js";
import rollupAdapter from "../src/rollup.js";
import rspackAdapter from "../src/rspack.js";
import viteAdapter from "../src/vite.js";
import webpackAdapter from "../src/webpack.js";
import { transformReactFineGrainedSignals } from "../src/internal/transform.js";
import {
  canTransform,
  reactFineGrainedSignals,
  resolveEsbuildLoader,
  type ReactFineGrainedSignalsOptions,
} from "../src/unplugin.js";

const counterSource = "const count = { value: 1 }; export const App = () => <p>{count.value}</p>;";

/** The defaults the plugin's own `transform` hook fills in, for direct calls. */
const internalOptions = {
  importSource: "react-fine-grained-signals",
  reactImportSource: "react",
  mode: "auto" as const,
  transform: "managed" as const,
  reactCompiler: "auto" as const,
};

function transformSource(
  source: string,
  options: ReactFineGrainedSignalsOptions,
): string | undefined {
  const plugin = reactFineGrainedSignals.vite(options) as unknown as {
    transform(code: string, id: string): { code: string } | null;
  };
  return plugin.transform(source, "/project/src/App.tsx")?.code;
}

function transformCounter(options: ReactFineGrainedSignalsOptions): string | undefined {
  return transformSource(counterSource, options);
}

const explicitSource = [
  'import { useSignals } from "react-fine-grained-signals";',
  "const count = { value: 1 };",
  "export function App() { useSignals(); return <p>{count.value}</p>; }",
].join("\n");

const explicitAsyncSource = [
  'import { useSignals } from "react-fine-grained-signals";',
  "const count = { value: 1 };",
  "export async function App() { useSignals(); return <p>{count.value}</p>; }",
].join("\n");

const explicitGeneratorSource = [
  'import { useSignals } from "react-fine-grained-signals";',
  "const count = { value: 1 };",
  "export function* App() { useSignals(); yield <p>{count.value}</p>; }",
].join("\n");

describe("unplugin-react-fine-grained-signals", () => {
  it("only includes application JavaScript and TypeScript modules", () => {
    const options = {
      include: (id: string) => id.includes("/src/"),
    };

    expect(canTransform("/project/src/App.tsx", options)).toBe(true);
    expect(canTransform("/project/src/state.ts", options)).toBe(true);
    expect(canTransform("/project/node_modules/pkg/index.js", options)).toBe(false);
    expect(canTransform("/project/src/styles.css", options)).toBe(false);
    expect(canTransform("/project/test/App.tsx", options)).toBe(false);
  });

  it("leaves declared-CommonJS modules alone", () => {
    // The only binding this transform introduces is an ESM `import`, which a
    // `.cjs`/`.cts` module cannot carry alongside its `module.exports`.
    expect(canTransform("/project/src/legacy.cjs", {})).toBe(false);
    expect(canTransform("/project/src/legacy.cts", {})).toBe(false);
    expect(canTransform("/project/src/modern.mjs", {})).toBe(true);
    expect(canTransform("/project/src/modern.mts", {})).toBe(true);
  });

  it("decides on the module id the transform will actually parse", () => {
    // The transform strips `?query`/`#fragment` before choosing its parser
    // plugins, so a decision made on the raw id is a decision about a different
    // file name than the one that gets parsed.
    //
    // Vite hands a Vue SFC's script block over as `App.vue?...&lang.tsx`: the
    // raw id ends in `.tsx`, but the name that reaches the parser is `App.vue`,
    // which gets neither the `jsx` nor the `typescript` parser plugin.
    expect(canTransform("/src/App.vue?vue&type=script&lang.tsx", {})).toBe(false);
    expect(canTransform("/src/App.vue?vue&type=script&setup=true&lang.ts", {})).toBe(false);
    // A `#fragment` is not part of the file name either, and the file beneath
    // it is one the transform handles perfectly well.
    expect(canTransform("/project/src/App.tsx#frag", {})).toBe(true);
    expect(canTransform("/project/src/App.tsx?t=1730000000#frag", {})).toBe(true);
    // Still the extension that decides, not the query: cleaning must not let a
    // declared-CommonJS module back in.
    expect(canTransform("/project/src/legacy.cjs?t=1730000000", {})).toBe(false);
    expect(canTransform("/project/src/legacy.cts#frag", {})).toBe(false);
  });

  it("claims exactly the ids the transform can parse", () => {
    // Both halves of the divergence above, stated against the transform itself
    // rather than against a second copy of the rule.
    const sfcId = "/src/App.vue?vue&type=script&lang.tsx";

    expect(canTransform(sfcId, {})).toBe(false);
    // Claiming it is what turns a file this plugin has no business touching
    // into a parse failure that reads like the author's own syntax error.
    expect(() => transformReactFineGrainedSignals(counterSource, sfcId, internalOptions))
      .toThrow(/jsx/);

    const fragmentId = "/project/src/App.tsx#frag";

    expect(canTransform(fragmentId, {})).toBe(true);
    const result = transformReactFineGrainedSignals(counterSource, fragmentId, internalOptions);
    expect(result?.code).toContain("_useSignals()");
    expect((result?.map as { sources: string[] } | undefined)?.sources)
      .toEqual(["/project/src/App.tsx"]);
  });

  it("leaves modules another plugin generated and owns alone", () => {
    // Rollup's convention: a `\0` prefix marks an id some other plugin created
    // and is responsible for, including the proxy modules `@rollup/plugin-commonjs`
    // synthesises around real files.
    expect(canTransform("\0virtual:mod.tsx", {})).toBe(false);
    expect(canTransform("\0/project/src/legacy.js?commonjs-proxy", {})).toBe(false);
    expect(canTransform("/project/src/virtual.tsx", {})).toBe(true);
  });

  it("never claims a CommonJS module for transformation", () => {
    // `transformInclude` is the gate every adapter consults before calling
    // `transform`, so a `.cjs` module with `module.exports` is never reached
    // and can never have an ESM import injected into it.
    const plugin = reactFineGrainedSignals.vite({ mode: "auto" }) as unknown as {
      transformInclude(id: string): boolean;
    };

    expect(plugin.transformInclude("/project/src/legacy.cjs")).toBe(false);
    expect(plugin.transformInclude("/project/src/legacy.cts")).toBe(false);
    expect(plugin.transformInclude("/project/src/App.tsx")).toBe(true);
  });

  it("accepts the public auto mode option", () => {
    expect(reactFineGrainedSignals).toBeDefined();
  });

  it("uses the managed try/finally transform by default", () => {
    const output = transformCounter({ mode: "auto" });

    expect(output).toContain('from "react-fine-grained-signals/runtime"');
    expect(output).toContain("const _signals = _useSignals();");
    expect(output).toContain("try {");
    expect(output).toContain("_signals.f();");
  });

  it("uses the lightweight injection transform when it is opted into", () => {
    const output = transformCounter({ mode: "auto", transform: "inject" });

    expect(output).toContain('from "react-fine-grained-signals"');
    expect(output).not.toContain('from "react-fine-grained-signals/runtime"');
    expect(output).toContain("_useSignals();");
    expect(output).not.toContain("try {");
  });

  it("absorbs an explicit useSignals call into the default managed boundary", () => {
    const output = transformSource(explicitSource, { mode: "auto" });

    // The author's own call is replaced by the managed store declaration, so
    // the body is rewritten rather than left untouched — but no second
    // `useSignals()` call is ever added.
    expect(output).toContain('from "react-fine-grained-signals/runtime"');
    expect(output).toContain("const _signals = _useSignals();");
    expect(output).toContain("try {");
    expect(output).toContain("_signals.f();");
    expect(output).not.toMatch(/^\s*useSignals\(\);$/m);
  });

  it("keeps an explicit useSignals call in place under the injection transform", () => {
    const output = transformSource(explicitSource, { mode: "auto", transform: "inject" });

    expect(output).not.toContain('from "react-fine-grained-signals/runtime"');
    expect(output).not.toContain("try {");
    expect(output).toMatch(/^\s*useSignals\(\);$/m);
  });

  it("rejects an explicit useSignals call in an async or generator function by default", () => {
    expect(() => transformSource(explicitAsyncSource, { mode: "auto" }))
      .toThrow("only supports synchronous, non-generator functions");
    expect(() => transformSource(explicitGeneratorSource, { mode: "auto" }))
      .toThrow("only supports synchronous, non-generator functions");
  });

  it("leaves an explicit async or generator useSignals call alone under the injection transform", () => {
    const asyncOutput = transformSource(explicitAsyncSource, {
      mode: "auto",
      transform: "inject",
    });
    const generatorOutput = transformSource(explicitGeneratorSource, {
      mode: "auto",
      transform: "inject",
    });

    expect(asyncOutput).toContain("async function App()");
    expect(asyncOutput).not.toContain('from "react-fine-grained-signals/runtime"');
    expect(generatorOutput).toContain("function* App()");
    expect(generatorOutput).not.toContain('from "react-fine-grained-signals/runtime"');
  });
});

const pluginName = "unplugin-react-fine-grained-signals";
const componentSource = "const count = { value: 1 };\nexport const App = () => <p>{count.value}</p>;\n";

/**
 * The minimum a webpack/rspack compiler has to expose for unplugin's own
 * `apply()` to run: a build context to derive the virtual-module prefix from,
 * the rules array it unshifts its transform rule into, and -- for rspack --
 * the `rspack.experiments` namespace it reads while computing that prefix.
 * Nothing else is touched by a plugin that only declares `transform`.
 */
function createFakeCompiler() {
  return {
    options: {
      context: "/project",
      plugins: [] as unknown[],
      resolve: {},
      module: { rules: [] as unknown[] },
    },
    rspack: { experiments: {} },
  };
}

interface LoaderEntry {
  loader: string;
  ident: string;
  options: unknown;
}

function transformLoaderEntries(bundler: "webpack" | "rspack", resource: string): LoaderEntry[] {
  const compiler = createFakeCompiler();
  const plugin = reactFineGrainedSignals[bundler]({ mode: "auto" }) as unknown as {
    apply(compiler: unknown): void;
  };
  plugin.apply(compiler);
  const rule = compiler.options.module.rules[0] as { use(data: unknown): LoaderEntry[] };
  return rule.use({ resource, resourceQuery: "" });
}

interface LoaderRun {
  error: Error | null;
  content: string | undefined;
  map: unknown;
}

function runLoader(
  query: unknown,
  resource: string,
  source: string,
  incomingMap?: unknown,
  compilerHooks: {
    addDependency?: (file: string) => void;
    getDependencies?: () => string[];
    emitWarning?: (warning: Error) => void;
  } = {},
): Promise<LoaderRun> {
  return new Promise<LoaderRun>((resolve) => {
    const context = {
      ...compilerHooks,
      async: () => (error: Error | null, content?: string, map?: unknown) => {
        resolve({ error, content, map });
      },
      query,
      resource,
    };
    loader.call(context, source, incomingMap);
  });
}

function runTransformLoader(
  entry: LoaderEntry,
  resource: string,
  source: string,
  incomingMap?: unknown,
): Promise<LoaderRun> {
  return runLoader(entry.options, resource, source, incomingMap);
}

describe("bundler adapters", () => {
  const options: ReactFineGrainedSignalsOptions = { mode: "auto" };

  // Each package entry point re-exports its own bundler's factory, and those
  // are what a consumer actually imports -- so the shape assertions go through
  // them rather than through `reactFineGrainedSignals[bundler]`.
  it.each([
    ["vite", viteAdapter],
    ["rollup", rollupAdapter],
  ] as const)("creates a %s transform plugin from its entry point", (_bundler, create) => {
    const plugin = create(options) as unknown as Record<string, unknown>;

    expect(plugin.name).toBe(pluginName);
    expect(plugin.enforce).toBe("pre");
    expect(typeof plugin.transform).toBe("function");
    expect(typeof plugin.transformInclude).toBe("function");
  });

  it.each([
    ["webpack", webpackAdapter],
    ["rspack", rspackAdapter],
  ] as const)("creates a %s compiler plugin from its entry point", (_bundler, create) => {
    const plugin = create(options) as unknown as Record<string, unknown>;

    expect(typeof plugin.apply).toBe("function");
  });

  it("creates an esbuild plugin from its entry point", () => {
    const plugin = esbuildAdapter(options) as unknown as Record<string, unknown>;

    expect(plugin.name).toBe(pluginName);
    expect(typeof plugin.setup).toBe("function");
  });

  it.each(["webpack", "rspack"] as const)(
    "registers one %s transform rule for application modules only",
    (bundler) => {
      expect(transformLoaderEntries(bundler, "/project/src/App.tsx")).toHaveLength(1);
      expect(transformLoaderEntries(bundler, "/project/src/styles.css")).toHaveLength(0);
      expect(transformLoaderEntries(bundler, "/project/src/legacy.cjs")).toHaveLength(0);
    },
  );

  it.each(["webpack", "rspack"] as const)(
    "%s keeps the transform's own source map when no incoming map exists",
    async (bundler) => {
      // With `enforce: "pre"` this plugin is the first loader, so webpack hands
      // it no incoming map -- and unplugin's own loader answers
      // `map == null ? map : res.map || map`, dropping the map every time.
      // Babel re-prints the whole file, so losing it makes every downstream
      // line number point at source that no longer exists.
      const resource = "/project/src/App.tsx";
      const [entry] = transformLoaderEntries(bundler, resource);
      expect(entry).toBeDefined();

      const run = await runTransformLoader(entry!, resource, componentSource, undefined);
      const expected = transformReactFineGrainedSignals(componentSource, resource, {
        importSource: "react-fine-grained-signals",
        reactImportSource: "react",
        mode: "auto",
        transform: "managed",
        reactCompiler: "auto",
      });

      expect(run.error).toBeNull();
      expect(run.content).toBe(expected?.code);
      expect(run.map).toBeTruthy();
      const map = run.map as { version: number; sources: string[]; mappings: string };
      expect(map.version).toBe(3);
      expect(map.sources).toEqual([resource]);
      expect(map.mappings)
        .toBe((expected?.map as { mappings: string } | undefined)?.mappings);
    },
  );

  // What an upstream `pre` loader that prepended a banner line hands on: the
  // text this loader receives, plus a map from it back to the real file.
  const upstreamOriginal = "/project/src/App.original.tsx";
  const bannerSource = `// generated banner\n${componentSource}`;

  function upstreamMap(): Record<string, unknown> {
    return {
      version: 3,
      file: "App.tsx",
      sources: [upstreamOriginal],
      sourcesContent: [componentSource],
      names: [],
      // Nothing on the banner line; generated lines 2 and 3 are original 1 and 2.
      mappings: ";AAAA;AACA",
    };
  }

  it.each(["webpack", "rspack"] as const)(
    "%s composes an incoming source map with the transform's own",
    async (bundler) => {
      // `enforce: "pre"` puts this loader first in an ordinary config, but
      // webpack lets several `pre` loaders chain, so an incoming map is
      // possible -- and keeping only one of the two maps leaves every position
      // wrong by whatever the other one changed.
      const resource = "/project/src/App.tsx";
      const [entry] = transformLoaderEntries(bundler, resource);
      expect(entry).toBeDefined();

      const run = await runTransformLoader(entry!, resource, bannerSource, upstreamMap());
      const expected = transformReactFineGrainedSignals(bannerSource, resource, internalOptions);

      expect(run.error).toBeNull();
      // Carrying the incoming map in does not change a byte of the output, and
      // the inline comment it travels in never reaches it.
      expect(run.content).toBe(expected?.code);
      expect(run.content).not.toContain("sourceMappingURL");

      const map = run.map as {
        version: number;
        sources: string[];
        sourcesContent?: string[];
        mappings: string;
      };
      expect(map.version).toBe(3);
      // Composed, not clobbered. The upstream loader's original file and its
      // content survive...
      expect(map.sources).toEqual([upstreamOriginal]);
      expect(map.sourcesContent).toEqual([componentSource]);
      const ownMappings = (expected?.map as { mappings: string } | undefined)?.mappings ?? "";
      // ...while the generated side stays the transform's own -- one entry per
      // line of the file it just printed -- with the original side re-pointed
      // through the upstream map rather than left at this resource.
      expect(map.mappings.split(";")).toHaveLength(ownMappings.split(";").length);
      expect(map.mappings).not.toBe(ownMappings);
      expect(map.mappings).not.toBe(upstreamMap().mappings);
    },
  );

  it("accepts an incoming source map handed over as JSON text", async () => {
    // webpack passes a loader's map either as an object or as its JSON.
    const resource = "/project/src/App.tsx";
    const [entry] = transformLoaderEntries("webpack", resource);

    const run = await runTransformLoader(
      entry!,
      resource,
      bannerSource,
      JSON.stringify(upstreamMap()),
    );

    expect(run.error).toBeNull();
    expect((run.map as { sources: string[] }).sources).toEqual([upstreamOriginal]);
  });

  it.each([
    // Babel throws outright on a map object with no `sources` at all...
    ["no sources at all", { version: 3, mappings: "" }],
    // ...and one whose `sources` is present but empty composes into a map with
    // no sources either, throwing away the file name the transform's own map
    // would have carried -- worse than not composing at all.
    ["an empty sources array", { version: 3, sources: [], names: [], mappings: "" }],
    ["a version this loader does not know", { version: 2, sources: ["/a.tsx"], mappings: "" }],
  ])("keeps transforming when the incoming map has %s", async (_label, incomingMap) => {
    // Forwarding the incoming map must never leave the result worse off than
    // not forwarding it: an unusable map is left behind and the transform's own
    // is emitted, exactly as it is when no map comes in.
    const resource = "/project/src/App.tsx";
    const [entry] = transformLoaderEntries("webpack", resource);

    const run = await runTransformLoader(entry!, resource, componentSource, incomingMap);

    expect(run.error).toBeNull();
    expect(run.content).toContain("_useSignals()");
    expect((run.map as { sources: string[] }).sources).toEqual([resource]);
  });

  it("leaves a source that names its own map file uncomposed", async () => {
    // Babel strips a `sourceMappingURL` comment naming a map *file* only on the
    // branch it takes when it found no input map, so appending one would leave
    // that stale line in the output. Such a file keeps the behaviour it had
    // before incoming maps were forwarded at all: its own map, not a composed
    // one, and the comment gone because Babel is the one removing it.
    const resource = "/project/src/App.tsx";
    const [entry] = transformLoaderEntries("webpack", resource);
    const source = `${componentSource}//# sourceMappingURL=App.tsx.map\n`;

    const run = await runTransformLoader(entry!, resource, source, upstreamMap());

    expect(run.error).toBeNull();
    expect(run.content).toContain("_useSignals()");
    expect(run.content).not.toContain("sourceMappingURL");
    expect((run.map as { sources: string[] }).sources).toEqual([resource]);
  });

  it("keeps the inlined incoming map out of a transform hook's own output", async () => {
    // The map reaches Babel as a trailing `sourceMappingURL` comment, which
    // Babel lifts out as it reads it -- but a hook that is not Babel would
    // print it straight back into its result.
    const query = { plugin: { transform: (code: string) => `${code}\n// seen` } };

    const run = await runLoader(query, "/project/src/App.tsx", "export const a = 1;\n", {
      version: 3,
      sources: ["/project/src/App.tsx"],
      names: [],
      mappings: "AAAA",
    });

    expect(run.content).toBe("export const a = 1;\n\n// seen");
  });

  it("warns once when unplugin's transform rule is not there to patch", () => {
    // The rewrite is shape-matched so a future unplugin can restructure its
    // transform rule without breaking the build -- but the source map fix then
    // stops applying, which is exactly the regression nobody would notice.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const raw = (reactFineGrainedSignals as unknown as {
      raw(
        options: ReactFineGrainedSignalsOptions,
        meta: { framework: string },
      ): { webpack(compiler: unknown): void };
    }).raw({ mode: "auto" }, { framework: "webpack" });

    raw.webpack({ options: { module: { rules: [] } } });
    raw.webpack({ options: { module: { rules: [] } } });

    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain("Source map fix not applied");
    warn.mockRestore();
  });

  it("passes an untransformed module through the loader unchanged", async () => {
    const resource = "/project/src/plain.tsx";
    const [entry] = transformLoaderEntries("webpack", resource);
    const incomingMap = { version: 3, sources: [resource], names: [], mappings: "" };
    const source = "export const answer = 42;\n";

    const run = await runTransformLoader(entry!, resource, source, incomingMap);

    expect(run.error).toBeNull();
    expect(run.content).toBe(source);
    expect(run.map).toBe(incomingMap);
  });

  it("reports a transform failure as a loader error", async () => {
    const resource = "/project/src/Broken.tsx";
    const [entry] = transformLoaderEntries("webpack", resource);
    const source = [
      'import { useSignals } from "react-fine-grained-signals";',
      "export async function App() { useSignals(); return <p />; }",
    ].join("\n");

    const run = await runTransformLoader(entry!, resource, source, undefined);

    expect(run.error?.message).toContain("only supports synchronous, non-generator functions");
  });

  it.each([
    ["a query with no plugin", {}],
    ["a plugin with no transform hook", { plugin: {} }],
    ["a non-object query", "?raw"],
  ])("passes the module through untouched for %s", async (_label, query) => {
    const source = "export const answer = 42;\n";
    const incomingMap = { version: 3, mappings: "" };

    const run = await runLoader(query, "/project/src/App.tsx", source, incomingMap);

    expect(run.error).toBeNull();
    expect(run.content).toBe(source);
    expect(run.map).toBe(incomingMap);
  });

  it("honours transformInclude before calling the transform", async () => {
    let called = false;
    const query = {
      plugin: {
        transformInclude: () => false,
        transform() {
          called = true;
          return { code: "changed" };
        },
      },
    };

    const run = await runLoader(query, "/project/src/App.tsx", "kept", undefined);

    expect(called).toBe(false);
    expect(run.content).toBe("kept");
  });

  it("accepts an object-form transform hook and a string result", async () => {
    const query = { plugin: { transform: { handler: (code: string) => `${code}//seen` } } };

    const run = await runLoader(query, "/project/src/App.tsx", "source", undefined);

    expect(run.error).toBeNull();
    expect(run.content).toBe("source//seen");
  });

  it("wires the transform hook's context to the loader", async () => {
    const dependencies: string[] = [];
    const warnings: Error[] = [];
    let watched: string[] = [];
    const query = {
      plugin: {
        transform(
          this: {
            addWatchFile(file: string): void;
            getWatchFiles(): string[];
            warn(message: unknown): void;
          },
          code: string,
        ) {
          this.addWatchFile("/project/src/dep.ts");
          watched = this.getWatchFiles();
          this.warn("heads up");
          return { code: `${code}//touched` };
        },
      },
    };

    const run = await runLoader(query, "/project/src/App.tsx", "source", undefined, {
      addDependency: (file) => dependencies.push(file),
      getDependencies: () => dependencies,
      emitWarning: (warning) => warnings.push(warning),
    });

    expect(run.content).toBe("source//touched");
    expect(dependencies).toEqual(["/project/src/dep.ts"]);
    expect(watched).toEqual(["/project/src/dep.ts"]);
    expect(warnings.map(({ message }) => message)).toEqual(["heads up"]);
  });

  it("reports a transform's own this.error as a loader error", async () => {
    const query = {
      plugin: {
        transform(this: { error(message: unknown): never }) {
          this.error("not today");
        },
      },
    };

    const run = await runLoader(query, "/project/src/App.tsx", "source", undefined);

    expect(run.error?.message).toBe("not today");
  });

  it("falls back to console.warn when the compiler exposes no emitWarning", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const query = {
      plugin: {
        transform(this: { warn(message: unknown): void }, code: string) {
          this.warn("no channel");
          return { code };
        },
      },
    };

    await runLoader(query, "/project/src/App.tsx", "source", undefined);

    expect(warn).toHaveBeenCalledWith("no channel");
    warn.mockRestore();
  });

  it("reports an asynchronously rejected transform as a loader error", async () => {
    const query = {
      plugin: { transform: () => Promise.reject(new Error("boom")) },
    };

    const run = await runLoader(query, "/project/src/App.tsx", "source", undefined);

    expect(run.error?.message).toBe("boom");
  });

  it("labels each claimed module with a loader esbuild can actually parse", () => {
    // unplugin's fallback maps `.js` to esbuild's `js` loader and applies it to
    // every file this plugin claims -- including the ones it declines to
    // transform -- which breaks any project keeping JSX in `.js` files.
    expect(resolveEsbuildLoader("/project/src/App.js")).toBe("jsx");
    expect(resolveEsbuildLoader("/project/src/App.mjs")).toBe("jsx");
    expect(resolveEsbuildLoader("/project/src/App.jsx")).toBe("jsx");
    expect(resolveEsbuildLoader("/project/src/state.ts")).toBe("ts");
    expect(resolveEsbuildLoader("/project/src/state.mts")).toBe("ts");
    expect(resolveEsbuildLoader("/project/src/App.tsx")).toBe("tsx");
    expect(resolveEsbuildLoader("/project/src/App.tsx?t=1730000000")).toBe("tsx");
  });

  it("defers to the build's own loader configuration", () => {
    expect(resolveEsbuildLoader("/project/src/App.js", { ".js": "js" })).toBe("js");
    expect(resolveEsbuildLoader("/project/src/state.ts", { ".ts": "tsx" })).toBe("tsx");
    expect(resolveEsbuildLoader("/project/src/App.js", { ".ts": "tsx" })).toBe("jsx");
  });
});

interface EsbuildModule {
  build(options: Record<string, unknown>): Promise<{ outputFiles?: { text: string }[] }>;
}

/**
 * esbuild is not a direct dependency of this package, but Vite depends on it,
 * so an installed workspace can reach it through Vite's own resolution. When it
 * cannot, the build below is skipped rather than failed: the loader decision it
 * exercises is unit-tested above regardless.
 */
function resolveEsbuildEntry(): string | undefined {
  const require = createRequire(import.meta.url);
  try {
    return createRequire(require.resolve("vite")).resolve("esbuild");
  } catch {
    return undefined;
  }
}

const esbuildEntry = resolveEsbuildEntry();

describe.skipIf(esbuildEntry === undefined)("esbuild adapter build", () => {
  const directory = mkdtempSync(join(tmpdir(), "unplugin-rfgs-"));

  afterAll(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  async function build(
    fileName: string,
    source: string,
    pluginOptions: ReactFineGrainedSignalsOptions,
  ): Promise<string> {
    const esbuild = (await import(pathToFileURL(esbuildEntry!).href)) as EsbuildModule;
    const entry = join(directory, fileName);
    writeFileSync(entry, source, "utf8");
    const result = await esbuild.build({
      entryPoints: [entry],
      bundle: false,
      write: false,
      format: "esm",
      // The project keeps JSX in .js files, which is exactly the configuration
      // unplugin's `guessLoader` fallback overrode.
      loader: { ".js": "jsx" },
      plugins: [reactFineGrainedSignals.esbuild(pluginOptions)],
    });
    return result.outputFiles?.[0]?.text ?? "";
  }

  it("builds JSX in a .js file the transform never touches", async () => {
    const output = await build(
      "untouched.js",
      "export const Plain = () => <p>plain</p>;\n",
      { mode: "manual" },
    );

    expect(output).toContain("Plain");
    expect(output).not.toContain("react-fine-grained-signals");
  });

  it("builds JSX in a .js file the transform does rewrite", async () => {
    const output = await build("counter.js", componentSource, { mode: "auto" });

    expect(output).toContain("react-fine-grained-signals/runtime");
    expect(output).toContain("finally");
  });

  it("builds a .tsx file through the same adapter", async () => {
    const output = await build(
      "Counter.tsx",
      "const count = { value: 1 };\nexport const App = (): unknown => <p>{count.value}</p>;\n",
      { mode: "auto" },
    );

    expect(output).toContain("react-fine-grained-signals/runtime");
  });
});
