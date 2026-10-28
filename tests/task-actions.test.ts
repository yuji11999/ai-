import test from 'node:test';
import assert from 'node:assert/strict';
import { Engine, type EngineOptions } from '../src/main/engine';
import { MemoryStore } from '../src/main/store';

function makeEngine(store: MemoryStore) {
  const options: EngineOptions = {
    store,
    credentials: { async get() { return undefined; }, async set() {}, async delete() {} },
    provider: { async generate() { throw new Error('unexpected request'); }, async models() { return []; }, async enhance() { return ''; } },
    output: { async stage() { throw new Error('unexpected output'); }, async write() { throw new Error('unexpected output'); } },
  };
  return new Engine(options);
}

test('renaming persists and deletion preserves the archived task and its data', async () => {
  const store = new MemoryStore();
  const engine = makeEngine(store);
  await engine.init();
  await engine.execute('createTask', { kind: 'single' });
  const id = engine.getState().tasks[0].id;
  await engine.execute('updateTask', { id, prompt: '原始内容' });
  await assert.rejects(engine.execute('renameTask', { id, title: '  ' }), /不能为空/);
  await engine.execute('renameTask', { id, title: '  自定义名称  ' });
  assert.equal(engine.getState().tasks[0].customTitle, '自定义名称');
  await engine.execute('deleteTask', { id });
  assert.equal(engine.getState().tasks.length, 0);
  const saved = (await store.load())!.state.tasks[0];
  assert.equal(saved.archived, true);
  assert.equal(saved.prompt, '原始内容');
  assert.equal(saved.customTitle, '自定义名称');
  await assert.rejects(engine.execute('updateTask', { id, prompt: '不应修改' }), /找不到任务/);
  engine.stop();
  const restarted = makeEngine(store);
  await restarted.init();
  assert.equal(restarted.getState().tasks.length, 0);
  assert.equal((await store.load())!.state.tasks[0].prompt, '原始内容');
  await restarted.execute('createTask', { kind: 'single' });
  assert.equal(restarted.getState().tasks.length, 1);
  restarted.stop();
});

test('queued tasks cannot be deleted', async () => {
  const store = new MemoryStore();
  const first = makeEngine(store);
  await first.init();
  await first.execute('createTask', { kind: 'single' });
  const id = first.getState().tasks[0].id;
  first.stop();
  const snapshot = (await store.load())!;
  const task = snapshot.state.tasks[0];
  task.paused = true;
  task.jobs.push({ id: 'queued-job', row: 0, run: 1, prompt: '待处理', referenceIds: [], params: task.params, status: 'queued', results: [], createdAt: 1, attempts: 0 });
  await store.save(snapshot);
  const engine = makeEngine(store);
  await engine.init();
  await assert.rejects(engine.execute('deleteTask', { id }), /执行或排队/);
  assert.equal(engine.getState().tasks.length, 1);
  engine.stop();
});
