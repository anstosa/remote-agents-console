import { z } from 'zod';
import type { SettingsSchema } from './contracts.js';
import { keyActions } from '../config/keys.js';
import { appApply, composeOptionSettings, protectedPath } from './catalog.js';
import { sourceSchema } from '../config/schema.js';

// describe the dependency-free keyboard parser's exact existing vocabulary
export function keyboardSettingsSchema(): SettingsSchema { return { type: 'record', optional: true, label: 'Key tables', items: { type: 'record', label: 'Bindings', items: { type: 'union', nullable: true, variants: [{ type: 'enum', options: Object.keys(keyActions), label: 'Built-in action' }, { type: 'object', label: 'Switch table', properties: { table: { type: 'string' } } }, { type: 'object', label: 'Terminal command', properties: { terminal: { type: 'string' }, reuse: { type: 'boolean', optional: true, default: false } } }] } } }; }
// attach protection and apply semantics without creating new validation rules
export function applicationSettingsSchema(): SettingsSchema {
  const schema = settingsSchema(sourceSchema);
  schema.properties!.keys = keyboardSettingsSchema();
  describeProjectSettings(schema);
  // annotate each declared object and collection control
  const visit = (node: SettingsSchema, path: string[]): void => {
    node.protected = node.protected === true || protectedPath(path); node.apply = appApply(path);
    if (node.protected) delete node.default;
    if (node.properties !== undefined) for (const [key, child] of Object.entries(node.properties)) visit(child, [...path, key]);
    if (node.items !== undefined) visit(node.items, [...path, node.type === 'array' ? '0' : '*']);
    if (node.variants !== undefined) for (const child of node.variants) visit(child, path);
  };
  visit(schema, []); return schema;
}

// attach descriptions to the declared project command controls
function describeProjectCommands(commands: SettingsSchema | undefined, context: 'project' | 'override'): void {
  if (commands === undefined) return;
  commands.description = context === 'project'
    ? 'Default trusted shell commands for this Project’s Worktrees.'
    : 'Complete command set for this checkout. Blank inherits Project commands; an explicit empty object disables inherited controls.';
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
  const process = commands.properties?.processes?.items;
  if (process === undefined) return;
  process.description = 'One named foreground process, declared as a shell command or as a command with startup dependencies.';
  // describe both supported process declaration forms
  for (const variant of process.variants ?? []) {
    variant.description = variant.type === 'object'
      ? 'Foreground process command plus optional startup dependencies.'
      : 'Trusted foreground shell command for this process.';
    if (variant.type !== 'object') continue;
    if (variant.properties?.command !== undefined) variant.properties.command.description = 'Trusted foreground shell command for this process.';
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
  const descriptions: Record<string, string> = {
    id: 'Stable Project key used for saved state and Worktree IDs. Use 1–80 letters, numbers, underscores, or dashes.',
    label: 'Display name for this Project. Leave blank to use the Project ID.',
    defaultBranch: 'Fallback comparison branch used when RAC cannot discover a pull-request base or branch-creation source. Leave blank to fall back to main.',
    path: 'Path to any checkout, bare repository, or plain directory to manage. Missing paths load unavailable; non-Git directories launch in place.',
    hostPath: 'Host path for the Main checkout when RAC runs in Docker. Leave blank when the host and RAC use the same path.',
    worktreeOrder: 'Checkout paths to show first, in this order. Relative paths resolve from the Project path; unlisted Worktrees keep the default order.',
    worktreeOverrides: 'Per-checkout commands and preview settings. Entries select discovered checkouts; they do not create Worktrees.',
    worktreesDirectory: 'Directory where RAC creates Worktrees. Relative paths resolve from the Main checkout; blank uses the default sibling directory.',
    externalUrl: 'Existing HTTPS origin to open directly. Use this instead of Hostname and Port.',
    hostname: 'Public hostname for RAC’s proxied preview. Set it together with Port.',
    port: 'Local project service port for RAC’s proxied preview. Set it together with Hostname.',
    commands: 'Default trusted shell commands for this Project’s Worktrees.',
    newTask: 'Trusted shell command for New Task. It is available only for clean, pushed Worktrees; {taskId} inserts a random task ID.',
    push: 'Label and prompt for the commit-and-push action. Omit this setting to use the default action.'
  };
  // describe every declared project field
  for (const [key, description] of Object.entries(descriptions)) {
    const field = project.properties[key];
    if (field !== undefined) field.description = description;
  }
  describeProjectCommands(project.properties.commands, 'project');
  // describe each preferred checkout path
  if (project.properties.worktreeOrder?.items !== undefined) project.properties.worktreeOrder.items.description = 'One checkout path to place ahead of unlisted Worktrees.';
  const override = project.properties.worktreeOverrides?.items;
  if (override?.properties !== undefined) {
    override.description = 'Settings for one discovered checkout selected by its path.';
    override.properties.path!.description = 'Checkout to override. Relative paths resolve from the Project path; each resolved checkout can appear once.';
    override.properties.externalUrl!.description = 'Direct HTTPS preview for this checkout. Null disables the inherited preview.';
    override.properties.hostname!.description = 'Proxied preview hostname for this checkout. Set it with Port; set both to null to disable the inherited preview.';
    override.properties.port!.description = 'Local preview port for this checkout. Set it with Hostname; set both to null to disable the inherited preview.';
    describeProjectCommands(override.properties.commands, 'override');
  }
  const push = project.properties.push;
  if (push?.properties !== undefined) {
    push.properties.label!.description = 'Button text shown for the commit-and-push action.';
    push.properties.prompt!.description = 'Prompt queued to the active agent when the action is selected.';
  }
}

// add editor defaults without changing parsed source bytes
export function installationSettingsPresentationSchema(input: z.ZodTypeAny): SettingsSchema {
  const schema = settingsSchema(input);
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
    if (input instanceof z.ZodDefault) result.default = definition.defaultValue();
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
