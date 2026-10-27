import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import { cp, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const pluginRoot = join(repositoryRoot, "packages", "unplugin-react-fine-grained-signals");
const fixtureRoot = join(repositoryRoot, "tests", "fixtures", "consumer-vite");

function resolvePnpmInvocation() {
  const packageManagerScript = process.env.npm_execpath;
  if (packageManagerScript !== undefined && /pnpm/i.test(basename(packageManagerScript))) {
    if (/\.(?:cjs|mjs|js)$/i.test(packageManagerScript)) {
      return { command: process.execPath, prefixArguments: [packageManagerScript] };
    }
    if (/\.exe$/i.test(packageManagerScript) && existsSync(packageManagerScript)) {
      return { command: packageManagerScript, prefixArguments: [] };
    }
  }

  if (process.platform === "win32") {
    for (const pathEntry of (process.env.PATH ?? "").split(delimiter)) {
      if (pathEntry.length === 0) continue;

      const executable = join(pathEntry, "pnpm.exe");
      if (existsSync(executable)) {
        return { command: executable, prefixArguments: [] };
      }

      const commandShim = join(pathEntry, "pnpm.cmd");
      if (!existsSync(commandShim)) continue;

      const shimDirectory = dirname(commandShim);
      const shim = readFileSync(commandShim, "utf8");
      const launchLine = shim.split(/\r?\n/).find((line) => /%\*/.test(line));
      const launchArguments = launchLine?.match(/"([^"]+)"(?:\s+"([^"]+)")?.*%\*/i);
      if (launchArguments === undefined || launchArguments === null) continue;

      const expandShimPath = (value) => resolve(value.replace(/%~dp0/gi, `${shimDirectory}\\`));
      const launcher = expandShimPath(launchArguments[1]);
      const cliScript = launchArguments[2] === undefined ? undefined : expandShimPath(launchArguments[2]);

      if (/\.exe$/i.test(launcher) && existsSync(launcher)) {
        const adjacentCli = [join(dirname(launcher), "pnpm.mjs"), join(dirname(launcher), "bin", "pnpm.mjs")].find(
          (candidate) => existsSync(candidate),
        );
        if (adjacentCli !== undefined) {
          return { command: process.execPath, prefixArguments: [adjacentCli] };
        }
        return {
          command: launcher,
          prefixArguments: cliScript === undefined ? [] : [cliScript],
        };
      }
      if (cliScript !== undefined && existsSync(cliScript)) {
        return { command: process.execPath, prefixArguments: [cliScript] };
      }
    }
  }

  return { command: "pnpm", prefixArguments: [] };
}

const pnpmInvocation = resolvePnpmInvocation();

// `pnpm pack` below runs each package's `prepack` script, which rebuilds its
// `dist` from source, so the tarballs are packed exactly as `pnpm publish`
// packs them -- never from whatever `dist` happened to hold. No separate build
// step is needed first.

const temporaryRoot = await mkdtemp(join(tmpdir(), "react-fine-grained-signals-consumer-"));

async function run(command, arguments_, cwd) {
  process.stdout.write(`[consumer] ${basename(command)} ${arguments_.join(" ")}\n`);
  try {
    const { stdout, stderr } = await execFileAsync(command, arguments_, {
      cwd,
      windowsHide: true,
    });
    if (stdout) process.stdout.write(stdout);
    if (stderr) process.stderr.write(stderr);
  } catch (error) {
    const output = [error.stdout, error.stderr].filter(Boolean).join("\n");
    throw new Error(`${command} ${arguments_.join(" ")} failed${output ? `:\n${output}` : ""}`, {
      cause: error,
    });
  }
}

async function pack(packageRoot, destination) {
  await run(
    pnpmInvocation.command,
    [...pnpmInvocation.prefixArguments, "pack", "--pack-destination", destination],
    packageRoot,
  );
  const tarballs = (await readdir(destination))
    .filter((entry) => entry.endsWith(".tgz"))
    .map((entry) => join(destination, entry));
  if (tarballs.length !== 1) {
    throw new Error(`Expected one tarball from ${basename(packageRoot)}, received ${tarballs.length}`);
  }
  return tarballs[0];
}

