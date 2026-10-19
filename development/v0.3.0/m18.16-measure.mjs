import { build } from 'vite'
import react from '@vitejs/plugin-react'
import { chromium } from '@playwright/test'
import { gzipSync, brotliCompressSync, constants } from 'node:zlib'
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { resolve, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = resolve(fileURLToPath(new URL('../..', import.meta.url)))
const buildRoot = mkdtempSync(join(tmpdir(), 'rfsg-m18-16-'))
const dist = join(repo, 'dist')
const sourceText = readFileSync(join(repo, 'src/runtime/jsx.ts'), 'utf8')
const baseFile = readdirSync(dist).find((name) => /^base-.+\.js$/.test(name))
const protocolFile = readdirSync(dist).find((name) => /^plain-result-iterators-.+\.js$/.test(name))
if (!baseFile || !protocolFile) throw new Error('Missing built runtime chunks; run `pnpm build:runtime` first.')
const baseChunk = join(dist, baseFile)
const protocolChunk = join(dist, protocolFile)
const reactPath = (path) => join(repo, 'node_modules', 'react', path)


function replaceBetween(source, startMarker, endMarker, replacement) {
  const start = source.indexOf(startMarker)
  const end = source.indexOf(endMarker, start)
  if (start < 0 || end < 0) throw new Error(`PoC source anchor missing: ${startMarker}`)
  return `${source.slice(0, start)}${replacement}\n\n${source.slice(end)}`
}

function sharedImports(source, readableModule) {
  return source
    .replaceAll('"../core/index.js"', '"react-fine-grained-signals"')
    .replaceAll('"../react/hooks.js"', '"react-fine-grained-signals"')
    .replaceAll('import { detachedEffect, type FormBindableChoiceSignal } from "../core/base.js";', `import { r as detachedEffect } from ${JSON.stringify(baseChunk)};`)
    .replaceAll('"../core/readable-subscription.js"', JSON.stringify(readableModule))
    .replaceAll('import { notifyListener } from "../core/render-tracking.js";', `import { o as notifyListener } from ${JSON.stringify(protocolChunk)};`)
}

const formlessFindHostBindings = `function findHostBindings(props: HostProps, tagName: string): Binding[] {
  const bindings: Binding[] = [];
  for (const [name, value] of Object.entries(props)) {
    if ((name === "bindValue" || name === "bindChecked") && value !== undefined) {
      throw new TypeError("Form binding is disabled in this isolated PoC runtime.");
    }
    if ((name === "value" || name === "checked") && isSignal(value)) {
      throw new TypeError(
        "Use " + (name === "value" ? "bindValue" : "bindChecked") + " or " + name + ".value for signal props.",
      );
    }
    if (isReactiveHostProp(name, value)) {
      const kind = resolveBindingKind(tagName, name, props);
      bindings.push([name, value, kind, readInitialValue(value, kind)]);
    }
  }
  return bindings;
}`

const formlessTransformHostProps = `function transformHostProps(type: string, input: unknown): { props: HostProps; bindings: Binding[] } {
  const inputProps = (input ?? {}) as HostProps;
  const isHtmlHost = !NON_HTML_HOST_ELEMENTS.has(type);
  const bindings: Binding[] = [];
  const hasFormBinding = inputProps.bindValue !== undefined || inputProps.bindChecked !== undefined;
  if (hasFormBinding) throw new TypeError("Form binding is disabled in this isolated PoC runtime.");
  if (isHtmlHost) {
    for (const [name, value] of Object.entries(inputProps)) {
      if ((name === "value" || name === "checked") && isSignal(value)) {
        throw new TypeError("Signal value/checked props are unsupported in this isolated runtime.");
      }
      if (isReactiveHostProp(name, value)) {
        const kind = resolveBindingKind(type, name, inputProps);
        bindings.push([name, value, kind, readInitialValue(value, kind)]);
      }
    }
  }
  const normalizeChildren = "children" in inputProps && (isSignal(inputProps.children) || Array.isArray(inputProps.children));
  if (bindings.length === 0 && !normalizeChildren && !("bindValue" in inputProps) && !("bindChecked" in inputProps)) {
    return { props: inputProps, bindings };
  }
  const props: HostProps = { ...inputProps };
  delete props.bindValue;
  delete props.bindChecked;
  if (normalizeChildren) props.children = normalizeChild(inputProps.children);
  for (const [name, , , snapshot] of bindings) props[name] = snapshot;
  return { props, bindings };
}`

const childrenCreateJsxWrapper = `export function createJsxWrapper(factory: CreateElement): CreateElement {
  return (type, input, key) => {
    if (typeof type !== "string" && type !== Fragment) return factory(type, input, key);
    const props = input as HostProps | null;
    if (props == null || !("children" in props)) return factory(type, input, key);
    const children = props.children;
    if (!isSignal(children) && !Array.isArray(children)) return factory(type, input, key);
    return factory(type, { ...props, children: normalizeChild(children) }, key);
  };
}`

const childrenCreateSignalAwareElement = `export function createSignalAwareElement(
  type: React.ElementType,
  config?: Record<string, unknown> | null,
  ...children: unknown[]
): React.ReactElement {
  const normalizedChildren = children.map((child) => normalizeChild(child)) as React.ReactNode[];
  return createElement(type, config, ...normalizedChildren);
}`

function makeFormlessSource(readableModule) {
  let source = sharedImports(sourceText, readableModule)
  source = source.replace(
    'type BindingKind = "style" | "style-properties" | "select-value" | "text-value" | "radio-value" | "checkbox-group" | "checked" | "prop";',
    'type BindingKind = "style" | "style-properties" | "prop";',
  )
  source = replaceBetween(
    source,
    'function resolveBindingKind(',
    'function isTwoWayBindingKind(',
    `function resolveBindingKind(_tagName: string, name: string): BindingKind {
  return name === "style" ? "style" : "prop";
}`,
  )
  source = replaceBetween(
    source,
    'function findHostBindings(',
    '/**\n * Transforms a native host element',
    formlessFindHostBindings,
  )
  source = replaceBetween(
    source,
    'function transformHostProps(',
    '/**\n * `Fragment`',
    formlessTransformHostProps,
  )
  const subscribeStart = source.indexOf('function subscribeBinding(')
  const formStart = source.indexOf('    case "select-value":', subscribeStart)
  const propCase = source.indexOf('    case "prop":', formStart)
  if (subscribeStart < 0 || formStart < 0 || propCase < 0) throw new Error('PoC form dispatch anchors missing')
  source = `${source.slice(0, formStart)}${source.slice(propCase)}`
  return source
}

function makeChildrenOnlySource(readableModule) {
  let source = sharedImports(sourceText, readableModule)
  source = replaceBetween(source, 'export function createJsxWrapper(', '/**\n * The classic-runtime `createElement`', childrenCreateJsxWrapper)
  source = replaceBetween(source, 'export function createSignalAwareElement(', 'type Signalable<T>', childrenCreateSignalAwareElement)
  return source
}

async function runBuild({ name, jsxSource, jsxImportSource, runtimeAlias, entrySource }) {
  const project = join(buildRoot, name)
  const outDir = join(project, 'dist')
  mkdirSync(project, { recursive: true })
  const entry = join(project, 'entry.tsx')
  writeFileSync(entry, `${entrySource}\nglobalThis.__rfsgConsumer = App;`)
  writeFileSync(join(project, 'index.html'), '<!doctype html><div id="root"></div><script type="module" src="./dist/app.js"></script>')
  const aliases = [
    { find: /^react\/jsx-runtime$/, replacement: reactPath('jsx-runtime.js') },
    { find: /^react\/jsx-dev-runtime$/, replacement: reactPath('jsx-dev-runtime.js') },
    { find: /^react$/, replacement: reactPath('index.js') },
    { find: /^react-dom\/client$/, replacement: join(repo, 'node_modules/react-dom/client.js') },
    { find: /^react-fine-grained-signals\/jsx-runtime$/, replacement: runtimeAlias },
    { find: /^react-fine-grained-signals$/, replacement: join(dist, 'index.js') },
    { find: /^@m18\/jsx-runtime$/, replacement: runtimeAlias },
    { find: /^@m18\/jsx-source$/, replacement: jsxSource },
  ]
  await build({
    configFile: false,
    root: project,
    plugins: [react({ jsxImportSource })],
    resolve: { alias: aliases, dedupe: ['react', 'react-dom'] },
    build: {
      outDir,
      emptyOutDir: true,
      minify: 'esbuild',
      sourcemap: false,
      cssCodeSplit: false,
      rollupOptions: {
        input: entry,
        output: { entryFileNames: 'app.js', assetFileNames: 'asset-[name][extname]' },
      },
    },
  })
  writeFileSync(join(outDir, 'index.html'), '<!doctype html><div id="root"></div><script type="module" src="./app.js"></script>')
  const jsFiles = readdirSync(outDir).filter((fileName) => fileName.endsWith('.js'))
    .map((fileName) => ({ name: fileName, bytes: readFileSync(join(outDir, fileName)) }))
  const code = Buffer.concat(jsFiles.map((file) => file.bytes))
  return {
    name,
    outDir,
    raw: code.byteLength,
    gzip: gzipSync(code, { level: 9 }).byteLength,
    brotli: brotliCompressSync(code, { params: { [constants.BROTLI_PARAM_QUALITY]: 11 } }).byteLength,
    files: jsFiles.map(({ name: fileName }) => fileName),
    markers: {
      selectBinding: code.includes(Buffer.from('Invalid select bindValue.')),
      textBinding: code.includes(Buffer.from('bindValue: text-like, number, or range input/textarea/select only.')),
      checkboxGroup: code.includes(Buffer.from('Checkbox group bindValue requires an array of strings.')),
      signalChild: code.includes(Buffer.from('useSyncExternalStore')),
    },
  }
}

const childConsumer = `
import { createRoot } from "react-dom/client";
import { signal } from "react-fine-grained-signals";
const count = signal(0);
function App() {
  return <main><button onClick={() => count.value++}>increment</button><output data-testid="value">{count}</output></main>;
}
createRoot(document.getElementById("root")!).render(<App />);
`
const attributeConsumer = `
import { createRoot } from "react-dom/client";
import { signal } from "react-fine-grained-signals";
const count = signal(0);
const title = signal("Counter 0");
function App() {
  return <main><button title={title} onClick={() => { count.value++; title.value = "Counter " + count.peek(); }}>increment</button><output data-testid="value">{count}</output></main>;
}
createRoot(document.getElementById("root")!).render(<App />);
`
const hooksConsumer = `
import { createRoot } from "react-dom/client";
import { signal, useSignalValue } from "react-fine-grained-signals";
const count = signal(0);
function App() {
  const value = useSignalValue(count);
  return <main><button onClick={() => count.value++}>increment</button><output data-testid="value">{value}</output></main>;
}
createRoot(document.getElementById("root")!).render(<App />);
`
const reactStaticConsumer = `
import { createRoot } from "react-dom/client";
function App() {
  return <main><button>increment</button><output data-testid="value">0</output></main>;
}
createRoot(document.getElementById("root")!).render(<App />);
`
const coreOnlyConsumer = `
import { signal } from "react-fine-grained-signals";
const count = signal(0);
count.value++;
globalThis.__rfsgCoreOnlyValue = count.value;
`

try {
  const readableModule = join(buildRoot, 'readable-subscription.mjs')
  writeFileSync(readableModule, `import { u as getReadableInterop, o as notifyListener } from ${JSON.stringify(protocolChunk)};\nexport function subscribeReadableV1(readable, listener) { const protocol = getReadableInterop(readable); if (protocol === undefined) return undefined; const subscription = protocol.subscribe(() => notifyListener(listener)); return () => subscription.unsubscribe(); }\n`)
  const formlessSource = join(buildRoot, 'jsx-formless.ts')
  const childrenSource = join(buildRoot, 'jsx-children.ts')
  writeFileSync(formlessSource, makeFormlessSource(readableModule))
  writeFileSync(childrenSource, makeChildrenOnlySource(readableModule))
  const formlessRuntime = join(buildRoot, 'jsx-formless-runtime.ts')
  const childrenRuntime = join(buildRoot, 'jsx-children-runtime.ts')
  writeFileSync(formlessRuntime, `import { Fragment, jsx as reactJsx, jsxs as reactJsxs } from "react/jsx-runtime";\nimport { createJsxWrapper } from "@m18/jsx-source";\nexport { Fragment };\nexport const jsx = createJsxWrapper(reactJsx);\nexport const jsxs = createJsxWrapper(reactJsxs);\n`)
  writeFileSync(childrenRuntime, `import { Fragment, jsx as reactJsx, jsxs as reactJsxs } from "react/jsx-runtime";\nimport { createJsxWrapper } from "@m18/jsx-source";\nexport { Fragment };\nexport const jsx = createJsxWrapper(reactJsx);\nexport const jsxs = createJsxWrapper(reactJsxs);\n`)

  const outputs = [
    await runBuild({ name: 'react-jsx-static', jsxSource: '', jsxImportSource: 'react', runtimeAlias: '', entrySource: reactStaticConsumer }),
    await runBuild({ name: 'core-only', jsxSource: '', jsxImportSource: 'react', runtimeAlias: '', entrySource: coreOnlyConsumer }),
    await runBuild({ name: 'full-child', jsxSource: '', jsxImportSource: 'react-fine-grained-signals', runtimeAlias: join(dist, 'jsx-runtime.js'), entrySource: childConsumer }),
    await runBuild({ name: 'formless-child', jsxSource: formlessSource, jsxImportSource: '@m18', runtimeAlias: formlessRuntime, entrySource: childConsumer }),
    await runBuild({ name: 'children-only-child', jsxSource: childrenSource, jsxImportSource: '@m18', runtimeAlias: childrenRuntime, entrySource: childConsumer }),
    await runBuild({ name: 'react-jsx-hook-child', jsxSource: '', jsxImportSource: 'react', runtimeAlias: '', entrySource: hooksConsumer }),
    await runBuild({ name: 'full-attribute', jsxSource: '', jsxImportSource: 'react-fine-grained-signals', runtimeAlias: join(dist, 'jsx-runtime.js'), entrySource: attributeConsumer }),
    await runBuild({ name: 'formless-attribute', jsxSource: formlessSource, jsxImportSource: '@m18', runtimeAlias: formlessRuntime, entrySource: attributeConsumer }),
  ]

  const server = createServer((request, response) => {
    const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname).replace(/^\/+/, '')
    const path = resolve(buildRoot, pathname)
    if (!path.startsWith(buildRoot)) { response.writeHead(403).end(); return }
    try {
      const content = readFileSync(path)
      response.writeHead(200, { 'content-type': path.endsWith('.html') ? 'text/html' : 'text/javascript' }).end(content)
    } catch { response.writeHead(404).end('not found') }
  })
  await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen))
  const address = server.address()
  const browser = await chromium.launch()
  try {
    for (const output of outputs.filter(({ name }) => !['react-jsx-static', 'core-only', 'full-attribute', 'formless-attribute'].includes(name))) {
      const page = await browser.newPage()
      const errors = []
      page.on('pageerror', (error) => errors.push(error.message))
      page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()) })
      const route = relative(buildRoot, output.outDir).replaceAll('\\', '/')
      await page.goto(`http://127.0.0.1:${address.port}/${route}/index.html`)
      await page.getByRole('button', { name: 'increment' }).click()
      const value = await page.getByTestId('value').textContent()
      if (value !== '1') throw new Error(`${output.name} child interaction rendered ${value}, expected 1`)
      if (errors.length > 0) throw new Error(`${output.name} browser errors: ${errors.join('; ')}`)
      if (output.name === 'formless-child' && (output.markers.selectBinding || output.markers.checkboxGroup)) {
        throw new Error('Formless bundle retained a form-specific marker.')
      }
      if (output.name === 'children-only-child' && output.markers.selectBinding) {
        throw new Error('Children-only bundle retained a form-specific marker.')
      }
      await page.close()
    }
    for (const output of outputs.filter(({ name }) => name.endsWith('attribute'))) {
      const page = await browser.newPage()
      const errors = []
      page.on('pageerror', (error) => errors.push(error.message))
      page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()) })
      const route = relative(buildRoot, output.outDir).replaceAll('\\', '/')
      await page.goto(`http://127.0.0.1:${address.port}/${route}/index.html`)
      await page.getByRole('button', { name: 'increment' }).click()
      const value = await page.getByTestId('value').textContent()
      const title = await page.getByRole('button').getAttribute('title')
      if (value !== '1' || title !== 'Counter 1') throw new Error(`${output.name} attribute update failed: value=${value}, title=${title}`)
      if (errors.length > 0) throw new Error(`${output.name} browser errors: ${errors.join('; ')}`)
      await page.close()
    }
  } finally {
    await browser.close()
    await new Promise((resolveClose, rejectClose) => server.close((error) => error ? rejectClose(error) : resolveClose()))
  }

  for (const output of outputs) {
    console.log(JSON.stringify(output))
  }
  writeFileSync(join(repo, 'development/v0.3.0/m18.16-consumer-bundles.json'), JSON.stringify(outputs.map(({ outDir: _outDir, ...result }) => result), null, 2) + '\n')
} finally {
  rmSync(buildRoot, { recursive: true, force: true })
}
