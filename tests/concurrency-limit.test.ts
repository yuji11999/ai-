import test from 'node:test';
import assert from 'node:assert/strict';
import { Engine, type CredentialStore, type EngineOptions, type ProviderImage } from '../src/main/engine';
import { MemoryStore } from '../src/main/store';
import { getModelInfo } from '../src/main/provider';
import { BUILTIN_MODELS, BUILTIN_URL } from '../src/shared/types';

class Vault implements CredentialStore {
  values = new Map<string, string>();
  async get(id: string) { return this.values.get(id); }
  async set(id: string, key: string) { this.values.set(id, key); }
  async delete(id: string) { this.values.delete(id); }
}
async function until(condition: () => boolean) {
  for (let i = 0; i < 1000; i++) { if (condition()) return; await new Promise(resolve => setImmediate(resolve)); }
  throw new Error('state timeout');
}
async function setup() {
  const calls: { count: number; prompt: string; resolve: (images: ProviderImage[]) => void; reject: (error: Error) => void }[] = [];
  const store = new MemoryStore();
  const options: EngineOptions = {
    store, credentials: new Vault(),
    provider: { generate: ({ params, prompt }) => new Promise((resolve, reject) => calls.push({ count: params.count, prompt, resolve, reject })), async models() { return BUILTIN_MODELS.map(id => getModelInfo(id, true)); }, async enhance() { return ''; } },
    output: { async stage(images, context) { return images.map((_, index) => ({ id: `${context.jobId}-${index}` })); }, async write(image) { return { id: image.id, name: `${image.id}.png`, url: `qingtu-asset://${image.id}`, favorite: false, saved: false }; } },
  };
  const engine = new Engine(options);
  await engine.init();
  await engine.execute('testProvider', { id: 'builtin', baseURL: BUILTIN_URL, key: 'local-test-key' });
  await engine.execute('saveProvider', { id: 'builtin', name: 'Test', baseURL: BUILTIN_URL, key: 'local-test-key', enabledModels: [...BUILTIN_MODELS] });
  return { engine, calls, options };
}
const images = (count: number): ProviderImage[] => Array.from({ length: count }, (_, index) => ({ url: `https://images.example/${index}` }));

test('five individual jobs can run; a sixth waits for a completed slot', async () => {
  const { engine, calls } = await setup();
  const ids: string[] = [];
  for (let index = 0; index < 6; index++) {
    await engine.execute('createTask', { kind: 'single' });
    const task = engine.getState().tasks.at(-1)!;
    ids.push(task.id);
    await engine.execute('updateTask', { id: task.id, prompt: `prompt ${index}`, params: { count: 4 } });
    if (index < 5) await engine.execute('submitTask', { id: task.id });
  }
  await until(() => calls.length === 5);
  assert.deepEqual(calls.map(call => call.count), [4, 4, 4, 4, 4]);
  await assert.rejects(engine.execute('submitTask', { id: ids[5] }), /5 个/);
  calls[0].resolve(images(4));
  await until(() => engine.getState().tasks[0].jobs[0].status === 'completed');
  await engine.execute('submitTask', { id: ids[5] });
  await until(() => calls.length === 6);
  for (const call of calls.slice(1)) call.resolve(images(4));
  await engine.drain();
  assert.equal(engine.getState().tasks.flatMap(task => task.jobs).filter(job => job.status === 'completed').length, 6);
  engine.stop();
});

test('batch rows share five slots and start the next row when one finishes', async () => {
  const { engine, calls } = await setup();
  await engine.execute('createTask', { kind: 'batch' });
  const id = engine.getState().tasks[0].id;
  await engine.setRows(id, ['1', '2', '3', '4', '5', '6', '7']);
  await engine.execute('updateTask', { id, params: { count: 4 }, concurrency: 1 });
  await engine.execute('submitTask', { id });
  await until(() => calls.length === 5);
  assert.deepEqual(calls.map(call => call.count), [4, 4, 4, 4, 4]);
  assert.equal(engine.getState().tasks[0].jobs.filter(job => job.status === 'queued').length, 2);
  calls[0].resolve(images(4));
  await until(() => calls.length === 6);
  assert.equal(engine.getState().tasks[0].jobs.filter(job => job.status === 'queued').length, 1);
  calls[1].resolve(images(4));
  await until(() => calls.length === 7);
  for (const call of calls.slice(2)) call.resolve(images(4));
  await engine.drain();
  assert.equal(engine.getState().tasks[0].jobs.filter(job => job.status === 'completed').length, 7);
  engine.stop();
});

