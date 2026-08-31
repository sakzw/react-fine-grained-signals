// Removes the `//# sourceMappingURL=*.d.ts.map` comment tsdown leaves in every
// emitted .d.ts.
//
// `dts.sourcemap: false` in tsdown.config.ts stops the .d.ts.map files from
// being written, but the declaration pass inherits the top-level
// `sourcemap: true` (kept for the .js maps) and still emits the comment, so
// each .d.ts ends up pointing at a file that does not exist. Verified against
// tsdown 0.22.14: flipping the top-level flag is what removes the comment, and
// `dts.sourcemap` alone does not. Drop this script if that is fixed upstream.
//
// The declaration maps are deliberately not shipped: they would resolve to
// `../src/*.ts`, which `files: ["dist"]` does not publish. The .js maps stay --
// those embed `sourcesContent`, so they work standalone.

import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const DIST = "dist";
const COMMENT = /\r?\n?\/\/# sourceMappingURL=[^\n]*\.d\.ts\.map\s*$/;

const entries = readdirSync(DIST);

// If a declaration map is ever emitted again, its comment is load-bearing and
// stripping it would silently break the map instead of tidying a dead pointer.
const maps = entries.filter((name) => name.endsWith(".d.ts.map"));
if (maps.length > 0) {
  console.error(
    `strip-dts-sourcemap-comments: ${DIST} contains ${maps.length} .d.ts.map file(s), so the comments are real. Remove this script from the build, or turn declaration maps back off.`,
  );
  process.exit(1);
}

let stripped = 0;
for (const name of entries) {
  if (!name.endsWith(".d.ts")) continue;
  const path = join(DIST, name);
  const source = readFileSync(path, "utf8");
  if (!COMMENT.test(source)) continue;
  writeFileSync(path, `${source.replace(COMMENT, "")}\n`);
  stripped++;
}

console.log(`strip-dts-sourcemap-comments: stripped ${stripped} dangling comment(s).`);
