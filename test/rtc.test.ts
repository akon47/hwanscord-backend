import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { auth, register, startTestApp, type TestApp } from './helpers.js';

describe('rtc without Cloudflare configuration', () => {
  let app: TestApp;
  beforeAll(async () => {
    app = await startTestApp();
  });
  afterEach(() => app.reset());
  afterAll(() => app.stop());

  it('returns STUN-only ice servers and admin-only usage', async () => {
    const admin = await register(app, 'admin');
    const user = await register(app, 'user');
    const res = await app.api.get('/api/v1/rtc/ice-servers').set(auth(user.token)).expect(200);
    expect(res.body.relay).toBe(false);
    expect(res.body.iceServers).toHaveLength(1);
    expect(res.body.iceServers[0].urls[0]).toMatch(/^stun:/);
    await app.api.get('/api/v1/rtc/usage').set(auth(user.token)).expect(403);
    const usage = await app.api.get('/api/v1/rtc/usage').set(auth(admin.token)).expect(200);
    expect(usage.body).toMatchObject({ budgetGB: 800, relayEnabled: false, egressGB: 0 });
  });
});

describe('rtc with Cloudflare TURN and the monthly budget guard', () => {
  let app: TestApp;
  let egressBytes = 0;
  const calls: string[] = [];

  const fakeFetch: typeof fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    calls.push(url);
    if (url.includes('/graphql')) {
      expect(init?.headers).toMatchObject({ Authorization: 'Bearer analytics-token' });
      return new Response(
        JSON.stringify({
          data: { viewer: { accounts: [{ callsTurnUsageAdaptiveGroups: [{ sum: { egressBytes } }] }] } },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }
    if (url.includes('rtc.live.cloudflare.com')) {
      expect(url).toContain('/turn/keys/key-123/credentials/generate-ice-servers');
      expect(init?.headers).toMatchObject({ Authorization: 'Bearer turn-token' });
      return new Response(
        JSON.stringify({
          iceServers: [
            {
              urls: [
                'stun:stun.cloudflare.com:3478',
                'turn:turn.cloudflare.com:3478?transport=udp',
                'turn:turn.cloudflare.com:53?transport=udp',
              ],
              username: 'u',
              credential: 'c',
            },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }
    return new Response('not found', { status: 404 });
  };

  beforeAll(async () => {
    app = await startTestApp(
      {
        CF_TURN_KEY_ID: 'key-123',
        CF_TURN_API_TOKEN: 'turn-token',
        CF_ACCOUNT_ID: 'acct',
        CF_ANALYTICS_TOKEN: 'analytics-token',
        TURN_MONTHLY_BUDGET_GB: '1',
        TURN_CREDENTIAL_TTL: '3600',
      },
      fakeFetch,
    );
  });
  afterEach(() => app.reset());
  afterAll(() => app.stop());

  it('appends TURN credentials (dropping port 53) while under budget, STUN-only once over budget', async () => {
    const user = await register(app, 'user');
    egressBytes = 100_000_000; // 0.1 GB
    const ok = await app.api.get('/api/v1/rtc/ice-servers').set(auth(user.token)).expect(200);
    expect(ok.body).toMatchObject({ relay: true, ttl: 3600 });
    expect(ok.body.iceServers).toHaveLength(2);
    expect(ok.body.iceServers[1].urls).toEqual([
      'stun:stun.cloudflare.com:3478',
      'turn:turn.cloudflare.com:3478?transport=udp',
    ]);
    expect(ok.body.iceServers[1]).toMatchObject({ username: 'u', credential: 'c' });

    // usage is cached for 10 minutes, so build a fresh app with the counter over budget
    await app.stop();
    egressBytes = 2_000_000_000; // 2 GB > 1 GB budget
    app = await startTestApp(
      {
        CF_TURN_KEY_ID: 'key-123',
        CF_TURN_API_TOKEN: 'turn-token',
        CF_ACCOUNT_ID: 'acct',
        CF_ANALYTICS_TOKEN: 'analytics-token',
        TURN_MONTHLY_BUDGET_GB: '1',
      },
      fakeFetch,
    );
    const admin = await register(app, 'admin');
    const over = await app.api.get('/api/v1/rtc/ice-servers').set(auth(admin.token)).expect(200);
    expect(over.body.relay).toBe(false);
    expect(over.body.iceServers).toHaveLength(1);
    const usage = await app.api.get('/api/v1/rtc/usage').set(auth(admin.token)).expect(200);
    expect(usage.body).toMatchObject({ egressGB: 2, budgetGB: 1, relayEnabled: false });
    expect(calls.some((c) => c.includes('/graphql'))).toBe(true);
  });
});
