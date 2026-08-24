# comma-replay

Static Vite SPA that reads openpilot route directories **in the browser**. Schema types are generated from cereal `.capnp` files; log framing matches pycapnp `Event.read_multiple_bytes`.

UI is **shadcn/ui (radix-nova)** plus the **ReUI** registry (`@reui` in `components.json`) for extra tokens/primitives (e.g. `src/components/reui/alert.tsx`).

## Wire a source

`DataSource` is the only I/O boundary:

| Implementation | Use |
|----------------|-----|
| Sign in | Google/GitHub via `replay-server` (session cookie) |
| Bring your own directory | File System Access picker → lists `record_id` child dirs |

Route discovery (`src/route/discover.ts`) is a port of `tools/lib/route.py` layouts over that interface.

## Dev

```bash
npm install
npm run codegen   # needs openpilot .venv capnp + capnpc-ts
npm run dev
```

Regenerate types after cereal/opendbc schema changes: `npm run codegen`.

Production uses **`replay-server`** (Go, typically beside this app in an openpilot checkout): OAuth sign-in, then files from `{DATA_ROOT}/{user_id}/{device_id}/{record_id}/` on disk.

## Cloudflare Pages (static)

This repo is a static Vite build (`dist/`). Connect the Git repo in the Cloudflare dashboard, or deploy a local build:

| Setting | Value |
|---------|--------|
| Framework preset | Vite |
| Build command | `npm run build:pages` |
| Build output directory | `dist` |
| Node.js version | 20 (see `.nvmrc`) |

Set a **build-time** env var so the SPA can reach `replay-server` (empty means same origin, which Pages will not have):

```
VITE_API_BASE=https://your-replay-server.example
```

On the API, set:

```
REPLAY_BASE_URL=https://your-replay-server.example
REPLAY_FRONTEND_ORIGIN=https://your-pages-project.pages.dev
```

OAuth cookies are cross-site in this layout; `replay-server` uses `SameSite=None; Secure` when the frontend host differs from the API host.

`src/gen` (cereal types) is committed so Pages CI does not need capnp or an openpilot checkout. Re-run `npm run codegen` locally after schema changes.

CLI deploy after `npm run build:pages`:

```bash
npx wrangler pages deploy dist --project-name comma-replay
```
