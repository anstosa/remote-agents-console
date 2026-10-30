import { rename } from 'node:fs/promises';

/**
 * Keep a store's file that does not parse aside, as `<file>.corrupt-<ms>`, so the store can start
 * empty without its next write replacing what the file held, and say so in the log.
 */
export async function setAside(file: string, store: string): Promise<void> {
  const aside = `${file}.corrupt-${Date.now()}`;
  try {
    await rename(file, aside);
    console.warn(`[${store}] ${file} is not valid: kept it as ${aside}, and starting with none`);
  } catch (error) {
    console.warn(`[${store}] ${file} is not valid, and could not be kept aside (${error instanceof Error ? error.message : String(error)}): starting with none`);
  }
}
