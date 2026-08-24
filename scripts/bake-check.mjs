#!/usr/bin/env node
/**
 * Fail fast before Vite if Client IDs are missing from the real process environment
 * (Cloudflare Pages dashboard → Environment variables).
 */
const google = (process.env.VITE_GOOGLE_CLIENT_ID ?? "").trim();
const github = (process.env.VITE_GITHUB_CLIENT_ID ?? "").trim();
const api = (process.env.VITE_API_BASE ?? "").trim();

const viteKeys = Object.keys(process.env)
  .filter((k) => k.startsWith("VITE_"))
  .sort();

console.log("[bake-check] VITE_API_BASE:", api ? "set" : "empty");
console.log("[bake-check] VITE_GOOGLE_CLIENT_ID:", google ? "set" : "empty");
console.log("[bake-check] VITE_GITHUB_CLIENT_ID:", github ? "set" : "empty");
console.log("[bake-check] all VITE_* keys in process.env:", viteKeys.join(", ") || "(none)");

if (!google && !github) {
  console.error(`
[bake-check] Missing OAuth Client IDs in the build environment.

Cloudflare Pages:
  1. Project → Settings → Environment variables
  2. Add VITE_GOOGLE_CLIENT_ID / VITE_GITHUB_CLIENT_ID / VITE_API_BASE
  3. Enable for BOTH Production and Preview (branch builds use Preview)
  4. Deployments → … → Retry deployment (editing vars does not rebuild by itself)
`);
  process.exit(1);
}
