import { z } from 'zod';
import type { SettingsSchema } from './contracts.js';
import { keyActions } from '../config/keys.js';
import { appApply, composeOptionSettings, protectedPath } from './catalog.js';
import { sourceSchema } from '../config/schema.js';
import { builtInTourPrompt } from '../review-runs/config.js';

type ApplicationSettingsPresentation = { scratchDirectory?: string };

// pair one concrete fallback with its authoritative source
const sourcedPlaceholder = (value: string | number | boolean, source: string): string => `${value === '' ? 'Empty' : String(value)} (from ${source})`;

// describe the dependency-free keyboard parser's exact existing vocabulary
export function keyboardSettingsSchema(): SettingsSchema { return { type: 'record', optional: true, label: 'Key tables', items: { type: 'record', label: 'Bindings', items: { type: 'union', nullable: true, variants: [{ type: 'enum', options: Object.keys(keyActions), label: 'Built-in action' }, { type: 'object', label: 'Switch table', properties: { table: { type: 'string' } } }, { type: 'object', label: 'Terminal command', properties: { terminal: { type: 'string', editor: 'shell', singleLine: true }, reuse: { type: 'boolean', optional: true, default: false } } }] } } }; }
// attach protection and apply semantics without creating new validation rules
export function applicationSettingsSchema(presentation: ApplicationSettingsPresentation = {}): SettingsSchema {
  const schema = settingsSchema(sourceSchema);
  schema.properties!.keys = keyboardSettingsSchema();
  // keep legacy source compatibility without publishing an obsolete control
  delete schema.properties!.integrations!.properties!.multiInstance;
  // capitalize product acronyms only in presentation metadata
  schema.properties!.integrations!.properties!.mcp!.label = 'MCP';
  schema.properties!.adapters!.properties!.omx!.label = 'OMX';
  // present safe calendar policy separately from inbound tools
  const calendar = schema.properties?.googleCalendar;
  if (calendar?.properties !== undefined) {
    calendar.label = 'Google Calendar';
    Object.assign(calendar.properties.enabled!, { label: 'Enable Google Calendar', description: 'Capture new RAC agent prompts after saving and restarting RAC.' });
    Object.assign(calendar.properties.titleTemplate!, { label: 'Event title', description: 'Use {worktree}, {project}, or {agent}. Escape literal braces with {{ and }}.' });
    Object.assign(calendar.properties.startMoment!, { label: 'Event start', description: 'Submission includes queue waiting; working starts only with verified agent work.' });
    Object.assign(calendar.properties.endMoment!, { label: 'Event end', description: 'First question otherwise uses the confirmed finish; continuing the prompt does not create another event.' });
  }
  describeApplicationPlaceholders(schema, presentation);
  describeApplicationCommands(schema);
  describeButtonSettings(schema);
  describeProjectSettings(schema);
  // annotate each declared object and collection control
  const visit = (node: SettingsSchema, path: string[]): void => {
    node.protected = node.protected === true || protectedPath(path); node.apply = appApply(path);
    // remove defaults before protected metadata crosses the API boundary
    if (node.protected) {
      delete node.default;
      // remove only generated scalar guidance
      if (node.placeholder?.endsWith(' (from built-in default)') === true) delete node.placeholder;
    }
    if (node.properties !== undefined) for (const [key, child] of Object.entries(node.properties)) visit(child, [...path, key]);
    if (node.items !== undefined) visit(node.items, [...path, node.type === 'array' ? '0' : '*']);
    if (node.variants !== undefined) for (const child of node.variants) visit(child, path);
  };
  visit(schema, []); return schema;
}

// label ordered button slots and their disjoint action editors
function describeButtonSettings(schema: SettingsSchema): void {
  const labelLists = (buttons: SettingsSchema | undefined, project: boolean): void => {
    if (buttons?.properties === undefined) return;
    buttons.label = project ? 'Button overrides' : 'Buttons';
    buttons.description = project
      ? 'Replace application buttons with the same text or append new buttons. Empty lists inherit application buttons.'
      : 'Ordered configurable actions shown throughout the application.';
    if (project) buttons.default = {};
    const labels: Record<string, string> = { tabLead: 'Left of tabs', leftNav: 'Left navigation', rightNav: 'Right navigation', navMenu: 'Navigation menu', pullRequest: 'Pull request' };
    // annotate every direct slot
    for (const [key, label] of Object.entries(labels)) {
      const list = buttons.properties[key];
      if (list === undefined) continue;
      Object.assign(list, { label, default: [] });
      describeButtonList(list);
    }
    const splits = buttons.properties.splits;
    if (splits?.properties === undefined) return;
    Object.assign(splits, { label: 'Panel buttons', default: {} });
    // annotate every split-kind slot
    for (const [key, list] of Object.entries(splits.properties)) {
      Object.assign(list, { label: `${key[0]!.toUpperCase()}${key.slice(1)}`, default: [] });
      describeButtonList(list);
    }
  };
  labelLists(schema.properties?.buttons, false);
  labelLists(schema.properties?.projects?.items?.properties?.buttons, true);
}

