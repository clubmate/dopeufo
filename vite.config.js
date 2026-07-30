import { defineConfig } from 'vite'

// GitHub Pages serves project sites from /<repo>/, so production builds need a
// non-root base. Dev stays at '/' — every harness script in tools/ hardcodes
// http://localhost:5173 with no path prefix, and a dev-time base would 404 them all.
export default defineConfig(({ command }) => ({
  base: command === 'build' ? '/dopeufo/' : '/',
}))
