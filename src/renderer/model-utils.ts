import type { AppState, GenerationParams, Job, ModelInfo, Provider, Task } from '../shared/types';
import { IMAGE_RATIO_PRESETS } from '../shared/image-presets';

export type ModelChoice = { provider: Provider; model: ModelInfo; value: string };
export function modelChoices(providers: Provider[]): ModelChoice[] {
  return providers.flatMap(provider => provider.models.filter(model => model.image && provider.enabledModels.includes(model.id))
    .map(model => ({ provider, model, value: JSON.stringify([provider.id, model.id]) })));
}
export function textModelChoices(providers: Provider[]): ModelChoice[] {
  return providers.flatMap(provider => provider.models.filter(model => model.text && provider.enabledModels.includes(model.id))
    .map(model => ({ provider, model, value: JSON.stringify([provider.id, model.id]) })));
}
export function textSelectionValue(choices: ModelChoice[], providerId?: string, modelId?: string): string {
  return choices.find(choice => choice.provider.id === providerId && choice.model.id === modelId)?.value ?? (providerId || modelId ? '__missing__' : '');
}
export function selectedImageModel(choices: ModelChoice[], params: GenerationParams): ModelChoice | undefined {
  return choices.find(choice => choice.provider.id === params.providerId && choice.model.id === params.model);
}
export function normalizeParams(params: GenerationParams, choice?: ModelChoice): GenerationParams {
  if (!choice) return { providerId: '', model: '', quality: '', size: '', count: 1 };
  const { model, provider } = choice;
  return { providerId: provider.id, model: model.id,
    size: model.sizes.includes(params.size) ? params.size : (model.sizes[0] ?? ''),
    quality: model.qualities.includes(params.quality) ? params.quality : (model.qualities[0] ?? ''),
    count: Math.min(Math.max(1, Number.isFinite(params.count) ? Math.floor(params.count) : 1), Math.max(1, Math.min(4, model.maxImages))) };
}
export function aspectRatio(size: string): string {
  const match = /^(\d+)\s*[x×]\s*(\d+)$/i.exec(size);
  if (!match) return size === 'auto' || !size ? '自动' : size;
  const width = Number(match[1]), height = Number(match[2]);
  if (!width || !height) return '自动';
  const gcd = (a: number, b: number): number => b ? gcd(b, a % b) : a;
  const d = gcd(width, height);
  return `${width / d}:${height / d}`;
}
export function sizeForRatio(model: ModelInfo | undefined, ratio: string): string | undefined {
  const preset = IMAGE_RATIO_PRESETS.find(item => item.ratio === ratio);
  return preset && model?.sizes.includes(preset.size) ? preset.size : undefined;
}
export function is1kPreset(size: string): boolean { return IMAGE_RATIO_PRESETS.some(item => item.size !== 'auto' && item.size === size); }
export function sizeForResolution(model: ModelInfo | undefined, resolution: 'auto' | '1k', current: string): string | undefined {
  if (!model) return undefined;
  if (resolution === 'auto') return model.sizes.includes('auto') ? 'auto' : undefined;
  if (is1kPreset(current) && model.sizes.includes(current)) return current;
  return sizeForRatio(model, '1:1') ?? IMAGE_RATIO_PRESETS.find(item => item.size !== 'auto' && model.sizes.includes(item.size))?.size;
}
export const statusLabels: Record<Job['status'], string> = {
  queued: '排队中', submitting: '正在提交', running: '生成中', downloading: '下载中', completed: '成功', failed: '失败', unknown: '结果未知',
};
export const activeJob = (job: Job) => ['submitting', 'running', 'downloading'].includes(job.status);
export function pendingImageSlots(job: Job): number {
  if (job.status !== 'queued' && !activeJob(job)) return 0;
  return Math.max(0, job.params.count - job.results.length);
}
export function summarizeTask(task: Task) {
  const total = task.jobs.length;
  const completed = task.jobs.filter(job => job.status === 'completed').length;
  const failed = task.jobs.filter(job => job.status === 'failed').length;
  const unknown = task.jobs.filter(job => job.status === 'unknown').length;
  const active = task.jobs.some(activeJob);
  const queued = task.jobs.filter(job => job.status === 'queued').length;
  const results = task.jobs.flatMap(job => job.results);
  const label = active ? `运行中 ${completed}/${total}` : task.paused && queued ? '队列已暂停' : queued ? '排队中'
    : unknown ? `结果未知 · ${unknown} 项` : failed ? `失败 · ${failed} 项` : total ? `已完成 · ${results.length} 张` : '待提交';
  return { total, completed, failed, unknown, active, queued, results, label,
    status: (active ? 'running' : unknown ? 'unknown' : failed ? 'failed' : queued || !total ? 'queued' : 'completed') as Job['status'] };
}
export function isAppState(value: unknown): value is AppState {
  const s = value as AppState | null;
  return !!s && Array.isArray(s.tasks) && Array.isArray(s.providers) && Array.isArray(s.references) && !!s.settings;
}
