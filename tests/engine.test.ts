import test from 'node:test';
import assert from 'node:assert/strict';
import { Engine, type CredentialStore, type EngineOptions, type EngineSnapshot, type GenerationService, type OutputService, type StateStore } from '../src/main/engine';
import { MemoryStore, SQLiteStore } from '../src/main/store';
import { getModelInfo, ProviderError } from '../src/main/provider';
import { BUILTIN_MODELS, BUILTIN_URL } from '../src/shared/types';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

class Vault implements CredentialStore { values = new Map<string, string>(); async get(id: string) { return this.values.get(id); } async set(id: string, key: string) { this.values.set(id, key); } async delete(id: string) { this.values.delete(id); } }
const output: OutputService = { async stage(images, context) { return images.map((_, i) => ({ id: `${context.jobId}-${i}` })); }, async write(image) { return { id: image.id, name: `${image.id}.png`, url: `qingtu-asset://${image.id}`, favorite: false, saved: false }; } };
const service = (generate: GenerationService['generate'] = async () => [{ url: 'https://images.example/one.png' }]): GenerationService => ({ generate, models: async () => BUILTIN_MODELS.map(id => getModelInfo(id, true)), enhance: async () => 'new prompt' });
async function setup(options: Partial<EngineOptions> = {}) { const store = options.store ?? new MemoryStore(); const credentials = options.credentials ?? new Vault(); const engine = new Engine({ store, credentials, provider: service(), output, ...options }); await engine.init(); await engine.execute('testProvider', { id: 'builtin', baseURL: BUILTIN_URL, key: 'test-key-not-real' }); await engine.execute('saveProvider', { id: 'builtin', name: 'Test', baseURL: BUILTIN_URL, key: 'test-key-not-real', enabledModels: [...BUILTIN_MODELS] }); await engine.execute('createTask', { kind: 'single' }); const id = engine.getState().tasks[0].id; await engine.execute('updateTask', { id, prompt: 'mock image' }); return { engine, id, store, credentials }; }
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
async function until(condition: () => boolean) { for (let i = 0; i < 300; i++) { if (condition()) return; await new Promise(resolve => setImmediate(resolve)); } throw new Error('test state timeout'); }

test('restoring a configured provider adds new size presets without losing tasks or verification', async () => {
  const { engine, store, credentials } = await setup();
  engine.stop();
  const stored = (await store.load())!;
  const provider = stored.state.providers[0];
  const selected = provider.models.find(model => model.id === 'gpt-image-2.5')!;
  selected.sizes = ['auto', '1024x1024', '1536x1024', '1024x1536'];
  await store.save(stored);
  const restarted = new Engine({ store, credentials, provider: service(), output });
  await restarted.init();
  const restored = restarted.getState();
  const model = restored.providers[0].models.find(item => item.id === 'gpt-image-2.5')!;
  assert.ok(model.sizes.includes('864x1536'));
  assert.ok(model.sizes.includes('1152x864'));
  assert.equal(model.verified, true);
  assert.equal(restored.providers[0].connection, 'connected');
  assert.ok(restored.providers[0].enabledModels.includes(model.id));
  assert.equal(restored.tasks[0].prompt, 'mock image');
  restarted.stop();
});

test('all mutations serialize; concurrent duplicate clicks create one run; later click appends a run', async () => {
  const wait = deferred<Array<{ url: string }>>(); let posts = 0;
  const { engine, id } = await setup({ provider: service(async () => { posts++; return wait.promise; }) });
  await Promise.all([engine.execute('submitTask', { id }), engine.execute('submitTask', { id }), engine.execute('submitTask', { id })]);
  await until(() => posts === 1); assert.equal(engine.getState().tasks[0].jobs.length, 1);
  wait.resolve([{ url: 'https://images.example/one.png' }]); await engine.drain(); assert.equal(engine.getState().tasks[0].jobs[0].status, 'completed');
  await engine.execute('submitTask', { id }); await engine.drain(); assert.equal(posts, 2); assert.deepEqual(engine.getState().tasks[0].jobs.map(j => j.run), [1, 2]);
});