// describe one ordered configured-button list
function describeButtonList(list: SettingsSchema): void {
  const button = list.items;
  if (button?.properties === undefined) return;
  button.label = 'Button';
  Object.assign(button.properties.text!, { label: 'Button text' });
  Object.assign(button.properties.icon!, { label: 'Button icon path', description: 'Optional SVG path data using the existing icon style. Leave blank for no icon.', placeholder: 'No icon' });
  Object.assign(button.properties.color!, { label: 'Button color' });
  Object.assign(button.properties.style!, { label: 'Button style' });
  const action = button.properties.action;
  if (action?.variants === undefined) return;
  // label both exclusive action variants
  for (const variant of action.variants) {
    const shell = variant.properties?.shellCommand;
    const prompt = variant.properties?.agentPrompt;
    if (shell !== undefined) Object.assign(variant, { label: 'Shell command' }, { properties: { ...variant.properties, shellCommand: { ...shell, label: 'Shell command', editor: 'shell' as const } } });
    if (prompt !== undefined) Object.assign(variant, { label: 'Agent prompt' }, { properties: { ...variant.properties, agentPrompt: { ...prompt, label: 'Agent prompt', description: 'Codex and OMX stay loading until the prompt finishes. Claude stays loading until the prompt is submitted.', multiline: true } } });
  }
}

// mark application-level shell command controls
function describeApplicationCommands(schema: SettingsSchema): void {
  Object.assign(schema.properties!.editor!, { editor: 'shell' as const, singleLine: true });
  const adapters = schema.properties!.adapters!.properties!;
  // annotate every supported adapter's lifecycle and update commands
  for (const adapter of Object.values(adapters)) {
    Object.assign(adapter.properties!.args!, { default: [] });
    Object.assign(adapter.properties!.env!, { label: 'Environment & keys' });
    Object.assign(adapter.properties!.setup!, { editor: 'shell' as const, default: '', placeholder: 'Disabled (when blank)' });
    Object.assign(adapter.properties!.teardown!, { editor: 'shell' as const, default: '', placeholder: 'Disabled (when blank)' });
    Object.assign(adapter.properties!.updates!, {
      default: {},
      description: 'Set all three commands to enable agent updates. Leave all three blank to disable updates.'
    });
    const updates = adapter.properties!.updates!.properties!;
    Object.assign(updates.current!, { label: 'Get current version command', editor: 'shell' as const });
    Object.assign(updates.latest!, { label: 'Get latest version command', editor: 'shell' as const });
    Object.assign(updates.run!, { label: 'Update command', editor: 'shell' as const });
  }
}

// attach omission guidance without changing parsed defaults
function describeApplicationPlaceholders(schema: SettingsSchema, presentation: ApplicationSettingsPresentation): void {
  const application = schema.properties!;
  application.listen!.properties!.host!.placeholder = sourcedPlaceholder('127.0.0.1', 'built-in default');
  application.listen!.properties!.port!.placeholder = sourcedPlaceholder(8787, 'built-in default');
  application.scratchDirectory!.placeholder = presentation.scratchDirectory === undefined
    ? 'Unavailable (from host home)'
    : sourcedPlaceholder(presentation.scratchDirectory, 'host home');
  application.editor!.placeholder = 'Disabled when unset';
  application.publicOrigin!.placeholder = 'Required; no default';
  const project = application.projects!.items!.properties!;
  project.id!.placeholder = 'Required here; omit the key in the source to derive it';
  project.path!.placeholder = 'Required; no default';
  project.externalUrl!.placeholder = 'No preview when unset';
  project.newTask!.placeholder = 'No New Task action when unset';
  const review = application.review!.properties!;
  // name the dedicated review page without changing its optional source contract
  application.review!.label = 'Reviews';
  review.agents!.label = 'Review agents';
  review.agents!.properties!.codex!.label = 'Codex';
  review.agents!.properties!.claude!.label = 'Claude';
  review.tour!.label = 'Review tour';
  review.presets!.label = 'Review presets';
  review.presets!.items!.label = 'Review preset';
  review.presets!.description = 'When no custom presets are configured, the built-in Correctness preset is used. Custom presets replace the built-in list.';
  review.defaultPreset!.label = 'Default preset';
  const tour = review.tour!.properties!;
  tour.model!.placeholder = 'Not specified (from agent default)';
  tour.effort!.placeholder = 'Not specified (from agent default)';
  tour.prompt!.placeholder = sourcedPlaceholder(builtInTourPrompt, 'built-in Review Tour prompt');
  review.presets!.placeholder = sourcedPlaceholder('Correctness', 'built-in Review preset');
  const preset = review.presets!.items!.properties!;
  preset.model!.placeholder = 'Not specified (from agent default)';
  preset.effort!.placeholder = 'Not specified (from agent default)';
  review.defaultPreset!.placeholder = sourcedPlaceholder('correctness', 'first Review preset');
}

