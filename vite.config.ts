import path from "node:path";
import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import commonjs from "vite-plugin-commonjs";
import { defineConfig } from "vite";

const root = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  plugins: [
    // capnpc-ts emits CommonJS into src/gen — transform for browser ESM.
    commonjs({
      filter(id) {
        if (id.includes(`${path.sep}src${path.sep}gen${path.sep}`) && id.endsWith(".js")) {
          return true;
        }
      },
    }),
    react(),
    tailwindcss(),
  ],
  resolve: {
    alias: {
      "@": path.resolve(root, "./src"),
    },
  },
  worker: { format: "es" },
  optimizeDeps: {
    include: ["capnp-ts", "mpegts.js"],
  },
  build: {
    commonjsOptions: {
      include: [/node_modules/, /src[\\/]gen/],
      transformMixedEsModules: true,
    },
    chunkSizeWarningLimit: 2000,
  },
  server: {
    fs: { allow: [".."] },
  },
});