test('pause stops queued dispatch but does not cancel the in-flight request; clear refuses active', async () => {
  const wait = deferred<Array<{ url: string }>>(); let posts = 0;
  const { engine } = await setup({ provider: service(async () => { posts++; return posts <= 5 ? wait.promise : [{ url: 'https://images.example/two.png' }]; }) });
  await engine.execute('createTask', { kind: 'batch' }); const id = engine.getState().tasks[1].id; await engine.setRows(id, ['one', 'two', 'three', 'four', 'five', 'six', 'seven']); await engine.execute('submitTask', { id }); await until(() => posts === 5);
  await engine.execute('pauseTask', { id }); await assert.rejects(engine.execute('clearTask', { id }), /仍在执行/); wait.resolve([{ url: 'https://images.example/one.png' }]); await engine.drain();
  assert.equal(posts, 5); assert.deepEqual(engine.getState().tasks[1].jobs.map(j => j.status), ['completed', 'completed', 'completed', 'completed', 'completed', 'queued', 'queued']);
  await engine.execute('resumeTask', { id }); await engine.drain(); assert.equal(posts, 7);
});

test('batch jobs use five shared slots and retain validation for older task settings', async () => {
  const wait = deferred<Array<{ url: string }>>(); let active = 0, maximum = 0, posts = 0;
  const { engine } = await setup({ provider: service(async () => { posts++; maximum = Math.max(maximum, ++active); const images = await wait.promise; active--; return images; }) });
  await engine.execute('createTask', { kind: 'batch' }); const id = engine.getState().tasks[1].id; await engine.setRows(id, ['1', '2', '3', '4', '5']);
  await assert.rejects(engine.execute('updateTask', { id, concurrency: 9 }), /并发数/); await assert.rejects(engine.execute('updateTask', { id, concurrency: 0 }), /并发数/);
  await engine.execute('updateTask', { id, concurrency: 3 }); await engine.execute('submitTask', { id }); await until(() => posts === 5); assert.equal(maximum, 5); wait.resolve([{ url: 'https://images.example/one.png' }]); await engine.drain(); assert.equal(posts, 5); assert.equal(maximum, 5);
});

test('restart during POST marks unknown, never resends; manual unknown retry requires confirmation', async () => {
  const wait = deferred<Array<{ url: string }>>(); let posts = 0;
  const { engine, id, store, credentials } = await setup({ provider: service(async () => { posts++; return wait.promise; }) });
  await engine.execute('submitTask', { id }); await until(() => posts === 1); engine.stop();
  const restarted = new Engine({ store, credentials, provider: service(async () => { posts++; return [{ url: 'https://images.example/one.png' }]; }), output }); await restarted.init(); await restarted.drain();
  assert.equal(posts, 1); assert.equal(restarted.getState().tasks[0].jobs[0].status, 'unknown'); await assert.rejects(restarted.execute('retryFailed', { id }), /明确确认/); await assert.rejects(restarted.execute('submitTask', { id }), /未知/);
  await restarted.execute('retryFailed', { id, confirmUnknown: true }); await restarted.drain(); assert.equal(posts, 2); assert.equal(restarted.getState().tasks[0].jobs[0].attempts, 2);
});

test('submitting durability failure prevents the generation POST and preserves queued durable state', async () => {
  const memory = new MemoryStore(); let fail = false, posts = 0;
  const store: StateStore = { load: () => memory.load(), save: async snapshot => { if (fail && snapshot.state.tasks.some(t => t.jobs.some(j => j.status === 'submitting'))) throw new Error('disk'); await memory.save(snapshot); } };
  const { engine, id } = await setup({ store, provider: service(async () => { posts++; return []; }) }); fail = true; await engine.execute('submitTask', { id }); await engine.drain(); assert.equal(posts, 0); assert.equal((await memory.load())?.state.tasks[0].jobs[0].status, 'queued'); assert.match(engine.getState().notice ?? '', /写入失败/);
});

