#!/usr/bin/env node
// Cross-platform launcher for the `@react-router/serve` production server.
//
// `react-router-serve`'s CLI (see its `dist/cli.js`) only reads the port and
// host to bind to from `process.env.PORT` / `process.env.HOST` — there is no
// `--port`/`--host` flag. Setting env vars inline in an npm script
// (`PORT=4175 react-router-serve ...`) isn't portable between POSIX shells
// and Windows' cmd.exe, so this sets them in JS first and then loads the
// CLI module directly instead of shelling out to its bin script.
//
// `@react-router/serve` only exposes `./package.json` in its "exports" map
// (its CLI is meant to be run, not imported), so the internal `dist/cli.js`
// path is resolved relative to that public entry rather than imported by a
// deep bare specifier.
process.env.PORT ??= "4175";
process.env.HOST ??= "127.0.0.1";
process.env.NODE_ENV ??= "production";

const packageJsonUrl = import.meta.resolve("@react-router/serve/package.json");
const cliUrl = new URL("dist/cli.js", packageJsonUrl);

// The CLI reads its server-build path positionally off process.argv[2],
// resolved relative to process.cwd() (this package's directory).
process.argv[2] = "build/server/index.js";

await import(cliUrl.href);
