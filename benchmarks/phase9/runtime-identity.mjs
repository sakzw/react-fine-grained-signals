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

export async function hashCurrentRuntimeInputs() {
  const { stdout } = await execFileAsync("git", [
    "ls-files", "--cached", "--others", "--exclude-standard", "-z", "--", ...runtimeRelevantPaths,
  ], { cwd: repoRoot, windowsHide: true });
  const paths = [...new Set(stdout.split("\0").filter(Boolean))].toSorted();
  const hash = createHash("sha256");
  for (const path of paths) {
    hash.update(path.split(sep).join("/"));
    hash.update("\0");
    hash.update(await readFile(resolve(repoRoot, path)));
    hash.update("\0");
  }
  return hash.digest("hex");
}

export async function verifyCurrentRuntimeIdentity({ expectedRuntimeInputsSha256 } = {}) {
  const runtimeInputsSha256 = await hashCurrentRuntimeInputs();
  let identityGuard = "production-inputs-match-baseline";
  if (expectedRuntimeInputsSha256 !== undefined) {
    if (!/^[a-f0-9]{64}$/.test(expectedRuntimeInputsSha256)) {
      throw new Error("--runtime-inputs-sha256 must be a lowercase 64-character SHA-256.");
    }
    if (runtimeInputsSha256 !== expectedRuntimeInputsSha256) {
      throw new Error(`Runtime input SHA-256 mismatch: expected ${expectedRuntimeInputsSha256}, found ${runtimeInputsSha256}.`);
    }
    identityGuard = "explicit-runtime-inputs-sha256";
  } else {
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
        "Restore the recorded baseline or provide --runtime-inputs-sha256 for an explicitly identified M1.2 implementation.",
      ].join(" "));
    }
  }

  return {
    baselineSha: RUNTIME_BASELINE_SHA,
    guardedPaths: runtimeRelevantPaths,
    runtimeInputsSha256,
    identityGuard,
    artifact: await hashCurrentRuntimeArtifact(),
  };
}
