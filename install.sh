#!/usr/bin/env bash
# Thin wrapper: find a node binary (PATH, else the one bundled with DSH) and run install.mjs.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"

NODE_BIN=""
if command -v node >/dev/null 2>&1; then
  NODE_BIN="$(command -v node)"
else
  for app in "/Applications/DeepSeek Harness.app" "/Applications/DSH Desktop.app" "$HOME/Applications/DeepSeek Harness.app"; do
    if [ -x "$app/Contents/Resources/runtime/bin/node" ]; then
      NODE_BIN="$app/Contents/Resources/runtime/bin/node"
      break
    fi
  done
fi

if [ -z "$NODE_BIN" ]; then
  echo "E_NO_NODE: 没有 node，也没有找到 DSH 自带的 node" >&2
  exit 3
fi

exec "$NODE_BIN" "$ROOT/install.mjs" "$@"
