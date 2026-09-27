import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const harnessDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(harnessDir, "../..");

async function packageManifest(moduleUrl) {
  let directory = dirname(fileURLToPath(moduleUrl));
  while (true) {
    const path = resolve(directory, "package.json");
    try {
      const manifest = JSON.parse(await readFile(path, "utf8"));
      return { path, manifest };
    } catch {
      const parent = dirname(directory);
      if (parent === directory) throw new Error(`Cannot find package.json above ${moduleUrl}`);
      directory = parent;
    }
  }
}

function lockIntegrity(lockText, packageName, expectedVersion) {
  const lines = lockText.split(/\r?\n/);
  const prefix = `  ${packageName}@${expectedVersion}`;
  const index = lines.findIndex((line) => line.replaceAll("'", "").startsWith(prefix) && line.trimEnd().endsWith(":"));
  if (index === -1) throw new Error(`Lockfile has no ${packageName}@${expectedVersion} resolution.`);
  let end = index + 1;
  while (end < lines.length && !/^  [^ ]/.test(lines[end])) end += 1;
  const block = lines.slice(index, end).join("\n");
  const integrity = block.match(/integrity: ([^\s}]+)/)?.[1];
  if (!integrity) throw new Error(`Lockfile has no integrity for ${packageName}@${expectedVersion}.`);
  return integrity;
}

const oldEntryUrl = import.meta.resolve("react-fine-grained-signals");
const vueEntryUrl = import.meta.resolve("@vue/reactivity");
const alienEntryUrl = import.meta.resolve("alien-signals");
const oldPackage = await packageManifest(oldEntryUrl);
const vuePackage = await packageManifest(vueEntryUrl);
const alienPackage = await packageManifest(alienEntryUrl);
const currentPackage = JSON.parse(await readFile(resolve(repoRoot, "package.json"), "utf8"));
const oldAlienUrl = createRequire(oldEntryUrl).resolve("alien-signals");
const currentEntryUrl = new URL("../../dist/index.js", import.meta.url).href;
const currentAlienUrl = createRequire(currentEntryUrl).resolve("alien-signals");
const oldAlienPackage = await packageManifest(pathToFileURL(oldAlienUrl).href);
const currentAlienPackage = await packageManifest(pathToFileURL(currentAlienUrl).href);
const lockText = await readFile(resolve(harnessDir, "pnpm-lock.yaml"), "utf8");

const expectations = [
  ["published RFSG v0.1.1", oldPackage.manifest.version, "0.1.1"],
  ["RFSG v0.1.1 Alien peer", oldPackage.manifest.peerDependencies?.["alien-signals"], "^3.2.1"],
  ["v0.1.1 resolved Alien Signals", oldAlienPackage.manifest.version, "3.2.1"],
  ["current RFSG package metadata", currentPackage.version, "0.1.1"],
  ["current RFSG Alien dependency", currentPackage.dependencies?.["alien-signals"], "^3.2.1"],
  ["current RFSG resolved Alien Signals", currentAlienPackage.manifest.version, "3.2.1"],
  ["direct Alien Signals package", alienPackage.manifest.version, "3.2.1"],
  ["Vue reactivity package", vuePackage.manifest.version, "3.6.0-rc.9"],
];
for (const [label, actual, expected] of expectations) {
  if (actual !== expected) throw new Error(`${label}: expected ${expected}, got ${actual}`);
}

export const pinnedArtifactIntegrity = {
  rfsgV011: lockIntegrity(lockText, "react-fine-grained-signals", "0.1.1"),
  alienSignals: lockIntegrity(lockText, "alien-signals", "3.2.1"),
  vueReactivity: lockIntegrity(lockText, "@vue/reactivity", "3.6.0-rc.9"),
};

export const verifiedPins = {
  v0_1_1: { version: oldPackage.manifest.version, tarballSource: "npm registry package installed by the pinned fixture lockfile" },
  oldAlien: oldAlienPackage.manifest.version,
  currentAlien: currentAlienPackage.manifest.version,
  vue: vuePackage.manifest.version,
  pinnedArtifactIntegrity,
};