// attach descriptions to the declared project command controls
function describeProjectCommands(commands: SettingsSchema | undefined, context: 'project' | 'override'): void {
  if (commands === undefined) return;
  commands.description = context === 'project'
    ? 'Trusted shell commands shared by this Project’s Worktrees.'
    : 'Complete command set for this checkout. An explicit empty object disables inherited controls.';
  const descriptions: Record<string, string> = {
    start: 'Trusted one-shot shell command used to start this stack.',
    stop: 'Trusted one-shot shell command used to stop this stack.',
    build: 'Trusted one-shot shell command used to build this stack.',
    restart: 'Trusted one-shot shell command used to restart this stack.',
    migrate: 'Trusted one-shot shell command used to migrate this stack.',
    status: 'Quick daemon-style health probe; exit 0 means running. Not available with Processes.',
    setup: 'Trusted shell command run once after RAC creates a Worktree and before launching an agent.',
    processes: 'Named foreground processes supervised in tmux. They derive Start, Stop, Restart, and running state, so those commands and Status must be blank.'
  };
  // describe every declared command field
  for (const [key, description] of Object.entries(descriptions)) {
    const field = commands.properties?.[key];
    if (field !== undefined) field.description = description;
  }
  // mark only executable stack command leaves
  for (const key of ['start', 'stop', 'build', 'restart', 'migrate', 'status', 'setup']) commands.properties![key]!.editor = 'shell';
  const process = commands.properties?.processes?.items;
  if (process === undefined) return;
  process.description = 'One named foreground process, declared as a shell command or as a command with startup dependencies.';
  // describe both supported process declaration forms
  for (const variant of process.variants ?? []) {
    variant.description = variant.type === 'object'
      ? 'Foreground process command plus optional startup dependencies.'
      : 'Trusted foreground shell command for this process.';
    // mark the scalar process command directly
    if (variant.type === 'string') variant.editor = 'shell';
    if (variant.type !== 'object') continue;
    if (variant.properties?.command !== undefined) Object.assign(variant.properties.command, { description: 'Trusted foreground shell command for this process.', editor: 'shell' as const });
    // describe both the dependency list and each name
    if (variant.properties?.dependsOn !== undefined) {
      variant.properties.dependsOn.description = 'Processes that must start first. Names must exist in this map; dependencies cannot cycle.';
      if (variant.properties.dependsOn.items !== undefined) variant.properties.dependsOn.items.description = 'Name of one declared process that must start first.';
    }
  }
}

// attach presentation copy without changing project validation
function describeProjectSettings(schema: SettingsSchema): void {
  const projects = schema.properties?.projects;
  const project = projects?.items;
  if (projects === undefined || project?.properties === undefined) return;
  projects.description = 'Repositories and directories RAC exposes as Projects and discovers Worktrees for.';
  project.description = 'One repository, bare repository, or plain directory managed as a Project.';
  // keep proxy fields available only through raw source editing
  delete project.properties.hostname;
  delete project.properties.port;
  const descriptions: Record<string, string> = {
    id: 'Stable Project key used for saved state and Worktree IDs. Use 1–80 letters, numbers, underscores, or dashes. Omit the key in the source to use the id derived from the repository, which an unconfigured repository already has.',
    label: 'Display name for this Project.',
    defaultBranch: 'Comparison branch for Worktree changes.',
    path: 'Path to any checkout, bare repository, or plain directory to manage. Missing paths load unavailable; non-Git directories launch in place.',
    hostPath: 'Host path for the Main checkout when RAC runs in Docker.',
    worktreeOrder: 'Checkout paths to show first, in this order. Relative paths resolve from the Project path.',
    worktreeOverrides: 'Per-checkout commands and preview settings. Entries select discovered checkouts; they do not create Worktrees.',
    worktreesDirectory: 'Directory where RAC creates Worktrees. Relative paths resolve from the Main checkout.',
    externalUrl: 'Existing HTTPS origin to open directly.',
    commands: 'Trusted shell commands shared by this Project’s Worktrees.',
    newTask: 'Trusted shell command for New Task. It is available only for clean, pushed Worktrees; {taskId} inserts a random task ID.',
    buttons: 'Replace application buttons with the same text or append new buttons. Empty lists inherit application buttons.'
  };
  // describe every declared project field
  for (const [key, description] of Object.entries(descriptions)) {
    const field = project.properties[key];
    if (field !== undefined) field.description = description;
  }
  Object.assign(project.properties.label!, { placeholder: 'Unavailable (from Project ID, else the folder name)' });
  Object.assign(project.properties.defaultBranch!, { placeholder: 'Unavailable (from resolved branch)' });
  Object.assign(project.properties.hostPath!, { placeholder: 'Unavailable (from Project Path)' });
  Object.assign(project.properties.worktreeOrder!, { placeholder: 'Unavailable (from discovered Worktree order)' });
  Object.assign(project.properties.worktreesDirectory!, { placeholder: 'Unavailable (from resolved Worktrees directory)' });
  project.properties.newTask!.editor = 'shell';
  // legacy push is migrated into generic buttons and has no Settings control
  delete project.properties.push;
  describeProjectCommands(project.properties.commands, 'project');
  // describe each preferred checkout path
  if (project.properties.worktreeOrder?.items !== undefined) project.properties.worktreeOrder.items.description = 'One checkout path to place ahead of unlisted Worktrees.';
  const override = project.properties.worktreeOverrides?.items;
  if (override?.properties !== undefined) {
    override.description = 'Settings for one discovered checkout selected by its path.';
    override.properties.path!.description = 'Checkout to override. Relative paths resolve from the Project path; each resolved checkout can appear once.';
    Object.assign(override.properties.externalUrl!, { description: 'Direct HTTPS preview for this checkout. Set null to disable preview.', placeholder: 'No preview when unset' });
    // keep proxy fields available only through raw source editing
    delete override.properties.hostname;
    delete override.properties.port;
    describeProjectCommands(override.properties.commands, 'override');
  }
}