test('failed ordinary mutation is rolled back; API key never enters persisted snapshot or public state', async () => {
  const memory = new MemoryStore(); let fail = false;
  const store: StateStore = { load: () => memory.load(), save: async snapshot => { if (fail) throw new Error('disk'); await memory.save(snapshot); } };
  const { engine, id } = await setup({ store }); fail = true; await assert.rejects(engine.execute('updateTask', { id, prompt: 'do not commit' }), /持久/); assert.equal(engine.getState().tasks[0].prompt, 'mock image');
  assert.ok(!JSON.stringify(await memory.load()).includes('test-key-not-real')); assert.ok(!JSON.stringify(engine.getState()).includes('test-key-not-real'));
});

test('no API key fails before queue creation or POST; reference/model/count/path/naming validation', async () => {
  const engine = new Engine({ store: new MemoryStore(), credentials: new Vault(), provider: service(), output }); await engine.init(); await engine.execute('createTask', { kind: 'single' }); const id = engine.getState().tasks[0].id; await engine.execute('updateTask', { id, prompt: 'mock' });
  await assert.rejects(engine.execute('submitTask', { id }), /API Key/); assert.equal(engine.getState().tasks[0].jobs.length, 0);
  for (const changes of [{ params: { count: 5 } }, { params: { size: 'unlisted' } }, { params: { model: 'text-only' } }, { naming: '../escape' }, { naming: '{prompt}' }, { outputDirectory: 'relative/path' }]) await assert.rejects(engine.execute('updateTask', { id, ...changes }));
});

test('only explicit 429 rejection retries, at most two extra POSTs; ambiguous errors never retry', async () => {
  let posts = 0; const { engine, id } = await setup({ sleep: async () => undefined, provider: service(async () => { posts++; throw new ProviderError('HTTP', { status: 429, outcome: 'rejected', safeRetry: true }); }) }); await engine.execute('updateTask', { id, retry: true }); await engine.execute('submitTask', { id }); await engine.drain(); assert.equal(posts, 3); assert.equal(engine.getState().tasks[0].jobs[0].status, 'failed');
  let unknownPosts = 0; const second = await setup({ sleep: async () => undefined, provider: service(async () => { unknownPosts++; throw new ProviderError('TIMEOUT', { outcome: 'unknown' }); }) }); await second.engine.execute('updateTask', { id: second.id, retry: true }); await second.engine.execute('submitTask', { id: second.id }); await second.engine.drain(); assert.equal(unknownPosts, 1); assert.equal(second.engine.getState().tasks[0].jobs[0].status, 'unknown');
});

test('multi-image download failure preserves partial results; retry and restart download only missing images', async () => {
  let posts = 0, writes = 0; let fail = true;
  const outputs: OutputService = { stage: output.stage, write: async (image, context) => { writes++; if (context.index === 2 && fail) throw new Error('offline'); return output.write(image, context); } };
  const { engine, id, store, credentials } = await setup({ output: outputs, provider: service(async () => { posts++; return [{ url: 'https://images.example/1.png' }, { url: 'https://images.example/2.png' }]; }) });
  await engine.execute('updateTask', { id, params: { count: 2 } }); await engine.execute('submitTask', { id }); await engine.drain(); assert.equal(posts, 1); assert.equal(engine.getState().tasks[0].jobs[0].results.length, 1); assert.equal(engine.getState().tasks[0].jobs[0].status, 'failed');
  fail = false; engine.stop(); const restarted = new Engine({ store, credentials, provider: service(async () => { posts++; return []; }), output: outputs }); await restarted.init(); await restarted.execute('retryFailed', { id }); await restarted.drain(); assert.equal(posts, 1); assert.equal(writes, 3); assert.equal(restarted.getState().tasks[0].jobs[0].results.length, 2); assert.equal(restarted.getState().tasks[0].jobs[0].status, 'completed');
});

test('partial provider response preserves images and does not auto-generate replacements', async () => {
  let posts = 0; const { engine, id } = await setup({ provider: service(async () => { posts++; throw new ProviderError('PARTIAL_RESULT', { outcome: 'unknown', partialImages: [{ url: 'https://images.example/partial.png' }] }); }) }); await engine.execute('updateTask', { id, retry: true, params: { count: 2 } }); await engine.execute('submitTask', { id }); await engine.drain(); const job = engine.getState().tasks[0].jobs[0]; assert.equal(posts, 1); assert.equal(job.status, 'unknown'); assert.equal(job.results.length, 1);
});

