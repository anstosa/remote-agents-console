import argon2 from 'argon2';
import { z } from 'zod';
import { applyListenOverrides, sourceSchema, validateConfig } from '../config/schema.js';
import { environment } from './env.js';
import { SettingsError, type SettingsIssue } from './contracts.js';
import { parseTokenKey } from '../google-calendar/crypto.js';

// validate otherwise-ownerless installation selectors
const absolute = z.string().startsWith('/').max(4096).refine(value => !/[\0\r\n]/u.test(value));
// allow Docker's unlimited sentinel or bounded concurrency
const composeParallel = z.number().int().refine(value => value === -1 || value >= 1 && value <= 64);
export const installationSettingsSchema = z.object({
  version: z.literal(1).default(1),
  host: z.object({ checkout: absolute }).strict().optional(),
  native: z.object({ environmentFile: absolute, cloudflaredConfig: absolute.optional(), cloudflaredCredentials: absolute.optional(), cloudflaredUnit: z.string().regex(/^[a-zA-Z0-9_.@-]+\.service$/u).optional() }).strict().optional(),
  compose: z.object({ projectDirectory: absolute, projectName: z.string().regex(/^[a-z0-9][a-z0-9_-]*$/u), files: z.array(absolute).min(1).max(16), envFiles: z.array(absolute).max(16), profiles: z.array(z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]*$/u)).max(16), options: z.object({ parallel: composeParallel.optional(), compatibility: z.boolean().optional() }).strict().optional() }).strict().optional(),
  sources: z.object({ wrapper: absolute.optional(), icons: z.object({ heart: absolute.optional(), potato: absolute.optional() }).strict().optional() }).strict().optional()
}).strict();

// validate safe text and auth candidates without disclosure
export async function validateEnvironment(content: string): Promise<void> {
  const env = environment(content);
  // preserve the login and signed-session prerequisites on every candidate
  if (!env.RAC_PASSWORD_HASH || !env.RAC_SESSION_SECRET) throw new SettingsError('required_authentication_settings');
  let activeCalendarKey: ReturnType<typeof parseTokenKey> | undefined;
  let previousCalendarKey: ReturnType<typeof parseTokenKey> | undefined;
  // validate each known security contract
  for (const [key, value] of Object.entries(env)) {
    // retain required authentication even during rotation
    if (key === 'RAC_PASSWORD_HASH') {
      if (!value.startsWith('$argon2id$')) throw new SettingsError('invalid_password_hash');
      try { await argon2.verify(value, 'settings-validation'); } catch { throw new SettingsError('invalid_password_hash'); }
    }
    // reject malformed key material rather than accepting decoder truncation
    if (key === 'RAC_SESSION_SECRET' || /(?:INSTANCE_STATUS|INTEGRATION_FEDERATION)_SECRET$/u.test(key) && value !== '') {
      if (!/^[A-Za-z0-9_-]+$/u.test(value) || Buffer.from(value, 'base64url').length < 32) throw new SettingsError('invalid_secret');
    }
    // require valid listener ports
    if (key === 'RAC_LISTEN_PORT' && value !== '' && (!/^\d{1,5}$/u.test(value) || Number(value) < 1 || Number(value) > 65_535)) throw new SettingsError('invalid_listener_port');
    // validate persisted timezone choices
    if (key === 'TZ' && value !== '') { try { new Intl.DateTimeFormat('en', { timeZone: value }); } catch { throw new SettingsError('invalid_timezone'); } }
    // validate authored encryption keys without making optional runtime failures fatal
    if ((key === 'RAC_GOOGLE_CALENDAR_TOKEN_KEY' || key === 'RAC_GOOGLE_CALENDAR_PREVIOUS_TOKEN_KEY') && value !== '') {
      try {
        const parsed = parseTokenKey(value);
        // retain each parsed slot for the runtime-equivalent rotation invariant
        if (key === 'RAC_GOOGLE_CALENDAR_TOKEN_KEY') activeCalendarKey = parsed;
        else previousCalendarKey = parsed;
      } catch { throw new SettingsError('invalid_google_calendar_token_key'); }
    }
    // validate structured provider mappings
    if (key === 'RAC_OPENAI_API_KEY_IDS' && value !== '') {
      try { const parsed: unknown = JSON.parse(value); if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(); } catch { throw new SettingsError('invalid_api_key_mapping'); }
    }
  }
  // reject ambiguous rotation identities without reflecting either key in the error
  if (activeCalendarKey !== undefined && previousCalendarKey !== undefined && (activeCalendarKey.kid === previousCalendarKey.kid || activeCalendarKey.bytes.equals(previousCalendarKey.bytes))) throw new SettingsError('invalid_google_calendar_token_key');
}

