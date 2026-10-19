import { build as viteBuild, createServer as createViteServer } from 'vite'
import react from '@vitejs/plugin-react'
import { chromium } from '@playwright/test'
import { gzipSync, brotliCompressSync, constants } from 'node:zlib'
import { createServer as createHttpServer } from 'node:http'
import { createRequire } from 'node:module'
import { cpSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, extname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = resolve(fileURLToPath(new URL('../..', import.meta.url)))
const temporaryRoot = join(repo, `.m18.18-qualification-${process.pid}`)
const packageJson = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8'))
const schedulerPackage = readdirSync(join(repo, 'node_modules/.pnpm')).find((name) => name.startsWith('scheduler@'))
if (!schedulerPackage) throw new Error('Expected React 19 scheduler dependency in the pnpm virtual store')
const schedulerPath = join(repo, 'node_modules/.pnpm', schedulerPackage, 'node_modules/scheduler')
const requireFromPlugin = createRequire(join(repo, 'packages/unplugin-react-fine-grained-signals/package.json'))
const errors = []
let browser
let viteServer
let httpServer

function write(path, contents) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, contents)
}

function copyPackage(projectRoot) {
  const target = join(projectRoot, 'node_modules/react-fine-grained-signals')
  mkdirSync(target, { recursive: true })
  cpSync(join(repo, 'dist'), join(target, 'dist'), { recursive: true })
  cpSync(join(repo, 'LICENSE-ALIEN-SIGNALS.txt'), join(target, 'LICENSE-ALIEN-SIGNALS.txt'))
  writeFileSync(join(target, 'package.json'), JSON.stringify(packageJson, null, 2))
}

function createSourceTree(projectRoot) {
  copyPackage(projectRoot)
  write(join(projectRoot, 'package.json'), JSON.stringify({ private: true, type: 'module' }))
  write(join(projectRoot, 'index.html'), '<div id="root"></div><script type="module" src="/src/main.tsx"></script>')
  write(join(projectRoot, 'src/store.ts'), `import { signal } from 'react-fine-grained-signals';\nexport const liteCount = signal(0);\nexport const fullCount = signal(0);\n`)
  write(join(projectRoot, 'src/LiteCounter.tsx'), `/** @jsxImportSource react-fine-grained-signals/lite */
import { useState } from 'react';
import { liteCount } from './store';
export function LiteCounter() {
  if (window.hmrMetrics) window.hmrMetrics.liteRenders++;
  const [local, setLocal] = useState(0);
  return <section><output data-testid="lite-count">{liteCount}</output><output data-testid="lite-local">{local}</output><button id="lite-inc" onClick={() => liteCount.value++}>lite +1</button><button id="lite-local" onClick={() => setLocal((n) => n + 1)}>lite local</button><label data-testid="lite-label">LITE_REV_1</label></section>;
}
`)
  write(join(projectRoot, 'src/FullCounter.tsx'), `/** @jsxImportSource react-fine-grained-signals */
import { useState } from 'react';
import { fullCount } from './store';
export function FullCounter() {
  if (window.hmrMetrics) window.hmrMetrics.fullRenders++;
  const [local, setLocal] = useState(0);
  return <section><output data-testid="full-count">{fullCount}</output><output data-testid="full-local">{local}</output><button id="full-inc" onClick={() => fullCount.value++}>full +1</button><button id="full-local" onClick={() => setLocal((n) => n + 1)}>full local</button><label data-testid="full-label">FULL_REV_1</label></section>;
}
`)
  write(join(projectRoot, 'src/App.tsx'), `/** @jsxImportSource react-fine-grained-signals/lite */
import { useState } from 'react';
import { liteCount, fullCount } from './store';
import { LiteCounter } from './LiteCounter';
import { FullCounter } from './FullCounter';
export default function App() {
  window.hmrMetrics.appRenders++;
  const [shown, setShown] = useState(true);
  return <main><button id="lite-outside" onClick={() => liteCount.value++}>lite outside</button><button id="full-outside" onClick={() => fullCount.value++}>full outside</button><button id="toggle" onClick={() => setShown((value) => !value)}>toggle</button>{shown && <><LiteCounter /><FullCounter /></>}</main>;
}
`)
  write(join(projectRoot, 'src/main.tsx'), `import React from 'react'; import { createRoot } from 'react-dom/client'; import App from './App'; window.hmrMetrics = { appRenders: 0, liteRenders: 0, fullRenders: 0 }; createRoot(document.getElementById('root')).render(<React.StrictMode><App /></React.StrictMode>);`)
}

