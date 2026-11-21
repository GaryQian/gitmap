import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));
const isolation = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "require-corp",
};

export default defineConfig({
  root: here,
  cacheDir: here + ".vite-cache",
  server: { port: 5182, strictPort: true, headers: isolation },
  preview: { port: 5182, strictPort: true, headers: isolation },
  worker: { format: "es" },
});
