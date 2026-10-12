import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from '@playwright/test';
import { createServer as createVite8 } from 'vite';
import reactOxc from '@vitejs/plugin-react';
import babel from '@rolldown/plugin-babel';
import preactTransform from '@preact/signals-react-transform';
import signals from '../../../../packages/unplugin-react-fine-grained-signals/dist/vite.js';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '../../../..');
const runtimeVersions = {
  node: process.version,
  viteOxc: '8.3.1',
  viteBabel: '6.4.4',
  babelCore: '7.29.7',
  react: '19.3.0',
  reactDom: '19.3.0',
  reactPluginOxc: '6.1.2',
  reactPluginBabel: '4.7.0',
  preactSignals: '3.12.0',
  preactTransform: '0.8.3',
};

const source = (variant, { jsx = 'base', hooks = 'base' } = {}) => {
  const moduleName = variant === 'preact-oxc' ? '@preact/signals-react' : 'react-fine-grained-signals';
  let extraHooks = '';
  let hookRead = '';
  if (hooks === 'added') {
    extraHooks = '  const [extra, setExtra] = useState("added");\n';
    hookRead = '    <output data-testid="extra">{extra}</output><button data-testid="extra-increment" onClick={() => setExtra((value) => value + "!")}>extra +1</button>\n';
  } else if (hooks === 'reordered') {
    extraHooks = '  const [mode, dispatch] = useReducer((state) => state + 1, 0);\n  const [extra, setExtra] = useState("added");\n';
    hookRead = '    <output data-testid="mode">{mode}</output><button data-testid="mode-increment" onClick={() => dispatch()}>mode +1</button><output data-testid="extra">{extra}</output><button data-testid="extra-increment" onClick={() => setExtra((value) => value + "!")}>extra +1</button>\n';
  } else if (hooks === 'reverse-order') {
    extraHooks = '  const [extra, setExtra] = useState("added");\n  const [mode, dispatch] = useReducer((state) => state + 1, 0);\n';
    hookRead = '    <output data-testid="extra">{extra}</output><button data-testid="extra-increment" onClick={() => setExtra((value) => value + "!")}>extra +1</button><output data-testid="mode">{mode}</output><button data-testid="mode-increment" onClick={() => dispatch()}>mode +1</button>\n';
  }
  const label = jsx === 'base' ? 'baseline JSX' : jsx;
  return `import { useReducer, useState } from "react";
import { count } from "./signal-store";

export function Counter() {
  const [local, setLocal] = useState(0);
${extraHooks}  window.__hmrMetrics.renders += 1;
  const signalValue = count.value;
  return (
    <section data-testid="counter">
      <p data-testid="jsx-label">${label}</p>
      <output data-testid="local">{local}</output>
      ${hookRead}      <output data-testid="signal">{signalValue}</output>
      <button id="local-increment" onClick={() => setLocal((n) => n + 1)}>local +1</button>
    </section>
  );
}

export default function App() {
  const [shown, setShown] = useState(true);
  return <main>
    <button id="toggle" onClick={() => setShown((value) => !value)}>toggle</button>
    <button id="signal-increment" onClick={() => { count.value += 1; }}>signal +1</button>
    {shown ? <Counter /> : <p data-testid="hidden">hidden</p>}
  </main>;
}
`;
};

const indexHtml = `<!doctype html><html><head><meta charset="UTF-8"><title>Fast Refresh HMR harness</title></head><body><div id="root"></div><script type="module" src="/src/main.tsx"></script></body></html>`;
const mainSource = `import React from "react"; import { createRoot } from "react-dom/client"; import App from "./App";\nconst boot = Number(sessionStorage.getItem("__rfgs_hmr_boots") ?? 0) + 1; sessionStorage.setItem("__rfgs_hmr_boots", String(boot));\nwindow.__hmrMetrics = { renders: 0, boot };\ncreateRoot(document.getElementById("root")).render(<React.StrictMode><App /></React.StrictMode>);\n`;
const storeSource = (variant) => {
  const sourceName = variant === 'preact-oxc' ? '@preact/signals-react' : 'react-fine-grained-signals';
  return `import { signal } from "${sourceName}";\nexport const count = signal(0);\n`;
};

const variants = [
  { id: 'managed-oxc', server: 'vite8', kind: 'rfgs', transform: 'managed' },
  { id: 'inject-oxc', server: 'vite8', kind: 'rfgs', transform: 'inject' },
  { id: 'preact-oxc', server: 'vite8', kind: 'preact' },
  { id: 'managed-babel', server: 'vite6', kind: 'rfgs', transform: 'managed' },
];
const playwrightErrors = [];
const servers = [];
const appRoots = new Map();
let browser;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function setVariantSource(variant, state) {
  const root = appRoots.get(variant.id);
  await writeFile(join(root, 'src', 'App.tsx'), source(variant.id, state), 'utf8');
}

