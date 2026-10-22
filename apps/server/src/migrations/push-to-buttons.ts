import { defaultButtons, pushButtonIcon, type ButtonSlots, type ConfiguredButton, type ProjectButtons } from '../config/buttons.js';

type Json = Record<string, unknown>;
const defaultPush = { label: 'Commit/Push', prompt: 'review, commit, and push' } as const;
const isObject = (value: unknown): value is Json => value !== null && typeof value === 'object' && !Array.isArray(value);

export type PushToButtonsPlan = {
  newConfig: Json;
  migratedProjects: number;
  materializedDefaults: boolean;
  errors: string[];
};

// detect the independent push-to-buttons migration stage
export function needsPushToButtonsMigration(raw: unknown): boolean {
  if (!isObject(raw)) return false;
  if (!Object.hasOwn(raw, 'buttons')) return true;
  const projects = Array.isArray(raw.projects) ? raw.projects : [];
  return projects.some(project => isObject(project) && Object.hasOwn(project, 'push'));
}

// convert one valid legacy action without changing its prompt bytes
function legacyButton(label: string, prompt: string): ConfiguredButton {
  if (label === '$fixup') return { text: label, color: 'mauve', style: 'outline', action: { agentPrompt: prompt } };
  return { text: label, icon: pushButtonIcon, color: 'mauve', style: 'solid', action: { agentPrompt: prompt } };
}

// validate one legacy pair against the old contract plus the new nonblank rule
function readLegacyPush(value: unknown, path: string, errors: string[]): { label: string; prompt: string } | undefined {
  if (!isObject(value)) { errors.push(`${path} must be an object`); return undefined; }
  const unknown = Object.keys(value).filter(key => key !== 'label' && key !== 'prompt');
  if (unknown.length > 0) errors.push(`${path}.${unknown[0]} is not recognized`);
  const label = typeof value.label === 'string' ? value.label.trim() : undefined;
  const prompt = typeof value.prompt === 'string' ? value.prompt : undefined;
  if (label === undefined || label.length < 1 || label.length > 80) errors.push(`${path}.label must be a nonblank string of at most 80 characters`);
  if (prompt === undefined || prompt.length < 1 || prompt.length > 32_000 || prompt.includes('\0')) errors.push(`${path}.prompt must be a NUL-free string of at most 32000 characters`);
  else if (prompt.trim().length === 0) errors.push(`${path}.prompt cannot be blank`);
  return label === undefined || label.length < 1 || label.length > 80 || prompt === undefined || prompt.length < 1 || prompt.length > 32_000 || prompt.includes('\0') || prompt.trim().length === 0
    ? undefined
    : { label, prompt };
}

// lift a shared legacy label so project actions replace rather than duplicate it
function applicationDefaultsFor(projects: unknown[]): ButtonSlots {
  const buttons = structuredClone(defaultButtons);
  const labels = projects.map(project => {
    // leave malformed projects to the existing validation boundary
    if (!isObject(project)) return undefined;
    // implicit legacy buttons retain their built-in identity
    if (!Object.hasOwn(project, 'push')) return defaultPush.label;
    const push = project.push;
    return isObject(push) && typeof push.label === 'string' ? push.label.trim() : undefined;
  });
  const sharedLabel = labels[0];
  // distinct labels and the existing fixup identity cannot share one application push
  if (sharedLabel !== undefined && sharedLabel.length > 0 && sharedLabel.length <= 80 && sharedLabel !== '$fixup' && labels.every(label => label === sharedLabel)) buttons.pullRequest[0]!.text = sharedLabel;
  return buttons;
}

// preserve key order while replacing one legacy project field
function migrateProject(value: unknown, index: number, errors: string[], applicationPushLabel: string): { value: unknown; migrated: boolean } {
  if (!isObject(value) || !Object.hasOwn(value, 'push')) return { value, migrated: false };
  const path = `projects.${index}.push`;
  if (Object.hasOwn(value, 'buttons')) {
    errors.push(`${path} cannot be combined with projects.${index}.buttons`);
    return { value, migrated: false };
  }
  const push = readLegacyPush(value.push, path, errors);
  const out: Json = {};
  // remove push only after it has a valid equivalent
  for (const [key, child] of Object.entries(value)) {
    if (key !== 'push') out[key] = child;
    else if (push !== undefined && (push.label !== applicationPushLabel || push.prompt !== defaultPush.prompt)) {
      const buttons: ProjectButtons = { pullRequest: [legacyButton(push.label, push.prompt)] };
      out.buttons = buttons;
    }
  }
  return push === undefined ? { value, migrated: false } : { value: out, migrated: true };
}

// materialize application defaults and translate every project action in one pure pass
export function planPushToButtonsMigration(raw: unknown): PushToButtonsPlan {
  const errors: string[] = [];
  if (!isObject(raw)) return { newConfig: {}, migratedProjects: 0, materializedDefaults: false, errors: ['configuration is not a JSON object'] };
  const projects = Array.isArray(raw.projects) ? raw.projects : [];
  const applicationDefaults = applicationDefaultsFor(projects);
  const hasLegacyPush = projects.some(project => isObject(project) && Object.hasOwn(project, 'push'));
  if (Object.hasOwn(raw, 'buttons') && hasLegacyPush) errors.push('configuration declares both `buttons` and legacy `projects[].push`; migrate one representation only');
  let migratedProjects = 0;
  const migrated = projects.map((project, index) => {
    const result = migrateProject(project, index, errors, applicationDefaults.pullRequest[0]!.text);
    if (result.migrated) migratedProjects += 1;
    return result.value;
  });
  const materializedDefaults = !Object.hasOwn(raw, 'buttons');
  const out: Json = {};
  let placedButtons = false;
  // retain source order and place root buttons beside projects
  for (const [key, value] of Object.entries(raw)) {
    if (key === 'buttons') { out.buttons = value; placedButtons = true; continue; }
    if (key === 'projects') {
      if (!placedButtons) { out.buttons = structuredClone(applicationDefaults); placedButtons = true; }
      // preserve malformed source values for final validation rather than discarding them
      out.projects = Array.isArray(value) ? migrated : value;
      continue;
    }
    out[key] = value;
  }
  if (!placedButtons) out.buttons = structuredClone(applicationDefaults);
  return { newConfig: out, migratedProjects, materializedDefaults, errors };
}
