import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const fixtures = join(repositoryRoot, "tests/phase6/fixtures/candidates.ts");
const outputRoot = resolve(process.argv[2] ?? "");
if (outputRoot === repositoryRoot || outputRoot.length < 5) throw new Error("Pass a separate temporary output directory");
mkdirSync(outputRoot, { recursive: true });

for (const [file, exportName] of [
  ["A.js", "createCandidateA"],
  ["B.js", "createCandidateB"],
  ["C0.js", "createCandidateC"],
  ["C1.js", "createCandidateC1"],
]) {
  const entry = join(outputRoot, `entry-${file}.ts`);
  writeFileSync(entry, `export { ${exportName} as create } from ${JSON.stringify(fixtures)};\n`);
  await build({
    configFile: false,
    logLevel: "silent",
    build: {
      outDir: outputRoot,
      emptyOutDir: false,
      minify: true,
      lib: { entry, formats: ["es"], fileName: () => file },
    },
  });
}
