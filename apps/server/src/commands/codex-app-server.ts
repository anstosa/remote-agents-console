import { createCodexProtocolClient, initializeCodexProtocol, type CodexProtocolClient, type CodexProtocolClientFactory } from '../accounts/protocol.js';

export type RuntimeSkill = { name: string; description: string };
export type RuntimeSlashCommand = { name: string; description?: string };
export type RuntimeCommandCatalog = { skills: RuntimeSkill[]; slash: RuntimeSlashCommand[] };

const requestTimeoutMs = 5_000;
const skillName = /^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$/u;
type JsonObject = Record<string, unknown>;

// narrow one protocol object
const object = (value: unknown): value is JsonObject => value !== null && typeof value === 'object' && !Array.isArray(value);

// parse the runtime skill response
function skillsFrom(value: unknown, workspace: string): RuntimeSkill[] | undefined {
  const result = object(value) ? value : undefined;
  const data = Array.isArray(result?.data) ? result.data : undefined;
  // require one response entry
  if (data === undefined) return undefined;
  const entries = data.filter(object);
  // select the addressed workspace entry
  const entry = entries.find(candidate => candidate.cwd === workspace) ?? entries[0];
  // require the skill array
  if (entry === undefined || !Array.isArray(entry.skills)) return undefined;
  const skills: RuntimeSkill[] = [];
  // retain valid enabled skills
  for (const candidate of entry.skills) {
    // reject malformed records
    if (!object(candidate) || candidate.enabled !== true || typeof candidate.name !== 'string' || !skillName.test(candidate.name) || typeof candidate.description !== 'string') continue;
    const description = candidate.description.trim().replace(/\s+/gu, ' ').slice(0, 500);
    // require useful metadata
    if (!description) continue;
    skills.push({ name: candidate.name, description });
  }
  return skills;
}

// parse model service-tier commands
function slashFrom(value: unknown): RuntimeSlashCommand[] | undefined {
  const result = object(value) ? value : undefined;
  const models = Array.isArray(result?.data) ? result.data : undefined;
  // require one model response
  if (models === undefined) return undefined;
  const byName = new Map<string, RuntimeSlashCommand>();
  // collect commands across available models
  for (const model of models) {
    // ignore malformed models
    if (!object(model) || !Array.isArray(model.serviceTiers)) continue;
    // collect valid tiers
    for (const candidate of model.serviceTiers) {
      // reject malformed tiers
      if (!object(candidate) || typeof candidate.name !== 'string' || typeof candidate.description !== 'string') continue;
      const name = `/${candidate.name.trim().toLocaleLowerCase()}`;
      // require one safe slash token
      if (!/^\/[a-z0-9][a-z0-9-]*$/u.test(name)) continue;
      byName.set(name, { name, description: candidate.description.trim().replace(/\s+/gu, ' ').slice(0, 500) });
    }
  }
  return [...byName.values()];
}

// enforce one bounded protocol operation
async function withDeadline<T>(task: Promise<T>, onTimeout?: () => void): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  // reject after one operation deadline
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      onTimeout?.();
      reject(new Error('Codex app-server request timed out'));
    }, requestTimeoutMs);
    timer.unref();
  });
  try {
    return await Promise.race([task, timeout]);
  } finally {
    // clear completed deadlines
    if (timer !== undefined) clearTimeout(timer);
  }
}

// discover the exact skills and dynamic commands codex exposes for one workspace
export async function codexAppServerCatalog(workspace: string, stateDirectory: string, program: string | undefined, createClient: CodexProtocolClientFactory = createCodexProtocolClient): Promise<RuntimeCommandCatalog> {
  let client: CodexProtocolClient | undefined;
  try {
    client = await withDeadline(createClient(stateDirectory, { command: program }));
    await withDeadline(initializeCodexProtocol(client), () => void client?.close());
    const skillResult = await withDeadline(client.request('skills/list', { cwds: [workspace], forceReload: true }), () => void client?.close());
    const skills = skillsFrom(skillResult, workspace);
    // reject incomplete primary discovery
    if (skills === undefined) throw new Error('Codex app-server returned an invalid skill catalog');
    const modelResult = await withDeadline(client.request('model/list', { limit: 100 }), () => void client?.close());
    const slash = slashFrom(modelResult);
    // reject incomplete dynamic discovery
    if (slash === undefined) throw new Error('Codex app-server returned an invalid model catalog');
    return { skills, slash };
  } finally {
    // ignore cleanup errors
    await client?.close().catch(() => undefined);
  }
}
