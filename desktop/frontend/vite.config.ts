import { defineConfig } from 'vite'

export default defineConfig({
  build: {
    // Mermaid's optional diagram renderers are already split into on-demand
    // chunks. Some (notably Cynefin) are just over Vite's generic 500 kB
    // warning threshold even though they never affect startup or users who
    // do not render that diagram type.
    chunkSizeWarningLimit: 750,
  },
})
