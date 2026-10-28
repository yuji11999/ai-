import { createHash, randomUUID } from 'node:crypto';
import { getModelInfo, validateGenerationParams } from './provider';
import { isAbsolute, win32 } from 'node:path';
import { BUILTIN_MODELS, BUILTIN_URL, type Action, type AppState, type GenerationParams, type Job, type ModelInfo, type Provider, type Reference, type ResultImage, type Task, type TaskKind } from '../shared/types';

export interface ProviderImage { bytes?: Uint8Array; url?: string; mime?: string }
export interface ReferenceInput { name: string; mime: string; data: Uint8Array }
export interface GenerationService {
  generate(input: { baseURL: string; key: string; params: GenerationParams; prompt: string; references: ReferenceInput[] }): Promise<ProviderImage[]>;
  models(input: { baseURL: string; key: string }): Promise<ModelInfo[]>;
  enhance(input: { baseURL: string; key: string; model?: string; prompt: string; mode: 'optimize' | 'translate' }): Promise<string>;
}
export interface CredentialStore { get(id: string): Promise<string | undefined>; set(id: string, key: string): Promise<void>; delete(id: string): Promise<void> }
export interface StoredImage { id: string; url?: string; path?: string; mime?: string }
export interface OutputContext { taskId: string; taskKind: TaskKind; jobId: string; run: number; row: number; index: number; outputDirectory: string; naming: string; format: 'png' | 'jpg' | 'webp'; createdAt: number }
export interface OutputService { stage(images: ProviderImage[], context: OutputContext): Promise<StoredImage[]>; recover?(context: OutputContext): Promise<StoredImage[]>; write(image: StoredImage, context: OutputContext): Promise<ResultImage> }
export interface ReferenceService { read(reference: Reference): Promise<ReferenceInput>; fromResult?(result: ResultImage, existingReferenceIds?: string[]): Promise<Reference> }
export interface JobRecord { provider: Pick<Provider, 'id' | 'baseURL'>; references: Reference[]; context: OutputContext; rowId: string; credentialRevision: string; sources?: StoredImage[]; completedSourceIds?: string[]; phase: 'generate' | 'download'; terminal?: 'failed' | 'unknown'; terminalError?: string; retryAt?: number }
export interface EngineSnapshot { schemaVersion: 1; state: AppState; jobs: Record<string, JobRecord>; rowIds: Record<string, string[]>; credentialRevisions: Record<string, string> }
export interface StateStore { load(): Promise<EngineSnapshot | null>; save(snapshot: EngineSnapshot): Promise<void> }
export interface EngineOptions { store: StateStore; provider: GenerationService; credentials: CredentialStore; output: OutputService; references?: ReferenceService; onState?: (state: AppState) => void; now?: () => number; id?: () => string; sleep?: (milliseconds: number) => Promise<void>; version?: string; textModel?: string; defaultOutputDirectory?: string }
const ACTIVE = new Set(['submitting', 'running', 'downloading']);
const PENDING = new Set(['queued', ...ACTIVE]);
const MAX_CONCURRENT_JOBS = 5;
const clone = <T>(value: T): T => structuredClone(value);
const BUILTIN_TEXT_MODEL = 'gpt-5.6';
const builtinModel = (id: string): ModelInfo => getModelInfo(id);
const credentialSlot = (revision: string): string => `cred_${revision}`;
const credentialHash = (key: string): string => createHash('sha256').update(key).digest('hex');
function problem(message: string): never { throw new Error(message); }
function safeText(value: unknown, label: string, max = 20000): string { if (typeof value !== 'string' || value.length > max || value.includes('\0')) problem(`${label}无效。`); return value as string; }
function baseURL(value: unknown): string { const text = safeText(value, '服务地址', 2000).trim(); if (/[\s\\]/.test(text)) problem('服务地址不能包含空白或反斜杠。'); let url: URL; try { url = new URL(text); } catch { return problem('请输入有效的 HTTPS 服务地址。'); } if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) problem('服务地址必须为不含账户、查询或片段的 HTTPS 地址。'); return url.href.replace(/\/+$/, ''); }
function directory(value: unknown): string { const text = safeText(value, '输出目录', 4096); if (text && (!isAbsolute(text) && !win32.isAbsolute(text) || /[\x00-\x1f]/.test(text))) problem('输出目录必须是完整路径。'); return text; }
function naming(value: unknown): string { const text = safeText(value, '命名规则', 100).trim(); if (!text || /[\\/:*?"<>|\x00-\x1f]/.test(text) || /\{(?!序号\}|日期\})/.test(text) || /[{}]/.test(text.replace(/\{序号\}|\{日期\}/g, '')) || /\.$/.test(text)) problem('命名规则只支持 {序号}、{日期}，不能含路径、非法字符或以句点结尾。'); return text; }
function modelsValid(models: ModelInfo[]): ModelInfo[] { return models.filter(model => model && typeof model.id === 'string' && model.id.length > 0 && model.id.length < 200).map(model => getModelInfo(model.id, true)).filter(model => model.image || model.text); }
function errorMessage(error: unknown, fallback: string): string {
  // Do not echo server bodies, keys, signed URLs, file paths, or arbitrary thrown content.
  const candidate = error as { code?: string; status?: number };
  if (candidate?.status === 401 || candidate?.status === 403) return 'API Key 无效或无权使用此模型。';
  if (candidate?.status === 429) return '服务限流，稍后可重试。';
  if (candidate?.code === 'TEXT_MODEL_REQUIRED') return '尚未配置文本模型，暂不支持提示词优化或翻译。';
  return fallback;
}

export class Engine {
  private snapshot!: EngineSnapshot;
  private serial: Promise<unknown> = Promise.resolve();
  private inflight = new Map<string, Promise<void>>();
  private timers = new Set<Promise<void>>();
  private transientSources = new Map<string, ProviderImage[]>();
  private tested = new Map<string, ModelInfo[]>();
  private pumpScheduled = false;
  private pumping = false;
  private repump = false;
  private stopped = false;
  private initialized = false;
  private readonly now: () => number;
  private readonly id: () => string;
  constructor(private readonly options: EngineOptions) { this.now = options.now ?? Date.now; this.id = options.id ?? randomUUID; }
  async init(): Promise<AppState> {
    return this.enqueue(async () => {
      if (this.initialized) return this.getState();
      const stored = await this.options.store.load();
      if (stored) { this.snapshot = clone(stored); this.snapshot.rowIds ??= {}; this.snapshot.credentialRevisions ??= {}; }
      else {
        const provider: Provider = { id: 'builtin', name: '默认服务', baseURL: BUILTIN_URL, enabledModels: [...BUILTIN_MODELS, BUILTIN_TEXT_MODEL], models: [...BUILTIN_MODELS, BUILTIN_TEXT_MODEL].map(builtinModel), hasKey: false, builtin: true, connection: 'untested' };
        this.snapshot = { schemaVersion: 1, state: { tasks: [], providers: [provider], references: [], settings: { outputDirectory: this.options.defaultOutputDirectory ?? '', format: 'png', textProviderId: 'builtin', textModel: BUILTIN_TEXT_MODEL }, version: this.options.version ?? '1.0.0', quota: '暂不可查询' }, jobs: {}, rowIds: {}, credentialRevisions: { builtin: this.id() } };
      }
      this.snapshot.state.settings.naming ??= [...this.snapshot.state.tasks].reverse().find(task => task.kind === 'batch' && !task.archived)?.naming ?? '{序号}_{日期}';
      for (const provider of this.snapshot.state.providers) {
        this.snapshot.credentialRevisions[provider.id] ??= this.id();
        provider.hasKey = Boolean(await this.credential(this.snapshot, provider.id));
        // Refresh built-in UI size presets without changing enabled models or verification.
        for (const model of provider.models) if (model.image && BUILTIN_MODELS.includes(model.id)) model.sizes = [...new Set([...model.sizes, ...getModelInfo(model.id).sizes])];
      }
      for (const record of Object.values(this.snapshot.jobs)) if (record.phase === 'download' && !record.sources?.length && this.options.output.recover) { try { const recovered = await this.options.output.recover(record.context); if (recovered.length) { record.sources = recovered; record.completedSourceIds ??= []; } } catch { /* unavailable files remain retryable and can never trigger regeneration */ } }
      for (const task of this.snapshot.state.tasks) for (const job of task.jobs) if (ACTIVE.has(job.status)) {
        const record = this.snapshot.jobs[job.id];
        if (record?.phase === 'download') { job.status = 'failed'; job.error = record.sources?.length ? '程序退出时图片尚未保存，请重试下载；不会重新生成。' : '生成已返回，但图片未能持久保存。请勿盲目重新生成。'; }
        else { job.status = 'unknown'; job.error = '上次提交结果未知，可能已产生费用；确认后才能重新生成。'; }
        job.endedAt = this.now();
      }
      delete this.snapshot.state.notice; this.snapshot.state.quota = '暂不可查询'; this.snapshot.state.version = this.options.version ?? this.snapshot.state.version;
      await this.options.store.save(this.snapshot); this.initialized = true; this.publish(); for (const [jobId, record] of Object.entries(this.snapshot.jobs)) if (record.retryAt) this.scheduleRetry(jobId, Math.max(0, record.retryAt - this.now())); this.kick(); return this.getState();
    });
  }
  getState(): AppState { if (!this.snapshot) throw new Error('队列尚未初始化。'); const state = clone(this.snapshot.state); state.tasks = state.tasks.filter(task => !task.archived); return state; }
  async getProviderConnection(id: string): Promise<{ baseURL: string; key: string | undefined }> { return this.enqueue(async () => { const provider = this.provider(this.snapshot, id); return { baseURL: provider.baseURL, key: await this.credential(this.snapshot, id) }; }); }
  private credential(draft: EngineSnapshot, id: string): Promise<string | undefined> { const revision = draft.credentialRevisions[id]; return revision ? this.options.credentials.get(credentialSlot(revision)) : Promise.resolve(undefined); }
  hasActiveJobs(): boolean { return Boolean(this.snapshot?.state.tasks.some(task => task.jobs.some(job => ACTIVE.has(job.status)))); }
  async execute(action: Action | string, payload: Record<string, unknown> = {}): Promise<any> {
    if (!this.initialized) throw new Error('队列尚未初始化。');
    if (action === 'getState') return this.getState();
    if (action === 'testProvider') return this.testProvider(payload);
    if (action === 'enhancePrompt') return this.enhance(payload);
    if (action === 'useResult') return this.useResult(payload);
    const result = await this.enqueue(async () => {
      const draft = clone(this.snapshot); const clearedSources: string[] = [];
      switch (action) {
        case 'createTask': this.createTask(draft, payload); break;
        case 'updateTask': this.updateTask(draft, payload); break;
        case 'renameTask': { const task = this.task(draft, payload.id); const title = safeText(payload.title, '名称', 100).trim(); if (!title) problem('名称不能为空。'); task.customTitle = title; break; }
        case 'deleteTask': { const task = this.task(draft, payload.id); if (task.jobs.some(job => PENDING.has(job.status))) problem('任务仍在执行或排队，请等待结束后删除。'); task.archived = true; break; }
        case 'submitTask': await this.submit(draft, payload); break;
        case 'pauseTask': this.task(draft, payload.id).paused = true; break;
        case 'resumeTask': this.task(draft, payload.id).paused = false; break;
        case 'retryFailed': this.retry(draft, payload); break;
        case 'clearTask': { const task = this.task(draft, payload.id); if (task.jobs.some(job => ACTIVE.has(job.status))) problem('任务仍在执行，请等待完成后清空。'); for (const job of task.jobs) { delete draft.jobs[job.id]; clearedSources.push(job.id); } task.jobs = []; task.rows = []; draft.rowIds[task.id] = []; task.paused = false; break; }
        case 'saveProvider': return this.saveProvider(draft, payload);
        case 'deleteProvider': return this.deleteProvider(draft, payload);
        case 'saveSettings': { if (payload.outputDirectory !== undefined) draft.state.settings.outputDirectory = directory(payload.outputDirectory); if (payload.naming !== undefined) draft.state.settings.naming = naming(payload.naming); if (payload.format !== undefined) { if (!['png', 'jpg', 'webp'].includes(String(payload.format))) problem('图片格式无效。'); draft.state.settings.format = payload.format as 'png' | 'jpg' | 'webp'; } if (payload.textProviderId !== undefined || payload.textModel !== undefined) { const providerId = safeText(payload.textProviderId ?? draft.state.settings.textProviderId ?? '', '文本供应商', 128); const modelId = safeText(payload.textModel ?? draft.state.settings.textModel ?? '', '文本模型', 200); if (providerId || modelId) { const provider = this.provider(draft, providerId); if (!provider.enabledModels.includes(modelId) || !provider.models.some(model => model.id === modelId && model.text)) problem('请选择该供应商已启用的文本模型，或清空默认文本配置。'); } draft.state.settings.textProviderId = providerId; draft.state.settings.textModel = modelId; } break; }
        case 'favoriteResult': { const result = this.result(draft, payload.resultId); result.favorite = !result.favorite; break; }
        case 'removeReference': { const task = this.task(draft, payload.id); task.referenceIds = task.referenceIds.filter(id => id !== payload.referenceId); break; }
        default: problem('此操作必须通过桌面窗口执行。');
      }
      await this.commit(draft); for (const jobId of clearedSources) this.transientSources.delete(jobId); return this.getState();
    });
    this.kick(); return result;
  }
  async setRows(id: string, rows: string[]): Promise<AppState> { return this.mutate(draft => { const task = this.task(draft, id); if (task.kind !== 'batch') problem('只能向批量任务导入提示词。'); if (task.jobs.some(j => PENDING.has(j.status))) problem('请先等待当前队列结束。'); if (!Array.isArray(rows) || !rows.length || rows.length > 10000) problem('请导入 1 至 10000 行提示词。'); const validated = rows.map(row => safeText(row, '提示词').trim()).filter(Boolean); if (!validated.length || validated.reduce((n, r) => n + Buffer.byteLength(r), 0) > 20 * 1024 * 1024) problem('导入内容为空或超过 20 MB。'); task.rows = validated; draft.rowIds[task.id] = validated.map(() => this.id()); }); }
  async addReferences(id: string, references: Reference[]): Promise<AppState> { return this.mutate(async draft => { const task = this.task(draft, id); const provider = this.provider(draft, task.params.providerId); const model = provider.models.find(m => m.id === task.params.model); if (!model?.reference || task.referenceIds.length + references.length > model.maxReferences) problem('当前模型不支持这些参考图数量。'); for (const reference of references) { if (!reference.id || !reference.name || !reference.url) problem('参考图无效。'); if (!draft.state.references.some(r => r.id === reference.id)) draft.state.references.push(clone(reference)); if (!task.referenceIds.includes(reference.id)) task.referenceIds.push(reference.id); } if (this.options.references) { let bytes = 0; for (const referenceId of task.referenceIds) { const reference = draft.state.references.find(r => r.id === referenceId)!; const input = await this.options.references.read(reference); bytes += input.data.byteLength; if (bytes > 100 * 1024 * 1024) problem('参考图总大小不能超过 100 MB。'); } } }); }
  async markResultSaved(resultId: string): Promise<AppState> { return this.mutate(draft => { this.result(draft, resultId).saved = true; }); }
  async drain(): Promise<void> { for (;;) { await this.serial; if (this.pumpScheduled || this.pumping) { await new Promise(resolve => setImmediate(resolve)); continue; } const pending = [...this.inflight.values(), ...this.timers]; if (!pending.length) return; await Promise.all(pending); } }
  stop(): void { this.stopped = true; }
  private enqueue<T>(work: () => Promise<T>): Promise<T> { const result = this.serial.then(work, work); this.serial = result.catch(() => undefined); return result; }
  private async mutate(operation: (draft: EngineSnapshot) => void | Promise<void>): Promise<AppState> { const result = await this.enqueue(async () => { const draft = clone(this.snapshot); await operation(draft); await this.commit(draft); return this.getState(); }); this.kick(); return result; }
  private async commit(draft: EngineSnapshot): Promise<void> { try { await this.options.store.save(draft); } catch { throw new Error('无法持久保存队列，操作未提交；请检查磁盘空间和权限。'); } this.snapshot = draft; this.publish(); }
  private publish(): void { try { this.options.onState?.(this.getState()); } catch { /* subscribers never break persistence */ } }
  private task(draft: EngineSnapshot, id: unknown): Task { return draft.state.tasks.find(task => task.id === id && !task.archived) ?? problem('找不到任务。'); }
  private provider(draft: EngineSnapshot, id: unknown): Provider { return draft.state.providers.find(provider => provider.id === id) ?? problem('找不到供应商，请重新选择。'); }
  private result(draft: EngineSnapshot, id: unknown): ResultImage { for (const task of draft.state.tasks) for (const job of task.jobs) { const result = job.results.find(item => item.id === id); if (result) return result; } return problem('找不到图片。'); }
  private defaults(draft: EngineSnapshot): GenerationParams { const provider = draft.state.providers.find(p => p.models.some(model => model.image && p.enabledModels.includes(model.id))); const model = provider?.models.find(m => m.image && provider.enabledModels.includes(m.id)); return { providerId: provider?.id ?? '', model: model?.id ?? '', quality: model?.qualities[0] ?? 'auto', size: model?.sizes[0] ?? 'auto', count: 1 }; }
  private createTask(draft: EngineSnapshot, payload: Record<string, unknown>): void { if (payload.kind !== 'single' && payload.kind !== 'batch') problem('任务类型无效。'); if (draft.state.tasks.filter(task => !task.archived).length >= 100) problem('任务数量已达上限，请使用已有任务。'); const kind = payload.kind as TaskKind; const ordinal = draft.state.tasks.filter(task => task.kind === kind).length + 1; const task: Task = { id: this.id(), kind, title: `${kind === 'single' ? '生成' : '批量任务'} ${ordinal}`, prompt: '', referenceIds: [], params: this.defaults(draft), rows: [], jobs: [], paused: false, concurrency: 1, outputDirectory: draft.state.settings.outputDirectory, naming: '{序号}_{日期}', retry: false, createdAt: this.now() }; draft.state.tasks.push(task); draft.rowIds[task.id] = []; }
  private updateTask(draft: EngineSnapshot, payload: Record<string, unknown>): void {
    const task = this.task(draft, payload.id);
    if (payload.prompt !== undefined) task.prompt = safeText(payload.prompt, '提示词');
    if (payload.params !== undefined) { if (!payload.params || typeof payload.params !== 'object' || Array.isArray(payload.params)) problem('生成参数无效。'); const changes = payload.params as Partial<GenerationParams>; for (const field of ['providerId', 'model', 'quality', 'size'] as const) if (Object.prototype.hasOwnProperty.call(changes, field) && typeof changes[field] !== 'string') problem('生成参数必须为有效字符串。'); if (Object.prototype.hasOwnProperty.call(changes, 'count') && typeof changes.count !== 'number') problem('图片数量必须为数字。'); const params = { providerId: changes.providerId ?? task.params.providerId, model: changes.model ?? task.params.model, quality: changes.quality ?? task.params.quality, size: changes.size ?? task.params.size, count: changes.count ?? task.params.count }; if (params.providerId === '' && params.model === '') { safeText(params.quality, '质量', 100); safeText(params.size, '尺寸', 100); if (!Number.isInteger(params.count) || params.count < 1 || params.count > 4) problem('草稿图片数量必须为 1 至 4。'); } else this.validateParams(draft, params, task.referenceIds.length); task.params = params; }
    if (payload.concurrency !== undefined) { if (!Number.isInteger(payload.concurrency) || Number(payload.concurrency) < 1 || Number(payload.concurrency) > 8) problem('并发数必须为 1 至 8。'); task.concurrency = Number(payload.concurrency); }
    if (payload.outputDirectory !== undefined) task.outputDirectory = directory(payload.outputDirectory);
    if (payload.naming !== undefined) task.naming = naming(payload.naming);
    if (payload.retry !== undefined) { if (typeof payload.retry !== 'boolean') problem('重试设置无效。'); task.retry = payload.retry; }
  }
  private validateParams(draft: EngineSnapshot, params: GenerationParams, referenceCount: number): void { validateGenerationParams(params, referenceCount); const provider = this.provider(draft, params.providerId); const model = provider.models.find(item => item.id === params.model); if (!model?.image || !provider.enabledModels.includes(params.model)) problem('请选择供应商已启用的生图模型。'); if (!Number.isInteger(params.count) || params.count < 1 || params.count > model.maxImages) problem(`当前模型每行图片数量必须为 1 至 ${model.maxImages}。`); if (!model.sizes.includes(params.size) || !model.qualities.includes(params.quality)) problem('当前模型不支持所选尺寸或质量。'); if (referenceCount && (!model.reference || referenceCount > model.maxReferences)) problem('当前模型不支持这些参考图数量。'); }
  private async submit(draft: EngineSnapshot, payload: Record<string, unknown>): Promise<void> {
    const task = this.task(draft, payload.id); if (task.jobs.some(job => PENDING.has(job.status))) return;
    if (task.kind === 'single' && draft.state.tasks.reduce((total, current) => total + current.jobs.filter(job => ACTIVE.has(job.status) || (current.kind === 'single' && !current.paused && job.status === 'queued' && (draft.jobs[job.id]?.retryAt ?? 0) <= this.now())).length, 0) >= MAX_CONCURRENT_JOBS) problem('当前已有 5 个请求正在处理或等待处理，请等待完成后再提交。');
    if (task.jobs.some(job => job.status === 'unknown') && payload.confirmUnknown !== true) problem('上次生成结果未知，可能已扣费；请先明确确认重试。');
    this.validateParams(draft, task.params, task.referenceIds.length); const provider = this.provider(draft, task.params.providerId); if (!await this.credential(draft, provider.id)) problem('请先在设置中保存 API Key。');
    if (provider.connection !== 'connected' || !provider.models.find(m => m.id === task.params.model)?.verified) problem('请先测试连接并验证当前生图模型。');
    const prompts = task.kind === 'single' ? [task.prompt.trim()] : task.rows; if (!prompts.length || prompts.some(p => !p.trim())) problem('请填写提示词或先导入批量提示词。');
    const run = task.jobs.reduce((highest, job) => Math.max(highest, job.run), 0) + 1; task.paused = false;
    const refs = task.referenceIds.map(id => draft.state.references.find(r => r.id === id) ?? problem('参考图已失效，请重新添加。'));
    if (task.kind === 'single') draft.rowIds[task.id] = [this.id()];
    for (let index = 0; index < prompts.length; index++) { const job: Job = { id: this.id(), row: index + 1, run, prompt: prompts[index], referenceIds: [...task.referenceIds], params: clone(task.params), status: 'queued', results: [], createdAt: this.now(), attempts: 0 }; task.jobs.push(job); draft.jobs[job.id] = { provider: { id: provider.id, baseURL: provider.baseURL }, references: clone(refs), rowId: draft.rowIds[task.id]?.[index] ?? this.id(), credentialRevision: draft.credentialRevisions[provider.id], phase: 'generate', context: { taskId: task.id, taskKind: task.kind, jobId: job.id, run, row: job.row, index: 1, outputDirectory: draft.state.settings.outputDirectory, naming: draft.state.settings.naming ?? '{序号}_{日期}', format: draft.state.settings.format, createdAt: job.createdAt } }; }
  }
  private retry(draft: EngineSnapshot, payload: Record<string, unknown>): void { const task = this.task(draft, payload.id); if (task.jobs.some(job => job.status === 'unknown') && !task.jobs.some(job => job.status === 'failed') && payload.confirmUnknown !== true) problem('存在结果未知的请求，可能已扣费。请明确确认后重新生成。'); for (const job of task.jobs) if (job.status === 'failed' || job.status === 'unknown' && payload.confirmUnknown === true) { const record = draft.jobs[job.id]; if (!record) continue; if (record.phase === 'download' && !record.sources?.length && !this.transientSources.has(job.id)) { job.error = '图片源未能保存，无法恢复下载；不会重新生成。'; continue; } if (record.phase === 'generate') { const provider = this.provider(draft, job.params.providerId); if (!provider.hasKey) problem('请先保存 API Key。'); if (provider.baseURL !== record.provider.baseURL || draft.credentialRevisions[provider.id] !== record.credentialRevision) problem('供应商地址或 Key 已更改，旧请求不能重试；请检查配置后发起新一轮生成。'); this.validateParams(draft, job.params, record.references.length); if (provider.connection !== 'connected') problem('请先测试连接并保存供应商。'); } job.status = 'queued'; job.error = undefined; job.endedAt = undefined; record.retryAt = undefined; } task.paused = false; }
  private providerBusy(draft: EngineSnapshot, id: string): boolean { return draft.state.tasks.some(task => task.jobs.some(job => job.params.providerId === id && PENDING.has(job.status))); }
  private async saveProvider(draft: EngineSnapshot, payload: Record<string, unknown>): Promise<AppState> {
    const existing = payload.id ? this.provider(draft, payload.id) : undefined; const id = existing?.id ?? this.id(); if (existing && this.providerBusy(draft, id)) problem('此供应商仍有排队或进行中的请求，请结束后再编辑。');
    const name = safeText(payload.name, '供应商名称', 80).trim(); if (!name) problem('请输入供应商名称。'); const url = baseURL(payload.baseURL); const key = payload.key === undefined ? '' : safeText(payload.key, 'API Key', 4096).trim(); if (/\s/.test(key)) problem('API Key 不能含空白。'); const oldRevision = draft.credentialRevisions[id]; const oldKey = await this.credential(draft, id);
    if (existing && existing.baseURL !== url && oldKey && !key && payload.reuseKey !== true) problem('服务地址已修改，请输入新 Key 或明确确认复用现有 Key。');
    const hash = credentialHash(key || oldKey || ''); const cacheKey = `${id}:${url}:${hash}`; const draftCacheKey = `draft:${url}:${hash}`; const candidates = this.tested.get(cacheKey) ?? this.tested.get(draftCacheKey) ?? (existing?.baseURL === url ? existing.models : url === BUILTIN_URL ? [...BUILTIN_MODELS, BUILTIN_TEXT_MODEL].map(builtinModel) : []);
    if (!Array.isArray(payload.enabledModels) || payload.enabledModels.some(model => typeof model !== 'string')) problem('启用模型列表无效。'); const enabled = [...new Set(payload.enabledModels as string[])]; if (enabled.some(model => !candidates.find(candidate => candidate.id === model && (candidate.image || candidate.text)))) problem('启用列表包含未支持或未发现的模型，请先测试连接。');
    const tested = this.tested.has(cacheKey) || this.tested.has(draftCacheKey);
    const provider: Provider = { id, name, baseURL: url, enabledModels: enabled, models: clone(candidates), hasKey: Boolean(key || oldKey), builtin: existing?.builtin ?? false, connection: tested ? 'connected' : key || existing?.baseURL !== url ? 'untested' : existing?.connection ?? 'untested', checkedAt: tested ? this.now() : existing?.checkedAt };
    if (!existing || key && key !== oldKey || existing.baseURL !== url) draft.credentialRevisions[id] = this.id();
    if (existing) draft.state.providers[draft.state.providers.findIndex(p => p.id === id)] = provider; else draft.state.providers.push(provider);
    const nextRevision = draft.credentialRevisions[id];
    // Immutable slots make the vault/SQLite boundary crash-safe: an old snapshot can never read a new Key.
    if (nextRevision !== oldRevision && (key || oldKey)) await this.options.credentials.set(credentialSlot(nextRevision), key || oldKey!);
    await this.commit(draft);
    if (oldRevision && oldRevision !== nextRevision) await this.options.credentials.delete(credentialSlot(oldRevision)).catch(() => undefined);
    return this.getState();
  }
  private async deleteProvider(draft: EngineSnapshot, payload: Record<string, unknown>): Promise<AppState> { const provider = this.provider(draft, payload.id); if (this.providerBusy(draft, provider.id)) problem('此供应商仍有排队或进行中的请求，不能删除。'); const revision = draft.credentialRevisions[provider.id]; draft.state.providers = draft.state.providers.filter(p => p.id !== provider.id); delete draft.credentialRevisions[provider.id]; if (draft.state.settings.textProviderId === provider.id) { draft.state.settings.textProviderId = ''; draft.state.settings.textModel = ''; } for (const task of draft.state.tasks) if (task.params.providerId === provider.id) task.params = { providerId: '', model: '', quality: '', size: '', count: 1 }; await this.commit(draft); if (revision) await this.options.credentials.delete(credentialSlot(revision)).catch(() => undefined); return this.getState(); }
  private async testProvider(payload: Record<string, unknown>): Promise<ModelInfo[]> {
    // Capture only saved credentials for the exact saved URL, never a draft origin.
    const request = await this.enqueue(async () => { const existing = payload.id ? this.provider(this.snapshot, payload.id) : undefined; const url = baseURL(payload.baseURL ?? existing?.baseURL); let key = payload.key ? safeText(payload.key, 'API Key', 4096).trim() : ''; if (!key && existing?.baseURL === url) key = await this.credential(this.snapshot, existing.id) ?? ''; if (!key) problem('请输入 API Key；测试新地址不能自动使用已保存的 Key。'); return { id: existing?.id, baseURL: url, key }; });
    let models: ModelInfo[]; try { models = modelsValid(await this.options.provider.models(request)).map(model => ({ ...model, verified: true })); } catch (error) { throw new Error(errorMessage(error, '连接测试失败，请检查地址、Key 和网络。')); }
    await this.enqueue(async () => { this.tested.set(`${request.id ?? 'draft'}:${request.baseURL}:${credentialHash(request.key)}`, clone(models)); }); return clone(models);
  }
  private async enhance(payload: Record<string, unknown>): Promise<AppState> {
    if (payload.mode !== 'optimize' && payload.mode !== 'translate') problem('提示词操作无效。');
    const capture = await this.enqueue(async () => {
      const task = this.task(this.snapshot, payload.id);
      const { textProviderId, textModel } = this.snapshot.state.settings;
      if (!textProviderId || !textModel) problem('请先在基础设置中配置默认文本供应商和模型。');
      const provider = this.snapshot.state.providers.find(item => item.id === textProviderId);
      if (!provider || !provider.enabledModels.includes(textModel) || !provider.models.some(model => model.id === textModel && model.text)) problem('默认文本模型已删除或停用，请在基础设置重新选择。');
      if (provider.connection !== 'connected' || !provider.models.find(model => model.id === textModel)?.verified) problem('请先测试连接并验证默认文本模型。');
      if (!task.prompt.trim()) problem('请先填写需要处理的提示词。');
      const key = await this.credential(this.snapshot, provider.id);
      if (!key) problem('请先保存默认文本供应商的 API Key。');
      return { prompt: task.prompt, baseURL: provider.baseURL, key, model: textModel };
    });
    let prompt: string;
    try { prompt = await this.options.provider.enhance({ ...capture, mode: payload.mode as 'optimize' | 'translate' }); }
    catch (error) { throw new Error(errorMessage(error, '提示词处理失败，请稍后重试。')); }
    return this.mutate(draft => { const task = this.task(draft, payload.id); if (task.prompt !== capture.prompt) problem('提示词已修改，请重试以免覆盖新内容。'); task.prompt = safeText(prompt, '提示词'); });
  }
  private async useResult(payload: Record<string, unknown>): Promise<AppState> { const result = clone(this.result(this.snapshot, payload.resultId)); if (!this.options.references?.fromResult) problem('参考图功能不可用。'); const reference = await this.options.references!.fromResult!(result, [...this.task(this.snapshot, payload.id).referenceIds]); return this.addReferences(String(payload.id), [reference]); }
  private kick(): void { if (this.pumping) { this.repump = true; return; } if (this.pumpScheduled || this.stopped || !this.initialized) return; this.pumpScheduled = true; queueMicrotask(() => { this.pumpScheduled = false; this.pumping = true; void this.pump().catch(() => { this.snapshot.state.notice = '队列写入失败，已停止调度；请检查磁盘后重新启动。'; this.stopped = true; this.publish(); }).finally(() => { this.pumping = false; if (this.repump) { this.repump = false; this.kick(); } }); }); }
  private async pump(): Promise<void> {
    for (;;) {
      const claim = await this.enqueue(async () => {
        if (this.stopped || this.inflight.size >= MAX_CONCURRENT_JOBS) return undefined;
        const eligible = (task: Task) => !task.paused && task.jobs.filter(job => ACTIVE.has(job.status)).length < (task.kind === 'batch' ? MAX_CONCURRENT_JOBS : task.concurrency) && task.jobs.some(job => job.status === 'queued' && !this.inflight.has(job.id) && (this.snapshot.jobs[job.id]?.retryAt ?? 0) <= this.now());
        const task = this.snapshot.state.tasks.find(task => task.kind === 'single' && eligible(task)) ?? this.snapshot.state.tasks.find(task => eligible(task));
        const job = task?.jobs.find(job => job.status === 'queued' && !this.inflight.has(job.id) && (this.snapshot.jobs[job.id]?.retryAt ?? 0) <= this.now()); if (!task || !job) return undefined;
        const draft = clone(this.snapshot); const draftJob = this.task(draft, task.id).jobs.find(j => j.id === job.id)!; const record = draft.jobs[job.id]; const currentProvider = draft.state.providers.find(p => p.id === record.provider.id); if (record.phase === 'generate' && (!currentProvider || currentProvider.baseURL !== record.provider.baseURL || draft.credentialRevisions[record.provider.id] !== record.credentialRevision)) { draftJob.status = 'failed'; draftJob.error = '供应商配置已更改，已阻止旧请求发送。'; await this.commit(draft); return { skip: true as const }; } const key = record.phase === 'generate' ? await this.credential(draft, record.provider.id) : undefined;
        if (record.phase === 'generate' && !key) { draftJob.status = 'failed'; draftJob.error = 'API Key 不可用，请重新保存。'; draftJob.endedAt = this.now(); await this.commit(draft); return { skip: true as const }; }
        draftJob.status = record.phase === 'download' ? 'downloading' : 'submitting'; draftJob.startedAt = this.now(); if (record.phase === 'generate') draftJob.attempts++; draftJob.error = undefined; await this.commit(draft);
        return { skip: false as const, taskId: task.id, job: clone(draftJob), record: clone(record), key };
      });
      if (!claim) return; if (claim.skip) continue;
      const work = this.run(claim.taskId, claim.job, claim.record, claim.key).catch(() => { this.stopped = true; this.snapshot.state.notice = '图片状态未能保存，调度已停止；重启后会安全恢复，不会自动重新生成。'; this.publish(); }).finally(() => { this.inflight.delete(claim.job.id); this.kick(); });
      this.inflight.set(claim.job.id, work);
    }
  }
  private async run(taskId: string, job: Job, record: JobRecord, key?: string): Promise<void> {
    if (record.phase === 'download') { await this.download(taskId, job.id); return; }
    let refs: ReferenceInput[];
    try { refs = await Promise.all(record.references.map(reference => { if (!this.options.references) return Promise.reject(new Error('参考图不可读')); return this.options.references.read(reference); })); } catch { await this.finish(taskId, job.id, 'failed', '参考图读取失败，请重新添加。'); return; }
    let images: ProviderImage[];
    try { images = await this.options.provider.generate({ baseURL: record.provider.baseURL, key: key!, params: job.params, prompt: job.prompt, references: refs }); }
    catch (error) {
      const typed = error as { outcome?: string; status?: number; safeRetry?: boolean; retryAfterMs?: number; partialImages?: ProviderImage[] };
      if (typed.partialImages?.length) { await this.receive(taskId, job.id, typed.partialImages, typed.outcome === 'rejected' ? 'failed' : 'unknown', '服务仅返回部分图片；已保留收到的图片，不会自动补生成。'); return; }
      const retry = typed.outcome === 'rejected' && typed.status === 429 && typed.safeRetry === true;
      let retried = false; let delay = 0;
      await this.mutate(draft => { const task = this.task(draft, taskId); const current = task.jobs.find(j => j.id === job.id)!; if (retry && task.retry && current.attempts < 3) { delay = Math.min(60000, Math.max(500 * 2 ** (current.attempts - 1), Number(typed.retryAfterMs) || 0)); current.status = 'queued'; current.error = '服务明确拒绝请求，等待安全重试。'; draft.jobs[job.id].retryAt = this.now() + delay; retried = true; } else { current.status = typed.outcome === 'rejected' ? 'failed' : 'unknown'; current.endedAt = this.now(); current.error = errorMessage(error, typed.outcome === 'rejected' ? '服务拒绝生成，请检查请求后重试。' : '生成结果未知，可能已产生费用；请确认后再重新生成。'); } });
      if (retried) this.scheduleRetry(job.id, delay);
      return;
    }
    if (!images.length) { await this.finish(taskId, job.id, 'unknown', '服务未返回可用图片，生成结果未知；不会自动重试。'); return; }
    await this.receive(taskId, job.id, images, images.length < job.params.count ? 'unknown' : undefined, images.length < job.params.count ? '返回图片数量不足；已保留收到的图片，不会自动补生成。' : undefined);
  }
  private scheduleRetry(jobId: string, delay: number): void { const timer = (this.options.sleep ?? (ms => new Promise<void>(resolve => setTimeout(resolve, ms))))(delay).then(async () => { await this.mutate(draft => { if (draft.jobs[jobId]) draft.jobs[jobId].retryAt = undefined; }); }).catch(() => { this.stopped = true; this.snapshot.state.notice = '安全重试状态未能持久保存，已停止调度。'; this.publish(); }).finally(() => { this.timers.delete(timer); this.kick(); }); this.timers.add(timer); }
  private async receive(taskId: string, jobId: string, images: ProviderImage[], terminal?: 'failed' | 'unknown', terminalError?: string): Promise<void> {
    this.transientSources.set(jobId, images);
    // Persist knowledge of completed generation BEFORE touching filesystem/downloads.
    await this.mutate(draft => { const job = this.task(draft, taskId).jobs.find(j => j.id === jobId)!; const record = draft.jobs[jobId]; record.phase = 'download'; record.terminal = terminal; record.terminalError = terminalError; job.status = 'downloading'; });
    await this.download(taskId, jobId);
  }
  private async download(taskId: string, jobId: string): Promise<void> {
    let record = clone(this.snapshot.jobs[jobId]);
    if (!record.sources) {
      const images = this.transientSources.get(jobId); if (!images) { await this.finish(taskId, jobId, 'failed', '图片源未保存，无法恢复下载；不会重新生成。'); return; }
      let sources: StoredImage[]; try { sources = await this.options.output.stage(images, record.context); } catch { await this.finish(taskId, jobId, 'failed', '图片缓存失败，可重试保存；不会重新生成。'); return; }
      await this.mutate(draft => { draft.jobs[jobId].sources = sources; draft.jobs[jobId].completedSourceIds = []; }); this.transientSources.delete(jobId); record = clone(this.snapshot.jobs[jobId]);
    }
    let failed = false;
    for (let index = 0; index < record.sources!.length; index++) {
      const source = record.sources![index]; if (record.completedSourceIds?.includes(source.id)) continue;
      let result: ResultImage; try { result = await this.options.output.write(source, { ...record.context, index: index + 1 }); } catch { failed = true; continue; }
      await this.mutate(draft => { const job = this.task(draft, taskId).jobs.find(j => j.id === jobId)!; if (!job.results.some(r => r.id === result.id)) job.results.push(result); (draft.jobs[jobId].completedSourceIds ??= []).push(source.id); });
    }
    if (failed) await this.finish(taskId, jobId, 'failed', '部分图片下载或保存失败；已保留成功图片，重试只会下载未完成图片。');
    else await this.finish(taskId, jobId, record.terminal ?? 'completed', record.terminalError);
  }
  private async finish(taskId: string, jobId: string, status: 'completed' | 'failed' | 'unknown', error?: string): Promise<void> { await this.mutate(draft => { const job = this.task(draft, taskId).jobs.find(j => j.id === jobId)!; job.status = status; job.error = error; job.endedAt = this.now(); }); }
}