test('provider cannot edit/delete while queued or in-flight; deleting its finished task never falls back to another provider', async () => {
  const wait = deferred<Array<{ url: string }>>(); let posts = 0; const { engine } = await setup({ provider: service(async () => { posts++; return wait.promise; }) });
  await engine.execute('testProvider', { baseURL: 'https://custom.example/v1', key: 'custom-test-key' }); await engine.execute('saveProvider', { name: 'Custom', baseURL: 'https://custom.example/v1', key: 'custom-test-key', enabledModels: [...BUILTIN_MODELS] }); const provider = engine.getState().providers[1]; const id = engine.getState().tasks[0].id; await engine.execute('updateTask', { id, params: { providerId: provider.id } }); await engine.execute('submitTask', { id }); await until(() => posts === 1);
  await assert.rejects(engine.execute('deleteProvider', { id: provider.id }), /不能删除/); await assert.rejects(engine.execute('saveProvider', { ...provider, name: 'changed' }), /再编辑/); wait.resolve([{ url: 'https://images.example/one.png' }]); await engine.drain(); await engine.execute('deleteProvider', { id: provider.id }); assert.ok(engine.getState().providers.some(item => item.id === 'builtin')); assert.deepEqual(engine.getState().tasks[0].params, { providerId: '', model: '', quality: '', size: '', count: 1 }); await assert.rejects(engine.execute('submitTask', { id })); assert.equal(posts, 1);
});

test('credential revision rejects retry even after same-origin key changes', async () => {
  let posts = 0; const { engine, id } = await setup({ provider: service(async () => { posts++; throw new ProviderError('HTTP', { status: 400, outcome: 'rejected' }); }) }); await engine.execute('submitTask', { id }); await engine.drain(); await engine.execute('testProvider', { id: 'builtin', baseURL: BUILTIN_URL, key: 'replacement-test-key' }); await engine.execute('saveProvider', { id: 'builtin', name: 'Test', baseURL: BUILTIN_URL, key: 'replacement-test-key', enabledModels: [...BUILTIN_MODELS] }); await assert.rejects(engine.execute('retryFailed', { id }), /Key 已更改/); assert.equal(posts, 1);
});

test('SQLite snapshots survive reopen, contain no images/keys, and failed replace preserves old transaction', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'qingtu-store-')); const path = join(dir, 'queue.sqlite'); let fail = false; const store = new SQLiteStore(path, { beforeReplace: async () => { if (fail) throw new Error('simulated disk failure'); } });
  try { const { engine, id } = await setup({ store }); const first = await store.load(); fail = true; await assert.rejects(engine.execute('updateTask', { id, prompt: 'not committed' })); assert.deepEqual(await store.load(), first); fail = false; await store.close(); const reopened = new SQLiteStore(path); assert.deepEqual(await reopened.load(), first); assert.equal((await readFile(path)).subarray(0, 15).toString(), 'SQLite format 3'); assert.ok(!(await readFile(path)).includes(Buffer.from('test-key-not-real'))); await reopened.close(); } finally { await store.close(); await rm(dir, { recursive: true, force: true }); }
});

test('staged output is recovered after a crash before SQLite sources commit without regeneration', async () => {
  const memory = new MemoryStore(); let fail = false, posts = 0; let staged: Array<{ id: string }> = [];
  const store: StateStore = { load: () => memory.load(), save: async snapshot => { if (fail && Object.values(snapshot.jobs).some(j => j.sources?.length)) throw new Error('crash boundary'); await memory.save(snapshot); } };
  const outputs: OutputService = { stage: async (images, context) => { staged = await output.stage(images, context); return staged; }, recover: async () => staged, write: output.write };
  const { engine, id, credentials } = await setup({ store, output: outputs, provider: service(async () => { posts++; return [{ url: 'https://images.example/crash.png' }]; }) });
  fail = true; await engine.execute('submitTask', { id }); await engine.drain(); assert.equal(posts, 1); assert.equal(staged.length, 1); assert.equal((await memory.load())!.jobs[engine.getState().tasks[0].jobs[0].id].sources, undefined);
  fail = false; const restarted = new Engine({ store, credentials, output: outputs, provider: service(async () => { posts++; return []; }) }); await restarted.init(); await restarted.execute('retryFailed', { id }); await restarted.drain(); assert.equal(posts, 1); assert.equal(restarted.getState().tasks[0].jobs[0].status, 'completed');
});

