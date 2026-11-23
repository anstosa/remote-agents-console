const exactUpdateAdvisorLabel = /^Update Advisor (?:Starting )?v5 [0-9a-f]{40}$/u;
const legacyUpdateAdvisorLabel = /^Update Advisor (?:(?:Starting v4|v[234]) )?[0-9a-f]{7}$/u;

// create one writable server-owned advisor identity
export const updateAdvisorLabel = (targetSha: string): string => `Update Advisor v5 ${targetSha}`;

// identify one advisor until its initial prompt is scheduled
export const updateAdvisorPendingLabel = (targetSha: string): string => `Update Advisor Starting v5 ${targetSha}`;

// recognize current and cleanup-only legacy advisor identities
export const isUpdateAdvisorLabel = (label: string | undefined): boolean => label !== undefined && (exactUpdateAdvisorLabel.test(label) || legacyUpdateAdvisorLabel.test(label));

// match only panes pinned to the full reviewed target
export const isUpdateAdvisorForTarget = (label: string | undefined, targetSha: string): boolean => label === updateAdvisorLabel(targetSha)
  || label === updateAdvisorPendingLabel(targetSha);

// match a legacy prefix for retention or cleanup but never reuse
export const isLegacyUpdateAdvisorForTarget = (label: string | undefined, targetSha: string): boolean => label !== undefined
  && legacyUpdateAdvisorLabel.test(label) && label.endsWith(targetSha.slice(0, 7));
