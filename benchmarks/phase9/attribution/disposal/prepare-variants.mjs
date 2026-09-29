import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const phase9 = resolve(import.meta.dirname, "../..");
const repo = resolve(phase9, "../..");
const sourceDist = resolve(repo, "dist");
const variantRoot = resolve(import.meta.dirname, "variants");
const coreChunk = "core-runtime-Q96i8t-7.js";
const original = await readFile(resolve(sourceDist, coreChunk), "utf8");

const replaceOnce = (source, before, after, label) => {
  if (!source.includes(before)) throw new Error(`Could not prepare ${label}: source anchor missing`);
  if (source.indexOf(before) !== source.lastIndexOf(before)) throw new Error(`Could not prepare ${label}: source anchor is ambiguous`);
  return source.replace(before, after);
};

const candidates = {
  D1: replaceOnce(original, "function disposeEffect(effect) {\n\t\teffect.flags = None;", "function disposeEffect(effect) {", "D1 no flags reset"),
  D2: replaceOnce(original,
    "\t\tif (effect.cleanup !== void 0) try {\n\t\t\trunCleanup(effect);\n\t\t} catch (error) {\n\t\t\treportFailure(error);\n\t\t}",
    "",
    "D2 no-cleanup branch"),
  D3: replaceOnce(original,
    "function disposeEffect(effect) {\n\t\teffect.flags = None;\n\t\tdisposeDeps(effect);\n\t\tif (effect.cleanup !== void 0) try {\n\t\t\trunCleanup(effect);\n\t\t} catch (error) {\n\t\t\treportFailure(error);\n\t\t}\n\t}",
    "function disposeEffect(effect) {\n\t\tdisposeDeps(effect);\n\t}",
    "D3 unlink-only"),
  D4: replaceOnce(original, "return () => disposeEffect(node);", "return disposeEffect.bind(null, node);", "D4 bound disposer"),
};

await mkdir(variantRoot, { recursive: true });
for (const [name, core] of Object.entries(candidates)) {
  const destination = resolve(variantRoot, name, "dist");
  await cp(sourceDist, destination, { recursive: true, force: true });
  await writeFile(resolve(destination, coreChunk), core);
}
process.stdout.write(`Prepared ${Object.keys(candidates).join(", ")} as benchmark-only copies under ${variantRoot}\n`);
