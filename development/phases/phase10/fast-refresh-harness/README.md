# Fast Refresh browser HMR harness

From the repository root, install the root workspace and the isolated legacy Babel fixture, then build and run the browser matrix:

```sh
pnpm install --frozen-lockfile --ignore-scripts
npm ci --prefix development/phases/phase10/fast-refresh-harness/legacy
pnpm build
node development/phases/phase10/fast-refresh-harness/run.mjs
```

The harness starts Vite servers, edits each fixture on disk through a sequence of JSX-only, hook addition, hook removal, and hook-order changes, and checks the live browser DOM, runtime errors, signal updates, and React render count after each edit. The Vite 8/Oxc matrix includes ordinary React without a transform, ordinary React with its component body wrapped in `try/finally`, RFSG managed, RFSG inject, and Preact Signals' React transform. RFSG managed with the Babel React Refresh path runs in a separate Vite 6 compatibility fixture.

The ordinary React `try/finally` control is important: it distinguishes an Oxc Refresh-signature limitation for hooks nested in a `TryStatement` from an RFSG-only regression. The current Oxc hook-add/remove/order allowlist applies to that control and Preact only; RFSG managed and inject are required to pass. JSX-only state preservation, signal updates and cleanup, and the Babel managed compatibility route are also ordinary pass/fail checks. The script prints version metadata and transformed signature lines fetched from the running dev servers.