function reactPluginConfig() {
  return react({ jsxImportSource: 'react-fine-grained-signals/lite' })
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

async function checkViteFastRefresh(projectRoot) {
  viteServer = await createViteServer({
    configFile: false,
    root: projectRoot,
    appType: 'spa',
    logLevel: 'error',
    plugins: [reactPluginConfig()],
    resolve: { dedupe: ['react', 'react-dom'] },
    server: { host: '127.0.0.1', port: 0, strictPort: false, hmr: true },
  })
  await viteServer.listen()
  browser = await chromium.launch()
  const page = await browser.newPage()
  page.on('pageerror', (error) => errors.push(error.message))
  page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()) })
  await page.goto(viteServer.resolvedUrls.local[0])
  await page.locator('#lite-local').click()
  await page.locator('#full-local').click()
  await page.locator('#lite-outside').click()
  await page.locator('#full-outside').click()
  assert(await page.getByTestId('lite-count').textContent() === '1', 'Lite Signal child did not update before HMR')
  assert(await page.getByTestId('full-count').textContent() === '1', 'Full Signal child did not update before HMR')
  assert(await page.getByTestId('lite-local').textContent() === '1', 'Lite component state setup failed')
  assert(await page.getByTestId('full-local').textContent() === '1', 'Full component state setup failed')

  const liteRendersAfterRefresh = async (revision) => {
    const count = await page.evaluate(() => window.hmrMetrics.liteRenders)
    write(join(projectRoot, 'src/LiteCounter.tsx'), readFileSync(join(projectRoot, 'src/LiteCounter.tsx'), 'utf8').replace(/LITE_REV_\d+/, `LITE_REV_${revision}`))
    await page.getByTestId('lite-label').getByText(`LITE_REV_${revision}`).waitFor()
    assert(await page.getByTestId('lite-local').textContent() === '1', 'Lite Fast Refresh did not preserve local component state')
    assert(await page.getByTestId('lite-count').textContent() === '1', 'Lite Fast Refresh lost the Signal child value')
    return { before: count, after: await page.evaluate(() => window.hmrMetrics.liteRenders) }
  }
  const firstLiteEdit = await liteRendersAfterRefresh(2)
  const fullRendersBeforeLiteSignal = await page.evaluate(() => window.hmrMetrics.fullRenders)
  const liteRendersBeforeSignal = await page.evaluate(() => window.hmrMetrics.liteRenders)
  await page.locator('#lite-inc').click()
  assert(await page.getByTestId('lite-count').textContent() === '2', 'Lite Signal stopped updating after Fast Refresh')
  assert(await page.evaluate(() => window.hmrMetrics.liteRenders) === liteRendersBeforeSignal, 'Lite Signal update rerendered its component after Fast Refresh')
  assert(await page.evaluate(() => window.hmrMetrics.fullRenders) === fullRendersBeforeLiteSignal, 'Lite Signal update rerendered the Full sibling')

  const fullCountBeforeEdit = await page.evaluate(() => window.hmrMetrics.fullRenders)
  write(join(projectRoot, 'src/FullCounter.tsx'), readFileSync(join(projectRoot, 'src/FullCounter.tsx'), 'utf8').replace('FULL_REV_1', 'FULL_REV_2'))
  await page.getByTestId('full-label').getByText('FULL_REV_2').waitFor()
  assert(await page.getByTestId('full-local').textContent() === '1', 'Full Fast Refresh did not preserve component state')
  const fullRendersAfterEdit = await page.evaluate(() => window.hmrMetrics.fullRenders)
  const liteRendersBeforeFullSignal = await page.evaluate(() => window.hmrMetrics.liteRenders)
  await page.locator('#full-inc').click()
  assert(await page.getByTestId('full-count').textContent() === '2', 'Full Signal stopped updating after sibling refresh')
  assert(await page.evaluate(() => window.hmrMetrics.fullRenders) === fullRendersAfterEdit, 'Full Signal update rerendered its component')
  assert(await page.evaluate(() => window.hmrMetrics.liteRenders) === liteRendersBeforeFullSignal, 'Full Signal update rerendered the Lite sibling')
  await page.locator('#toggle').click()
  const hiddenLiteRenders = await page.evaluate(() => window.hmrMetrics.liteRenders)
  const hiddenFullRenders = await page.evaluate(() => window.hmrMetrics.fullRenders)
  await page.locator('#lite-outside').click()
  await page.locator('#full-outside').click()
  assert(await page.evaluate(() => window.hmrMetrics.liteRenders) === hiddenLiteRenders, 'Unmounted Lite component reacted to Signal writes')
  assert(await page.evaluate(() => window.hmrMetrics.fullRenders) === hiddenFullRenders, 'Unmounted Full component reacted to Signal writes')
  await page.locator('#toggle').click()
  await page.getByTestId('lite-count').waitFor()
  assert(await page.getByTestId('lite-count').textContent() === '3', 'Lite Signal value was not current after remount')
  assert(await page.getByTestId('full-count').textContent() === '3', 'Full Signal value was not current after remount')
  const liteRendersAfterRemount = await page.evaluate(() => window.hmrMetrics.liteRenders)
  await page.locator('#lite-inc').click()
  assert(await page.getByTestId('lite-count').textContent() === '4', 'Lite Signal did not resume after remount')
  assert(await page.evaluate(() => window.hmrMetrics.liteRenders) === liteRendersAfterRemount, 'Remounted Lite Signal update rerendered the host component')
  assert(errors.length === 0, `Vite Fast Refresh console errors: ${errors.join('; ')}`)
  return { firstLiteEdit, fullEditRenders: { before: fullCountBeforeEdit, after: fullRendersAfterEdit }, afterUnmountAndRemount: true, browserErrors: errors }
}

