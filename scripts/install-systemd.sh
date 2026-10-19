#!/usr/bin/env bash
set -Eeuo pipefail

repository="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
environment_file="${RAC_ENV_FILE:-$repository/.env}"
unit_directory="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
unit_file="$unit_directory/remote-agent-console.service"
template="$repository/systemd/remote-agent-console.service.in"

if [[ ! -f "$environment_file" ]]; then
  printf 'missing environment file: %s\n' "$environment_file" >&2
  exit 1
fi

node_binary="${NODE_BIN:-$(command -v node || true)}"
if [[ -z "$node_binary" || ! -x "$node_binary" ]]; then
  printf 'Node.js was not found; set NODE_BIN to the absolute Node.js executable\n' >&2
  exit 1
fi
node_binary="$(readlink -f "$node_binary")"
# A mise (or asdf) shim is a symlink to the version manager itself, so the
# resolved path is the manager binary rather than Node. Ask the manager for
# the real Node executable instead.
if [[ "$(basename "$node_binary")" != node* ]]; then
  if command -v mise >/dev/null 2>&1; then
    node_binary="$(mise which node)"
  else
    printf 'Resolved Node path is %s, not a Node binary; set NODE_BIN to the absolute Node.js executable\n' "$node_binary" >&2
    exit 1
  fi
fi

# install the fixed host settings control plane first
settings_installation="$(NODE_BIN="$node_binary" "$repository/scripts/install-settings-applier.sh" systemd --environment-file "$environment_file")"
settings_control="$($node_binary -e 'const value=JSON.parse(process.argv[1]); if(typeof value.controlRoot!=="string") process.exit(1); process.stdout.write(value.controlRoot)' "$settings_installation")"

executable_path="$(dirname "$node_binary"):$HOME/.local/share/mise/shims:$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin"

escape_sed() {
  printf '%s' "$1" | sed 's/[&|]/\\&/g'
}

mkdir -p "$unit_directory"
sed \
  -e "s|@REPOSITORY@|$(escape_sed "$repository")|g" \
  -e "s|@ENVIRONMENT_FILE@|$(escape_sed "$environment_file")|g" \
  -e "s|@EXECUTABLE_PATH@|$(escape_sed "$executable_path")|g" \
  -e "s|@NODE@|$(escape_sed "$node_binary")|g" \
  -e "s|@SETTINGS_CONTROL@|$(escape_sed "$settings_control")|g" \
  "$template" > "$unit_file"
chmod 600 "$unit_file"

systemctl --user daemon-reload
systemctl --user enable --now remote-agent-console.service
systemctl --user --no-pager --full status remote-agent-console.service
