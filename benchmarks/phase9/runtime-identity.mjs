import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { RUNTIME_BASELINE_SHA } from "./config.mjs";

const execFileAsync = promisify(execFile);
const harnessDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(harnessDir, "../..");
const runtimeRelevantPaths = [
  "src",
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "tsdown.config.ts",
  "tsconfig.json",
  "scripts/strip-dts-sourcemap-comments.mjs",
];
const requiredRuntimeEntries = [
  "index.js",
  "jsx-runtime.js",
  "jsx-dev-runtime.js",
  "runtime.js",
  "utils.js",
];

async function gitOutput(args) {
  const { stdout } = await execFileAsync("git", args, { cwd: repoRoot, windowsHide: true });
  return stdout.trim();
}

export async function hashCurrentRuntimeArtifact() {
  const distRoot = resolve(repoRoot, "dist");
  const files = [];
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile()) files.push(path);
    }
  }

  await visit(distRoot);
  files.sort((left, right) => {
    const leftPath = relative(distRoot, left);
    const rightPath = relative(distRoot, right);
    return leftPath < rightPath ? -1 : (leftPath > rightPath ? 1 : 0);
  });
  const relativePaths = files.map((path) => relative(distRoot, path).split(sep).join("/"));
  const missingEntries = requiredRuntimeEntries.filter((entry) => !relativePaths.includes(entry));
  if (missingEntries.length > 0) throw new Error(`Built runtime dist is missing required entries: ${missingEntries.join(", ")}`);

  const hash = createHash("sha256");
  for (let index = 0; index < files.length; index += 1) {
    hash.update(relativePaths[index]);
    hash.update("\0");
    hash.update(await readFile(files[index]));
    hash.update("\0");
  }
  return { sha256: hash.digest("hex"), fileCount: files.length, requiredEntries: requiredRuntimeEntries };
}

export async function verifyCurrentRuntimeIdentity() {
  await gitOutput(["cat-file", "-e", `${RUNTIME_BASELINE_SHA}^{commit}`]);
  const changedTracked = await gitOutput(["diff", "--name-only", RUNTIME_BASELINE_SHA, "--", ...runtimeRelevantPaths]);
  const addedUntracked = await gitOutput(["ls-files", "--others", "--", "src", "scripts/strip-dts-sourcemap-comments.mjs"]);
  const divergence = [
    ...changedTracked.split(/\r?\n/).filter(Boolean),
    ...addedUntracked.split(/\r?\n/).filter(Boolean),
  ];
  if (divergence.length > 0) {
    throw new Error([
      `Current runtime sources do not match Phase 9 baseline ${RUNTIME_BASELINE_SHA}.`,
      `Changed production-relevant paths: ${[...new Set(divergence)].join(", ")}`,
      "Restore the recorded baseline before running measurement or calibration mode.",
    ].join(" "));
  }

  return {
    baselineSha: RUNTIME_BASELINE_SHA,
    guardedPaths: runtimeRelevantPaths,
    artifact: await hashCurrentRuntimeArtifact(),
  };
}