test('an outstanding safe rejection backoff survives restart and still honors pause', async () => {
  const sleeping = deferred<void>(); let posts = 0;
  const { engine, id, store, credentials } = await setup({ sleep: () => sleeping.promise, provider: service(async () => { posts++; throw new ProviderError('HTTP', { outcome: 'rejected', safeRetry: true, status: 429, retryAfterMs: 2000 }); }) });
  await engine.execute('updateTask', { id, retry: true }); await engine.execute('submitTask', { id }); await until(() => engine.getState().tasks[0].jobs[0]?.status === 'queued' && posts === 1); await engine.execute('pauseTask', { id }); engine.stop();
  const resumedWait = deferred<void>(); let requestedDelay = 0; const restarted = new Engine({ store, credentials, output, sleep: milliseconds => { requestedDelay = milliseconds; return resumedWait.promise; }, provider: service(async () => { posts++; return [{ url: 'https://images.example/recovered.png' }]; }) }); await restarted.init(); assert.ok(requestedDelay > 0 && requestedDelay <= 2000); resumedWait.resolve(); await restarted.drain(); assert.equal(posts, 1); await restarted.execute('resumeTask', { id }); await restarted.drain(); assert.equal(posts, 2);
});

test('known failures retry without forcing an unrelated unknown job to regenerate', async () => {
  let posts = 0; const { engine } = await setup({ provider: service(async () => { posts++; if (posts === 1) throw new ProviderError('TIMEOUT', { outcome: 'unknown' }); if (posts === 2) throw new ProviderError('HTTP', { outcome: 'rejected', status: 400 }); return [{ url: 'https://images.example/retry.png' }]; }) });
  await engine.execute('createTask', { kind: 'batch' }); const id = engine.getState().tasks[1].id; await engine.setRows(id, ['unknown row', 'rejected row']); await engine.execute('submitTask', { id }); await engine.drain(); assert.deepEqual(engine.getState().tasks[1].jobs.map(j => j.status), ['unknown', 'failed']); await engine.execute('retryFailed', { id }); await engine.drain(); assert.equal(posts, 3); assert.deepEqual(engine.getState().tasks[1].jobs.map(j => j.status), ['unknown', 'completed']);
});

test('favorites, use-result references and saved state are durable; returned DTO cannot mutate engine', async () => {
  let passed: string[] = [];
  const refs: EngineOptions['references'] = { read: async reference => ({ name: reference.name, mime: 'image/png', data: new Uint8Array([1, 2]) }), fromResult: async (result, existing) => { passed = existing ?? []; return { id: 'reference-copy', name: result.name, url: 'qingtu-asset://reference-copy' }; } };
  const { engine, id, store } = await setup({ references: refs }); await engine.execute('submitTask', { id }); await engine.drain(); const resultId = engine.getState().tasks[0].jobs[0].results[0].id; await engine.execute('favoriteResult', { resultId }); await engine.markResultSaved(resultId); await engine.execute('useResult', { id, resultId }); assert.deepEqual(passed, []); assert.deepEqual(engine.getState().tasks[0].referenceIds, ['reference-copy']); const dto = engine.getState(); dto.tasks[0].prompt = 'external mutation'; assert.equal(engine.getState().tasks[0].prompt, 'mock image'); const stored = (await store.load())!; assert.equal(stored.state.tasks[0].jobs[0].results[0].favorite, true); assert.equal(stored.state.tasks[0].jobs[0].results[0].saved, true);
});

test('credential replacement before a failed snapshot commit cannot change the old active credentials', async () => {
  const memory = new MemoryStore(); let fail = false; const store: StateStore = { load: () => memory.load(), save: async snapshot => { if (fail) throw new Error('disk'); await memory.save(snapshot); } };
  const { engine } = await setup({ store }); fail = true; await assert.rejects(engine.execute('saveProvider', { id: 'builtin', name: 'changed', baseURL: 'https://new.example/v1', key: 'new-test-key', enabledModels: [] })); const connection = await engine.getProviderConnection('builtin'); assert.equal(connection.baseURL, BUILTIN_URL); assert.equal(connection.key, 'test-key-not-real');
});