async function buildViteScenario(projectRoot, name, entrySource) {
  const scenarioRoot = join(projectRoot, 'bundles', name)
  createSourceTree(scenarioRoot)
  write(join(scenarioRoot, 'index.html'), '<div id="root"></div><script type="module" src="/src/main.tsx"></script>')
  write(join(scenarioRoot, 'src/main.tsx'), entrySource)
  const outDir = join(scenarioRoot, 'dist')
  await viteBuild({
    configFile: false,
    root: scenarioRoot,
    plugins: [reactPluginConfig()],
    resolve: { dedupe: ['react', 'react-dom'] },
    base: './',
    build: { outDir, emptyOutDir: true, manifest: true, minify: 'esbuild', sourcemap: false },
  })
  const manifestPath = join(outDir, '.vite/manifest.json')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  const entry = Object.values(manifest).find((value) => value.isEntry)
  assert(entry, `${name}: no Vite entry found in manifest`)
  const closure = new Set()
  const visit = (chunk, seen) => {
    if (!chunk || seen.has(chunk.file)) return
    seen.add(chunk.file)
    for (const imported of chunk.imports ?? []) visit(manifest[imported], seen)
  }
  visit(entry, closure)
  const jsFiles = [...closure].filter((file) => file.endsWith('.js'))
  const summarize = (files) => {
    const bytes = Buffer.concat(files.map((file) => readFileSync(join(outDir, file))))
    return {
      files,
      raw: bytes.byteLength,
      gzip: gzipSync(bytes, { level: 9 }).byteLength,
      brotli: brotliCompressSync(bytes, { params: { [constants.BROTLI_PARAM_QUALITY]: 11 } }).byteLength,
    }
  }
  const initial = summarize(jsFiles)
  const metric = {
    name,
    initial,
    fullMarker: Buffer.concat(jsFiles.map((file) => readFileSync(join(outDir, file)))).includes(Buffer.from('bindValue: text-like, number, or range input/textarea/select only.')),
  }
  const dynamicClosure = new Set()
  for (const id of entry.dynamicImports ?? []) visit(manifest[id], dynamicClosure)
  const dynamicFiles = [...dynamicClosure].filter((file) => file.endsWith('.js') && !closure.has(file))
  if (dynamicFiles.length) metric.dynamic = summarize(dynamicFiles)
  return { scenarioRoot, outDir, metric }
}

