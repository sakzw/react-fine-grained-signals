import { defineConfig } from 'vite'
import signals from 'unplugin-react-fine-grained-signals/vite'

export default defineConfig({
  plugins: [signals({ mode: 'auto', include: (id) => id.replaceAll('\\', '/').includes('/src/demos.tsx') })],
  resolve: { dedupe: ['react', 'react-dom'] },
})
