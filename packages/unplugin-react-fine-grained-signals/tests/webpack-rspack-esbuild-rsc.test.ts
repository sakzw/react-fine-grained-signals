import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { transformSync } from "esbuild";
import { afterAll, describe, expect, it } from "vitest";
import esbuildAdapter from "../src/esbuild.js";
import rspackAdapter from "../src/rspack.js";
import webpackAdapter from "../src/webpack.js";
import { pluginName } from "../src/unplugin.js";

const fixtureDir = mkdtempSync(join(tmpdir(), "signals-bundler-rsc-"));
const outputDir = join(fixtureDir, "out");
const serverEntry = join(fixtureDir, "server.jsx");
const clientEntry = join(fixtureDir, "client.jsx");
const sourceLoader = join(fixtureDir, "rfgs-loader.cjs");
writeFileSync(
  sourceLoader,
  transformSync(readFileSync(new URL("../src/loader.ts", import.meta.url), "utf8"), {
    loader: "ts",
    format: "cjs",
  }).code,
);

writeFileSync(
  serverEntry,
  [
    '"use server";',
    'import { signal } from "react-fine-grained-signals";',
    "const count = signal(0);",
    "export function ServerAction() { return <output>{count.value}</output>; }",
    "",
  ].join("\n"),
);
writeFileSync(
  clientEntry,
  [
    '"use client";',
    'import { signal } from "react-fine-grained-signals";',
    "const count = signal(0);",
    "export function Client() { return <output>{count.value}</output>; }",
    "",
  ].join("\n"),
);

afterAll(() => {
  rmSync(fixtureDir, { recursive: true, force: true });
});

interface RuleWithDynamicUse {
  enforce?: unknown;
  use?: unknown;
}

interface PluginWithApply {
  apply(compiler: unknown): void;
}

/** Source tests run without dist, so route unplugin's generated loader rule to
 * a CJS copy of the exact TS loader source compiled into the temp fixture. */
function useSourceLoader<T extends PluginWithApply>(plugin: T): T {
  const apply = plugin.apply.bind(plugin);
  plugin.apply = (compiler: unknown) => {
    apply(compiler);
    const rules = (compiler as { options?: { module?: { rules?: RuleWithDynamicUse[] } } }).options?.module?.rules;
    for (const rule of rules ?? []) {
      if (rule.enforce !== "pre" || typeof rule.use !== "function") continue;
      const originalUse = rule.use as (data: unknown) => unknown;
      rule.use = (data: unknown) => {
        const entries = originalUse(data);
        if (!Array.isArray(entries)) return entries;
        return entries.map((entry) =>
          entry !== null && typeof entry === "object" && (entry as { ident?: unknown }).ident === pluginName
            ? { ...(entry as object), loader: sourceLoader }
            : entry,
        );
      };
    }
  };
  return plugin;
}

function assertBuildArtifacts(
  serverCode: string,
  clientCode: string,
  serverMap: string,
  clientMap: string,
  warning: { message: string; file: string | undefined },
): void {
  expect(warning.message).toContain('top-level "use server" directive');
  expect(warning.message).toContain("> 4 | export function ServerAction()");
  expect(warning.file).toContain(basename(serverEntry));

  expect(serverCode).not.toContain("useSignalCapture");
  expect(clientCode).toContain("useSignalCapture");
  expect(JSON.parse(serverMap).sources.some((source: string) => source.endsWith(basename(serverEntry)))).toBe(true);
  expect(JSON.parse(clientMap).sources.some((source: string) => source.endsWith(basename(clientEntry)))).toBe(true);
}