test('default provider may be deleted; no replacement is invented on restart and empty tasks are safe', async () => {
  const { engine, id, store, credentials } = await setup(); await engine.execute('deleteProvider', { id: 'builtin' }); assert.deepEqual(engine.getState().providers, []); assert.equal(engine.getState().tasks[0].params.providerId, ''); await assert.rejects(engine.execute('submitTask', { id })); await engine.execute('createTask', { kind: 'batch' }); const restarted = new Engine({ store, credentials, provider: service(), output }); await restarted.init(); assert.deepEqual(restarted.getState().providers, []); assert.equal(restarted.getState().tasks.length, 2);
});

test('concurrent reference additions cannot bypass total bytes limit', async () => {
  const { engine, id } = await setup({ references: { read: async ref => ({ name: ref.name, mime: 'image/png', data: { byteLength: 60 * 1024 * 1024 } as Uint8Array }) } });
  const results = await Promise.allSettled([engine.addReferences(id, [{ id: 'r1', name: 'one.png', url: 'qingtu-asset://r1' }]), engine.addReferences(id, [{ id: 'r2', name: 'two.png', url: 'qingtu-asset://r2' }])]); assert.equal(results.filter(result => result.status === 'fulfilled').length, 1); assert.equal(results.filter(result => result.status === 'rejected').length, 1); assert.equal(engine.getState().tasks[0].referenceIds.length, 1);
});

test('default text candidate is seeded but cannot be used until verified and explicitly enabled', async () => {
  let enhances = 0; const provider: GenerationService = { ...service(), models: async () => [...BUILTIN_MODELS, 'gpt-5.6'].map(id => getModelInfo(id, true)), enhance: async () => { enhances++; return 'polished'; } };
  const engine = new Engine({ store: new MemoryStore(), credentials: new Vault(), provider, output }); await engine.init(); assert.equal(engine.getState().settings.textProviderId, 'builtin'); assert.equal(engine.getState().settings.textModel, 'gpt-5.6'); assert.equal(engine.getState().providers[0].models.find(model => model.id === 'gpt-5.6')?.text, true); await engine.execute('createTask', { kind: 'single' }); const id = engine.getState().tasks[0].id; await engine.execute('updateTask', { id, prompt: 'hello' }); await assert.rejects(engine.execute('enhancePrompt', { id, mode: 'optimize' }), /验证/); assert.equal(enhances, 0);
  await engine.execute('testProvider', { id: 'builtin', key: 'text-test-key' }); await engine.execute('saveProvider', { id: 'builtin', name: 'Text', baseURL: BUILTIN_URL, key: 'text-test-key', enabledModels: [...BUILTIN_MODELS, 'gpt-5.6'] }); await engine.execute('enhancePrompt', { id, mode: 'optimize' }); assert.equal(enhances, 1); assert.equal(engine.getState().tasks[0].prompt, 'polished');
  await engine.execute('saveProvider', { id: 'builtin', name: 'Text', baseURL: BUILTIN_URL, enabledModels: [...BUILTIN_MODELS] }); await assert.rejects(engine.execute('enhancePrompt', { id, mode: 'translate' }), /停用/); assert.equal(enhances, 1);
});

