import { defineConfig } from "vite";

// Capacitor serves the built web assets from a local scheme inside the WebView.
// Relative base keeps asset URLs working under that scheme on all Android versions.
export default defineConfig({
  base: "./",
  build: {
    outDir: "dist",
    emptyOutDir: true,
    target: "es2021",
  },
  test: {
    globals: true,
    environment: "node",
    include: ["tests/**/*.test.ts"],
  },
});