describe("Webpack adapter RSC integration", () => {
  it("skips use server with a source warning and transforms use client with entry maps", async () => {
    const webpack = (await import("webpack")).default;
    const compiler = webpack({
      mode: "development",
      context: fixtureDir,
      entry: { server: serverEntry, client: clientEntry },
      target: "node",
      devtool: "source-map",
      output: { path: outputDir, filename: "[name].js", clean: true },
      optimization: { minimize: false },
      externals: [/^(?:react|react-fine-grained-signals)(?:\/|$)/],
      module: { rules: [{ test: /\.jsx$/, enforce: "post", use: [join(import.meta.dirname, "jsx-loader.cjs")] }] },
      plugins: [useSourceLoader(webpackAdapter({ mode: "auto" }))],
    });

    try {
      const stats = await new Promise<import("webpack").Stats>((resolve, reject) => {
        compiler.run((error, result) =>
          error ? reject(error) : result ? resolve(result) : reject(new Error("Webpack returned no stats")),
        );
      });
      expect(stats.hasErrors()).toBe(false);
      const warning = stats.compilation.warnings.find((entry) =>
        entry.message.includes('top-level "use server" directive'),
      );
      expect(warning?.message).toContain('top-level "use server" directive');
      if (warning === undefined)
        throw new Error(JSON.stringify(stats.compilation.warnings.map((entry) => entry.message)));
      assertBuildArtifacts(
        readFileSync(join(outputDir, "server.js"), "utf8"),
        readFileSync(join(outputDir, "client.js"), "utf8"),
        readFileSync(join(outputDir, "server.js.map"), "utf8"),
        readFileSync(join(outputDir, "client.js.map"), "utf8"),
        {
          message: warning!.message,
          file: (warning as Error & { module?: { resource?: string } }).module?.resource,
        },
      );
    } finally {
      await new Promise<void>((resolve) => compiler.close(() => resolve()));
    }
  }, 60_000);

  it("keeps an errorOn diagnostic as a build error with an incoming source map", async () => {
    const webpack = (await import("webpack")).default;
    const compiler = webpack({
      mode: "development",
      context: fixtureDir,
      entry: { server: serverEntry },
      target: "node",
      devtool: "source-map",
      output: { path: outputDir, filename: "[name].js", clean: true },
      optimization: { minimize: false },
      externals: [/^(?:react|react-fine-grained-signals)(?:\/|$)/],
      module: { rules: [{ test: /\.jsx$/, enforce: "post", use: [join(import.meta.dirname, "jsx-loader.cjs")] }] },
      plugins: [
        useSourceLoader(
          webpackAdapter({
            mode: "auto",
            diagnostics: { errorOn: ["RFGS009"] },
          }),
        ),
      ],
    });

    try {
      const stats = await new Promise<import("webpack").Stats>((resolve, reject) => {
        compiler.run((error, result) =>
          error ? reject(error) : result ? resolve(result) : reject(new Error("Webpack returned no stats")),
        );
      });
      expect(stats.hasErrors()).toBe(true);
      const failure = stats.compilation.errors.find((entry) => entry.message.includes("RFGS009"));
      expect(failure?.message).toContain('top-level "use server" directive');
      expect(failure?.message).toContain("> 4 | export function ServerAction()");
    } finally {
      await new Promise<void>((resolve) => compiler.close(() => resolve()));
    }
  }, 60_000);
});

