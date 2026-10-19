import { build } from 'vite'
import react from '@vitejs/plugin-react'
import { gzipSync, brotliCompressSync, constants } from 'node:zlib'
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = resolve(fileURLToPath(new URL('../..', import.meta.url)))
const root = mkdtempSync(join(tmpdir(), 'rfsg-m18-15-'))
const outResults = []
const scenarios = [
  {name:'react-jsx', source:`export function App(){ return <main><h1>Consumer</h1><button>Plain JSX</button></main> }`, jsx:'react'},
  {name:'rfsg-jsx-no-binding', source:`export function App(){ return <main><h1>Consumer</h1><button>Plain JSX</button></main> }`, jsx:'react-fine-grained-signals'},
  {name:'signal-children-only', source:`import { signal } from 'react-fine-grained-signals'; const count=signal(0); export function App(){ return <main><button onClick={()=>count.value++}>increment</button><output>{count}</output></main> }`, jsx:'react-fine-grained-signals'},
  {name:'signal-child-and-attribute', source:`import { signal } from 'react-fine-grained-signals'; const count=signal(0), title=signal('Counter'); export function App(){ return <main><button title={title} onClick={()=>count.value++}>increment</button><output>{count}</output></main> }`, jsx:'react-fine-grained-signals'},
  {name:'all-form-bindings', source:`import { signal } from 'react-fine-grained-signals'; const text=signal('text'), number=signal('2'), choice=signal('a'), many=signal(['x']), checked=signal(false); export function App(){ return <form><input bindValue={text}/><input type="number" bindValue={number}/><input type="range" bindValue={number}/><textarea bindValue={text}/><select bindValue={choice}><option value="a">A</option></select><select multiple bindValue={many}><option value="x">X</option></select><input type="radio" name="r" value="a" bindValue={choice}/><input type="checkbox" name="c" value="x" bindValue={many}/><input type="checkbox" bindChecked={checked}/></form> }`, jsx:'react-fine-grained-signals'},
]
const alias = [
 {find:/^react\/jsx-runtime$/, replacement:join(repo,'node_modules/react/jsx-runtime.js')},
 {find:/^react\/jsx-dev-runtime$/, replacement:join(repo,'node_modules/react/jsx-dev-runtime.js')},
 {find:/^react$/, replacement:join(repo,'node_modules/react/index.js')},
 {find:/^react-fine-grained-signals\/jsx-runtime$/, replacement:join(repo,'dist/jsx-runtime.js')},
 {find:/^react-fine-grained-signals\/jsx-dev-runtime$/, replacement:join(repo,'dist/jsx-dev-runtime.js')},
 {find:/^react-fine-grained-signals$/, replacement:join(repo,'dist/index.js')},
]
try {
 for(const scenario of scenarios){
  const project=join(root,scenario.name); mkdirSync(project,{recursive:true}); const entry=join(project,'entry.tsx'); writeFileSync(entry,scenario.source + "\nglobalThis.__rfsgConsumer = App;")
  const outDir=join(project,'dist')
  await build({configFile:false,root:project,plugins:[react({jsxImportSource:scenario.jsx})],resolve:{alias,dedupe:['react','react-dom']},build:{outDir,emptyOutDir:true,minify:'esbuild',sourcemap:false,cssCodeSplit:false,rollupOptions:{input:entry,output:{entryFileNames:'app.js',assetFileNames:'asset-[name][extname]'}}}})
  const jsFiles=readdirSync(outDir).filter(x=>x.endsWith('.js')).map(x=>({name:x,bytes:readFileSync(join(outDir,x))}))
  const raw=jsFiles.reduce((n,x)=>n+x.bytes.length,0), gzip=jsFiles.reduce((n,x)=>n+gzipSync(x.bytes,{level:9}).length,0), br=jsFiles.reduce((n,x)=>n+brotliCompressSync(x.bytes,{params:{[constants.BROTLI_PARAM_QUALITY]:11}}).length,0)
  const text=jsFiles.map(x=>x.bytes.toString()).join('\n')
  const result={name:scenario.name,raw,gzip,brotli:br,files:jsFiles.map(x=>x.name),markers:{'select binding':text.includes('Invalid select bindValue.'),'text input validation':text.includes('bindValue: text-like, number, or range input/textarea/select only.'),'checkbox group':text.includes('Checkbox group bindValue requires an array of strings.'),'checked binding':text.includes('bindChecked: checkbox only.'),'form reset':text.includes('reset'),'radio group':text.includes('Radio bindValue requires a string.')},text}
  outResults.push(result)
  console.log(JSON.stringify({...result,text:undefined}))
 }
 writeFileSync(join(repo,'development/v0.3.0/m18.15-consumer-bundles.json'),JSON.stringify(outResults.map(({text:_text,...r})=>r),null,2)+'\n')
} finally { rmSync(root,{recursive:true,force:true}) }
