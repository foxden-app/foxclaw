#!/usr/bin/env bash
set -euo pipefail
ROOT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
node "$ROOT_DIR/dist/main.js" install-launchd
