import path from "node:path";
import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import commonjs from "vite-plugin-commonjs";
import { defineConfig, loadEnv } from "vite";

const root = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, root, "VITE_");
  const apiBase = (env.VITE_API_BASE ?? "").trim().replace(/\/$/, "");
  const googleClientId = (env.VITE_GOOGLE_CLIENT_ID ?? "").trim();
  const githubClientId = (env.VITE_GITHUB_CLIENT_ID ?? "").trim();

  if (mode === "production" && !googleClientId && !githubClientId) {
    throw new Error(
      "Production build requires VITE_GOOGLE_CLIENT_ID and/or VITE_GITHUB_CLIENT_ID in the build environment (baked into the bundle).",
    );
  }

  return {
    plugins: [
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
    // Force string literals into the client bundle (not runtime process.env).
    define: {
      __BAKED_API_BASE__: JSON.stringify(apiBase),
      __BAKED_GOOGLE_CLIENT_ID__: JSON.stringify(googleClientId),
      __BAKED_GITHUB_CLIENT_ID__: JSON.stringify(githubClientId),
    },
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
  };
});
