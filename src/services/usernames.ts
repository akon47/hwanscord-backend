import { User } from '../models/User.js';

export const USERNAME_RE = /^[a-z0-9_.]{2,32}$/;

/** Turns any text (an email local part, a GitHub login) into a valid handle candidate. */
export function sanitizeUsername(input: string): string {
  let name = input
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[-+\s]+/g, '_')
    .replace(/[^a-z0-9_.]/g, '')
    .replace(/_{2,}/g, '_')
    .replace(/\.{2,}/g, '.')
    .replace(/^[_.]+|[_.]+$/g, '')
    .slice(0, 32);
  if (name.length < 2) name = `${name}user`.slice(0, Math.max(2, name.length + 4));
  return name;
}

export function usernameFromEmail(email: string): string {
  return sanitizeUsername(email.split('@')[0] ?? '');
}

/** The candidate itself when free, otherwise the first free `candidate2`, `candidate3`, … (kept ≤ 32 chars). */
export async function freeUsername(candidate: string, exceptUserId?: string): Promise<string> {
  const base = sanitizeUsername(candidate);
  const taken = async (name: string) =>
    !!(await User.exists(
      exceptUserId ? { username: name, _id: { $ne: exceptUserId } } : { username: name },
    ).exec());
  if (!(await taken(base))) return base;
  for (let n = 2; n < 10_000; n++) {
    const suffix = String(n);
    const name = `${base.slice(0, 32 - suffix.length)}${suffix}`;
    if (!(await taken(name))) return name;
  }
  return `${base.slice(0, 24)}${Date.now().toString(36).slice(-8)}`;
}
