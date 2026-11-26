# Agent notes

## Agent version compatibility

- Never impose an upper version bound or a release allowlist on agent
  installations or feature availability. Compatibility floors are permitted;
  discover actual capabilities at runtime rather than rejecting newer releases
  solely because their version has not been audited.
- Treat an update's selected version as a minimum, not an exact version.
  Accept newer installations and never downgrade them to match a target.
  Verify the actual installed version rather than assuming a zero installer
  exit proves success.
- Bundled dependency pins for reproducible builds are not compatibility ceilings
  on newer host installations.

## Local-stack deployment

Before giving a final summary for any change that affects the local stack, deploy
that change with `docker compose up -d --build`. Then verify the relevant
services with `docker compose ps` (and any targeted health checks). Do not claim
completion if deployment fails; report the failure and its impact instead.

## Portable deployment

- Keep tracked Compose and documentation free of hostnames, absolute worktree
  paths, tunnel credentials, and other values specific to one installation.
- Put per-host environment values in ignored `.env`, project bind mounts in
  ignored `compose.override.yaml`, and console/tunnel configuration in the
  ignored files under `config/`.
- Never recreate the live Compose project from `git show`, a temporary Compose
  file, or another revision. That can silently replace the current host's
  runtime configuration.
- A remote deployment must run on the target host: enter its checkout, run
  `git pull --ff-only`, then run `docker compose up -d --build` and targeted
  health checks. Do not copy a working tree, built image, or generated artifact
  from another host.
