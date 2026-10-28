import test from 'node:test';
import assert from 'node:assert/strict';
import { Engine, type CredentialStore, type EngineOptions, type ReferenceInput } from '../src/main/engine';
import { MemoryStore } from '../src/main/store';
import { getModelInfo, ProviderError } from '../src/main/provider';
import { BUILTIN_MODELS, BUILTIN_URL, type Reference } from '../src/shared/types';

class Vault implements CredentialStore {
  values = new Map<string, string>();
  async get(id: string) { return this.values.get(id); }
  async set(id: string, key: string) { this.values.set(id, key); }
  async delete(id: string) { this.values.delete(id); }
}

test('batch rows carry their own references through submission and retry', async () => {
  const captured: { prompt: string; count: number; references: string[] }[] = [];
  const store = new MemoryStore(), credentials = new Vault();
  let failSecondOnce = true;
  const options: EngineOptions = {
    store, credentials,
    references: { async read(reference): Promise<ReferenceInput> { return { name: reference.name, mime: 'image/png', data: new Uint8Array([1]) }; } },
    provider: {
      async generate({ prompt, params, references }) {
        captured.push({ prompt, count: params.count, references: references.map(reference => reference.name) });
        if (prompt === '第二行' && failSecondOnce) { failSecondOnce = false; throw new ProviderError('HTTP', { status: 400, outcome: 'rejected' }); }
        return Array.from({ length: params.count }, (_, index) => ({ url: `https://example.test/${index}.png` }));
      },
      async models() { return BUILTIN_MODELS.map(id => getModelInfo(id, true)); }, async enhance() { return ''; },
    },
    output: { async stage(images, context) { return images.map((_, index) => ({ id: `${context.jobId}-${index}` })); }, async write(image) { return { id: image.id, name: '结果.png', url: `qingtu-asset://${image.id}`, favorite: false, saved: false }; } },
  };
  const engine = new Engine(options);
  await engine.init();
  assert.equal(engine.getState().features?.batchReferencePaths, true);
  await engine.execute('testProvider', { id: 'builtin', baseURL: BUILTIN_URL, key: 'test-key' });
  await engine.execute('saveProvider', { id: 'builtin', name: 'Test', baseURL: BUILTIN_URL, key: 'test-key', enabledModels: [...BUILTIN_MODELS] });
  await engine.execute('createTask', { kind: 'batch' });
  const id = engine.getState().tasks[0].id;
  const a: Reference = { id: 'a', name: '参考图一.png', url: 'qingtu-asset://a' };
  const b: Reference = { id: 'b', name: '参考图二.png', url: 'qingtu-asset://b' };
  await assert.rejects(engine.setRows(id, [''], [a]), /不能为空提示词/);
  await engine.setRows(id, ['第一行', '第二行', '第三行', '第四行'], [a, b, null, a]);
  await engine.execute('updateTask', { id, params: { count: 4 } });
  assert.deepEqual(engine.getState().tasks[0].rowReferenceIds, ['a', 'b', null, 'a']);
  assert.equal(engine.getState().tasks[0].rowsPending, true);
  await engine.execute('submitTask', { id });
  await engine.drain();
  const initial = engine.getState().tasks[0];
  assert.equal(initial.rowsPending, false);
  assert.deepEqual(initial.jobs.map(job => job.referenceIds), [['a'], ['b'], [], ['a']]);
  assert.deepEqual(captured.map(call => [call.prompt, call.count, call.references]).sort(), [
    ['第一行', 4, ['参考图一.png']], ['第二行', 4, ['参考图二.png']], ['第三行', 4, []], ['第四行', 4, ['参考图一.png']],
  ].sort());
  assert.equal(initial.jobs[1].status, 'failed');
  await engine.execute('retryFailed', { id });
  await engine.drain();
  assert.deepEqual(captured.filter(call => call.prompt === '第二行').map(call => call.references), [['参考图二.png'], ['参考图二.png']]);
  await engine.setRows(id, ['新的导入'], [b]);
  const reimported = engine.getState().tasks[0];
  assert.equal(reimported.rowsPending, true);
  assert.deepEqual(reimported.rows, ['新的导入']);
  assert.equal(reimported.jobs.length, 4);
  await engine.execute('submitTask', { id });
  await engine.drain();
  assert.equal(engine.getState().tasks[0].rowsPending, false);
  assert.deepEqual(engine.getState().tasks[0].jobs.at(-1)?.referenceIds, ['b']);
  engine.stop();
});