describe("Rspack adapter RSC integration", () => {
  it("skips use server with a source warning and transforms use client with entry maps", async () => {
    const rspack = (await import("@rspack/core")).rspack;
    const compiler = rspack({
      mode: "development",
      context: fixtureDir,
      entry: { server: serverEntry, client: clientEntry },
      target: "node",
      devtool: "source-map",
      output: { path: outputDir, filename: "[name].js", clean: true },
      optimization: { minimize: false },
      externals: [/^(?:react|react-fine-grained-signals)(?:\/|$)/],
      module: { rules: [{ test: /\.jsx$/, enforce: "post", use: [join(import.meta.dirname, "jsx-loader.cjs")] }] },
      plugins: [useSourceLoader(rspackAdapter({ mode: "auto" }))],
    });

    try {
      const stats = await new Promise<import("@rspack/core").Stats>((resolve, reject) => {
        compiler.run((error, result) =>
          error ? reject(error) : result ? resolve(result) : reject(new Error("Rspack returned no stats")),
        );
      });
      expect(stats.hasErrors()).toBe(false);
      const warning = stats.compilation.warnings.find((entry) =>
        entry.message.includes('top-level "use server" directive'),
      );
      expect(warning?.message).toContain('top-level "use server" directive');
      if (warning === undefined)
        throw new Error(JSON.stringify(stats.compilation.warnings.map((entry) => entry.message)));
      assertBuildArtifacts(
        readFileSync(join(outputDir, "server.js"), "utf8"),
        readFileSync(join(outputDir, "client.js"), "utf8"),
        readFileSync(join(outputDir, "server.js.map"), "utf8"),
        readFileSync(join(outputDir, "client.js.map"), "utf8"),
        {
          message: warning!.message,
          file: (warning as Error & { module?: { resource?: string } }).module?.resource,
        },
      );
    } finally {
      await new Promise<void>((resolve) => compiler.close(() => resolve()));
    }
  }, 60_000);

  it("keeps an errorOn diagnostic as a build error with an incoming source map", async () => {
    const rspack = (await import("@rspack/core")).rspack;
    const compiler = rspack({
      mode: "development",
      context: fixtureDir,
      entry: { server: serverEntry },
      target: "node",
      devtool: "source-map",
      output: { path: outputDir, filename: "[name].js", clean: true },
      optimization: { minimize: false },
      externals: [/^(?:react|react-fine-grained-signals)(?:\/|$)/],
      module: { rules: [{ test: /\.jsx$/, enforce: "post", use: [join(import.meta.dirname, "jsx-loader.cjs")] }] },
      plugins: [
        useSourceLoader(
          rspackAdapter({
            mode: "auto",
            diagnostics: { errorOn: ["RFGS009"] },
          }),
        ),
      ],
    });

    try {
      const stats = await new Promise<import("@rspack/core").Stats>((resolve, reject) => {
        compiler.run((error, result) =>
          error ? reject(error) : result ? resolve(result) : reject(new Error("Rspack returned no stats")),
        );
      });
      expect(stats.hasErrors()).toBe(true);
      const failure = stats.compilation.errors.find((entry) => entry.message.includes("RFGS009"));
      expect(failure?.message).toContain('top-level "use server" directive');
      expect(failure?.message).toContain("> 4 | export function ServerAction()");
    } finally {
      await new Promise<void>((resolve) => compiler.close(() => resolve()));
    }
  }, 60_000);
});

describe("esbuild adapter RSC integration", () => {
  it("skips use server with a source warning and transforms use client with entry maps", async () => {
    const esbuild = await import("esbuild");
    const result = await esbuild.build({
      entryPoints: { server: serverEntry, client: clientEntry },
      bundle: true,
      format: "esm",
      outdir: outputDir,
      sourcemap: "external",
      write: true,
      logLevel: "silent",
      external: ["react-fine-grained-signals", "react-fine-grained-signals/*"],
      plugins: [esbuildAdapter({ mode: "auto" })],
    });

    const warning = result.warnings.find((entry) => entry.text.includes('top-level "use server" directive'));
    if (warning === undefined) throw new Error(JSON.stringify(result.warnings.map((entry) => entry.text)));
    expect(warning?.location?.file).toContain(basename(serverEntry));
    expect(warning?.location?.line).toBe(4);
    assertBuildArtifacts(
      readFileSync(join(outputDir, "server.js"), "utf8"),
      readFileSync(join(outputDir, "client.js"), "utf8"),
      readFileSync(join(outputDir, "server.js.map"), "utf8"),
      readFileSync(join(outputDir, "client.js.map"), "utf8"),
      { message: warning?.text ?? "", file: warning?.location?.file },
    );
  }, 60_000);
});
