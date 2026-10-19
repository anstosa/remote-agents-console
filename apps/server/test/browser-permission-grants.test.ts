import { afterEach, describe, expect, it, vi } from 'vitest';
import { beginBrowserPermissionApproval, forgetBrowserPermission, forgetBrowserPermissions, hasSavedBrowserPermission, isCurrentBrowserPermissionApproval, saveBrowserPermission, type BrowserPermissionCapability } from '../../web/src/browser-permission-grants.js';

const projectOrigin = 'https://project.example.com';
const approvalKey = `rac.browser-permission:v1:${encodeURIComponent(projectOrigin)}:notifications`;

// model an explicit synchronous always click followed by its granted result
const remember = (origin: string, capability: BrowserPermissionCapability): boolean => {
  const choice = beginBrowserPermissionApproval(origin, capability);
  return choice.status === 'ready' && saveBrowserPermission(origin, capability, choice.token);
};


// capture one verified choice for deferred native-result tests
const choose = (): string => {
  const choice = beginBrowserPermissionApproval(projectOrigin, 'notifications');
  expect(choice.status).toBe('ready');
  return choice.status === 'ready' ? choice.token : '';
};

// model browser-owned storage without a project-side cache
const installStorage = () => {
  const values = new Map<string, string>();
  const storage = {
    // read one persisted preference
    getItem: vi.fn((key: string) => values.get(key) ?? null),
    // persist one explicit preference
    setItem: vi.fn((key: string, value: string) => { values.set(key, value); }),
    // clear one exact preference
    removeItem: vi.fn((key: string) => { values.delete(key); })
  };
  vi.stubGlobal('localStorage', storage);
  return { storage, values };
};

// restore globals after each external storage simulation
afterEach(() => vi.unstubAllGlobals());

