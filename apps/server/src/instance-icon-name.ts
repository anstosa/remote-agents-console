// an icon is `<name>.svg` in the library; the pattern keeps names inside that directory
export const instanceIconPattern = /^[a-z0-9][a-z0-9-]{0,31}$/u;
export type InstanceIcon = string;

export function isInstanceIcon(value: string): value is InstanceIcon {
  return instanceIconPattern.test(value);
}
