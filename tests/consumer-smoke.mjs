import { execFile } from "node:child_process";
import { cp, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const pluginRoot = join(repositoryRoot, "packages", "unplugin-react-fine-grained-signals");
const fixtureRoot = join(repositoryRoot, "tests", "fixtures", "consumer-vite");
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
  await run("pnpm", ["pack", "--pack-destination", destination], packageRoot);
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

  await run("pnpm", ["install", "--ignore-workspace", "--no-frozen-lockfile"], consumerRoot);

  // Packaging guarantees that nothing else in the suite can observe. alien-signals
  // keeps its dependency tracking in module-global state (getActiveSub /
  // setActiveSub), so a second copy in a consumer's graph silently stops tracking
  // reads instead of failing loudly; only the peer declaration forces one copy.
  const installedManifest = JSON.parse(
    await readFile(
      join(consumerRoot, "node_modules", "react-fine-grained-signals", "package.json"),
      "utf8",
    ),
  );
  if (installedManifest.dependencies?.["alien-signals"] !== undefined) {
    throw new Error("alien-signals must not be published as a hard dependency");
  }
  if (installedManifest.peerDependencies?.["alien-signals"] === undefined) {
    throw new Error("alien-signals must be published as a peer dependency");
  }
  if (installedManifest.sideEffects !== false) {
    throw new Error('The published manifest must keep "sideEffects": false for tree-shaking');
  }

  await run("pnpm", ["exec", "tsc", "--noEmit"], consumerRoot);
  await run("pnpm", ["exec", "vite", "build"], consumerRoot);

  const output = await readFile(join(consumerRoot, "dist", "consumer.js"), "utf8");
  for (const entry of [
    "react-fine-grained-signals",
    "react-fine-grained-signals/utils",
    "react-fine-grained-signals/runtime",
  ]) {
    if (!output.includes(entry)) throw new Error(`Consumer output did not retain ${entry}`);
  }
  // The fixture hand-writes one managed boundary (ManagedBoundary, opted out of
  // the transform) and leaves exactly one automatic candidate (Counter), so the
  // default `transform: "managed"` must produce two boundaries in total.
  const managedBoundaries = output.match(/finally\s*\{\s*\w+\.f\(\);/g) ?? [];
  if (managedBoundaries.length !== 2) {
    throw new Error(
      `Vite consumer output should hold the fixture's hand-written managed boundary plus the one the transform injects into Counter, found ${managedBoundaries.length}`,
    );
  }
} finally {
  await rm(temporaryRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
}
