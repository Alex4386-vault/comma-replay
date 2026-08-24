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
