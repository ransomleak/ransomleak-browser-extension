import type { ConsentInfo } from './types.ts';

const lastSegment = (s: string): string => s.split('/').filter(Boolean).pop() ?? s;

function matches(scope: string, pattern: string): boolean {
  const s = scope.toLowerCase();
  let p = pattern.toLowerCase();
  let target = s;
  if (p.startsWith('user:')) {
    if (!s.startsWith('user:')) return false;
  } else if (s.startsWith('user:')) {
    target = s.slice(5);
  }
  if (p.endsWith('*')) {
    p = p.slice(0, -1);
    return target.startsWith(p) || lastSegment(target).startsWith(p);
  }
  return target === p || lastSegment(target) === p;
}

const bare = (s: string): string => lastSegment(s.toLowerCase().replace(/^user:/, ''));

function alwaysRisky(scopes: string[]): boolean {
  const tails = scopes.map(bare);
  const full = scopes.map((s) => s.toLowerCase());
  return (
    (tails.includes('mail.readwrite') && tails.includes('offline_access')) ||
    tails.includes('full_access_as_user') ||
    full.includes('https://mail.google.com/') ||
    tails.some((t) => t.startsWith('admin'))
  );
}

export function isRisky(info: ConsentInfo, riskyScopes: Record<string, string[]>, approvedAppIds: string[]): boolean {
  if (info.appId && approvedAppIds.includes(info.appId)) return false;
  if (info.scopeSource === 'dom' || info.unverifiedScopes) return true; // human text cannot be matched: fail closed
  if (alwaysRisky(info.scopes)) return true;
  if (info.verified) return false;
  const list = riskyScopes[info.provider] ?? [];
  return info.scopes.some((s) => list.some((p) => matches(s, p)));
}
