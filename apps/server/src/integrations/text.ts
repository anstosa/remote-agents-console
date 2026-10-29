import { randomBytes } from 'node:crypto';

/** Text an integration principal reads, cut to a byte length without splitting a code point. */
export type TextLimit = { text: string; truncated: boolean };

// limit UTF-8 output without splitting a code point
export function limitText(value: string, maxBytes: number): TextLimit {
  const serialized = Buffer.from(value);
  // retain complete bounded values
  if (serialized.byteLength <= maxBytes) return { text: value, truncated: false };
  let end = maxBytes;
  // remove a partial trailing sequence
  while (end > 0 && (serialized[end] & 0xc0) === 0x80) end -= 1;
  return { text: serialized.subarray(0, end).toString('utf8'), truncated: true };
}

// redact credential-shaped values from untrusted text
export function redactIntegrationText(value: string): string {
  return value
    .replace(/-----BEGIN [^-\r\n]+-----[\s\S]*?-----END [^-\r\n]+-----/gu, '[REDACTED PRIVATE KEY]')
    .replace(/(^|\n)([A-Z0-9_]*(?:SECRET|TOKEN|PASSWORD|PASSWD|API_KEY|PRIVATE_KEY|CREDENTIAL|AUTH)[A-Z0-9_]*)\s*=\s*[^\r\n]*/giu, '$1$2=[REDACTED]')
    .replace(/(^|\n)(\s*[A-Z0-9_.-]*(?:SECRET|TOKEN|PASSWORD|PASSWD|API[_-]?KEY|PRIVATE[_-]?KEY|CREDENTIAL|AUTH)[A-Z0-9_.-]*\s*:\s*)[^\r\n]*/giu, '$1$2[REDACTED]')
    .replace(/("[^"\r\n]*(?:secret|token|password|api[_-]?key|authorization|cookie)[^"\r\n]*"\s*:\s*)"[^"\r\n]*"/giu, '$1"[REDACTED]"')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]{8,}=?/giu, 'Bearer [REDACTED]')
    .replace(/\b(?:sk-(?:proj-)?|sk_|ghp_|github_pat_|xox[baprs]_)[A-Za-z0-9_-]{8,}\b/gu, '[REDACTED TOKEN]')
    .replace(/([?&](?:access_?token|api_?key|auth|password)=)[^&#\s]+/giu, '$1[REDACTED]');
}

/**
 * Another's text as data, under a fence it cannot close, cut at 8 KiB: `intro` says what follows
 * and whose it is, and `cut` is said when it was cut.
 */
export function fenced(text: string, intro: (fence: string) => string, cut: string): string[] {
  const fence = `untrusted-${randomBytes(6).toString('hex')}`;
  const shown = limitText(text, 8 * 1024);
  return [intro(fence), `<<<${fence}`, shown.text, `${fence}>>>`, ...(shown.truncated ? ['', cut] : [])];
}
