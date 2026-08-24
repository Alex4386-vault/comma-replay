import path from "node:path";
import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import commonjs from "vite-plugin-commonjs";
import { defineConfig, loadEnv } from "vite";

const root = fileURLToPath(new URL(".", import.meta.url));

function readVite(name: string, fromFiles: Record<string, string>): string {
  // Cloudflare Pages injects dashboard vars into process.env — prefer that over .env files.
  const raw = process.env[name] ?? fromFiles[name] ?? "";
  return String(raw).trim();
}

export default defineConfig(({ mode }) => {
  const fileEnv = loadEnv(mode, root, "VITE_");
  const apiBase = readVite("VITE_API_BASE", fileEnv).replace(/\/$/, "");
  const googleClientId = readVite("VITE_GOOGLE_CLIENT_ID", fileEnv);
  const githubClientId = readVite("VITE_GITHUB_CLIENT_ID", fileEnv);

  if (mode === "production" && !googleClientId && !githubClientId) {
    const seen = Object.keys(process.env)
      .filter((k) => /^VITE_/i.test(k) || /GOOGLE|GITHUB|CLIENT_ID/i.test(k))
      .sort();
    throw new Error(
      [
        "Production build requires VITE_GOOGLE_CLIENT_ID and/or VITE_GITHUB_CLIENT_ID in process.env (baked into the bundle).",
        "Cloudflare Pages: Settings → Environment variables — set them for Production AND Preview, then Retry deployment.",
        `process.env keys seen: ${seen.length ? seen.join(", ") : "(none)"}`,
      ].join("\n"),
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
