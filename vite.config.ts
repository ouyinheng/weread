import vue from '@vitejs/plugin-vue'
import { defineConfig } from 'vite'
import { resolve } from 'path'
import { readFileSync } from 'fs'

/** 版本号只有一个来源：package.json。Gradle 也读同一份。 */
const pkg = JSON.parse(readFileSync(resolve(import.meta.dirname, 'package.json'), 'utf8'))

export default defineConfig({
  plugins: [vue()],
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  resolve: {
    alias: { '@': resolve(import.meta.dirname, 'src') },
    // Test SFCs must share one Vue instance with the test harness; without
    // dedupe, vue.runtime.esm-bundler (dep-optimized) and vue.cjs.js (Node
    // resolved) both load and provide/inject silently breaks.
    dedupe: ['vue', 'vue-router', 'pinia'],
  },
  server: { port: 5173, host: true },
  // vite-node externalizes deps, so an SFC's `import 'vue'` resolves to the
  // dep-optimized ESM build while the test file's own import hits Node's CJS
  // build — two copies, and provide/inject silently fails. Inline them so the
  // test harness and the SFCs share one instance.
  ssr: {
    noExternal: ['vue', 'vue-router', 'pinia'],
  },
})
