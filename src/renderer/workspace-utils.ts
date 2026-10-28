import type { Job, Task, TaskKind } from '../shared/types';
import { isAppState } from './model-utils';

/** Reuse an unfinished draft so opening the workspace does not accumulate empty tasks. */
export function findWorkspaceDraft(tasks: Task[], kind: TaskKind): Task | undefined {
  return [...tasks].reverse().find(task => task.kind === kind && task.jobs.length === 0);
}

/** Single-image drafts appear in the history only after their first submission. */
export function visibleWorkspaceTasks(tasks: Task[], kind: TaskKind, selected?: string): Task[] {
  return tasks.filter(task => task.kind === kind && (kind === 'single' ? task.jobs.length > 0 : task.id !== selected || task.jobs.length > 0))
    .sort((a, b) => b.createdAt - a.createdAt);
}

/** A submitted prompt remains the task label even after the composer is cleared. */
export function workspaceTaskLabel(task: Task): string {
  return task.customTitle || (task.kind === 'single' ? task.jobs.at(-1)?.prompt || task.prompt : task.prompt) || task.title || (task.kind === 'single' ? '新建任务' : '批量任务');
}

export function hasNewSingleSubmission(task: Task, response: unknown): boolean {
  if (task.kind !== 'single' || !isAppState(response)) return false;
  const previous = new Set(task.jobs.map(job => job.id));
  return response.tasks.find(item => item.id === task.id)?.jobs.some(job => !previous.has(job.id)) ?? false;
}

export function clearPromptIfUnchanged<T extends { prompt: string }>(draft: T, expectedRevision: number, currentRevision: number): T | undefined {
  return expectedRevision === currentRevision ? { ...draft, prompt: '' } : undefined;
}

export function groupJobsByRun(jobs: Job[]): { run: number; jobs: Job[] }[] {
  const groups = new Map<number, Job[]>();
  for (const job of jobs) {
    const group = groups.get(job.run) ?? [];
    group.push(job);
    groups.set(job.run, group);
  }
  return [...groups].sort(([a], [b]) => a - b).map(([run, items]) => ({ run, jobs: items }));
}
