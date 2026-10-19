#!/usr/bin/env bash
set -Eeuo pipefail

operation_id="${1:-}"
target_sha="${2:-}"

# accept only server-generated identifiers
if [[ ! "$operation_id" =~ ^[A-Za-z0-9_-]{20,64}$ ]]; then
  exit 2
fi

# accept only fetched git object identifiers
if [[ ! "$target_sha" =~ ^[0-9a-f]{40}$ ]]; then
  exit 2
fi

repository="$(pwd -P)"
status_directory="$repository/.data"
status_file="$status_directory/server-update-$operation_id.json"
temporary_file="$status_file.tmp"
last_status_file="$status_directory/server-update-last.json"
last_temporary_file="$last_status_file.$operation_id.tmp"
log_file="$status_directory/server-update-$operation_id.log"
control_root="${RAC_SETTINGS_CONTROL_ROOT:-}"

# record only allowlisted lifecycle output
mkdir -p "$status_directory"
touch "$log_file"
chmod 600 "$log_file"
exec >> "$log_file" 2>&1

# publish one atomic lifecycle state
write_status() {
  local state="$1"
  local payload
  mkdir -p "$status_directory"
  printf -v payload '{"id":"%s","kind":"update","state":"%s","targetSha":"%s"}\n' "$operation_id" "$state" "$target_sha"
  printf '%s' "$payload" > "$temporary_file"
  printf '%s' "$payload" > "$last_temporary_file"
  chmod 600 "$temporary_file" "$last_temporary_file"
  mv -f "$temporary_file" "$status_file"
  mv -f "$last_temporary_file" "$last_status_file"
}

# preserve a readable failure state
fail_update() {
  local exit_code="${1:-1}"
  trap - ERR
  write_status failed
  exit "$exit_code"
}

# record one failing command location
on_error() {
  local exit_code="$?"
  printf '[%s] server update failed with exit %s at line %s\n' "$(date -Is)" "$exit_code" "${BASH_LINENO[0]:-unknown}"
  fail_update "$exit_code"
}

trap on_error ERR
write_status running
printf '[%s] server update started\n' "$(date -Is)"

# require the installer-owned shared mutation root
if [[ -z "$control_root" || ! -d "$control_root" ]]; then
  printf '[%s] settings control root is unavailable\n' "$(date -Is)"
  fail_update 2
fi
lock_file="$control_root/mutation.lock"

# serialize host repository and Compose mutations
exec 9> "$lock_file"
if ! flock -n 9; then
  printf '[%s] another server update is already running\n' "$(date -Is)"
  fail_update 1
fi

# verify the immutable descriptor before changing git or Compose state
node scripts/settings/update.mjs "$control_root" "$operation_id" --verify-only >/dev/null 2>&1

# update only the deployed main branch
if [[ "$(git symbolic-ref --short HEAD)" != "main" ]]; then
  printf '[%s] server update requires the main branch\n' "$(date -Is)"
  fail_update 1
fi

# preserve local tracked changes
if ! git diff --quiet || ! git diff --cached --quiet; then
  printf '[%s] server update requires a clean tracked working tree\n' "$(date -Is)"
  fail_update 1
fi

# install only the reviewed upstream revision
git fetch --quiet origin '+refs/heads/main:refs/remotes/origin/main' >/dev/null 2>&1
fetched_target="$(git rev-parse refs/remotes/origin/main)"
if [[ "$fetched_target" != "$target_sha" ]]; then
  printf '[%s] upstream changed after review; expected %s and found %s\n' "$(date -Is)" "$target_sha" "$fetched_target"
  fail_update 1
fi
if ! git merge-base --is-ancestor refs/heads/main "$target_sha"; then
  printf '[%s] reviewed update is not a fast-forward from local main\n' "$(date -Is)"
  fail_update 1
fi
git merge --ff-only "$target_sha" >/dev/null 2>&1

# deploy through the same fixed invocation and proof boundary
node scripts/settings/update.mjs "$control_root" "$operation_id" >/dev/null 2>&1
write_status complete
printf '[%s] server update completed\n' "$(date -Is)"
