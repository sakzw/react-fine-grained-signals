#!/usr/bin/env node
// Repository development mode: build the library and the transform plugin from
// a react-fine-grained-signals checkout and pack them into ./vendor, where
// package.json resolves them through `file:` tarballs. The site never imports
// the checkout directly, so it installs exactly what npm consumers would get.
//
//   node scripts/pack-local-rfsg.mjs [path/to/react-fine-grained-signals]
//
// The checkout defaults to the parent directory (this site's home inside the
// library repository); pass a path or set RFSG_REPO when the site lives
// elsewhere.
import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, renameSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const site = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repo = resolve(process.argv[2] ?? process.env.RFSG_REPO ?? join(site, ".."));
const vendor = join(site, "vendor");
const packages = [
  { dir: repo, name: "react-fine-grained-signals" },
  { dir: join(repo, "packages/unplugin-react-fine-grained-signals"), name: "unplugin-react-fine-grained-signals" },
];

mkdirSync(vendor, { recursive: true });
for (const { dir, name } of packages) {
  const scratch = join(vendor, `.pack-${name}`);
  rmSync(scratch, { recursive: true, force: true });
  mkdirSync(scratch);
  console.log(`[rfsg] pnpm pack ${dir}`);
  // `pnpm pack` runs the package's own prepack build and rewrites `workspace:`
  // ranges, so the tarball matches what `pnpm publish` would upload.
  execFileSync("pnpm", ["pack", "--pack-destination", scratch], { cwd: dir, stdio: "inherit" });
  const [tarball] = readdirSync(scratch).filter((file) => file.endsWith(".tgz"));
  if (tarball === undefined) throw new Error(`pnpm pack produced no tarball for ${name}`);
  // A fixed file name keeps package.json and the lockfile stable across versions.
  renameSync(join(scratch, tarball), join(vendor, `${name}.tgz`));
  rmSync(scratch, { recursive: true, force: true });
}
console.log(`[rfsg] packed into ${vendor}. Run \`pnpm install\` to pick up the new build.`);