async function checkBundleScenarios(projectRoot) {
  const sources = {
    lite: `/** @jsxImportSource react-fine-grained-signals/lite */\nimport React from 'react'; import { createRoot } from 'react-dom/client'; import { LiteCounter } from './LiteCounter'; createRoot(document.getElementById('root')).render(<React.StrictMode><LiteCounter /></React.StrictMode>);`,
    full: `/** @jsxImportSource react-fine-grained-signals */\nimport React from 'react'; import { createRoot } from 'react-dom/client'; import { FullCounter } from './FullCounter'; createRoot(document.getElementById('root')).render(<React.StrictMode><FullCounter /></React.StrictMode>);`,
    both: `/** @jsxImportSource react-fine-grained-signals/lite */\nimport React from 'react'; import { createRoot } from 'react-dom/client'; import { LiteCounter } from './LiteCounter'; import { FullCounter } from './FullCounter'; createRoot(document.getElementById('root')).render(<React.StrictMode><LiteCounter /><FullCounter /></React.StrictMode>);`,
    lazyFull: `/** @jsxImportSource react-fine-grained-signals/lite */\nimport React, { useState } from 'react'; import { createRoot } from 'react-dom/client'; import { LiteCounter } from './LiteCounter'; function App(){ const [Full, setFull] = useState(null); return <><LiteCounter /><button id="load-full" onClick={() => import('./FullCounter').then((mod) => setFull(() => mod.FullCounter))}>load Full</button>{Full && <Full />}</>; } createRoot(document.getElementById('root')).render(<React.StrictMode><App /></React.StrictMode>);`,
  }
  const outputs = []
  for (const [name, source] of Object.entries(sources)) outputs.push(await buildViteScenario(projectRoot, name, source))

  httpServer = createHttpServer((request, response) => {
    const url = new URL(request.url, 'http://localhost')
    const relativePath = decodeURIComponent(url.pathname).replace(/^\/+/, '')
    const fullPath = resolve(projectRoot, relativePath)
    if (!fullPath.startsWith(projectRoot)) { response.writeHead(403).end(); return }
    try {
      const content = readFileSync(fullPath)
      const ext = extname(fullPath)
      const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' }
      response.writeHead(200, { 'content-type': types[ext] ?? 'application/octet-stream' }).end(content)
    } catch { response.writeHead(404).end('not found') }
  })
  await new Promise((resolveListen) => httpServer.listen(0, '127.0.0.1', resolveListen))
  const port = httpServer.address().port
  const bundleBrowser = await chromium.launch()
  try {
    for (const output of outputs) {
      const page = await bundleBrowser.newPage()
      const pageErrors = []
      page.on('pageerror', (error) => pageErrors.push(error.message))
      page.on('console', (message) => { if (message.type() === 'error') pageErrors.push(message.text()) })
      const path = relative(projectRoot, output.outDir).replaceAll('\\', '/')
      await page.goto(`http://127.0.0.1:${port}/${path}/index.html`)
      if (output.metric.name === 'lazyFull') {
        assert(await page.getByTestId('lite-count').textContent() === '0', 'Lazy Consumer Lite initial state mismatch')
        await page.locator('#load-full').click()
        await page.getByTestId('full-count').waitFor()
      } else if (output.metric.name === 'lite' || output.metric.name === 'both') {
        await page.locator('#lite-inc').click()
        assert(await page.getByTestId('lite-count').textContent() === '1', `${output.metric.name}: Lite Signal child did not update`)
      }
      if (output.metric.name === 'full' || output.metric.name === 'both' || output.metric.name === 'lazyFull') {
        await page.locator('#full-inc').click()
        assert(await page.getByTestId('full-count').textContent() === '1', `${output.metric.name}: Full Signal child did not update`)
      }
      assert(pageErrors.length === 0, `${output.metric.name} browser errors: ${pageErrors.join('; ')}`)
      await page.close()
    }
  } finally {
    await bundleBrowser.close()
    await new Promise((done) => httpServer.close(done))
    httpServer = undefined
  }
  return outputs.map(({ metric }) => metric)
}

