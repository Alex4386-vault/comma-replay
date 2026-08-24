# comma-replay

Static Vite SPA that reads openpilot route directories **in the browser**. Schema types are generated from cereal `.capnp` files; log framing matches pycapnp `Event.read_multiple_bytes`.

UI is **shadcn/ui (radix-nova)** plus the **ReUI** registry (`@reui` in `components.json`) for extra tokens/primitives (e.g. `src/components/reui/alert.tsx`).

## Wire a source

`DataSource` is the only I/O boundary:

| Implementation | Use |
|----------------|-----|
| Sign in | Google/GitHub **PKCE on the SPA** → `POST /auth/session` (server code exchange) → API bearer |
| Bring your own directory | File System Access picker → lists `record_id` child dirs |

Route discovery (`src/route/discover.ts`) is a port of `tools/lib/route.py` layouts over that interface.

## Auth (PKCE)

1. Set Client IDs on the FE build (`VITE_GOOGLE_CLIENT_ID`, `VITE_GITHUB_CLIENT_ID`).
2. OAuth apps must allow redirect URI `{origin}/auth/callback`.
3. SPA runs PKCE; callback posts `code` + `code_verifier` to `server` `POST /auth/session` (token exchange is **not** done in the browser — GitHub blocks CORS).
4. API calls send `Authorization: Bearer <api_token>` (stored in `sessionStorage`).

On the API, set the same Client IDs plus **`REPLAY_GITHUB_CLIENT_SECRET`** (server-only). Keep `https://comma-replay.pages.dev` in `REPLAY_FRONTEND_ORIGIN`.

API lives in [`server/`](./server/) — see that README for Go run / Docker / GHCR.

## Dev

```bash
npm install
npm run codegen   # needs openpilot .venv capnp + capnpc-ts
npm run dev
```

Example `.env.local`:

```
VITE_API_BASE=http://localhost:8080
VITE_GOOGLE_CLIENT_ID=....apps.googleusercontent.com
VITE_GITHUB_CLIENT_ID=Ov23...
```

Regenerate types after cereal/opendbc schema changes: `npm run codegen`.

## Cloudflare Pages (static)

| Setting | Value |
|---------|--------|
| Framework preset | Vite |
| Build command | `npm run build:pages` |
| Build output directory | `dist` |
| Node.js version | 20 (see `.nvmrc`) |

Build-time env (must be present during `npm run build:pages` — Vite bakes them into JS):

```
VITE_API_BASE=https://your-api.example
VITE_GOOGLE_CLIENT_ID=...
VITE_GITHUB_CLIENT_ID=...
```

Production builds **fail** if both Client IDs are empty. On Coolify/Pages, mark these as **build** variables (not runtime-only), then redeploy.

On the API:

```
REPLAY_FRONTEND_ORIGIN=https://your-pages-project.pages.dev
REPLAY_DATA_ROOT=/path/to/data
```

`src/gen` (cereal types) is committed so Pages CI does not need capnp. Re-run `npm run codegen` locally after schema changes.

```bash
npx wrangler pages deploy dist --project-name comma-replay
```
