const fallbackStyle = 'fg=#cdd6f4,bg=#1e1e2e';

const terminalColorFallbackScript = `
# validate the pane identity before querying tmux
tmux_bin=$1
shift
tmux_value=\${TMUX-}
pane=\${TMUX_PANE-}
tmux_index=\${tmux_value##*,}
tmux_prefix=\${tmux_value%,*}
tmux_pid=\${tmux_prefix##*,}
tmux_socket=\${tmux_prefix%,*}
pane_digits=\${pane#%}

# accept only tmux's socket,pid,index environment shape
case $tmux_socket in
  '') valid_tmux=0 ;;
  *) valid_tmux=1 ;;
esac
case $tmux_pid in
  ''|*[!0-9]*) valid_tmux=0 ;;
esac
case $tmux_index in
  ''|*[!0-9]*) valid_tmux=0 ;;
esac
case $pane in
  %*) ;;
  *) valid_tmux=0 ;;
esac
case $pane_digits in
  ''|*[!0-9]*) valid_tmux=0 ;;
esac

# inspect only a verified pane on its inherited server
if [ "$valid_tmux" = 1 ]; then
  # bridge wrappers run before the host login shell restores its path
  if [ "$tmux_bin" = tmux ] && [ -x "/proc/$tmux_pid/exe" ]; then
    tmux_bin="/proc/$tmux_pid/exe"
  fi
  session=$("$tmux_bin" display-message -p -t "$pane" '#{session_id}' 2>/dev/null)
  session_status=$?
  session_digits=\${session#\\$}
  # require an exact numeric session id
  case $session in
    \\$*) ;;
    *) session_status=1 ;;
  esac
  case $session_digits in
    ''|*[!0-9]*) session_status=1 ;;
  esac

  # fail closed when client detection is unavailable
  if [ "$session_status" -eq 0 ]; then
    clients=$("$tmux_bin" list-clients -F '#{session_id}|#{client_control_mode}|#{client_suspended}' 2>/dev/null)
    clients_status=$?
    clients_valid=1
    real_client=0
    # validate every client before treating the pane as headless
    if [ "$clients_status" -eq 0 ]; then
      while IFS='|' read -r client_session client_control client_suspended client_extra; do
        # ignore the one empty record from an empty listing
        if [ -z "$client_session$client_control$client_suspended$client_extra" ]; then
          continue
        fi
        client_session_digits=\${client_session#\\$}
        # reject malformed client records conservatively
        case $client_session in
          \\$*) ;;
          *) clients_valid=0 ;;
        esac
        case $client_session_digits in
          ''|*[!0-9]*) clients_valid=0 ;;
        esac
        case $client_control:$client_suspended:$client_extra in
          0::|0:0:|0:1:|1::|1:0:|1:1:) ;;
          *) clients_valid=0 ;;
        esac
        # only an active terminal client blocks the fallback
        if [ "$client_session" = "$session" ] && [ "$client_control" = 0 ] && { [ -z "$client_suspended" ] || [ "$client_suspended" = 0 ]; }; then
          real_client=1
        fi
      done <<EOF
$clients
EOF
    else
      clients_valid=0
    fi

    # read both independently and mutate only the exact default pair
    if [ "$clients_valid" = 1 ] && [ "$real_client" = 0 ]; then
      window_style=$("$tmux_bin" show-options -p -A -v -t "$pane" window-style 2>/dev/null)
      window_style_status=$?
      active_style=$("$tmux_bin" show-options -p -A -v -t "$pane" window-active-style 2>/dev/null)
      active_style_status=$?
      # preserve every custom or partially custom pair
      if [ "$window_style_status" -eq 0 ] && [ "$active_style_status" -eq 0 ] && [ "$window_style" = default ] && [ "$active_style" = default ]; then
        "$tmux_bin" set-option -p -t "$pane" window-style '${fallbackStyle}' >/dev/null 2>&1 || :
        "$tmux_bin" set-option -p -t "$pane" window-active-style '${fallbackStyle}' >/dev/null 2>&1 || :
      fi
    fi
  fi
fi

# replace the wrapper with the requested process byte-for-byte
exec "$@"
`;

// prepend the best-effort tmux color fallback without interpolating caller input
export function terminalColorFallbackArgv(tmuxBinary: string, argv: readonly string[]): string[] {
  return ['/bin/sh', '-c', terminalColorFallbackScript, 'rac-terminal-colors', tmuxBinary, ...argv];
}
