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
