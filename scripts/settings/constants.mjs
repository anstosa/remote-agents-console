export const PROTOCOL_VERSION = 1;
export const MAX_REQUEST_BYTES = 2 * 1024 * 1024;
export const MAX_SOURCE_BYTES = 1024 * 1024;
export const MAX_COMMAND_BYTES = 16 * 1024 * 1024;
export const MAX_REVEAL_TTL_MS = 60_000;
export const REQUEST_KINDS = new Set([
  "inspect",
  "read",
  "validate",
  "commit",
  "restart",
  "reveal",
  "reconcile",
  "recover",
  "cloudflare"
]);
export const TARGETS = new Set(["rac", "cloudflared"]);
export const SOURCE_KINDS = new Set([
  "json",
  "env",
  "compose",
  "cloudflared",
  "credentials",
  "wrapper",
  "svg",
  "installation"
]);
export const APPLY_CLASSES = new Set([
  "rac-restart",
  "cloudflared-recreate",
  "saved-only",
  "live"
]);
export const SOURCE_IDS = new Set([
  "app",
  "env",
  "installation",
  "compose",
  "compose-override",
  "cloudflared",
  "cloudflared-credentials",
  "wrapper",
  "icon-heart",
  "icon-potato"
]);
export const CONTROL_DIRECTORIES = [
  "queued",
  "claimed",
  "status",
  "staging",
  "journal",
  "recovery"
];
