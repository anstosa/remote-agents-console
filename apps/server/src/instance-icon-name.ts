// an icon is `<name>.svg` in the library; the pattern keeps names inside that directory
export const instanceIconPattern = /^[a-z0-9][a-z0-9-]{0,31}$/u;
// a peer's artwork is named by the base64url SHA-256 of its bytes
export const instanceIconHashPattern = /^[A-Za-z0-9_-]{43}$/u;
// the revision a Settings save sends for an icon it creates; the save fails if the file already exists
export const newIconRevision = 'new';

export function isInstanceIconName(value: unknown): value is string {
  return typeof value === 'string' && instanceIconPattern.test(value);
}

// name the library artwork an `icon-<name>` settings source edits; the built-in terminal has no file
export function iconSourceName(sourceId: string): string | undefined {
  const name = sourceId.startsWith('icon-') ? sourceId.slice('icon-'.length) : '';
  return name !== 'terminal' && isInstanceIconName(name) ? name : undefined;
}

export const iconSourceLabel = (name: string): string => `${name} icon`;
