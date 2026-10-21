import type { Config } from '../config.js';
import type { Logger } from '../logger.js';

export interface IceServer {
  urls: string[];
  username?: string;
  credential?: string;
}

export interface IceServersResult {
  iceServers: IceServer[];
  ttl: number;
  relay: boolean;
}

export interface TurnUsage {
  month: string;
  egressGB: number;
  budgetGB: number;
  relayEnabled: boolean;
}

const STUN_SERVERS: IceServer = {
  urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302', 'stun:stun2.l.google.com:19302'],
};

const USAGE_CACHE_MS = 10 * 60 * 1000;

/**
 * Hands out ICE servers. Cloudflare Realtime TURN credentials are only issued while this month's
 * TURN egress (from the Cloudflare GraphQL analytics API) stays under the configured budget, so the
 * free tier (1,000 GB/month) is never exceeded and nothing gets billed.
 */
export class TurnService {
  private usageCache: { at: number; egressBytes: number; month: string } | null = null;

  constructor(
    private readonly config: Config['turn'],
    private readonly logger: Logger,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  get configured(): boolean {
    return !!(this.config.keyId && this.config.apiToken);
  }

  get budgetGuardConfigured(): boolean {
    return !!(this.config.accountId && this.config.analyticsToken);
  }

  async getIceServers(): Promise<IceServersResult> {
    const stunOnly: IceServersResult = {
      iceServers: [STUN_SERVERS],
      ttl: this.config.credentialTtl,
      relay: false,
    };
    if (!this.configured) return stunOnly;

    const usage = await this.getUsage();
    if (!usage.relayEnabled) {
      this.logger.warn(
        { egressGB: usage.egressGB, budgetGB: usage.budgetGB },
        'TURN monthly budget reached; STUN only',
      );
      return stunOnly;
    }

    try {
      const res = await this.fetchImpl(
        `https://rtc.live.cloudflare.com/v1/turn/keys/${encodeURIComponent(this.config.keyId as string)}/credentials/generate-ice-servers`,
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${this.config.apiToken}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ ttl: this.config.credentialTtl }),
          signal: AbortSignal.timeout(5000),
        },
      );
      if (!res.ok) {
        this.logger.warn({ status: res.status }, 'Cloudflare TURN credential request failed');
        return stunOnly;
      }
      const body = (await res.json()) as { iceServers?: IceServer | IceServer[] };
      const list = Array.isArray(body.iceServers)
        ? body.iceServers
        : body.iceServers
          ? [body.iceServers]
          : [];
      const turnServers = list
        .map((s) => ({
          ...s,
          // browsers refuse port 53 URLs
          urls: (Array.isArray(s.urls) ? s.urls : [s.urls]).filter(
            (u) => typeof u === 'string' && !/:53(\?|$)/.test(u),
          ),
        }))
        .filter((s) => s.urls.length > 0);
      if (turnServers.length === 0) return stunOnly;
      return { iceServers: [STUN_SERVERS, ...turnServers], ttl: this.config.credentialTtl, relay: true };
    } catch (err) {
      this.logger.warn({ err }, 'Cloudflare TURN credential request errored');
      return stunOnly;
    }
  }

  async getUsage(): Promise<TurnUsage> {
    const month = currentMonth();
    const budgetGB = this.config.monthlyBudgetGb;
    if (!this.budgetGuardConfigured) {
      return { month, egressGB: 0, budgetGB, relayEnabled: this.configured };
    }
    const now = Date.now();
    if (!this.usageCache || this.usageCache.month !== month || now - this.usageCache.at > USAGE_CACHE_MS) {
      const egressBytes = await this.queryMonthlyEgress(month);
      // on query failure keep the previous value (or 0) but retry sooner
      if (egressBytes === null) {
        if (!this.usageCache) this.usageCache = { at: now - USAGE_CACHE_MS + 60_000, egressBytes: 0, month };
        else this.usageCache.at = now - USAGE_CACHE_MS + 60_000;
      } else {
        this.usageCache = { at: now, egressBytes, month };
      }
    }
    const egressGB = this.usageCache.egressBytes / 1e9;
    return {
      month,
      egressGB: Math.round(egressGB * 1000) / 1000,
      budgetGB,
      relayEnabled: this.configured && egressGB < budgetGB,
    };
  }

  private async queryMonthlyEgress(month: string): Promise<number | null> {
    const query = `query ($account: string!, $since: Time!) {
      viewer { accounts(filter: {accountTag: $account}) {
        callsTurnUsageAdaptiveGroups(limit: 100, filter: {datetimeMinute_geq: $since}) { sum { egressBytes } }
      } }
    }`;
    try {
      const res = await this.fetchImpl('https://api.cloudflare.com/client/v4/graphql', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.config.analyticsToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          query,
          variables: { account: this.config.accountId, since: `${month}-01T00:00:00Z` },
        }),
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) {
        this.logger.warn({ status: res.status }, 'Cloudflare analytics query failed');
        return null;
      }
      const body = (await res.json()) as {
        data?: {
          viewer?: { accounts?: { callsTurnUsageAdaptiveGroups?: { sum?: { egressBytes?: number } }[] }[] };
        };
        errors?: unknown;
      };
      const groups = body.data?.viewer?.accounts?.[0]?.callsTurnUsageAdaptiveGroups;
      if (!groups) {
        this.logger.warn({ errors: body.errors }, 'Cloudflare analytics query returned no data');
        return null;
      }
      return groups.reduce((sum, g) => sum + (g.sum?.egressBytes ?? 0), 0);
    } catch (err) {
      this.logger.warn({ err }, 'Cloudflare analytics query errored');
      return null;
    }
  }
}

function currentMonth(): string {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}
