# Fast Refresh browser HMR harness

From the repository root, install the root workspace and the isolated legacy Babel fixture, then build and run the browser matrix:

```sh
pnpm install --frozen-lockfile --ignore-scripts
npm ci --prefix development/phases/phase10/fast-refresh-harness/legacy
pnpm build
node development/phases/phase10/fast-refresh-harness/run.mjs
```

The harness starts Vite servers, edits each fixture on disk through a sequence of JSX-only, hook addition, hook removal, and hook-order changes, and checks the live browser DOM, runtime errors, signal updates, and React render count after each edit. It compares RFSG managed and inject transforms under Vite 8/Oxc React Refresh, Preact Signals' React transform under Vite 8/Oxc React Refresh, and RFSG managed with the Babel React Refresh path in a Vite 6 compatibility fixture. The script prints installed version metadata and the transformed module signatures fetched from the running dev servers.
