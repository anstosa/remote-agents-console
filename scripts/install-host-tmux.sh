#!/usr/bin/env bash
set -Eeuo pipefail

repository="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
unit_directory="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
tmux_binary="${TMUX_BIN:-$(command -v tmux || true)}"
systemd_run_binary="$(command -v systemd-run || true)"
socket_directory="${HOST_TMUX_DIR:-$HOME/.local/state/tmux/tmux-$(id -u)}"

# require a real host executable, not the container's compatibility wrapper
if [[ "$tmux_binary" != /* || ! -x "$tmux_binary" ]]; then
  printf 'set TMUX_BIN to an absolute executable tmux path on this host\n' >&2
  exit 1
fi
# detect and launch scopes with the same host executable
if [[ "$systemd_run_binary" != /* || ! -x "$systemd_run_binary" ]]; then
  printf 'systemd-run must resolve to an absolute executable path on this host\n' >&2
  exit 1
fi
# keep the shared socket location stable across service starts
if [[ "$socket_directory" != /* ]]; then
  printf 'HOST_TMUX_DIR must be an absolute host directory\n' >&2
  exit 1
fi

# quote literal arguments for systemd, not a shell
unit_argument() {
  local value="$1"
  # reject values that could inject unit directives
  if [[ "$value" =~ [[:cntrl:]] ]]; then
    printf 'unit paths cannot contain control characters\n' >&2
    return 1
  fi
  value="${value//\\/\\\\}"
  value="${value//\"/\\\"}"
  value="${value//\$/\$\$}"
  value="${value//%/%%}"
  printf '"%s"' "$value"
}

helper_argument="$(unit_argument "$repository/scripts/ensure-host-tmux.sh")"
systemd_run_argument="$(unit_argument "$systemd_run_binary")"
# executable paths do not undergo environment-variable expansion
systemd_run_argument="${systemd_run_argument//\$\$/\$}"
binary_argument="$(unit_argument "$tmux_binary")"
socket_argument="$(unit_argument "$socket_directory")"
# preserve literal scope arguments on newer systemd releases
scope_environment_option=""
if "$systemd_run_binary" --help | grep -q -- '--expand-environment'; then
  scope_environment_option="--expand-environment=no"
fi
mkdir -p -- "$unit_directory"
umask 077
cat > "$unit_directory/remote-agent-tmux.service" <<EOF
[Unit]
Description=Keep the Remote Agent Console host tmux bridge available

[Service]
Type=oneshot
ExecStart=$systemd_run_argument --user --scope --collect --quiet $scope_environment_option /bin/bash $helper_argument $binary_argument $socket_argument
TimeoutStartSec=15s
# preserve sessions inherited from earlier unscoped installations
KillMode=process
EOF
cp "$repository/systemd/remote-agent-tmux.timer" "$unit_directory/remote-agent-tmux.timer"
systemctl --user daemon-reload
systemctl --user enable --now remote-agent-tmux.timer
systemctl --user start remote-agent-tmux.service
systemctl --user --no-pager --full status remote-agent-tmux.timer
printf 'host tmux socket: %s/default\n' "$socket_directory"
# boot availability requires the user manager before login
if [[ "$(loginctl show-user "$(id -un)" -p Linger --value 2>/dev/null || true)" != yes ]]; then
  printf 'enable boot without login: sudo loginctl enable-linger %s\n' "$(id -un)" >&2
fi