test('text settings validate provider-scoped capability, allow clear, and never fall back to generation provider', async () => {
  const captured: Array<{baseURL:string;key:string;model?:string}> = [];
  const provider: GenerationService = { ...service(), models: async () => [...BUILTIN_MODELS, 'gpt-5.6'].map(id => getModelInfo(id, true)), enhance: async request => { captured.push(request); return 'translated'; } };
  const { engine, id } = await setup({ provider });
  await engine.execute('testProvider', { baseURL: 'https://text.example/v1', key: 'text-provider-key' }); await engine.execute('saveProvider', { name: 'Text provider', baseURL: 'https://text.example/v1', key: 'text-provider-key', enabledModels: ['gpt-5.6'] }); const textProviderId = engine.getState().providers[1].id;
  await assert.rejects(engine.execute('saveSettings', { textProviderId: 'builtin', textModel: BUILTIN_MODELS[0] }), /文本模型/); await assert.rejects(engine.execute('saveSettings', { textProviderId: 'missing', textModel: 'gpt-5.6' })); await engine.execute('saveSettings', { textProviderId, textModel: 'gpt-5.6' }); await engine.execute('enhancePrompt', { id, mode: 'translate' }); assert.equal(captured[0].baseURL, 'https://text.example/v1'); assert.equal(captured[0].key, 'text-provider-key'); assert.equal(captured[0].model, 'gpt-5.6'); assert.equal(engine.getState().tasks[0].params.providerId, 'builtin');
  await engine.execute('saveSettings', { textProviderId: '', textModel: '' }); await assert.rejects(engine.execute('enhancePrompt', { id, mode: 'translate' }), /基础设置/); assert.equal(captured.length, 1); await engine.execute('saveSettings', { textProviderId, textModel: 'gpt-5.6' }); await engine.execute('deleteProvider', { id: textProviderId }); await assert.rejects(engine.execute('enhancePrompt', { id, mode: 'translate' }), /基础设置/); assert.equal(captured.length, 1);
});

test('enhancement snapshots text route and credential; late response never overwrites an edited prompt', async () => {
  const response = deferred<string>(); let started = false; let route: {baseURL:string;key:string;model?:string} | undefined;
  const provider: GenerationService = { ...service(), models: async () => [...BUILTIN_MODELS, 'gpt-5.6'].map(id => getModelInfo(id, true)), enhance: async request => { route = request; started = true; return response.promise; } };
  const { engine, id } = await setup({ provider }); await engine.execute('saveProvider', { id: 'builtin', name: 'Text', baseURL: BUILTIN_URL, enabledModels: [...BUILTIN_MODELS, 'gpt-5.6'] });
  const pending = engine.execute('enhancePrompt', { id, mode: 'optimize' }); await until(() => started); await engine.execute('testProvider', { id: 'builtin', baseURL: 'https://new-text.example/v1', key: 'replacement-text-key' }); await engine.execute('saveProvider', { id: 'builtin', name: 'New text', baseURL: 'https://new-text.example/v1', key: 'replacement-text-key', enabledModels: [...BUILTIN_MODELS, 'gpt-5.6'] }); await engine.execute('updateTask', { id, prompt: 'new user draft' }); response.resolve('outdated response'); await assert.rejects(pending, /已修改/); assert.equal(route?.baseURL, BUILTIN_URL); assert.equal(route?.key, 'test-key-not-real'); assert.equal(engine.getState().tasks[0].prompt, 'new user draft');
});

test('a task without a provider can persist a prompt and strictly typed empty-model draft, but cannot submit', async () => {
  let posts = 0; const { engine, id, store, credentials } = await setup({ provider: service(async () => { posts++; return [{ url: 'https://images.example/never.png' }]; }) });
  await engine.execute('deleteProvider', { id: 'builtin' });
  const params = { providerId: '', model: '', quality: '', size: '', count: 1 };
  await engine.execute('updateTask', { id, prompt: 'saved without a configured provider', params });
  assert.equal(engine.getState().tasks[0].prompt, 'saved without a configured provider');
  assert.deepEqual(engine.getState().tasks[0].params, params);
  for (const bad of [{ count: '1' }, { count: null }, { count: 0 }, { count: 1.5 }, { count: Infinity }, { quality: null }, { size: 1 }, { providerId: null }, { model: {} }]) await assert.rejects(engine.execute('updateTask', { id, params: { ...params, ...bad } }));
  await assert.rejects(engine.execute('submitTask', { id })); assert.equal(posts, 0);
  const restarted = new Engine({ store, credentials, provider: service(async () => { posts++; return []; }), output }); await restarted.init();
  assert.equal(restarted.getState().tasks[0].prompt, 'saved without a configured provider'); assert.deepEqual(restarted.getState().tasks[0].params, params); await assert.rejects(restarted.execute('submitTask', { id })); assert.equal(posts, 0);
});
