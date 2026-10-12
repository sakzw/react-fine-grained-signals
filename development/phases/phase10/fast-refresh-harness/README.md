# Fast Refresh browser HMR harness

From the repository root, install the root workspace and the isolated legacy Babel fixture, then build and run the browser matrix:

```sh
pnpm install --frozen-lockfile --ignore-scripts
npm ci --prefix development/phases/phase10/fast-refresh-harness/legacy
pnpm build
node development/phases/phase10/fast-refresh-harness/run.mjs
```

The harness starts Vite servers, edits each fixture on disk through a sequence of JSX-only, hook addition, hook removal, and hook-order changes, and checks the live browser DOM, runtime errors, signal updates, and React render count after each edit. The Vite 8/Oxc matrix includes ordinary React without a transform, ordinary React with its component body wrapped in `try/finally`, RFSG managed, RFSG inject, and Preact Signals' React transform. RFSG managed with the Babel React Refresh path runs in a separate Vite 6 compatibility fixture.

The ordinary React `try/finally` control is important: it distinguishes an Oxc Refresh-signature limitation for hooks nested in a `TryStatement` from an RFSG-only regression. The harness keeps an exact allowlist of the currently reproduced hook-add/remove/order failures for that control, RFSG managed, and Preact. Those cases report `known-failure`; any different error remains a test failure. If an allowlisted case begins passing, it is reported as passed. JSX-only state preservation, inject behavior, signal updates and cleanup, and Babel behavior remain ordinary pass/fail checks. The script prints version metadata and transformed signature lines fetched from the running dev servers.
