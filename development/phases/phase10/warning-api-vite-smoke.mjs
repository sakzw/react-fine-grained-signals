import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLogger, createServer } from 'vite';
import signals from '../../../packages/unplugin-react-fine-grained-signals/dist/vite.js';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '../../..');
const root = await mkdtemp(join(tmpdir(), 'rfgs-vite-warning-'));
const source = 'const count = { value: 1 };\nexport default () => <p>{count.value}</p>;\n';
const diagnostics = [];
const logger = createLogger('info');
const originalWarn = logger.warn.bind(logger);
logger.warn = (message, options) => {
  diagnostics.push({ message, options });
  originalWarn(message, options);
};

let server;
try {
  await mkdir(join(root, 'src'), { recursive: true });
  await writeFile(join(root, 'src', '123.jsx'), source, 'utf8');
  server = await createServer({
    configFile: false,
    root,
    appType: 'custom',
    customLogger: logger,
    plugins: [signals({ mode: 'auto' })],
    server: { host: '127.0.0.1', port: 0, strictPort: false },
    optimizeDeps: { noDiscovery: true, include: [] },
    resolve: {
      alias: [
        {
          find: /^react-fine-grained-signals\/runtime$/,
          replacement: join(repo, 'dist', 'runtime.js'),
        },
        {
          find: /^react-fine-grained-signals$/,
          replacement: join(repo, 'dist', 'index.js'),
        },
        { find: /^react\/jsx-dev-runtime$/, replacement: join(repo, 'node_modules', 'react', 'jsx-dev-runtime.js') },
        { find: /^react\/jsx-runtime$/, replacement: join(repo, 'node_modules', 'react', 'jsx-runtime.js') },
        { find: /^react$/, replacement: join(repo, 'node_modules', 'react', 'index.js') },
      ],
    },
  });
  const result = await server.transformRequest('/src/123.jsx');
  assert.ok(result, 'Vite transform should return the module instead of throwing');
  assert.equal(typeof result.code, 'string');

  const diagnostic = diagnostics.find(({ message }) =>
    JSON.stringify(message).includes('anonymous default export is left untransformed'));
  assert.ok(diagnostic, 'Vite should receive the non-fatal transform diagnostic');
  assert.equal(typeof diagnostic.message, 'string');
  assert.ok(diagnostic.message.includes('anonymous default export is left untransformed'));
  assert.ok(diagnostic.message.includes('> 2 |'));
  assert.match(diagnostic.message, /123\.jsx:2:15/);
  assert.equal(diagnostics.length, 1, 'the transform warning should be delivered once');

  console.log(JSON.stringify({
    bundler: 'Vite 8.3.1',
    transformCompleted: true,
    diagnosticMessage: diagnostic.message.split('\n')[0],
    displayedLocation: '123.jsx:2:15',
    warningCount: diagnostics.length,
  }, null, 2));
} finally {
  if (server) await server.close();
  await rm(root, { recursive: true, force: true });
}
