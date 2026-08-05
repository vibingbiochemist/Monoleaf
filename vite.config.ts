import { defineConfig } from "vite";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

// https://vite.dev/config/
export default defineConfig(async () => ({
  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },
  test: {
    // The end-to-end suite is written for Node's test runner, not Vitest: it
    // launches the built binary and needs a release build, so it runs on demand
    // via `npm run test:e2e`. Vitest's default include matches `**/*.test.mjs`,
    // which picks those files up and then fails with "No test suite found"
    // because it does not recognise node:test's describe. Excluding the
    // directory keeps `npm test` to the unit suites.
    exclude: ["e2e/**", "**/node_modules/**", "**/dist/**"],
  },
}));
