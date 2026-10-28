import test from 'node:test';
import assert from 'node:assert/strict';
import type { Job, Task, TaskKind } from '../shared/types';
import { clearPromptIfUnchanged, findWorkspaceDraft, groupJobsByRun, hasNewSingleSubmission, visibleWorkspaceTasks, workspaceTaskLabel } from './workspace-utils';

function task(id: string, kind: TaskKind, jobs: Job[] = []): Task {
  return { id, kind, title: id, prompt: '', referenceIds: [], params: { providerId: '', model: '', quality: '', size: '', count: 1 }, rows: [], jobs, paused: false, concurrency: 1, outputDirectory: '', naming: '{序号}', retry: false, createdAt: 1 };
}
const submitted = { id: 'job', status: 'queued', results: [] } as unknown as Job;

test('reuses the newest unsubmitted draft for the requested workspace', () => {
  const tasks = [task('single-old', 'single'), task('batch-draft', 'batch'), task('single-submitted', 'single', [submitted]), task('single-new', 'single')];
  assert.equal(findWorkspaceDraft(tasks, 'single')?.id, 'single-new');
  assert.equal(findWorkspaceDraft(tasks, 'batch')?.id, 'batch-draft');
  assert.equal(findWorkspaceDraft([task('done', 'single', [submitted])], 'single'), undefined);
});

test('the active draft appears on first submit and later runs remain in the same task', () => {
  const otherDraft = task('saved-draft', 'single');
  const current = task('current', 'single');
  const batch = task('batch', 'batch', [submitted]);
  assert.deepEqual(visibleWorkspaceTasks([otherDraft, current, batch], 'single', current.id).map(item => item.id), []);
  current.jobs.push(submitted);
  assert.deepEqual(visibleWorkspaceTasks([otherDraft, current, batch], 'single', current.id).map(item => item.id), ['current']);
  current.jobs.push({ ...submitted, id: 'second-run' });
  assert.deepEqual(visibleWorkspaceTasks([otherDraft, current, batch], 'single', current.id).map(item => item.id), ['current']);
  assert.deepEqual(visibleWorkspaceTasks([otherDraft, current, batch], 'single', 'another-task').map(item => item.id), ['current']);
  assert.deepEqual(visibleWorkspaceTasks([task('batch-draft', 'batch'), batch], 'batch', batch.id).map(item => item.id), ['batch-draft', 'batch']);
});

test('clearing the composer requires a newly accepted single-task job', () => {
  const current = task('current', 'single', [submitted]);
  const state = (tasks: Task[]) => ({ tasks, providers: [], references: [], settings: { outputDirectory: '', format: 'png' } });
  assert.equal(hasNewSingleSubmission(current, undefined), false);
  assert.equal(hasNewSingleSubmission(current, state([current])), false);
  const updated = { ...current, jobs: [...current.jobs, { ...submitted, id: 'next' }] };
  assert.equal(hasNewSingleSubmission(current, state([updated])), true);
  assert.equal(hasNewSingleSubmission({ ...current, kind: 'batch' }, state([updated])), false);
});

test('a later edit is preserved and submitted prompts remain available as task labels', () => {
  const draft = { prompt: '新输入', count: 2 };
  assert.equal(clearPromptIfUnchanged(draft, 3, 4), undefined);
  assert.deepEqual(clearPromptIfUnchanged(draft, 3, 3), { prompt: '', count: 2 });
  const current = task('current', 'single', [{ ...submitted, prompt: '上一轮提示词' }]);
  current.prompt = '';
  assert.equal(workspaceTaskLabel(current), '上一轮提示词');
  current.customTitle = '我的对话';
  current.jobs.push({ ...submitted, id: 'next', prompt: '新的提示词' });
  assert.equal(workspaceTaskLabel(current), '我的对话');
});

test('conversation keeps each run’s prompt, references and results together in run order', () => {
  const first = { ...submitted, id: 'first', run: 1, prompt: '第一轮', referenceIds: ['ref-a'], results: [{ id: 'image-a' }] } as Job;
  const second = { ...submitted, id: 'second', run: 2, prompt: '第二轮', referenceIds: ['ref-b'], results: [{ id: 'image-b' }] } as Job;
  const groups = groupJobsByRun([second, first]);
  assert.deepEqual(groups.map(group => group.run), [1, 2]);
  assert.equal(groups[0].jobs[0].prompt, '第一轮');
  assert.deepEqual(groups[0].jobs[0].referenceIds, ['ref-a']);
  assert.equal(groups[0].jobs[0].results[0].id, 'image-a');
  assert.equal(groups[1].jobs[0].results[0].id, 'image-b');
});
