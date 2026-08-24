#!/usr/bin/env bash
# Compile openpilot cereal schemas with capnpc-ts.
# Re-run after pulling schema changes: npm run codegen
#
# Looks for an openpilot checkout via OPENPILOT_ROOT, else ../openpilot.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
APP="$(cd "$HERE/.." && pwd)"
OUT="$APP/src/gen"

if [[ -n "${OPENPILOT_ROOT:-}" ]]; then
  ROOT="$(cd "$OPENPILOT_ROOT" && pwd)"
elif [[ -d "$APP/../openpilot/openpilot/cereal" ]]; then
  ROOT="$(cd "$APP/../openpilot" && pwd)"
elif [[ -d "$APP/../openpilot/cereal" ]]; then
  # unusual layout: cereal at repo root
  ROOT="$(cd "$APP/../openpilot" && pwd)"
else
  echo "openpilot checkout not found. Set OPENPILOT_ROOT or clone openpilot next to this repo." >&2
  exit 1
fi

CAPNP="${CAPNP:-}"
if [[ -z "$CAPNP" ]]; then
  if [[ -x "$ROOT/.venv/bin/capnp" ]]; then
    CAPNP="$ROOT/.venv/bin/capnp"
  else
    CAPNP="$(command -v capnp)"
  fi
fi

PLUGIN="$APP/node_modules/.bin/capnpc-ts"
if [[ ! -x "$PLUGIN" ]]; then
  echo "capnpc-ts not found. Run npm install in comma-replay/" >&2
  exit 1
fi

mkdir -p "$OUT"
rm -rf "$OUT"/*
printf '{ "type": "commonjs" }\n' > "$OUT/package.json"

compile() {
  local prefix="$1"
  local file="$2"
  echo "compile $(basename "$file")"
  "$CAPNP" compile \
    -I"$ROOT/opendbc_repo/opendbc/car" \
    -I"$ROOT/openpilot/cereal" \
    --src-prefix="$prefix" \
    -o"$PLUGIN:$OUT" \
    "$file"
}

# Compile separately so capnpc-ts dump() doesn't blow the traversal limit
# on a combined CodeGeneratorRequest.
compile "$ROOT/opendbc_repo/opendbc/car" "$ROOT/opendbc_repo/opendbc/car/car.capnp"
compile "$ROOT/openpilot/cereal" "$ROOT/openpilot/cereal/custom.capnp"
compile "$ROOT/openpilot/cereal" "$ROOT/openpilot/cereal/deprecated.capnp"
compile "$ROOT/openpilot/cereal" "$ROOT/openpilot/cereal/log.capnp"

echo "wrote $OUT"
ls -1 "$OUT"
