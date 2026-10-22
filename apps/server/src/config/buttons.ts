import { z } from 'zod';

export const buttonColors = [
  'rosewater', 'flamingo', 'pink', 'mauve', 'red', 'maroon', 'peach',
  'yellow', 'green', 'teal', 'sky', 'sapphire', 'blue', 'lavender'
] as const;

export const buttonSplitNames = ['agent', 'terminal', 'note', 'browser', 'files', 'code', 'review', 'stack', 'settings'] as const;
export const buttonSlotNames = ['tabLead', 'leftNav', 'rightNav', 'navMenu', 'pullRequest', ...buttonSplitNames.map(name => `split:${name}` as const)] as const;

export type ButtonColor = typeof buttonColors[number];
export type ButtonSplit = typeof buttonSplitNames[number];
export type ButtonSlot = typeof buttonSlotNames[number];
type DirectButtonSlot = Exclude<ButtonSlot, `split:${string}`>;
export type ConfiguredButton = {
  text: string;
  icon?: string;
  color: ButtonColor;
  style: 'outline' | 'solid';
  action: { shellCommand: string } | { agentPrompt: string };
};
export type ButtonSlots = {
  tabLead: ConfiguredButton[];
  leftNav: ConfiguredButton[];
  rightNav: ConfiguredButton[];
  navMenu: ConfiguredButton[];
  pullRequest: ConfiguredButton[];
  splits: Record<ButtonSplit, ConfiguredButton[]>;
};
export type ProjectButtons = Partial<Omit<ButtonSlots, 'splits'>> & { splits?: Partial<Record<ButtonSplit, ConfiguredButton[]>> };

export const pushButtonIcon = 'M12 16V4m0 0-5 5m5-5 5 5M5 14v5h14v-5';

export const defaultButtons: ButtonSlots = {
  tabLead: [],
  leftNav: [],
  rightNav: [],
  navMenu: [],
  pullRequest: [
    { text: 'Commit/Push', icon: pushButtonIcon, color: 'mauve', style: 'solid', action: { agentPrompt: 'review, commit, and push' } },
    { text: '$fixup', color: 'mauve', style: 'outline', action: { agentPrompt: '$fixup' } }
  ],
  splits: { agent: [], terminal: [], note: [], browser: [], files: [], code: [], review: [], stack: [], settings: [] }
};

const preservedAction = z.string().max(32_000).refine(value => Buffer.byteLength(value, 'utf8') <= 32_000, 'action must be at most 32000 UTF-8 bytes').refine(value => !value.includes('\0'), 'NUL is forbidden').refine(value => value.trim().length > 0, 'action cannot be blank');
const buttonIcon = z.string().max(4_096).refine(value => !/[\u0000-\u001f\u007f<>]/u.test(value), 'icon must be SVG path data without markup or control characters').refine(value => !/(?:^[a-z][a-z0-9+.-]*:|:\/\/)/iu.test(value.trim()), 'icon must be SVG path data, not a URL');
const buttonAction = z.union([
  z.object({ shellCommand: preservedAction }).strict(),
  z.object({ agentPrompt: preservedAction }).strict()
]);
const configuredButtonSchema = z.object({
  text: z.string().trim().min(1).max(128),
  icon: buttonIcon.optional(),
  color: z.enum(buttonColors),
  style: z.enum(['outline', 'solid']),
  action: buttonAction
}).strict();

// reject ambiguous text identities inside one authored slot
const buttonList = z.array(configuredButtonSchema).max(64).superRefine((buttons, context) => {
  const seen = new Set<string>();
  // compare the normalized text used by project replacement
  for (let index = 0; index < buttons.length; index += 1) {
    const text = buttons[index]!.text;
    if (seen.has(text)) context.addIssue({ code: z.ZodIssueCode.custom, path: [index, 'text'], message: `duplicate button text \`${text}\`` });
    seen.add(text);
  }
});

const applicationSplitsSchema = z.object(Object.fromEntries(buttonSplitNames.map(name => [name, buttonList.default([])])) as Record<ButtonSplit, z.ZodDefault<typeof buttonList>>).strict().default({});
const projectSplitsSchema = z.object(Object.fromEntries(buttonSplitNames.map(name => [name, buttonList.optional()])) as Record<ButtonSplit, z.ZodOptional<typeof buttonList>>).strict();

export const applicationButtonsSchema = z.object({
  tabLead: buttonList.default([]),
  leftNav: buttonList.default([]),
  rightNav: buttonList.default([]),
  navMenu: buttonList.default([]),
  pullRequest: buttonList.default(defaultButtons.pullRequest),
  splits: applicationSplitsSchema
}).strict().default(defaultButtons);

export const projectButtonsSchema = z.object({
  tabLead: buttonList.optional(),
  leftNav: buttonList.optional(),
  rightNav: buttonList.optional(),
  navMenu: buttonList.optional(),
  pullRequest: buttonList.optional(),
  splits: projectSplitsSchema.optional()
}).strict();

// clone one configured button so effective layouts never mutate source config
const cloneButton = (button: ConfiguredButton): ConfiguredButton => structuredClone(button);

// merge one project list by exact normalized text
function mergeButtonList(application: readonly ConfiguredButton[], project: readonly ConfiguredButton[] | undefined): ConfiguredButton[] {
  const merged = application.map(cloneButton);
  // replace inherited positions and append new project buttons in authored order
  for (const button of project ?? []) {
    const index = merged.findIndex(candidate => candidate.text === button.text);
    if (index === -1) merged.push(cloneButton(button));
    else merged[index] = cloneButton(button);
  }
  return merged;
}

// resolve all effective lists without interpreting an empty project list as hiding
export function effectiveButtons(application: ButtonSlots, project?: ProjectButtons): ButtonSlots {
  const splits = Object.fromEntries(buttonSplitNames.map(name => [name, mergeButtonList(application.splits[name], project?.splits?.[name])])) as Record<ButtonSplit, ConfiguredButton[]>;
  return {
    tabLead: mergeButtonList(application.tabLead, project?.tabLead),
    leftNav: mergeButtonList(application.leftNav, project?.leftNav),
    rightNav: mergeButtonList(application.rightNav, project?.rightNav),
    navMenu: mergeButtonList(application.navMenu, project?.navMenu),
    pullRequest: mergeButtonList(application.pullRequest, project?.pullRequest),
    splits
  };
}

// address one flattened slot name
export function buttonsForSlot(tree: ButtonSlots | ProjectButtons | undefined, slot: ButtonSlot): ConfiguredButton[] {
  if (tree === undefined) return [];
  if (!slot.startsWith('split:')) return tree[slot as DirectButtonSlot] ?? [];
  return tree.splits?.[slot.slice('split:'.length) as ButtonSplit] ?? [];
}

// bound every presentation materialized in the application and project catalogs
export function countButtonDefinitions(application: ButtonSlots, projects: readonly (ProjectButtons | undefined)[]): number {
  let count = buttonSlotNames.reduce((total, slot) => total + buttonsForSlot(application, slot).length, 0);
  // inherited definitions are repeated in each effective project catalog
  for (const project of projects) {
    // matching text replaces a presentation rather than adding another
    for (const slot of buttonSlotNames) {
      count += new Set([...buttonsForSlot(application, slot), ...buttonsForSlot(project, slot)].map(button => button.text)).size;
    }
  }
  return count;
}