function runBundler(name, bundler, projectRoot, outputPath) {
  const entry = join(projectRoot, 'bundler-main.tsx')
  write(entry, `import React from 'react'; import { createRoot } from 'react-dom/client'; import { signal } from 'react-fine-grained-signals'; const count = signal(0); function App(){ return <main><button onClick={() => count.value++}>increment</button><output>{count}</output></main> } createRoot(document.getElementById('root')).render(<React.StrictMode><App /></React.StrictMode>);`)
  const loaderPath = join(projectRoot, 'jsx-loader.cjs')
  const esbuildPath = requireFromPlugin.resolve('esbuild')
  write(loaderPath, `const esbuild = require(${JSON.stringify(esbuildPath)}); module.exports = function(source) { return esbuild.transformSync(source, { loader: 'tsx', target: 'es2022', format: 'esm', jsx: 'automatic', jsxImportSource: 'react-fine-grained-signals/lite', sourcefile: this.resourcePath }).code; };`)
  const config = {
    mode: 'production',
    context: projectRoot,
    entry,
    target: 'web',
    devtool: false,
    output: { path: outputPath, filename: 'app.js', clean: true },
    resolve: { extensions: ['.tsx', '.ts', '.js'], modules: [join(projectRoot, 'node_modules'), join(repo, 'node_modules')], alias: { scheduler: schedulerPath } },
    module: { rules: [{ test: /\.tsx?$/, use: [loaderPath] }] },
  }
  const compiler = bundler(config)
  return new Promise((resolveResult, reject) => compiler.run((error, stats) => {
    const finish = (failure, result) => compiler.close((closeError) => {
      if (failure) reject(failure)
      else if (closeError) reject(closeError)
      else resolveResult(result)
    })
    if (error) return finish(error)
    if (!stats || stats.hasErrors()) return finish(new Error(`${name} errors: ${stats?.toString({ errors: true })}`))
    const bytes = readFileSync(join(outputPath, 'app.js'))
    finish(undefined, { name, raw: bytes.byteLength, gzip: gzipSync(bytes, { level: 9 }).byteLength, brotli: brotliCompressSync(bytes, { params: { [constants.BROTLI_PARAM_QUALITY]: 11 } }).byteLength })
  }))
}

async function checkWebpackRspack(projectRoot) {
  const webpack = requireFromPlugin('webpack')
  const rspack = requireFromPlugin('@rspack/core').rspack
  const results = []
  for (const [name, bundler] of [['webpack', webpack], ['rspack', rspack]]) {
    const outputPath = join(projectRoot, 'bundler-output', name)
    const result = await runBundler(name, bundler, projectRoot, outputPath)
    results.push(result)
    write(join(outputPath, 'index.html'), '<div id="root"></div><script src="./app.js"></script>')
  }
  const serverRoot = join(projectRoot, 'bundler-output')
  const server = createHttpServer((request, response) => {
    const pathname = resolve(serverRoot, decodeURIComponent(new URL(request.url, 'http://localhost').pathname.replace(/^\/+/, '')))
    if (!pathname.startsWith(serverRoot)) { response.writeHead(403).end(); return }
    try { const content = readFileSync(pathname); response.writeHead(200, { 'content-type': pathname.endsWith('.html') ? 'text/html' : 'text/javascript' }).end(content) } catch { response.writeHead(404).end() }
  })
  await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen))
  const bundlerBrowser = await chromium.launch()
  try {
    for (const name of ['webpack', 'rspack']) {
      const page = await bundlerBrowser.newPage()
      await page.goto(`http://127.0.0.1:${server.address().port}/${name}/index.html`)
      await page.getByRole('button', { name: 'increment' }).click()
      assert(await page.locator('output').textContent() === '1', `${name}: packed-package Signal child failed to update`)
      await page.close()
    }
  } finally { await bundlerBrowser.close(); await new Promise((done) => server.close(done)) }
  return results
}

