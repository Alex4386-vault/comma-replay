# comma-replay server

Go HTTP API for the comma-replay SPA. The SPA owns Google/GitHub OAuth (PKCE); this process validates provider access tokens and issues opaque API bearer tokens.

## On-disk layout

```
{REPLAY_DATA_ROOT}/
  {user_id}/
    {device_id}/
      {record_id}/
        rlog.zst
        ...
```

After login, only `{REPLAY_DATA_ROOT}/{oauth_user_id}/...` is readable.

## Auth

1. FE completes PKCE at Google/GitHub (Client IDs on the SPA).
2. `POST /auth/session` with `{ "provider": "google"|"github", "accessToken": "..." }`.
3. Response `{ "token": "...", "user": { ... } }` — use `Authorization: Bearer <token>` on `/api/*`.
4. `POST /auth/logout` with the same Bearer header revokes the token.

## HTTP API

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/health` | — | Liveness |
| POST | `/auth/session` | — | Exchange provider access token → API token |
| POST | `/auth/logout` | Bearer | Revoke API token |
| GET | `/api/me` | Bearer | Current user |
| GET | `/api/devices` | Bearer | Device IDs |
| GET | `/api/devices/{deviceID}/records` | Bearer | Record IDs |
| GET | `/api/devices/{deviceID}/records/{recordID}/files` | Bearer | List files |
| GET | `/api/devices/{deviceID}/records/{recordID}/files/{path}` | Bearer | Download (Range OK) |

## Run

```bash
cd server
export REPLAY_DATA_ROOT=/path/to/your/data
export REPLAY_FRONTEND_ORIGIN=http://localhost:5173,https://your-pages.pages.dev
go run ./cmd/replay-server
```

Optional: `REPLAY_ADDR` (default `:8080`), `REPLAY_ALLOWED_USER_IDS` (comma-separated OAuth subject IDs).

## Docker / GHCR

Images publish to `ghcr.io/<owner>/comma-replay-server` on pushes that touch `server/` (see `.github/workflows/server-ghcr.yaml`).

```bash
cd server
docker compose up -d --build
```

Env for Compose — copy `.env.example` to `.env`:

```bash
cd server
cp .env.example .env
# edit REPLAY_DATA_HOST, REPLAY_FRONTEND_ORIGIN, …
docker compose up -d --build
```

Compose reads `server/.env` for `${…}` substitution and injects it into the container via `env_file`.

Packages may be private by default — mark the package public or grant pull access as needed.
