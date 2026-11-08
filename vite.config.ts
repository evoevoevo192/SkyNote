import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  // relative paths: the site works from a sub-folder too (GitHub Pages: user.github.io/repo/)
  base: "./",
  plugins: [react()],
  server: {
    host: true,
  },
});
