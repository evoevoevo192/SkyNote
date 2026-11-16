import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
// @ts-expect-error plain JS helper shared with the test setup
import { makeSw } from "./scripts/make-sw.mjs";

const root = path.dirname(fileURLToPath(import.meta.url));

/** After the build: writes sw.js (service worker with the cache of the app shell) next to index.html. */
function serviceWorker(): Plugin {
  let outDir = "dist";
  return {
    name: "sticky-service-worker",
    apply: "build",
    configResolved(cfg) {
      outDir = path.resolve(cfg.root, cfg.build.outDir);
    },
    closeBundle() {
      const r = makeSw(outDir, path.join(root, "scripts/sw.template.js"));
      console.log(`service worker: ${r.count} files, version ${r.version}`);
    },
  };
}

export default defineConfig({
  // relative paths: the site works from a sub-folder too (GitHub Pages: user.github.io/repo/)
  base: "./",
  plugins: [react(), serviceWorker()],
  server: {
    host: true,
  },
});
