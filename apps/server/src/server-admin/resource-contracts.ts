import { isResourceUsage, type ResourceUsage } from '../domain/resource-usage.js';

export type { ResourceDisk, ResourceUsage } from '../domain/resource-usage.js';

// one on-demand server sample, with WSL kept separate from its Windows host
export type ResourceSnapshot = {
  sampledAt: string;
  host: ResourceUsage | null;
  wsl?: ResourceUsage;
  errors?: string[];
};

// recognize one plain JSON object
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);

// validate the complete API response before publishing or rendering it
export const isResourceSnapshot = (value: unknown): value is ResourceSnapshot => {
  // require a parseable timestamp and host boundary
  if (!object(value) || typeof value.sampledAt !== 'string' || Number.isNaN(Date.parse(value.sampledAt))) return false;
  // retain explicit host unavailability
  if (value.host !== null && !isResourceUsage(value.host)) return false;
  // validate the optional WSL boundary
  if (value.wsl !== undefined && !isResourceUsage(value.wsl)) return false;
  // validate human-readable sampling errors
  if (value.errors !== undefined && (!Array.isArray(value.errors) || !value.errors.every(error => typeof error === 'string'))) return false;
  return true;
};
