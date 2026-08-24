#!/usr/bin/env node
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

function fromDotEnv(file) {
  if (!existsSync(file)) return {};
  const out = {};
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const i = t.indexOf("=");
    if (i <= 0) continue;
    out[t.slice(0, i)] = t.slice(i + 1).trim();
  }
  return out;
}

const fileEnv = {
  ...fromDotEnv(resolve(".env")),
  ...fromDotEnv(resolve(".env.production")),
};

function read(name) {
  return (process.env[name] ?? fileEnv[name] ?? "").trim();
}

const google = read("VITE_GOOGLE_CLIENT_ID");
const github = read("VITE_GITHUB_CLIENT_ID");
const api = read("VITE_API_BASE");

console.log("[bake-check] VITE_API_BASE:", api ? "set" : "empty");
console.log("[bake-check] VITE_GOOGLE_CLIENT_ID:", google ? "set" : "empty");
console.log("[bake-check] VITE_GITHUB_CLIENT_ID:", github ? "set" : "empty");

if (!google && !github) {
  console.error(
    "[bake-check] Missing Client IDs. Add them to .env.production or the build environment.",
  );
  process.exit(1);
}
