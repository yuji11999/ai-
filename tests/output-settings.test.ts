import test from 'node:test';
import assert from 'node:assert/strict';
import { Engine, type CredentialStore, type EngineOptions, type OutputService } from '../src/main/engine';
import { MemoryStore } from '../src/main/store';
import { getModelInfo } from '../src/main/provider';
import { BUILTIN_MODELS, BUILTIN_URL } from '../src/shared/types';

class Vault implements CredentialStore {
  values = new Map<string, string>();
  async get(id: string) { return this.values.get(id); }
  async set(id: string, key: string) { this.values.set(id, key); }
  async delete(id: string) { this.values.delete(id); }
}
const output: OutputService = { async stage() { throw new Error('unexpected generation'); }, async write() { throw new Error('unexpected output'); } };
function makeEngine(store: MemoryStore, credentials: Vault) {
  const options: EngineOptions = { store, credentials, output, provider: { async generate() { throw new Error('unexpected generation'); }, async models() { return BUILTIN_MODELS.map(id => getModelInfo(id, true)); }, async enhance() { return ''; } } };
  return new Engine(options);
}

test('new submissions use saved output settings while queued jobs keep their snapshot', async () => {
  const store = new MemoryStore(), credentials = new Vault(), engine = makeEngine(store, credentials);
  await engine.init();
  await engine.execute('testProvider', { id: 'builtin', baseURL: BUILTIN_URL, key: 'local-test-key' });
  await engine.execute('saveProvider', { id: 'builtin', name: 'Test', baseURL: BUILTIN_URL, key: 'local-test-key', enabledModels: [...BUILTIN_MODELS] });
  await engine.execute('createTask', { kind: 'batch' });
  const first = engine.getState().tasks[0].id;
  await engine.setRows(first, ['one', 'second']);
  await engine.execute('updateTask', { id: first, outputDirectory: 'C:\\legacy', naming: 'legacy_{序号}', params: { count: 4 } });
  await assert.rejects(engine.execute('saveSettings', { naming: '../invalid' }), /命名规则/);
  await assert.rejects(engine.execute('saveSettings', { naming: 'bad.' }), /命名规则/);
  await assert.rejects(engine.execute('saveSettings', { namingMode: 'custom' }), /文件命名方式/);
  await engine.execute('saveSettings', { outputDirectory: 'C:\\first', naming: '图_{序号}', outputLayout: 'flat' });
  engine.stop();
  await engine.execute('submitTask', { id: first });
  const firstJob = engine.getState().tasks[0].jobs[0].id;
  await engine.execute('saveSettings', { outputDirectory: 'C:\\second', namingMode: 'date-sequence', outputLayout: 'grouped' });
  await engine.execute('createTask', { kind: 'batch' });
  const second = engine.getState().tasks[1].id;
  await engine.setRows(second, ['two']);
  await engine.execute('submitTask', { id: second });
  const secondJob = engine.getState().tasks[1].jobs[0].id;
  const snapshot = (await store.load())!;
  assert.equal(snapshot.jobs[firstJob].context.outputDirectory, 'C:\\first');
  assert.equal(snapshot.jobs[firstJob].context.naming, '{日期}_{序号}');
  assert.equal(snapshot.jobs[firstJob].context.namingMode, 'date-sequence');
  assert.equal(snapshot.jobs[firstJob].context.outputLayout, 'flat');
  assert.equal(snapshot.jobs[engine.getState().tasks[0].jobs[1].id].context.sequence, 5);
  assert.equal(snapshot.jobs[secondJob].context.outputDirectory, 'C:\\second');
  assert.equal(snapshot.jobs[secondJob].context.naming, '{日期}_{序号}');
  assert.equal(snapshot.jobs[secondJob].context.namingMode, 'date-sequence');
  assert.equal(snapshot.jobs[secondJob].context.outputLayout, 'grouped');
  assert.equal(snapshot.jobs[secondJob].context.sequence, 1);
});

test('legacy custom settings migrate to a preset without discarding task data', async () => {
  const store = new MemoryStore(), credentials = new Vault(), first = makeEngine(store, credentials);
  await first.init();
  await first.execute('createTask', { kind: 'batch' });
  const id = first.getState().tasks[0].id;
  await first.execute('updateTask', { id, naming: '旧_{序号}' });
  first.stop();
  const previous = (await store.load())!;
  delete previous.state.settings.naming;
  previous.state.settings.namingMode = 'custom';
  await store.save(previous);
  const restarted = makeEngine(store, credentials);
  await restarted.init();
  assert.equal(restarted.getState().settings.naming, '{日期}_{序号}');
  assert.equal(restarted.getState().settings.namingMode, 'date-sequence');
  assert.equal(restarted.getState().tasks[0].naming, '旧_{序号}');
  restarted.stop();
});