// exercise durable approval and revocation boundaries
describe('remembered browser permissions', () => {
  // keep remembered approval separate for every origin and capability
  it('persists only the exact explicitly approved origin and capability', () => {
    installStorage();
    expect(hasSavedBrowserPermission(projectOrigin, 'geolocation')).toBe(false);
    expect(remember(projectOrigin, 'geolocation')).toBe(true);
    expect(hasSavedBrowserPermission(projectOrigin, 'geolocation')).toBe(true);
    expect(hasSavedBrowserPermission(projectOrigin, 'notifications')).toBe(false);
    expect(hasSavedBrowserPermission(projectOrigin, 'clipboard-read')).toBe(false);
    expect(hasSavedBrowserPermission(projectOrigin, 'clipboard-write')).toBe(false);
    expect(remember(projectOrigin, 'clipboard-read')).toBe(true);
    expect(hasSavedBrowserPermission(projectOrigin, 'clipboard-read')).toBe(true);
    expect(hasSavedBrowserPermission(projectOrigin, 'clipboard-write')).toBe(false);
    expect(hasSavedBrowserPermission('https://other-project.example.com', 'geolocation')).toBe(false);
    expect(hasSavedBrowserPermission('https://project.example.com:8443', 'geolocation')).toBe(false);
    expect(hasSavedBrowserPermission('http://project.example.com', 'geolocation')).toBe(false);
  });

  // reject malformed preferences rather than interpreting them as permission
  it('requires the exact versioned stored approval value', () => {
    const { values } = installStorage();
    const key = `rac.browser-permission:v1:${encodeURIComponent(projectOrigin)}:geolocation`;
    // reject every non-approval stored value
    for (const value of ['allow', 'true', '1', 'always', 'denied', '{"allow":true}', '../../other-key']) {
      values.set(key, value);
      expect(hasSavedBrowserPermission(projectOrigin, 'geolocation')).toBe(false);
    }
    values.delete(key);
    values.set(key.replace(':v1:', ':v2:'), 'allow');
    expect(hasSavedBrowserPermission(projectOrigin, 'geolocation')).toBe(false);
  });

  // storage failures must not invent a durable grant
  it('fails closed on blocked reads and quota-limited writes', () => {
    const { storage, values } = installStorage();
    storage.getItem.mockImplementation(() => { throw new DOMException('blocked', 'SecurityError'); });
    expect(hasSavedBrowserPermission(projectOrigin, 'geolocation')).toBe(false);
    expect(remember(projectOrigin, 'geolocation')).toBe(false);
    expect(values.size).toBe(0);
    storage.getItem.mockImplementation(key => values.get(key) ?? null);
    storage.setItem.mockImplementation(() => { throw new DOMException('full', 'QuotaExceededError'); });
    expect(remember(projectOrigin, 'notifications')).toBe(false);
    expect(values.size).toBe(0);
  });

  // verify browser storage accepted the approval rather than trusting a no-op write
  it('rejects a write that cannot be read back', () => {
    const { storage } = installStorage();
    storage.setItem.mockImplementation(() => undefined);
    expect(remember(projectOrigin, 'geolocation')).toBe(false);
    expect(hasSavedBrowserPermission(projectOrigin, 'geolocation')).toBe(false);
  });

  // reset only the selected project's approvals without clearing unrelated preferences
  it('clears every capability while preserving other origins and native preferences', () => {
    const { values } = installStorage();
    remember(projectOrigin, 'geolocation');
    remember(projectOrigin, 'notifications');
    remember(projectOrigin, 'clipboard-read');
    remember(projectOrigin, 'clipboard-write');
    // capture durable grants without pinning the number or layout of choice pointers
    const grantKeys = [...values].filter(([, value]) => value === 'allow').map(([key]) => key);
    remember('https://other-project.example.com', 'geolocation');
    remember('https://other-project.example.com', 'clipboard-read');
    values.set('rac.color-theme', 'latte');
    expect(forgetBrowserPermissions(projectOrigin)).toBe(true);
    expect(hasSavedBrowserPermission(projectOrigin, 'geolocation')).toBe(false);
    expect(hasSavedBrowserPermission(projectOrigin, 'notifications')).toBe(false);
    expect(hasSavedBrowserPermission(projectOrigin, 'clipboard-read')).toBe(false);
    expect(hasSavedBrowserPermission(projectOrigin, 'clipboard-write')).toBe(false);
    expect(hasSavedBrowserPermission('https://other-project.example.com', 'geolocation')).toBe(true);
    expect(hasSavedBrowserPermission('https://other-project.example.com', 'clipboard-read')).toBe(true);
    expect(values.get('rac.color-theme')).toBe('latte');
    // remove every captured grant without disturbing other preferences
    for (const key of grantKeys) expect(values.has(key)).toBe(false);
  });

  // attempt every key and report failure when any readable approval remains
  it('does not report a successful reset after blocked or ineffective removal', () => {
    const { storage, values } = installStorage();
    remember(projectOrigin, 'geolocation');
    remember(projectOrigin, 'notifications');
    storage.removeItem.mockImplementation(key => {
      // simulate a readable grant whose removal is blocked
      if (key.includes(':geolocation:')) throw new DOMException('blocked', 'SecurityError');
      values.delete(key);
    });
    expect(forgetBrowserPermissions(projectOrigin)).toBe(false);
    expect(hasSavedBrowserPermission(projectOrigin, 'geolocation')).toBe(false);
    expect(hasSavedBrowserPermission(projectOrigin, 'notifications')).toBe(false);
    remember(projectOrigin, 'geolocation');
    storage.removeItem.mockImplementation(() => undefined);
    expect(forgetBrowserPermission(projectOrigin, 'geolocation')).toBe(false);
  });

  // a pending native choice is not a grant and cannot survive later revocation
  it('ignores native answers after a newer once deny or reset rotates their pointer', () => {
    const { values } = installStorage();
    const token = choose();
    expect(hasSavedBrowserPermission(projectOrigin, 'notifications')).toBe(false);
    expect(forgetBrowserPermissions(projectOrigin)).toBe(true);
    expect(saveBrowserPermission(projectOrigin, 'notifications', token)).toBe(false);
    expect(values.get(`${approvalKey}:${token}`)).toBeUndefined();
    expect(hasSavedBrowserPermission(projectOrigin, 'notifications')).toBe(false);
  });

  // old settlers cannot approve or overwrite a newer pending or completed choice
  it('keeps grant records owned by their exact choice token', () => {
    const { values } = installStorage();
    const oldToken = choose();
    const newToken = choose();
    expect(saveBrowserPermission(projectOrigin, 'notifications', oldToken)).toBe(false);
    expect(hasSavedBrowserPermission(projectOrigin, 'notifications')).toBe(false);
    expect(saveBrowserPermission(projectOrigin, 'notifications', newToken)).toBe(true);
    expect(saveBrowserPermission(projectOrigin, 'notifications', oldToken)).toBe(false);
    expect(hasSavedBrowserPermission(projectOrigin, 'notifications')).toBe(true);
    expect(values.size).toBe(2);
  });

  // simulate another tab committing its choice during an older grant write
  it('cannot clobber a newer approval interleaved between pointer validation and writing', () => {
    const { storage, values } = installStorage();
    const oldToken = choose();
    let newToken: string | undefined;
    storage.setItem.mockImplementation((key, value) => {
      // interleave a complete newer explicit approval before the stale write lands
      if (key === `${approvalKey}:${oldToken}`) {
        newToken = choose();
        expect(saveBrowserPermission(projectOrigin, 'notifications', newToken!)).toBe(true);
      }
      values.set(key, value);
    });
    expect(saveBrowserPermission(projectOrigin, 'notifications', oldToken)).toBe(false);
    expect(values.get(approvalKey)).toBe(newToken);
    expect(values.get(`${approvalKey}:${oldToken}`)).toBeUndefined();
    expect(hasSavedBrowserPermission(projectOrigin, 'notifications')).toBe(true);
    expect(values.size).toBe(2);
  });

  // a reset racing a grant write leaves no usable or orphaned approval
  it('fails closed when reset interleaves with an asynchronous grant write', () => {
    const { storage, values } = installStorage();
    const token = choose();
    storage.setItem.mockImplementation((key, value) => {
      // reset in another tab after the pre-write pointer check
      if (key === `${approvalKey}:${token}`) expect(forgetBrowserPermissions(projectOrigin)).toBe(true);
      values.set(key, value);
    });
    expect(saveBrowserPermission(projectOrigin, 'notifications', token)).toBe(false);
    expect(hasSavedBrowserPermission(projectOrigin, 'notifications')).toBe(false);
    expect(values.get(`${approvalKey}:${token}`)).toBeUndefined();
  });

  // verify the captured grant record was removed as well as its ordering pointer
  it('reports reset failure if a captured grant cannot be removed', () => {
    const { storage, values } = installStorage();
    expect(remember(projectOrigin, 'notifications')).toBe(true);
    const token = values.get(approvalKey)!;
    storage.removeItem.mockImplementation(key => {
      // retain only the grant record to model partial storage failure
      if (key === `${approvalKey}:${token}`) return;
      values.delete(key);
    });
    expect(forgetBrowserPermissions(projectOrigin)).toBe(false);
    expect(values.get(approvalKey)).not.toBe(token);
    expect(hasSavedBrowserPermission(projectOrigin, 'notifications')).toBe(false);
  });

  // a failed verification must not mutate the tab that already superseded this click
  it('preserves a newer choice written before an older pointer verification', () => {
    const { storage, values } = installStorage();
    expect(remember(projectOrigin, 'notifications')).toBe(true);
    let newerToken: string | undefined;
    let interleave = true;
    storage.setItem.mockImplementation((key, value) => {
      values.set(key, value);
      // write and grant a newer choice before the older handler can verify its own pointer
      if (key === approvalKey && interleave) {
        interleave = false;
        newerToken = choose();
        expect(saveBrowserPermission(projectOrigin, 'notifications', newerToken)).toBe(true);
      }
    });
    expect(beginBrowserPermissionApproval(projectOrigin, 'notifications')).toEqual({ status: 'superseded' });
    expect(values.get(approvalKey)).toBe(newerToken);
    expect(hasSavedBrowserPermission(projectOrigin, 'notifications')).toBe(true);
    expect(values.size).toBe(2);
  });

  // revocation never removes a newer pointer observed during its own verification
  it('preserves a newer approval interleaved with reset tombstone rotation', () => {
    const { storage, values } = installStorage();
    expect(remember(projectOrigin, 'notifications')).toBe(true);
    let newerToken: string | undefined;
    let interleave = true;
    storage.setItem.mockImplementation((key, value) => {
      values.set(key, value);
      // another tab commits a newer always choice after the reset writes its tombstone
      if (key === approvalKey && interleave) {
        interleave = false;
        newerToken = choose();
        expect(saveBrowserPermission(projectOrigin, 'notifications', newerToken)).toBe(true);
      }
    });
    expect(forgetBrowserPermission(projectOrigin, 'notifications')).toBe(false);
    expect(values.get(approvalKey)).toBe(newerToken);
    expect(hasSavedBrowserPermission(projectOrigin, 'notifications')).toBe(true);
  });

  // unavailable storage permits fallback only when no grant or native choice can remain
  it('distinguishes an empty storage failure from unknown or existing approval', () => {
    const { storage, values } = installStorage();
    storage.setItem.mockImplementation(() => { throw new DOMException('full', 'QuotaExceededError'); });
    expect(beginBrowserPermissionApproval(projectOrigin, 'notifications')).toEqual({ status: 'unavailable', empty: true });
    storage.setItem.mockImplementation((key, value) => { values.set(key, value); });
    expect(remember(projectOrigin, 'notifications')).toBe(true);
    storage.setItem.mockImplementation(() => { throw new DOMException('full', 'QuotaExceededError'); });
    expect(beginBrowserPermissionApproval(projectOrigin, 'notifications')).toEqual({ status: 'unavailable', empty: false });
    storage.getItem.mockImplementation(() => { throw new DOMException('blocked', 'SecurityError'); });
    expect(beginBrowserPermissionApproval(projectOrigin, 'notifications')).toEqual({ status: 'unavailable', empty: false });
  });

  // expose a captured grant cleanup failure before the broker invokes native capabilities
  it('reports an uncleared prior grant even after rotating to a safe new pointer', () => {
    const { storage, values } = installStorage();
    expect(remember(projectOrigin, 'notifications')).toBe(true);
    const token = values.get(approvalKey)!;
    storage.removeItem.mockImplementation(() => undefined);
    const choice = beginBrowserPermissionApproval(projectOrigin, 'notifications');
    expect(choice).toEqual({ status: 'ready', token: expect.any(String), cleared: false });
    expect(values.get(approvalKey)).not.toBe(token);
    expect(values.get(`${approvalKey}:${token}`)).toBe('allow');
    expect(hasSavedBrowserPermission(projectOrigin, 'notifications')).toBe(false);
  });

  // revalidate verified-empty fallback when native permission settles after another tab changes consent
  it('keeps tokenless fallback current only while the shared pointer remains verifiably empty', () => {
    const { storage } = installStorage();
    expect(isCurrentBrowserPermissionApproval(projectOrigin, 'notifications', undefined)).toBe(true);
    const token = choose();
    expect(isCurrentBrowserPermissionApproval(projectOrigin, 'notifications', undefined)).toBe(false);
    expect(isCurrentBrowserPermissionApproval(projectOrigin, 'notifications', token)).toBe(true);
    expect(forgetBrowserPermission(projectOrigin, 'notifications')).toBe(true);
    expect(isCurrentBrowserPermissionApproval(projectOrigin, 'notifications', token)).toBe(false);
    expect(isCurrentBrowserPermissionApproval(projectOrigin, 'notifications', undefined)).toBe(false);
    storage.getItem.mockImplementation(() => { throw new DOMException('blocked', 'SecurityError'); });
    expect(isCurrentBrowserPermissionApproval(projectOrigin, 'notifications', undefined)).toBe(false);
  });
});
