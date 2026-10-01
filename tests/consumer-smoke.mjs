import { execFile } from "node:child_process";
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

      const expandShimPath = (value) => resolve(
        value.replace(/%~dp0/ig, `${shimDirectory}\\`),
      );
      const launcher = expandShimPath(launchArguments[1]);
      const cliScript = launchArguments[2] === undefined
        ? undefined
        : expandShimPath(launchArguments[2]);

      if (/\.exe$/i.test(launcher) && existsSync(launcher)) {
        const adjacentCli = [
          join(dirname(launcher), "pnpm.mjs"),
          join(dirname(launcher), "bin", "pnpm.mjs"),
        ].find((candidate) => existsSync(candidate));
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

// `pnpm pack` below tars up whatever `dist` already holds -- neither package
// declares a `prepack` script -- so a missing build surfaces as a confusing tsc
// or vite failure inside the throwaway consumer instead of here. CI runs this
// file directly after its own `pnpm build` step rather than through `pnpm
// test:consumer`, whose script would rebuild; that is the same contract
// scripts/check-size.mjs enforces for the size budget.
for (const packageRoot of [repositoryRoot, pluginRoot]) {
  if (!existsSync(join(packageRoot, "dist", "index.js"))) {
    console.error(`No build found at ${join(packageRoot, "dist")}. Run \`pnpm build\` first.`);
    process.exit(1);
  }
}

const temporaryRoot = await mkdtemp(join(tmpdir(), "react-fine-grained-signals-consumer-"));

async function run(command, arguments_, cwd) {
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
    await readFile(
      join(consumerRoot, "node_modules", "react-fine-grained-signals", "package.json"),
      "utf8",
    ),
  );
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
  await writeFile(entryContractPath, `
    import { Fragment, jsxDEV } from "react-fine-grained-signals/jsx-dev-runtime";
    import { createElement } from "react-fine-grained-signals";
    import generic, { pluginName, reactFineGrainedSignals } from "unplugin-react-fine-grained-signals";
    import vite from "unplugin-react-fine-grained-signals/vite";
    import rollup from "unplugin-react-fine-grained-signals/rollup";
    import webpack from "unplugin-react-fine-grained-signals/webpack";
    import rspack from "unplugin-react-fine-grained-signals/rspack";
    import esbuild from "unplugin-react-fine-grained-signals/esbuild";

    if (typeof jsxDEV !== "function" || Fragment === undefined) {
      throw new Error("The packed jsx-dev-runtime must export jsxDEV and Fragment");
    }
    if (typeof createElement !== "function") {
      throw new Error("The packed root must export the classic createElement fallback");
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
  `);
  await run(process.execPath, [entryContractPath], consumerRoot);

  await run(
    pnpmInvocation.command,
    [...pnpmInvocation.prefixArguments, "exec", "tsc", "--noEmit"],
    consumerRoot,
  );
  await run(
    pnpmInvocation.command,
    [...pnpmInvocation.prefixArguments, "exec", "vite", "build"],
    consumerRoot,
  );

  const output = await readFile(join(consumerRoot, "dist", "consumer.js"), "utf8");
  for (const entry of [
    "react-fine-grained-signals",
    "react-fine-grained-signals/utils",
    "react-fine-grained-signals/runtime",
  ]) {
    if (!output.includes(entry)) throw new Error(`Consumer output did not retain ${entry}`);
  }
  // `<p {...props} key="spread" />` compiles to the root's classic factory.
  if (!/import\s*\{[^}]*\bcreateElement\b[^}]*\}\s*from\s*["']react-fine-grained-signals["']/.test(output)) {
    throw new Error("Consumer output must import createElement from the package root for a key after a spread");
  }
  // The fixture hand-writes one managed boundary (ManagedBoundary, opted out of
  // the transform) and leaves exactly one automatic candidate (Counter), so the
  // default `transform: "managed"` must produce two boundaries in total.
  const managedBoundaries = output.match(/finally\s*\{\s*\w+\.finish\(\);/g) ?? [];
  if (managedBoundaries.length !== 2) {
    throw new Error(
      `Vite consumer output should hold the fixture's hand-written managed boundary plus the one the transform injects into Counter, found ${managedBoundaries.length}`,
    );
  }

  // Exercise two freshly copied runtime builds in this same consumer smoke
  // path. This keeps duplicate-copy coverage independent of stale dist during
  // ordinary source unit tests.
  await run(
    process.execPath,
    [join(repositoryRoot, "tests", "cross-copy-smoke.mjs")],
    repositoryRoot,
  );
} finally {
  await rm(temporaryRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
}
