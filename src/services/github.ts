import type { Config } from '../config.js';
import type { Logger } from '../logger.js';

export interface GithubProfile {
  id: string;
  login: string;
  name: string | null;
  avatarUrl: string | null;
  /** primary verified email, informational only (never used to match accounts) */
  email: string | null;
}

export class GithubOAuthError extends Error {}

const TIMEOUT_MS = 5000;
export const GITHUB_SCOPE = 'read:user user:email';

/** Minimal GitHub OAuth App client (authorization-code flow). */
export class GithubOAuth {
  constructor(
    private readonly config: Config['github'],
    private readonly redirectUri: string,
    private readonly logger: Logger,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  get enabled(): boolean {
    return !!(this.config.clientId && this.config.clientSecret);
  }

  authorizeUrl(state: string): string {
    const url = new URL(`${this.config.oauthBaseUrl}/login/oauth/authorize`);
    url.searchParams.set('client_id', this.config.clientId ?? '');
    url.searchParams.set('redirect_uri', this.redirectUri);
    url.searchParams.set('scope', GITHUB_SCOPE);
    url.searchParams.set('state', state);
    url.searchParams.set('allow_signup', 'true');
    return url.toString();
  }

  /** Exchanges the code and reads the profile. Throws GithubOAuthError on any failure. */
  async fetchProfile(code: string): Promise<GithubProfile> {
    const token = await this.exchange(code);
    const user = await this.api<{
      id?: number;
      login?: string;
      name?: string | null;
      avatar_url?: string | null;
      email?: string | null;
    }>('/user', token);
    if (typeof user.id !== 'number' || typeof user.login !== 'string') {
      throw new GithubOAuthError('unexpected /user response');
    }
    let email: string | null = null;
    try {
      const emails = await this.api<{ email: string; primary: boolean; verified: boolean }[]>(
        '/user/emails',
        token,
      );
      email = emails.find((e) => e.primary && e.verified)?.email ?? null;
    } catch (err) {
      this.logger.debug({ err }, 'github /user/emails unavailable');
    }
    return {
      id: String(user.id),
      login: user.login,
      name: user.name ?? null,
      avatarUrl: user.avatar_url ?? null,
      email,
    };
  }

  private async exchange(code: string): Promise<string> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.config.oauthBaseUrl}/login/oauth/access_token`, {
        method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify({
          client_id: this.config.clientId,
          client_secret: this.config.clientSecret,
          code,
          redirect_uri: this.redirectUri,
        }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (err) {
      throw new GithubOAuthError(`token request failed: ${(err as Error).message}`);
    }
    const body = (await res.json().catch(() => ({}))) as { access_token?: string; error?: string };
    if (!res.ok || !body.access_token) {
      throw new GithubOAuthError(`token exchange rejected: ${body.error ?? res.status}`);
    }
    return body.access_token;
  }

  private async api<T>(path: string, token: string): Promise<T> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.config.apiBaseUrl}${path}`, {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github+json',
          'User-Agent': 'hwanscord',
          'X-GitHub-Api-Version': '2022-11-28',
        },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (err) {
      throw new GithubOAuthError(`${path} failed: ${(err as Error).message}`);
    }
    if (!res.ok) throw new GithubOAuthError(`${path} returned ${res.status}`);
    return (await res.json()) as T;
  }

  /** Downloads an avatar image (≤ 2 MB, image/*). Returns null on any problem. */
  async downloadAvatar(url: string): Promise<Buffer | null> {
    try {
      const res = await this.fetchImpl(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
      if (!res.ok) return null;
      if (!(res.headers.get('content-type') ?? '').startsWith('image/')) return null;
      const declared = Number(res.headers.get('content-length') ?? 0);
      if (declared > 2 * 1024 * 1024) return null;
      const buf = Buffer.from(await res.arrayBuffer());
      return buf.length > 2 * 1024 * 1024 ? null : buf;
    } catch {
      return null;
    }
  }
}
