#!/usr/bin/env bash
set -Eeuo pipefail

repository="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
kind="${1:-compose}"
shift || true

# install through the fixed node entrypoint
exec "${NODE_BIN:-node}" "$repository/scripts/apply-settings.mjs" \
  --install \
  --repository "$repository" \
  --kind "$kind" \
  "$@"