try {
  const packsRoot = join(temporaryRoot, "packs");
  const rootTarball = await pack(repositoryRoot, join(packsRoot, "runtime"));
  const pluginTarball = await pack(pluginRoot, join(packsRoot, "plugin"));
  const consumerRoot = join(temporaryRoot, "consumer");

  await cp(fixtureRoot, consumerRoot, { recursive: true });
  const packageJsonPath = join(consumerRoot, "package.json");
  const packageJson = JSON.parse(await readFile(packageJsonPath, "utf8"));
  packageJson.dependencies["react-fine-grained-signals"] = pathToFileURL(rootTarball).href;
  packageJson.dependencies["unplugin-react-fine-grained-signals"] = pathToFileURL(pluginTarball).href;
  await writeFile(packageJsonPath, `${JSON.stringify(packageJson, null, 2)}\n`);

  await run(
    pnpmInvocation.command,
    [...pnpmInvocation.prefixArguments, "install", "--ignore-workspace", "--no-frozen-lockfile"],
    consumerRoot,
  );

  // Validate the package's current manifest separately from the actual runtime
  // composition checks in the private duplicate-copy smoke test.
  const installedManifest = JSON.parse(
    await readFile(join(consumerRoot, "node_modules", "react-fine-grained-signals", "package.json"), "utf8"),
  );
  const installedPluginManifest = JSON.parse(
    await readFile(join(consumerRoot, "node_modules", "unplugin-react-fine-grained-signals", "package.json"), "utf8"),
  );
  const installedRuntimePath = join(consumerRoot, "node_modules", "react-fine-grained-signals");
  const installedPluginPath = join(consumerRoot, "node_modules", "unplugin-react-fine-grained-signals");
  const publishedRuntimePeer = installedPluginManifest.peerDependencies?.["react-fine-grained-signals"];
  if (publishedRuntimePeer !== `^${installedManifest.version}`) {
    throw new Error(
      `Packed plugin must rewrite workspace:^ to ^${installedManifest.version}; got ${publishedRuntimePeer}`,
    );
  }
  if (
    !existsSync(join(installedRuntimePath, "LICENSE")) ||
    !existsSync(join(installedRuntimePath, "LICENSE-ALIEN-SIGNALS.txt")) ||
    !existsSync(join(installedPluginPath, "LICENSE"))
  ) {
    throw new Error("Packed runtime and plugin must include their MIT/license notices");
  }
  if (existsSync(join(installedRuntimePath, "src")) || existsSync(join(installedPluginPath, "src"))) {
    throw new Error("Packed packages must not depend on or contain source directories");
  }
  if (installedManifest.dependencies?.["alien-signals"] === undefined) {
    throw new Error("alien-signals must be published as a runtime dependency");
  }
  if (installedManifest.peerDependencies?.["alien-signals"] !== undefined) {
    throw new Error("alien-signals must not be required as a peer dependency");
  }
  if (installedManifest.peerDependencies?.react === undefined) {
    throw new Error("React must remain a peer dependency");
  }
  if (installedManifest.sideEffects !== false) {
    throw new Error('The published manifest must keep "sideEffects": false for tree-shaking');
  }

  // Import the packed public entries as an installed consumer would. The
  // fixture's TS file covers declaration resolution; this runtime check covers
  // actual package export maps and the minimum usable shape of every adapter.
  const entryContractPath = join(consumerRoot, "entry-contract.mjs");
  await writeFile(
    entryContractPath,
    `
    import { Fragment, jsxDEV } from "react-fine-grained-signals/jsx/jsx-dev-runtime";
    import { createElement, Fragment as classicFragment } from "react-fine-grained-signals/jsx";
    import { createElement as liteCreateElement } from "react-fine-grained-signals/jsx/lite";
    import { jsx as liteJsx } from "react-fine-grained-signals/jsx/lite/jsx-runtime";
    import { jsx } from "react-fine-grained-signals/jsx/jsx-runtime";
    import { useSignalCapture } from "react-fine-grained-signals/internal";
    import * as root from "react-fine-grained-signals";
    import generic, { pluginName, reactFineGrainedSignals } from "unplugin-react-fine-grained-signals";
    import vite from "unplugin-react-fine-grained-signals/vite";
    import rollup from "unplugin-react-fine-grained-signals/rollup";
    import webpack from "unplugin-react-fine-grained-signals/webpack";
    import rspack from "unplugin-react-fine-grained-signals/rspack";
    import esbuild from "unplugin-react-fine-grained-signals/esbuild";

    if (typeof jsxDEV !== "function" || Fragment === undefined) {
      throw new Error("The packed jsx-dev-runtime must export jsxDEV and Fragment");
    }
    if (typeof createElement !== "function" || typeof liteCreateElement !== "function" || classicFragment === undefined) {
      throw new Error("The packed /jsx and /jsx/lite entries must export the classic createElement fallback");
    }
    if (typeof jsx !== "function" || typeof liteJsx !== "function" || typeof useSignalCapture !== "function") {
      throw new Error("The packed JSX runtimes and /internal must export their public functions");
    }
    if ("createElement" in root) {
      throw new Error("The packed root must no longer export createElement");
    }
    // The pre-0.4 entries are removed without aliases, so they must fail to resolve.
    for (const removed of ["lite", "lite/jsx-runtime", "lite/jsx-dev-runtime", "jsx-runtime", "jsx-dev-runtime", "runtime"]) {
      try {
        await import("react-fine-grained-signals/" + removed);
      } catch (error) {
        if (error?.code === "ERR_PACKAGE_PATH_NOT_EXPORTED") continue;
        throw error;
      }
      throw new Error("The removed entry react-fine-grained-signals/" + removed + " must not resolve");
    }
    if (generic !== reactFineGrainedSignals || pluginName !== "unplugin-react-fine-grained-signals") {
      throw new Error("The generic unplugin entry must expose its named public plugin");
    }
    const raw = generic.raw({});
    if (raw.name !== pluginName || typeof raw.transform !== "function") {
      throw new Error("The generic unplugin entry must create a usable raw plugin");
    }
    const rollupPlugin = rollup({});
    if (rollupPlugin.name !== pluginName || typeof rollupPlugin.transform !== "function") {
      throw new Error("rollup entry must create a named transform plugin");
    }
    // Vite gets an object hook with order "pre" so it runs ahead of other
    // pre-enforced transforms such as @vitejs/plugin-react's React Compiler.
    const vitePlugin = vite({});
    if (
      vitePlugin.name !== pluginName ||
      vitePlugin.transform?.order !== "pre" ||
      typeof vitePlugin.transform.handler !== "function"
    ) {
      throw new Error("vite entry must create a named transform plugin with an order: 'pre' hook");
    }
    for (const [name, create] of [["webpack", webpack], ["rspack", rspack]]) {
      if (typeof create({}).apply !== "function") {
        throw new Error(name + " entry must create a compiler plugin with apply()");
      }
    }
    const esbuildPlugin = esbuild({});
    if (esbuildPlugin.name !== pluginName || typeof esbuildPlugin.setup !== "function") {
      throw new Error("The esbuild entry must create a named plugin with setup()");
    }
    console.log("Packed jsx-dev-runtime and unplugin public entries passed.");
  `,
  );
  await run(process.execPath, [entryContractPath], consumerRoot);

  await run(pnpmInvocation.command, [...pnpmInvocation.prefixArguments, "exec", "tsc", "--noEmit"], consumerRoot);
  await run(pnpmInvocation.command, [...pnpmInvocation.prefixArguments, "exec", "vite", "build"], consumerRoot);

  const output = await readFile(join(consumerRoot, "dist", "consumer.js"), "utf8");
  for (const entry of [
    "react-fine-grained-signals",
    "react-fine-grained-signals/utils",
    "react-fine-grained-signals/internal",
  ]) {
    if (!output.includes(entry)) throw new Error(`Consumer output did not retain ${entry}`);
  }
  // `<p {...props} key="spread" />` compiles to the `/jsx` entry's classic factory.
  if (!/import\s*\{[^}]*\bcreateElement\b[^}]*\}\s*from\s*["']react-fine-grained-signals\/jsx["']/.test(output)) {
    throw new Error(
      "Consumer output must import createElement from react-fine-grained-signals/jsx for a key after a spread",
    );
  }
  // Managed codegen keeps user Hooks at function top level and captures proven
  // reads individually. The consumer canary adds several interacting managed
  // components and a destructured deep read; require those captures to survive
  // the actual packed Vite + React Compiler build without pinning their count.
  const captureCalls = output.match(/\.capture\s*\(/g) ?? [];
  if (captureCalls.length < 4) {
    throw new Error(
      `Vite consumer output should retain managed captures for the consumer canary, found ${captureCalls.length}`,
    );
  }
  if (!output.includes("react/compiler-runtime")) {
    throw new Error("Packed consumer Vite build did not run React Compiler");
  }

  // Execute the packed Vite output under real React SSR and hydrate it in
  // JSDOM. Browser E2E covers actual browser input/StrictMode/HMR behavior;
  // this consumer run verifies package exports, managed codegen, nested
  // destructuring, and hydration together after installing the tarballs.
  const { JSDOM } = await import("jsdom");
  const consumerRequire = createRequire(join(consumerRoot, "package.json"));
  const React = consumerRequire("react");
  const { renderToString } = consumerRequire("react-dom/server");
  const { hydrateRoot } = consumerRequire("react-dom/client");
  const { act } = React;
  const canaryBundle = await import(pathToFileURL(join(consumerRoot, "dist", "consumer.js")).href);
  const canaryElement = React.createElement(React.StrictMode, null, React.createElement(canaryBundle.ConsumerCanary));
  console.log("[consumer] rendering the packed canary on the server");
  canaryBundle.resetConsumerCanary();
  const markup = renderToString(canaryElement);
  const dom = new JSDOM(`<!doctype html><div id="root">${markup}</div>`, { url: "http://consumer.test" });
  const globalValues = new Map(
    ["window", "document", "navigator", "HTMLElement", "MutationObserver", "IS_REACT_ACT_ENVIRONMENT"].map((key) => [
      key,
      Object.getOwnPropertyDescriptor(globalThis, key),
    ]),
  );
  for (const [key, value] of Object.entries({
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement,
    MutationObserver: dom.window.MutationObserver,
    IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  try {
    const rootElement = dom.window.document.querySelector("#root");
    let reactRoot;
    await act(() => {
      reactRoot = hydrateRoot(rootElement, canaryElement);
    });
    console.log("[consumer] packed canary hydrated");
    const read = (id) => dom.window.document.querySelector(`[data-testid="${id}"]`);
    if (read("deep-name").textContent !== "Ada" || read("map-value").textContent !== "Ada") {
      throw new Error("Packed canary SSR/hydration lost deep destructuring or reactive collection values");
    }
    if (read("switch-view").textContent !== "list") {
      throw new Error("Packed Switch/Match equals branch did not hydrate consistently");
    }
    const unrelatedRenders = canaryBundle.readUnrelatedCommitCount();
    await act(() => read("count-up").click());
    console.log("[consumer] shared signal update completed");
    if (
      read("count").textContent !== "2" ||
      read("computed").textContent !== "4" ||
      read("shared-child").textContent !== "2" ||
      read("deep-name").textContent !== "Grace" ||
      read("map-value").textContent !== "Grace" ||
      read("set-has").textContent !== "true" ||
      read("helper").textContent !== "2" ||
      canaryBundle.readUnrelatedCommitCount() !== unrelatedRenders ||
      read("count-up").getAttribute("title") !== "updated title" ||
      read("count-up").getAttribute("data-active") !== "true"
    ) {
      throw new Error("Packed canary update failed or caused a parent React rerender");
    }
    await act(() => read("count-only-up").click());
    if (
      read("count").textContent !== "3" ||
      read("computed").textContent !== "6" ||
      read("shared-child").textContent !== "3" ||
      read("helper").textContent !== "3" ||
      canaryBundle.readUnrelatedCommitCount() !== unrelatedRenders
    ) {
      throw new Error("Packed isolated signal update failed or committed the unrelated sibling");
    }
    const consumerCommits = canaryBundle.readConsumerCommitCount();
    await act(() => read("switch-details").click());
    if (read("switch-view").textContent !== "details" || canaryBundle.readConsumerCommitCount() !== consumerCommits) {
      throw new Error("Packed Switch/Match equals update failed or rerendered its React Compiler parent");
    }
    await act(() => read("replace-and-delete").click());
    if (
      read("deep-name").textContent !== "Lin" ||
      read("map-value").textContent !== "" ||
      read("set-has").textContent !== "false"
    ) {
      throw new Error("Packed deep destructuring replacement or collection deletion became stale");
    }
    const conditionalBeforeUnmount = read("conditional");
    await act(() => read("toggle-conditional").click());
    if (read("conditional") !== null) throw new Error("Packed canary conditional did not unmount");
    await act(() => read("toggle-conditional").click());
    const conditionalAfterRemount = read("conditional");
    if (
      conditionalAfterRemount === null ||
      conditionalAfterRemount === conditionalBeforeUnmount ||
      conditionalAfterRemount.textContent !== "3"
    ) {
      throw new Error("Packed canary conditional component did not remount with the current signal value");
    }
    await act(() => read("count-only-up").click());
    if (
      read("conditional").textContent !== "4" ||
      read("helper").textContent !== "4" ||
      canaryBundle.readUnrelatedCommitCount() !== unrelatedRenders
    ) {
      throw new Error("Remounted conditional component did not track subsequent isolated signal updates");
    }
    await act(() => read("react-count-up").click());
    if (read("react-state").textContent !== "1") throw new Error("React state stopped updating alongside signals");

    const input = read("text");
    const nativeInputValue = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value").set;
    await act(() => {
      nativeInputValue.call(input, "consumer");
      input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    });
    if (input.value !== "consumer" || canaryBundle.canaryState.text.value !== "consumer") {
      throw new Error("Packed writable computed input did not update both the DOM and its source signal");
    }
    await act(() => {
      canaryBundle.canaryState.text.value = "direct-text";
    });
    if (input.value !== "direct-text")
      throw new Error("Packed writable computed source update did not reach the input DOM");
    await act(async () => {
      nativeInputValue.call(input, "input longer than twelve");
      input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    if (input.value !== "direct-text" || canaryBundle.canaryState.text.value !== "direct-text") {
      throw new Error("Packed writable computed did not reject and restore an overlong input");
    }
    await act(() => {
      read("checkbox").click();
      read("radio-second").click();
      const select = read("select");
      select.value = "two";
      select.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
    });
    if (
      !read("checkbox").checked ||
      canaryBundle.canaryState.checked.value !== true ||
      !read("radio-second").checked ||
      canaryBundle.canaryState.radio.value !== "second" ||
      read("select").value !== "two" ||
      canaryBundle.canaryState.selected.value !== "two"
    ) {
      throw new Error("Packed consumer form bindings did not accept native events");
    }
    await act(() => {
      canaryBundle.canaryState.checked.value = false;
      canaryBundle.canaryState.radio.value = "first";
      canaryBundle.canaryState.selected.value = "one";
    });
    if (read("checkbox").checked || !read("radio-first").checked || read("select").value !== "one") {
      throw new Error("Packed consumer form binding source updates did not reach the DOM");
    }
    await act(() => reactRoot.unmount());
    canaryBundle.canaryState.count.value += 1;
    console.log("Packed consumer SSR/hydration and combined signal/form updates passed.");
  } finally {
    dom.window.close();
    for (const [key, descriptor] of globalValues) {
      if (descriptor === undefined) delete globalThis[key];
      else Object.defineProperty(globalThis, key, descriptor);
    }
  }

  // Build a second entry as a real installed consumer. Do not externalize
  // React: this checks whether importing only core primitives from the package
  // root causes a bundler to pull React into an application bundle.
  await writeFile(
    join(consumerRoot, "core-only.html"),
    `
    <!doctype html>
    <html><head><meta charset="UTF-8"></head><body>
      <script type="module" src="/core-only.js"></script>
    </body></html>
  `,
  );
  await writeFile(
    join(consumerRoot, "core-only.js"),
    `
    import { computed, signal } from "react-fine-grained-signals";
    const count = signal(1);
    const doubled = computed(() => count.value * 2);
    globalThis.coreOnlyResult = doubled.value;
  `,
  );
  const coreOnlyConfig = join(consumerRoot, "vite.core-only.config.mjs");
  await writeFile(
    coreOnlyConfig,
    `
    import { dirname, resolve } from "node:path";
    import { fileURLToPath } from "node:url";
    const root = dirname(fileURLToPath(import.meta.url));
    export default {
      root,
      build: {
        outDir: "dist-core-only",
        emptyOutDir: true,
        minify: false,
        rollupOptions: { input: resolve(root, "core-only.html") },
      },
    };
  `,
  );
  await run(
    pnpmInvocation.command,
    [...pnpmInvocation.prefixArguments, "exec", "vite", "build", "--config", coreOnlyConfig],
    consumerRoot,
  );
  const coreBundleDirectory = join(consumerRoot, "dist-core-only", "assets");
  const coreBundleFiles = (await readdir(coreBundleDirectory)).filter((entry) => entry.endsWith(".js"));
  if (coreBundleFiles.length !== 1) {
    throw new Error(`Expected one core-only consumer bundle, received ${coreBundleFiles.length}`);
  }
  const coreBundle = await readFile(join(coreBundleDirectory, coreBundleFiles[0]), "utf8");
  for (const reactMarker of ["useSyncExternalStore", "react.production.js", "react.development.js"]) {
    if (coreBundle.includes(reactMarker)) {
      throw new Error(`Core-only installed consumer unexpectedly bundled React marker ${JSON.stringify(reactMarker)}`);
    }
  }
} finally {
  await rm(temporaryRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
}
