#!/usr/bin/env node
// Serves the static build the way GitHub Pages serves a project site: the
// files in dist/public appear under the configured basePath, `/x` resolves to
// `x.html` or `x/index.html`, `/x/` to `x/index.html`, and anything missing
// gets `404.html` with status 404. No Node server runs in production; this
// only previews what Pages will host.
//
//   node scripts/serve-static.mjs [--port 4173]
import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const site = resolve(fileURLToPath(new URL("..", import.meta.url)));
const root = join(site, "dist/public");
const basePath = (process.env.SITE_BASE_PATH ?? "/react-fine-grained-signals").replace(/\/$/, "");
const portIndex = process.argv.indexOf("--port");
const port = Number(portIndex === -1 ? (process.env.PORT ?? 4173) : process.argv[portIndex + 1]);

const types = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".txt": "text/plain; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".wasm": "application/wasm",
  ".xml": "application/xml",
};

function file(path) {
  return existsSync(path) && statSync(path).isFile() ? path : undefined;
}

function lookup(pathname) {
  const target = normalize(join(root, decodeURIComponent(pathname)));
  if (!target.startsWith(root)) return undefined;
  if (pathname.endsWith("/")) return file(join(target, "index.html"));
  return file(target) ?? file(`${target}.html`);
}

/** GitHub Pages answers `/dir` with a redirect to `/dir/` when `dir/index.html` exists. */
function directoryRedirect(pathname) {
  if (pathname.endsWith("/")) return undefined;
  const target = normalize(join(root, decodeURIComponent(pathname)));
  return target.startsWith(root) && file(join(target, "index.html")) !== undefined ? `${pathname}/` : undefined;
}

createServer((request, response) => {
  const url = new URL(request.url ?? "/", "http://localhost");
  let found;
  if (url.pathname === basePath) {
    response.writeHead(301, { location: `${basePath}/` }).end();
    return;
  }
  if (url.pathname.startsWith(`${basePath}/`)) {
    const relative = url.pathname.slice(basePath.length);
    found = lookup(relative);
    const redirect = found === undefined ? directoryRedirect(relative) : undefined;
    if (redirect !== undefined) {
      response.writeHead(301, { location: `${basePath}${redirect}${url.search}` }).end();
      return;
    }
  }
  const status = found === undefined ? 404 : 200;
  const path = found ?? join(root, "404.html");
  response.writeHead(status, { "content-type": types[extname(path)] ?? "application/octet-stream" });
  createReadStream(path).pipe(response);
}).listen(port, "127.0.0.1", () => {
  console.log(`Static preview: http://127.0.0.1:${port}${basePath}/`);
});
