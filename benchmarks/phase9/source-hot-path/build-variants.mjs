import { createHash } from "node:crypto";
import { cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../../..");
const sourceDist = resolve(repoRoot, "dist");
const outputRoot = resolve(here, "variants");
const files = (await readdir(sourceDist)).filter((name) => name.endsWith(".js"));
const coreName = files.find((name) => name.startsWith("core-runtime-") && name.endsWith(".js"));
if (!coreName) throw new Error("Build current production runtime first; core-runtime chunk missing.");

const transformations = {
  R1: (s) => replaceFirst(s, "const currentOwner = executionContext.owner;", "const currentOwner = void 0;"),
  R2: (s) => replaceFirst(s, "if (activeRenderCollector !== void 0) trackRenderDependency(getRenderDependency(this, node));", ""),
  R3: (s) => replaceFirst(replaceFirst(s, "const currentOwner = executionContext.owner;", "const currentOwner = void 0;"), "if (activeRenderCollector !== void 0) trackRenderDependency(getRenderDependency(this, node));", ""),
  R4: (s) => replaceFirst(
    replaceFirst(s, "const currentOwner = executionContext.owner;", "const currentOwner = void 0;"),
    "const value = readSource(node);\n\t\t\t\tif (activeRenderCollector !== void 0) trackRenderDependency(getRenderDependency(this, node));",
    "if (node.flags & Dirty && updateSource(node)) {\n\t\t\t\t\tif (node.subs !== void 0) shallowPropagate(node.subs);\n\t\t\t\t}\n\t\t\t\tif (activeSub !== void 0) linkNode(node, activeSub, cycle);\n\t\t\t\tconst value = node.currentValue;",
  ),
  R5: (s) => replaceFirst(
    replaceFirst(replaceFirst(s, "const currentOwner = executionContext.owner;", "const currentOwner = void 0;"), "if (activeRenderCollector !== void 0) trackRenderDependency(getRenderDependency(this, node));", ""),
    "const value = readSource(node);",
    "const value = node.currentValue;",
  ),
  W1: (s) => replaceOnce(s, "\t\tif (deepSignalNodes.has(node)) deepWatchedNodes.delete(node);\n", ""),
  W2: (s) => replaceOnce(s, "\t\t\tif (node.renderRevision !== void 0) node.renderRevision = node.renderRevision + 1 | 0;\n", ""),
  W3: (s) => replaceOnce(replaceOnce(s, "\t\tif (deepSignalNodes.has(node)) deepWatchedNodes.delete(node);\n", ""), "\t\t\tif (node.renderRevision !== void 0) node.renderRevision = node.renderRevision + 1 | 0;\n", ""),
  W4: (s) => replaceOnce(s, "\t\t\tinlineWrite(this.#node, value);", "\t\t\tconst node = this.#node;\n\t\t\tif (!Object.is(node.pendingValue, node.pendingValue = value)) {\n\t\t\t\tnode.flags = 17;\n\t\t\t\tconst subscribers = node.subs;\n\t\t\t\tif (subscribers !== void 0) {\n\t\t\t\t\tpropagate(subscribers, !!runDepth);\n\t\t\t\t\tif (!batchDepth) flush();\n\t\t\t\t}\n\t\t\t}"),
};

function replaceOnce(input, before, after) {
  const first = input.indexOf(before);
  if (first < 0 || input.indexOf(before, first + before.length) >= 0) throw new Error(`Expected exactly one occurrence of ${JSON.stringify(before)}`);
  return input.slice(0, first) + after + input.slice(first + before.length);
}
function replaceFirst(input, before, after) {
  const first = input.indexOf(before);
  if (first < 0) throw new Error(`Expected at least one occurrence of ${JSON.stringify(before)}`);
  return input.slice(0, first) + after + input.slice(first + before.length);
}

function hash(text) { return createHash("sha256").update(text).digest("hex"); }
const manifest = { sourceHead: "", sourceDistPath: sourceDist, coreChunk: coreName, variants: {} };
manifest.sourceHead = process.argv[2] ?? "unrecorded";
const baseCore = await readFile(join(sourceDist, coreName), "utf8");

for (const [name, transform] of Object.entries(transformations)) {
  const destination = join(outputRoot, name, "dist");
  await rm(dirname(destination), { recursive: true, force: true });
  await mkdir(destination, { recursive: true });
  for (const file of files) await cp(join(sourceDist, file), join(destination, file));
  const transformed = transform(baseCore);
  await writeFile(join(destination, coreName), transformed);
  manifest.variants[name] = { coreSha256: hash(transformed), files: {} };
  for (const file of files.toSorted()) manifest.variants[name].files[file] = hash(await readFile(join(destination, file)));
  manifest.variants[name].artifactSha256 = hash(JSON.stringify(manifest.variants[name].files));
}
await writeFile(join(here, "variant-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
process.stdout.write(`Created ${Object.keys(transformations).length} benchmark-only variants from ${manifest.sourceHead}; production inputs unchanged.\n`);