test('single and batch requests share the same five slots', async () => {
  const { engine, calls } = await setup();
  await engine.execute('createTask', { kind: 'single' });
  const single = engine.getState().tasks[0].id;
  await engine.execute('updateTask', { id: single, prompt: 'one' });
  await engine.execute('submitTask', { id: single });
  await until(() => calls.length === 1);
  await engine.execute('createTask', { kind: 'batch' });
  const batch = engine.getState().tasks[1].id;
  await engine.setRows(batch, ['1', '2', '3', '4', '5', '6']);
  await engine.execute('submitTask', { id: batch });
  await until(() => calls.length === 5);
  assert.equal(engine.getState().tasks[1].jobs.filter(job => job.status === 'queued').length, 2);
  calls[0].resolve(images(1));
  await until(() => calls.length === 6);
  assert.equal(engine.getState().tasks[1].jobs.filter(job => job.status === 'queued').length, 1);
  calls[1].resolve(images(1));
  await until(() => calls.length === 7);
  for (const call of calls.slice(2)) call.resolve(images(1));
  await engine.drain();
  engine.stop();
});

test('paused batch backlog does not consume single generation slots', async () => {
  const { engine, calls } = await setup();
  await engine.execute('createTask', { kind: 'batch' });
  const batch = engine.getState().tasks[0].id;
  await engine.setRows(batch, Array.from({ length: 10 }, (_, index) => `row ${index}`));
  await engine.execute('submitTask', { id: batch });
  await until(() => calls.length === 5);
  await engine.execute('pauseTask', { id: batch });
  for (const call of calls) call.resolve(images(1));
  await until(() => engine.getState().tasks[0].jobs.filter(job => job.status === 'completed').length === 5);
  assert.equal(engine.getState().tasks[0].jobs.filter(job => job.status === 'queued').length, 5);
  await engine.execute('createTask', { kind: 'single' });
  const single = engine.getState().tasks[1].id;
  await engine.execute('updateTask', { id: single, prompt: 'new request' });
  await engine.execute('submitTask', { id: single });
  await until(() => calls.length === 6);
  calls[5].resolve(images(1));
  await engine.drain();
  assert.equal(engine.getState().tasks[1].jobs[0].status, 'completed');
  assert.equal(engine.getState().tasks[0].jobs.filter(job => job.status === 'queued').length, 5);
  engine.stop();
});

test('an eligible single request gets a slot ahead of a batch backlog after restart', async () => {
  const { engine, calls, options } = await setup();
  engine.stop();
  await engine.execute('createTask', { kind: 'batch' });
  const batch = engine.getState().tasks[0].id;
  await engine.setRows(batch, ['1', '2', '3', '4', '5', '6', '7']);
  await engine.execute('submitTask', { id: batch });
  await engine.execute('createTask', { kind: 'single' });
  const single = engine.getState().tasks[1].id;
  await engine.execute('updateTask', { id: single, prompt: 'interactive' });
  await engine.execute('submitTask', { id: single });
  const restarted = new Engine(options);
  await restarted.init();
  await until(() => calls.length === 5);
  assert.equal(calls[0].prompt, 'interactive');
  for (const call of calls) call.resolve(images(1));
  await until(() => calls.length === 8);
  for (const call of calls.slice(5)) call.resolve(images(1));
  await restarted.drain();
  restarted.stop();
});

test('failed or unknown requests release a slot without an automatic retry', async () => {
  const { engine, calls } = await setup();
  await engine.execute('createTask', { kind: 'batch' });
  const id = engine.getState().tasks[0].id;
  await engine.setRows(id, ['1', '2', '3', '4', '5', '6']);
  await engine.execute('submitTask', { id });
  await until(() => calls.length === 5);
  calls[0].reject(new Error('simulated network error'));
  await until(() => calls.length === 6);
  for (const call of calls.slice(1)) call.resolve(images(1));
  await engine.drain();
  assert.equal(calls.length, 6);
  assert.equal(engine.getState().tasks[0].jobs[0].status, 'unknown');
  assert.equal(engine.getState().tasks[0].jobs.filter(job => job.status === 'completed').length, 5);
  engine.stop();
});
