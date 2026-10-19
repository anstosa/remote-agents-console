export type BrowserPermissionCapability = 'geolocation' | 'notifications' | 'clipboard-read' | 'clipboard-write';
type BrowserPermissionApproval = { status: 'ready'; token: string; cleared: boolean } | { status: 'superseded' } | { status: 'unavailable'; empty: boolean };

const capabilities: readonly BrowserPermissionCapability[] = ['geolocation', 'notifications', 'clipboard-read', 'clipboard-write'];
const tokenPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

// scope each durable approval to one exact project origin and capability
const approvalKey = (origin: string, capability: BrowserPermissionCapability): string => `rac.browser-permission:v1:${encodeURIComponent(origin)}:${capability}`;

// accept only generated choice tokens rather than legacy or malformed values
const isApprovalToken = (value: string | null): value is string => value !== null && tokenPattern.test(value);

// clean only a captured choice's grant without touching a newer tab's approval
const removeGrant = (key: string, token: string | null): boolean => {
  // ignore values that never named a generated choice
  if (!isApprovalToken(token)) return true;
  try {
    const grantKey = `${key}:${token}`;
    localStorage.removeItem(grantKey);
    return localStorage.getItem(grantKey) === null;
  } catch { return false; }
};

// compare a deferred native answer with the latest choice across rac tabs
export const isCurrentBrowserPermissionApproval = (origin: string, capability: BrowserPermissionCapability, token: string | undefined): boolean => {
  try {
    const current = localStorage.getItem(approvalKey(origin, capability));
    return token === undefined ? current === null : isApprovalToken(token) && current === token;
  } catch { return false; }
};

// capture the exact saved approval for deferred native completion checks
export const savedBrowserPermissionToken = (origin: string, capability: BrowserPermissionCapability): string | undefined => {
  try {
    const key = approvalKey(origin, capability);
    const token = localStorage.getItem(key);
    return isApprovalToken(token) && localStorage.getItem(`${key}:${token}`) === 'allow' && localStorage.getItem(key) === token ? token : undefined;
  } catch { return undefined; }
};

// require both the current choice and its own explicit grant record
export const hasSavedBrowserPermission = (origin: string, capability: BrowserPermissionCapability): boolean => savedBrowserPermissionToken(origin, capability) !== undefined;

// rotate the shared choice before native work or revocation without deleting newer pointers
export const beginBrowserPermissionApproval = (origin: string, capability: BrowserPermissionCapability): BrowserPermissionApproval => {
  const key = approvalKey(origin, capability);
  try {
    const previous = localStorage.getItem(key);
    const token = crypto.randomUUID();
    localStorage.setItem(key, token);
    // remove only the captured old record even if another tab already superseded this choice
    const cleared = removeGrant(key, previous);
    // a concurrent newer choice owns the pointer and must not be cleared by this handler
    if (localStorage.getItem(key) !== token) return { status: 'superseded' };
    return { status: 'ready', token, cleared };
  } catch {
    try { return { status: 'unavailable', empty: localStorage.getItem(key) === null }; }
    catch { return { status: 'unavailable', empty: false }; }
  }
};

// write only this choice's grant so an interleaved reset or allow remains authoritative
export const saveBrowserPermission = (origin: string, capability: BrowserPermissionCapability, token: string): boolean => {
  const key = approvalKey(origin, capability);
  try {
    // refuse an answer superseded by another click or tab
    if (!isCurrentBrowserPermissionApproval(origin, capability, token)) return false;
    localStorage.setItem(`${key}:${token}`, 'allow');
    // confirm both the grant and its pointer after the potentially interleaved write
    if (localStorage.getItem(`${key}:${token}`) === 'allow' && isCurrentBrowserPermissionApproval(origin, capability, token)) return true;
  } catch { /* failed writes remain one-time approval */ }
  removeGrant(key, token);
  return false;
};

// retain an inert tombstone so stale native answers cannot undo a newer revocation
export const forgetBrowserPermission = (origin: string, capability: BrowserPermissionCapability): boolean => {
  const choice = beginBrowserPermissionApproval(origin, capability);
  // verify the captured old grant was removed after the new pointer became authoritative
  if (choice.status === 'ready') return choice.cleared;
  return choice.status === 'unavailable' && choice.empty;
};

// attempt every removal even when storage rejects one capability
export const forgetBrowserPermissions = (origin: string): boolean => {
  let removed = true;
  // clear every supported capability for this origin
  for (const capability of capabilities) removed = forgetBrowserPermission(origin, capability) && removed;
  return removed;
};