async function waitForUpdate(page, selector, expected, label) {
  await page.waitForFunction(({ selector: query, expectedValue }) => {
    const element = document.querySelector(query);
      return element?.textContent?.trim() === expectedValue;
  }, { selector, expectedValue: String(expected) }, { timeout: 3000 }).catch(async (error) => {
    const current = await page.locator(selector).textContent().catch(() => '<missing>');
    throw new Error(`${label}: expected ${JSON.stringify(expected)}, saw ${JSON.stringify(current)} (${error.message})`);
  });
}

async function openServer(variant, root) {
  const config = {
    configFile: false,
    root,
    appType: 'spa',
    logLevel: 'error',
    server: { host: '127.0.0.1', port: variant.server === 'vite8' ? 0 : 0, strictPort: false, hmr: true },
    optimizeDeps: { include: ['react', 'react-dom/client'] },
    resolve: {
      dedupe: ['react', 'react-dom'],
      alias: [
        { find: 'react-fine-grained-signals/runtime', replacement: join(repo, 'dist', 'runtime.js') },
        { find: 'react-fine-grained-signals', replacement: join(repo, 'dist', 'index.js') },
      ],
    },
    plugins: variant.kind === 'preact'
      ? [reactOxc(), babel({ plugins: [preactTransform] })]
      : [reactOxc(), signals({ mode: 'auto', transform: variant.transform })],
  };
  const server = await createVite8(config);
  await server.listen();
  servers.push(server);
  const url = server.resolvedUrls.local?.[0];
  assert(url, `${variant.id}: Vite server did not report a local URL`);
  return { server, url };
}

async function openLegacyServer(variant, root) {
  const viteDirectory = join(here, 'legacy', 'node_modules', 'vite');
  const reactPluginFile = join(here, 'legacy', 'node_modules', '@vitejs', 'plugin-react', 'dist', 'index.js');
  const { createServer } = await import(pathToFileURL(join(viteDirectory, 'dist', 'node', 'index.js')).href);
  const { default: reactBabel } = await import(pathToFileURL(reactPluginFile).href);
  const server = await createServer({
    configFile: false,
    root,
    appType: 'spa',
    logLevel: 'error',
    server: { host: '127.0.0.1', port: 0, strictPort: false, hmr: true },
    optimizeDeps: { include: ['react', 'react-dom/client'] },
    resolve: {
      dedupe: ['react', 'react-dom'],
      alias: [
        { find: 'react-fine-grained-signals/runtime', replacement: join(repo, 'dist', 'runtime.js') },
        { find: 'react-fine-grained-signals', replacement: join(repo, 'dist', 'index.js') },
      ],
    },
    plugins: [reactBabel(), signals({ mode: 'auto', transform: 'managed' })],
  });
  await server.listen();
  servers.push(server);
  const url = server.resolvedUrls.local?.[0];
  assert(url, `${variant.id}: Vite server did not report a local URL`);
  return { server, url };
}