// add editor defaults without changing parsed source bytes
export function installationSettingsPresentationSchema(input: z.ZodTypeAny, hostCheckout?: string): SettingsSchema {
  const schema = settingsSchema(input);
  const checkout = schema.properties?.host?.properties?.checkout;
  // describe the installed value only when the expected host block exists
  if (checkout !== undefined) checkout.placeholder = hostCheckout === undefined
    ? 'Unavailable (from installed checkout)'
    : sourcedPlaceholder(hostCheckout, 'installed checkout');
  const options = schema.properties?.compose?.properties?.options;
  // keep the permanent option controls visible for sparse installation files
  if (options?.properties?.parallel !== undefined && options.properties.compatibility !== undefined) {
    options.default = {};
    Object.assign(options.properties.parallel, composeOptionSettings.parallel);
    Object.assign(options.properties.compatibility, composeOptionSettings.compatibility);
  }
  return schema;
}

// describe existing validators without duplicating their rules
export function settingsSchema(input: z.ZodTypeAny): SettingsSchema {
  const definition = input._def;
  // retain wrapper semantics while describing the underlying type
  if (input instanceof z.ZodOptional || input instanceof z.ZodNullable || input instanceof z.ZodDefault || input instanceof z.ZodEffects) {
    const inner = input instanceof z.ZodEffects ? input.innerType() : definition.innerType as z.ZodTypeAny;
    const result = settingsSchema(inner);
    // expose default controls from code-defined values only
    if (input instanceof z.ZodDefault) {
      const defaultValue = definition.defaultValue();
      result.default = defaultValue;
      // expose concrete scalar defaults without turning them into authored values
      if (typeof defaultValue === 'string' || typeof defaultValue === 'number' || typeof defaultValue === 'boolean') result.placeholder = sourcedPlaceholder(defaultValue, 'built-in default');
    }
    // preserve optional and inherited settings
    if (input instanceof z.ZodOptional || input instanceof z.ZodDefault) result.optional = true;
    // keep explicit preview disablement
    if (input instanceof z.ZodNullable) result.nullable = true;
    return result;
  }
  // describe each strict object property
  if (input instanceof z.ZodObject) return { type: 'object', properties: Object.fromEntries(Object.entries(input.shape as Record<string, z.ZodTypeAny>).map(([key, child]) => [key, settingsSchema(child)])) };
  // preserve collection and dictionary controls
  if (input instanceof z.ZodArray) return { type: 'array', items: settingsSchema(input.element) };
  if (input instanceof z.ZodRecord) return { type: 'record', items: settingsSchema(input.valueSchema) };
  if (input instanceof z.ZodEnum) return { type: 'enum', options: input.options };
  if (input instanceof z.ZodUnion) return { type: 'union', variants: input.options.map(settingsSchema) };
  if (input instanceof z.ZodString) return { type: 'string' };
  if (input instanceof z.ZodNumber) return { type: 'number' };
  if (input instanceof z.ZodBoolean) return { type: 'boolean' };
  return { type: 'json' };
}
