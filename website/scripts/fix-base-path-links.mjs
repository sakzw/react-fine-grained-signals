import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Vocs 2.10.3's SkipToContent.client.tsx builds href from its router path
// without applying config.basePath. Patch only generated static HTML so
// GitHub Pages project sites keep the skip link on the current route. The
// Chromium smoke test asserts this for every route; fail if Vocs changes its
// markup so the workaround gets revisited rather than silently disappearing.
const site = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const output = path.join(site, "dist", "public");
const segments = (process.env.SITE_BASE_PATH ?? "/react-fine-grained-signals").split("/").filter(Boolean);
const basePath = segments.length > 0 ? `/${segments.join("/")}` : "";
let patched = 0;

async function visit(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const filename = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      await visit(filename);
      continue;
    }
    if (!entry.name.endsWith(".html")) continue;

    const relative = path.relative(output, filename).replaceAll("\\", "/");
    const route = relative === "index.html" ? "/" : `/${relative.replace(/\/index\.html$/, "").replace(/\.html$/, "")}`;
    const href = `${basePath}${route}#vocs-content`;
    const html = await readFile(filename, "utf8");
    const fixed = html.replace(/(<a\b[^>]*data-v-skip-to-content="true"[^>]*\bhref=")[^"]*("[^>]*>)/g, `$1${href}$2`);
    if (fixed !== html) {
      patched += 1;
      await writeFile(filename, fixed);
    }
  }
}

await visit(output);
if (patched === 0) throw new Error(`No Vocs skip links were found in ${output}`);
console.log(`[website] Added base path to ${patched} Vocs skip links.`);