async function runCase(variant, server, scenario) {
  await setVariantSource(variant, scenario.initial);
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (error) => {
    const value = `${variant.id}/${scenario.id} pageerror: ${error.stack ?? error.message}`;
    errors.push(value);
    playwrightErrors.push(value);
  });
  page.on('console', (message) => {
    if (message.type() === 'error' || message.type() === 'warning') {
      const value = `${variant.id}/${scenario.id} ${message.type()}: ${message.text()}`;
      errors.push(value);
      if (message.type() === 'error') playwrightErrors.push(value);
    }
  });
  try {
    // Vite's HMR websocket keeps the network active; wait for document readiness
    // and then the rendered counter instead of waiting for network idle.
    await page.goto(server.url, { waitUntil: 'domcontentloaded' });
    await page.getByTestId('counter').waitFor();
    const boot = await page.evaluate(() => window.__hmrMetrics.boot);
    const initialTransform = await fetch(`${server.url}src/App.tsx`).then((response) => response.text());
    const initialSignature = initialTransform.split('\n').filter((line) => /RefreshSig|RefreshReg|createSignature|_s\d?\(|try\s*\{|finish\(\)/.test(line));

    await page.locator('#local-increment').click();
    if (scenario.id === 'reorder-hooks') {
      await page.getByTestId('mode-increment').click();
      await page.getByTestId('extra-increment').click();
    }
    await setVariantSource(variant, scenario.edited);
    await waitForUpdate(page, '[data-testid="jsx-label"]', scenario.edited.jsx, `${variant.id}/${scenario.id} HMR`);
    const finalLocal = await page.getByTestId('local').textContent();
    assert(await page.evaluate(() => window.__hmrMetrics.boot) === boot, `${variant.id}/${scenario.id}: HMR caused a full page reload`);
    if (scenario.id === 'jsx-only') {
      assert(finalLocal === '1', `${variant.id}/${scenario.id}: JSX-only edit did not preserve local state (saw ${finalLocal})`);
    } else {
      const hookValues = scenario.id === 'reorder-hooks'
        ? ` mode=${await page.getByTestId('mode').textContent()} extra=${await page.getByTestId('extra').textContent()}`
        : '';
      assert(finalLocal === '0', `${variant.id}/${scenario.id}: Hook-shape edit did not safely remount the component (local state ${finalLocal}${hookValues})`);
    }
    for (const hook of ['extra', 'mode']) {
      const expected = hook === 'extra'
        ? ['added', 'reordered', 'reverse-order'].includes(scenario.edited.hooks)
        : ['reordered', 'reverse-order'].includes(scenario.edited.hooks);
      assert((await page.getByTestId(hook).count() > 0) === expected, `${variant.id}/${scenario.id}: wrong ${hook} output after HMR`);
    }
    if (scenario.id === 'reorder-hooks') {
      await waitForUpdate(page, '[data-testid="mode"]', '0', `${variant.id}/${scenario.id} reducer value after order change`);
      await waitForUpdate(page, '[data-testid="extra"]', 'added', `${variant.id}/${scenario.id} state value after order change`);
    }
    assert(!errors.some((error) => /Rendered (more|fewer) hooks|change in the order of Hooks/i.test(error)),
      `${variant.id}/${scenario.id}: React reported a Hook-order failure`);

    const signalBefore = Number(await page.getByTestId('signal').textContent());
    await page.locator('#signal-increment').click();
    await waitForUpdate(page, '[data-testid="signal"]', String(signalBefore + 1), `${variant.id}/${scenario.id} signal update after HMR`);
    await page.locator('#toggle').click();
    await page.getByTestId('hidden').waitFor();
    const rendersWhileUnmounted = await page.evaluate(() => window.__hmrMetrics.renders);
    await page.locator('#signal-increment').click();
    await page.waitForTimeout(100);
    assert(await page.evaluate(() => window.__hmrMetrics.renders) === rendersWhileUnmounted, `${variant.id}/${scenario.id}: hidden component continued rendering on signal updates`);
    await page.locator('#toggle').click();
    await page.getByTestId('counter').waitFor();
    await page.locator('#signal-increment').click();
    await waitForUpdate(page, '[data-testid="signal"]', String(signalBefore + 3), `${variant.id}/${scenario.id} signal after remount`);
    const finalTransform = await fetch(`${server.url}src/App.tsx`).then((response) => response.text());
    const signatureLines = finalTransform.split('\n').filter((line) => /RefreshSig|RefreshReg|createSignature|_s\d?\(|try\s*\{|finish\(\)/.test(line));
    const result = { variant: variant.id, scenario: scenario.id, status: 'passed', boot, finalLocal, initialSignature, finalSignature: signatureLines, signalAfterUnmount: signalBefore + 3, errors };
    console.log(JSON.stringify(result, null, 2));
    await page.close();
    return result;
  } catch (error) {
    const result = { variant: variant.id, scenario: scenario.id, status: 'failed', error: error.message, errors };
    console.log(JSON.stringify(result, null, 2));
    await page.close();
    return result;
  }
}

async function runVariant(variant) {
  const root = variant.server === 'vite6' ? join(here, 'legacy', 'app') : join(here, 'apps', variant.id);
  appRoots.set(variant.id, root);
  await mkdir(join(root, 'src'), { recursive: true });
  await writeFile(join(root, 'index.html'), indexHtml, 'utf8');
  await writeFile(join(root, 'src', 'main.tsx'), mainSource, 'utf8');
  await writeFile(join(root, 'src', 'signal-store.ts'), storeSource(variant.id), 'utf8');
  const server = variant.server === 'vite8' ? await openServer(variant, root) : await openLegacyServer(variant, root);
  const cases = [
    { id: 'jsx-only', initial: { jsx: 'baseline JSX', hooks: 'base' }, edited: { jsx: 'JSX-only edited', hooks: 'base' } },
    { id: 'add-hook', initial: { jsx: 'baseline JSX', hooks: 'base' }, edited: { jsx: 'hook added', hooks: 'added' } },
    { id: 'remove-hook', initial: { jsx: 'hook added', hooks: 'added' }, edited: { jsx: 'hook removed', hooks: 'base' } },
    { id: 'reorder-hooks', initial: { jsx: 'hook order A', hooks: 'reordered' }, edited: { jsx: 'hook order B', hooks: 'reverse-order' } },
  ];
  const results = [];
  for (const scenario of cases) results.push(await runCase(variant, server, scenario));
  return results;
}

async function main() {
  console.log(`Versions: ${JSON.stringify(runtimeVersions)}`);
  try {
    browser = await chromium.launch({ headless: true });
    const results = [];
    for (const variant of variants) results.push(...await runVariant(variant));
    console.log(JSON.stringify({ browserErrors: playwrightErrors, results }, null, 2));
    assert(results.every((result) => result.status === 'passed') && playwrightErrors.length === 0,
      `HMR browser failures: ${results.filter((result) => result.status !== 'passed').map((result) => `${result.variant}: ${result.error ?? result.errors.join('; ')}`).join('\n')}`);
    console.log(`PASS: ${variants.length} Vite HMR browser variants; no browser errors.`);
  } finally {
    if (browser) await browser.close();
    await Promise.all(servers.map((server) => server.close()));
  }
}

await main();
