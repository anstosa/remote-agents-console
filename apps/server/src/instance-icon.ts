import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { isInstanceIcon, type InstanceIcon } from './instance-icon-name.js';

export { instanceIconHashPattern, instanceIconPattern, isInstanceIcon, type InstanceIcon } from './instance-icon-name.js';

// texture the shared display background
const scanLines = '<path d="M6 11.5h52M6 16.5h52M6 21.5h52M6 26.5h52M6 31.5h52M6 36.5h52M6 41.5h52M6 46.5h52M6 51.5h52M6 56.5h52" fill="none" stroke="#45475a" stroke-width="1" stroke-opacity=".42"/>';

// render the portable terminal fallback
export function instanceIconSvg(): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="7.4" fill="#181825"/><rect x=".75" y=".75" width="62.5" height="62.5" rx="6.65" fill="none" stroke="#45475a" stroke-width="1.5"/>${scanLines}<circle cx="45" cy="20" r="5" fill="#89b4fa"/><path d="m11 40 6 5-6 5" fill="none" stroke="#cba6f7" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round"/><path d="M20 51h9" fill="none" stroke="#89b4fa" stroke-width="3.5" stroke-linecap="round"/></svg>`;
}

const libraryDirectory = (configPath: string): string => join(dirname(configPath), 'instance-icons');

// list the built-in terminal, then each named artwork file in the library
export async function listInstanceIcons(configPath: string | undefined = process.env.RAC_CONFIG): Promise<InstanceIcon[]> {
  if (configPath === undefined) return ['terminal'];
  try {
    const entries = await readdir(libraryDirectory(configPath), { withFileTypes: true });
    const names = entries.filter(entry => entry.isFile() && entry.name.endsWith('.svg')).map(entry => entry.name.slice(0, -4)).filter(name => name !== 'terminal' && isInstanceIcon(name));
    return ['terminal', ...names.sort()];
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('icon library unavailable', { cause: error });
    return ['terminal'];
  }
}

// load trusted server-local artwork beside the configuration
export async function loadInstanceIconSvg(icon: InstanceIcon = 'terminal', configPath: string | undefined = process.env.RAC_CONFIG): Promise<string> {
  // keep the terminal fallback independent of local files
  if (icon === 'terminal' || !isInstanceIcon(icon) || configPath === undefined) return instanceIconSvg();
  try {
    return await readFile(join(libraryDirectory(configPath), `${icon}.svg`), 'utf8');
  } catch (error) {
    // preserve diagnostics without exposing local paths
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('icon unavailable', { cause: error });
    return instanceIconSvg();
  }
}