// reuse application schema and cross-field checks
export async function validateApplication(value: unknown, env: Record<string, string | undefined>): Promise<SettingsIssue[]> {
  const parsed = sourceSchema.safeParse(value);
  // return field identities without rejected values
  if (!parsed.success) return parsed.error.issues.map(issue => {
    // explain the reserved-name rule only after a rejected project id
    const reservedProjectId = issue.code === 'custom' && issue.path.length === 3 && issue.path[0] === 'projects' && typeof issue.path[1] === 'number' && issue.path[2] === 'id';
    return { sourceId: 'app', path: issue.path.map(String), code: issue.code, message: reservedProjectId ? 'Project IDs “agent” and “scratch” are reserved. Choose another ID.' : 'Choose a valid value for this setting.' };
  });
  try { await validateConfig(applyListenOverrides(value, env), { checkExecutables: false }); return []; }
  catch { return [{ sourceId: 'app', path: [], code: 'invalid_configuration', message: 'These settings conflict with a configuration rule. Check listener, origins, projects, bindings and review references.' }]; }
}

// retain inert local artwork only
export function validateSvg(content: string): void {
  // reject declarations, references and active constructs
  if (Buffer.byteLength(content) > 262_144 || /<!|<\?|&|\b(?:href|style|on[a-z]+)\s*=|url\s*\(|(?:javascript|data):/iu.test(content)) throw new SettingsError('invalid_static_icon');
  const tags = new Set(['svg', 'g', 'path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon', 'title', 'desc']);
  const attributes = new Set(['xmlns', 'viewBox', 'width', 'height', 'x', 'y', 'x1', 'x2', 'y1', 'y2', 'cx', 'cy', 'r', 'rx', 'ry', 'd', 'points', 'fill', 'fill-rule', 'fill-opacity', 'stroke', 'stroke-width', 'stroke-linecap', 'stroke-linejoin', 'stroke-opacity', 'opacity', 'transform', 'id', 'role', 'aria-label']);
  const stack: string[] = [];
  let end = 0;
  // validate each token rather than only the root
  for (const match of content.matchAll(/<\/?([A-Za-z][A-Za-z0-9-]*)([^<>]*?)\/?\s*>/gu)) {
    // permit text only in inert title and description elements
    if (content.slice(end, match.index).trim() !== '' && !['title', 'desc'].includes(stack.at(-1) ?? '')) throw new SettingsError('invalid_static_icon');
    const name = match[1]!;
    if (!tags.has(name)) throw new SettingsError('invalid_static_icon');
    // enforce properly nested static geometry
    if (match[0].startsWith('</')) {
      if (stack.pop() !== name || match[2]!.trim() !== '') throw new SettingsError('invalid_static_icon');
    } else {
      const rest = match[2]!.trim(); let consumed = 0;
      // require quoted allowlisted attributes
      for (const attribute of rest.matchAll(/([A-Za-z][A-Za-z0-9-]*)\s*=\s*("[^"]*"|'[^']*')/gu)) {
        if (rest.slice(consumed, attribute.index).trim() !== '' || !attributes.has(attribute[1]!)) throw new SettingsError('invalid_static_icon');
        consumed = attribute.index + attribute[0].length;
      }
      if (rest.slice(consumed).trim() !== '') throw new SettingsError('invalid_static_icon');
      if (stack.length === 0 && (name !== 'svg' || end !== 0 && content.slice(0, end).trim() !== '')) throw new SettingsError('invalid_static_icon');
      if (!/\/\s*>$/u.test(match[0])) stack.push(name);
    }
    end = match.index + match[0].length;
  }
  // reject unfinished or unparsed markup
  if (end === 0 || stack.length !== 0 || content.slice(end).trim() !== '') throw new SettingsError('invalid_static_icon');
}