async function checkRuntimeConstructionCost(projectRoot) {
  const benchRoot = join(projectRoot, 'jsx-cost')
  copyPackage(benchRoot)
  write(join(benchRoot, 'package.json'), JSON.stringify({ private: true, type: 'module' }))
  write(join(benchRoot, 'index.html'), '<div id="root"></div><script type="module" src="/bench.ts"></script>')
  write(join(benchRoot, 'bench.ts'), `import { jsx as reactJsx } from 'react/jsx-runtime'; import { jsx as fullJsx } from 'react-fine-grained-signals/jsx-runtime'; import { jsx as liteJsx } from 'react-fine-grained-signals/lite/jsx-runtime'; import { signal } from 'react-fine-grained-signals'; const source = signal('child'); const cases = { reactPlain: () => reactJsx('div', { className: 'row', children: 'text' }), fullPlain: () => fullJsx('div', { className: 'row', children: 'text' }), litePlain: () => liteJsx('div', { className: 'row', children: 'text' }), fullSignalChild: () => fullJsx('div', { className: 'row', children: source }), liteSignalChild: () => liteJsx('div', { className: 'row', children: source }) }; window.runJsxCost = () => { const names = Object.keys(cases); const runs = Object.fromEntries(names.map((name) => [name, []])); for (let round = 0; round < 12; round++) { const order = [...names].sort(() => Math.random() - .5); for (const name of order) { const start = performance.now(); for (let i = 0; i < 12000; i++) cases[name](); runs[name].push(performance.now() - start); } } return Object.fromEntries(names.map((name) => { const samples = runs[name].slice(2).sort((a,b) => a-b); return [name, { medianMs: samples[Math.floor(samples.length/2)], minMs: samples[0], maxMs: samples.at(-1), samplesMs: samples }]; })); };`)
  const benchDist = join(benchRoot, 'bench-dist')
  await viteBuild({ configFile: false, root: benchRoot, plugins: [reactPluginConfig()], resolve: { dedupe: ['react', 'react-dom'] }, build: { outDir: benchDist, emptyOutDir: true, base: './', rollupOptions: { output: { entryFileNames: 'bench.js' } } } })
  httpServer = createHttpServer((request, response) => {
    const path = resolve(benchDist, decodeURIComponent(new URL(request.url, 'http://localhost').pathname.replace(/^\/+/, '')))
    if (!path.startsWith(benchDist)) { response.writeHead(403).end(); return }
    try { response.writeHead(200, { 'content-type': extname(path) === '.html' ? 'text/html' : 'text/javascript' }).end(readFileSync(path)) } catch { response.writeHead(404).end() }
  })
  await new Promise((resolveListen) => httpServer.listen(0, '127.0.0.1', resolveListen))
  const benchmarkBrowser = await chromium.launch()
  try {
    const page = await benchmarkBrowser.newPage()
    await page.goto(`http://127.0.0.1:${httpServer.address().port}/index.html`)
    await page.waitForFunction(() => typeof window.runJsxCost === 'function')
    return await page.evaluate(() => window.runJsxCost())
  } finally { await benchmarkBrowser.close(); await new Promise((done) => httpServer.close(done)); httpServer = undefined }
}

try {
  mkdirSync(temporaryRoot, { recursive: true })
  const devRoot = join(temporaryRoot, 'fast-refresh')
  createSourceTree(devRoot)
  const fastRefresh = await checkViteFastRefresh(devRoot)
  await browser?.close()
  browser = undefined
  await viteServer?.close()
  viteServer = undefined

  const bundleMetrics = await checkBundleScenarios(temporaryRoot)
  const bundlerMetrics = await checkWebpackRspack(temporaryRoot)
  const constructionCost = await checkRuntimeConstructionCost(join(temporaryRoot, 'bundles', 'lite'))
  const results = { node: process.version, fastRefresh, bundleMetrics, bundlerMetrics, constructionCost }
  writeFileSync(join(repo, 'development/v0.3.0/m18.18-qualification-results.json'), `${JSON.stringify(results, null, 2)}\n`)
  console.log(JSON.stringify(results, null, 2))
} finally {
  await browser?.close()
  await viteServer?.close()
  if (httpServer?.listening) await new Promise((done) => httpServer.close(done))
  rmSync(temporaryRoot, { recursive: true, force: true })
}
