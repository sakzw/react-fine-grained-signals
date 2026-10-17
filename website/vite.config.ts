import react from '@vitejs/plugin-react'
import signals from 'unplugin-react-fine-grained-signals/vite'
import { defineConfig } from 'vite'
import { vocs } from 'vocs/vite'

// The same plugins `vocs dev` / `vocs build` use, plus the managed signal
// transform. The Vocs CLI starts Vite with `configFile: false`, so a site that
// needs its own Vite plugins runs Vite directly with this file.
export default defineConfig({
  // `vite build` builds every environment (client, SSR, RSC) like `vocs build`.
  builder: {},
  plugins: [
    signals({
      mode: 'auto',
      // Only the interactive demos are client components. MDX pages and the
      // Vocs layout render as React Server Components, which must never get
      // the client-only render-tracking Hook.
      include: (id) => /\/src\/components\/.*\.tsx$/.test(id),
    }),
    react(),
    vocs(),
  ],
})
