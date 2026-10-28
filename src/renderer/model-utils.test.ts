import test from 'node:test';
import assert from 'node:assert/strict';
import type { GenerationParams, Job, ModelInfo, Provider, Task } from '../shared/types';
import { aspectRatio, is1kPreset, isAppState, modelChoices, normalizeParams, pendingImageSlots, sizeForRatio, sizeForResolution, summarizeTask, textModelChoices, textSelectionValue, selectedImageModel } from './model-utils';
import { IMAGE_RATIO_PRESETS } from '../shared/image-presets';

const model: ModelInfo = { id: 'image-model', image: true, reference: true, maxReferences: 8, maxImages: 2, sizes: ['1024x1024', '1536x1024'], qualities: ['low', 'high'], verified: true };
const provider: Provider = { id: 'a', name: '测试供应商', baseURL: 'https://example.invalid/v1', enabledModels: [model.id], models: [model], hasKey: true, builtin: false, connection: 'connected' };
const params: GenerationParams = { providerId: 'removed', model: 'removed', quality: 'unsupported', size: 'unsupported', count: 8 };

test('model choices use only enabled image models and preserve provider identity', () => {
  const choices = modelChoices([provider, { ...provider, id: 'b' }, { ...provider, id: 'c', enabledModels: [] }, { ...provider, id: 'd', models: [{ ...model, image: false }] }]);
  assert.equal(choices.length, 2);
  assert.notEqual(choices[0].value, choices[1].value);
});
test('switching model normalizes only to real provider capabilities', () => {
  assert.deepEqual(normalizeParams(params, modelChoices([provider])[0]), { providerId: 'a', model: 'image-model', quality: 'low', size: '1024x1024', count: 2 });
  assert.deepEqual(normalizeParams(params), { providerId: '', model: '', quality: '', size: '', count: 1 });
});
test('image count stays within the four-image API limit even if model metadata is higher', () => {
  const generous = { ...provider, models: [{ ...model, maxImages: 8 }] };
  assert.equal(normalizeParams({ ...params, count: 8 }, modelChoices([generous])[0]).count, 4);
  assert.equal(normalizeParams({ ...params, count: 3 }, modelChoices([generous])[0]).count, 3);
});
test('unknown capabilities do not invent sizes or qualities', () => {
  const unknown = { ...provider, models: [{ ...model, sizes: [], qualities: [], maxImages: 1, reference: false, maxReferences: 0 }] };
  assert.deepEqual(normalizeParams(params, modelChoices([unknown])[0]), { providerId: 'a', model: 'image-model', quality: '', size: '', count: 1 });
});
test('aspect ratio is calculated from actual dimensions rather than inaccurate prototype labels', () => {
  assert.equal(aspectRatio('1024x1024'), '1:1');
  assert.equal(aspectRatio('1536x1024'), '3:2');
  assert.equal(aspectRatio('1216x832'), '19:13');
  assert.equal(aspectRatio('864×1152'), '3:4');
  assert.equal(aspectRatio('auto'), '自动');
});
test('ratio and 1K options resolve to explicit supported pixel sizes', () => {
  const supported = { ...model, sizes: IMAGE_RATIO_PRESETS.map(item => item.size) };
  for (const { ratio, size } of IMAGE_RATIO_PRESETS) assert.equal(sizeForRatio(supported, ratio), size);
  assert.equal(sizeForResolution(supported, '1k', 'auto'), '1024x1024');
  assert.equal(sizeForResolution(supported, '1k', '864x1536'), '864x1536');
  assert.equal(sizeForResolution(supported, 'auto', '864x1536'), 'auto');
  assert.equal(is1kPreset('2048x2048'), false);
  assert.equal(sizeForRatio({ ...model, sizes: ['auto'] }, '16:9'), undefined);
  assert.equal(sizeForResolution({ ...model, sizes: ['auto'] }, '1k', 'auto'), undefined);
});
test('progress counts completed jobs and never fabricates a percentage while submitting', () => {
  const task = { jobs: [{ status: 'completed', results: [{ id: 'result' }] }, { status: 'submitting', results: [] }, { status: 'unknown', results: [] }], paused: false } as unknown as Task;
  const summary = summarizeTask(task);
  assert.equal(summary.completed, 1); assert.equal(summary.total, 3); assert.equal(summary.unknown, 1); assert.equal(summary.active, true); assert.equal(summary.label, '运行中 1/3');
});
test('unknown requests remain visibly unknown rather than failed or completed', () => {
  const summary = summarizeTask({ jobs: [{ status: 'unknown', results: [] }], paused: false } as unknown as Task);
  assert.equal(summary.status, 'unknown'); assert.equal(summary.failed, 0); assert.equal(summary.label, '结果未知 · 1 项');
});
test('pending image slots track expected images without masking failures or completed results', () => {
  const job = { status: 'queued', params: { count: 3 }, results: [] } as unknown as Job;
  assert.equal(pendingImageSlots(job), 3);
  job.status = 'running'; job.results = [{ id: 'ready' }] as Job['results'];
  assert.equal(pendingImageSlots(job), 2);
  job.status = 'downloading'; assert.equal(pendingImageSlots(job), 2);
  job.status = 'unknown'; assert.equal(pendingImageSlots(job), 0);
  job.status = 'failed'; assert.equal(pendingImageSlots(job), 0);
  job.status = 'completed'; assert.equal(pendingImageSlots(job), 0);
});
test('bridge accepts application snapshots but not a model list or cancelled result', () => {
  assert.equal(isAppState([model]), false); assert.equal(isAppState(null), false);
  assert.equal(isAppState({ tasks: [], providers: [], references: [], settings: { outputDirectory: '', format: 'png' } }), true);
});


test('text model selector only includes enabled text models and never falls back', () => {
  const textModel = { ...model, id: 'qa-text', image: false, text: true };
  const choices = textModelChoices([{ ...provider, enabledModels: [model.id, textModel.id], models: [model, textModel] }]);
  assert.equal(choices.length, 1); assert.equal(choices[0].model.id, 'qa-text');
  assert.equal(textSelectionValue(choices, 'a', 'qa-text'), choices[0].value);
  assert.equal(textSelectionValue(choices, 'removed', 'old'), '__missing__');
  assert.equal(textSelectionValue([], 'a', 'qa-text'), '__missing__');
  assert.equal(textSelectionValue([], '', ''), '');
});


test('empty or deleted task provider never silently switches to the next provider', () => {
  const choices = modelChoices([provider]);
  assert.equal(selectedImageModel(choices, { ...params, providerId: '', model: '' }), undefined);
  assert.equal(selectedImageModel(choices, params), undefined);
  assert.equal(selectedImageModel(choices, { ...params, providerId: provider.id, model: model.id })?.provider.id, 'a');
});
