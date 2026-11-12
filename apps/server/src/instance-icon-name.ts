// an icon is `<name>.svg` in the library; the pattern keeps names inside that directory
export const instanceIconPattern = /^[a-z0-9][a-z0-9-]{0,31}$/u;
export type InstanceIcon = string;
// a peer's artwork is named by the base64url SHA-256 of its bytes
export const instanceIconHashPattern = /^[A-Za-z0-9_-]{43}$/u;

export function isInstanceIcon(value: string): value is InstanceIcon {
  return instanceIconPattern.test(value);
}

// name the library artwork an `icon-<name>` settings source edits; the built-in terminal has no file
export function iconSourceName(sourceId: string): InstanceIcon | undefined {
  const name = sourceId.startsWith('icon-') ? sourceId.slice('icon-'.length) : '';
  return name !== 'terminal' && isInstanceIcon(name) ? name : undefined;
}
