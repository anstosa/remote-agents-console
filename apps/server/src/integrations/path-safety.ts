import { extname } from 'node:path';

const safeHiddenPaths = new Set(['.dockerignore', '.editorconfig', '.gitattributes', '.github', '.gitignore']);
const sensitiveFileNames = new Set(['.npmrc', '.netrc', '.pypirc', 'auth.json', 'credentials', 'credentials.json', 'id_ed25519', 'id_rsa', 'integration-auth.json', 'integration-state.json', 'secrets.json']);
const sensitiveExtensions = new Set(['.cer', '.crt', '.jks', '.key', '.keystore', '.p12', '.pem', '.pfx']);

// reject hidden and credential-bearing integration paths
export function safeIntegrationPath(value: string): boolean {
  const normalized = value.replaceAll('\\', '/').replace(/^\.\//u, '');
  const segments = normalized.split('/').filter(Boolean);
  // reject traversal and absolute paths before filesystem access
  if (normalized.startsWith('/') || segments.includes('..')) return false;
  // reject unsafe hidden files and directories
  if (segments.some(segment => segment.startsWith('.') && !safeHiddenPaths.has(segment))) return false;
  const name = segments.at(-1)?.toLocaleLowerCase() ?? '';
  // reject known credential stores and key material
  if (sensitiveFileNames.has(name) || sensitiveExtensions.has(extname(name)) || [...sensitiveExtensions].some(extension => name.endsWith(extension))) return false;
  // reject deployment-specific private configuration
  if (/^remote-agent-console\.(?!example\.json$).+\.json$/u.test(name)) return false;
  return true;
}
