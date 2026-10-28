import test from 'node:test';
import assert from 'node:assert/strict';
import { ImageProvider, ProviderError } from '../src/main/provider';
import { parseSub2APIQuota } from '../src/main/quota';
import { Engine, type CredentialStore, type GenerationService } from '../src/main/engine';
import { MemoryStore } from '../src/main/store';
import { BUILTIN_URL, type QuotaInfo } from '../src/shared/types';

const wallet = (remaining = 12.3456) => ({ mode: 'unrestricted', isValid: true, unit: 'USD', balance: remaining, remaining });
const valid = parseSub2APIQuota(wallet(), 123)!;
const credentials = { baseURL: 'https://upstream.example/v1', key: 'sk-private-quota-test' };

test('quota uses actual remaining values including zero, preserves currency and ignores spend totals', () => {
  assert.equal(parseSub2APIQuota(wallet(0), 12)?.remaining, 0);
  assert.equal(parseSub2APIQuota(wallet(-2), 12)?.unlimited, false);
  assert.equal(valid.currency, 'USD');
  assert.equal(valid.kind, 'balance');
  assert.equal(parseSub2APIQuota({ mode: 'unrestricted', isValid: true, status: 'active', total_cost: 100 }, 12), undefined);
  assert.equal(parseSub2APIQuota({ ...wallet(), remaining: '100', balance: '100' }, 12), undefined);
  assert.equal(parseSub2APIQuota({ total_available: 500000, total_used: 20 }, 12), undefined);
});

test('key quota, subscriptions and rolling limits retain their distinct meanings', () => {
  const key = parseSub2APIQuota({ mode: 'quota_limited', isValid: true, status: 'active', remaining: 0, balance: 100, unit: 'USD', quota: { remaining: 5 } }, 1)!;
  assert.equal(key.kind, 'key'); assert.equal(key.remaining, 0);
  const subscription = parseSub2APIQuota({ mode: 'unrestricted', isValid: true, remaining: -1, subscription: {}, unit: 'USD' }, 1)!;
  assert.equal(subscription.kind, 'subscription'); assert.equal(subscription.unlimited, true); assert.equal(subscription.remaining, undefined);
  assert.equal(parseSub2APIQuota({ mode: 'unrestricted', isValid: true, planName: 'Monthly', unit: 'USD' }, 1)?.remaining, undefined);
  const periodic = parseSub2APIQuota({ mode: 'quota_limited', isValid: true, rate_limits: [{ window: '5h', remaining: 2 }, { window: 'unexpected', remaining: 900 }] }, 1)!;
  assert.equal(periodic.kind, 'periodic'); assert.deepEqual(periodic.limits, [{ window: '5h', remaining: 2 }]); assert.equal(periodic.currency, undefined);
  assert.equal(parseSub2APIQuota({ ...wallet(), isValid: false, status: 'disabled' }, 1)?.valid, false);
});

test('GET usage uses the saved base path, header authentication and no redirects or POSTs', async () => {
  let calls = 0;
  const provider = new ImageProvider({ now: () => 77, fetch: (async (url, init) => {
    calls++; assert.equal(url, 'https://upstream.example/v1/usage');
    assert.equal(init?.method, 'GET'); assert.equal(init?.body, undefined); assert.equal(init?.redirect, 'manual');
    assert.equal(new Headers(init?.headers).get('authorization'), `Bearer ${credentials.key}`);
    return Response.json(wallet());
  }) as typeof fetch });
  assert.equal((await provider.quota(credentials)).checkedAt, 77); assert.equal(calls, 1);
  const redirected = new ImageProvider((async () => new Response(null, { status: 302, headers: { location: 'https://other.example/' } })) as typeof fetch);
  await assert.rejects(redirected.quota(credentials), (error: unknown) => error instanceof ProviderError && error.code === 'REDIRECT');
  const unsupported = new ImageProvider((async () => Response.json({ usage: { total_cost: 5 } })) as typeof fetch);
  await assert.rejects(unsupported.quota(credentials), (error: unknown) => error instanceof ProviderError && error.code === 'QUOTA_UNAVAILABLE');
});

class Vault implements CredentialStore {
  values = new Map<string, string>();
  async get(id: string) { return this.values.get(id); }
  async set(id: string, key: string) { this.values.set(id, key); }
  async delete(id: string) { this.values.delete(id); }
}
async function setup(quota: NonNullable<GenerationService['quota']>) {
  const store = new MemoryStore();
  const service: GenerationService = { quota, async generate() { throw new Error('No generation is permitted by quota tests'); }, async models() { return []; }, async enhance() { return ''; } };
  const engine = new Engine({ store, credentials: new Vault(), provider: service, output: { async stage() { return []; }, async write() { throw new Error('No images expected'); } } });
  await engine.init();
  await engine.execute('saveProvider', { id: 'builtin', name: 'Quota provider', baseURL: BUILTIN_URL, key: credentials.key, enabledModels: [] });
  return { engine, store };
}

test('quota queries never persist balances or mutate tasks and simultaneous requests share one GET', async () => {
  let calls = 0; let release!: (value: QuotaInfo) => void;
  const { engine, store } = await setup(async input => {
    calls++; assert.equal(input.baseURL, BUILTIN_URL); assert.equal(input.key, credentials.key);
    return new Promise(resolve => { release = resolve; });
  });
  assert.equal(calls, 0, 'initialization must not query credentials externally');
  const before = await store.load();
  const first = engine.execute('queryQuota', { id: 'builtin', baseURL: 'https://attacker.example' });
  const second = engine.execute('queryQuota', { id: 'builtin' });
  for (let i = 0; i < 50 && calls === 0; i++) await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls, 1);
  assert.equal(engine.getState().features?.quotaQuery, true);
  release(valid);
  assert.deepEqual(await first, valid); assert.deepEqual(await second, valid);
  assert.deepEqual(await store.load(), before);
});

test('an in-flight quota query cannot block task edits or publish results after credentials change', async () => {
  let release!: (value: QuotaInfo) => void;
  const { engine } = await setup(async () => new Promise(resolve => { release = resolve; }));
  const pending = engine.execute('queryQuota', { id: 'builtin' });
  await engine.execute('createTask', { kind: 'single' });
  assert.equal(engine.getState().tasks.length, 1);
  const revision = engine.getState().providers[0].configurationRevision;
  await engine.execute('saveProvider', { id: 'builtin', name: 'Quota provider', baseURL: BUILTIN_URL, key: 'sk-replacement-key', enabledModels: [] });
  assert.notEqual(engine.getState().providers[0].configurationRevision, revision);
  release(valid);
  await assert.rejects(pending, /配置已改变/);
});

test('query failures are explicit and do not echo upstream messages or keys', async () => {
  for (const [status, expected] of [[401, /未获授权/], [404, /未开放/], [429, /过于频繁/]] as const) {
    const { engine } = await setup(async () => { throw Object.assign(new Error(credentials.key), { status }); });
    await assert.rejects(engine.execute('queryQuota', { id: 'builtin' }), (error: unknown) => error instanceof Error && expected.test(error.message) && !error.message.includes(credentials.key));
  }
});
