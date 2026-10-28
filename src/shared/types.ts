export type TaskKind = 'single' | 'batch';
export type JobStatus = 'queued' | 'submitting' | 'running' | 'downloading' | 'completed' | 'failed' | 'unknown';
export interface ModelInfo { id: string; name?: string; image: boolean; text?: boolean; reference: boolean; maxReferences: number; maxImages: number; sizes: string[]; qualities: string[]; verified?: boolean }
export interface Provider { id: string; name: string; baseURL: string; enabledModels: string[]; models: ModelInfo[]; hasKey: boolean; builtin: boolean; connection: 'untested' | 'connected' | 'failed'; checkedAt?: number }
export interface GenerationParams { providerId: string; model: string; quality: string; size: string; count: number }
export interface Reference { id: string; name: string; url: string }
export interface ResultImage { id: string; name: string; url: string; favorite: boolean; saved: boolean }
export interface Job { id: string; row: number; run: number; prompt: string; referenceIds: string[]; params: GenerationParams; status: JobStatus; results: ResultImage[]; createdAt: number; startedAt?: number; endedAt?: number; error?: string; attempts: number }
export interface Task { id: string; kind: TaskKind; title: string; customTitle?: string; archived?: boolean; prompt: string; referenceIds: string[]; params: GenerationParams; rows: string[]; jobs: Job[]; paused: boolean; concurrency: number; outputDirectory: string; naming: string; retry: boolean; createdAt: number }
export interface Settings { outputDirectory: string; format: 'png' | 'jpg' | 'webp'; naming?: string; textProviderId?: string; textModel?: string }
export interface AppState { tasks: Task[]; providers: Provider[]; references: Reference[]; settings: Settings; version: string; quota: string; notice?: string }
export const BUILTIN_URL = 'https://sub.shapantutu.com/v1';
export const BUILTIN_MODELS = ['gpt-image-2', 'gpt-image-2.5', 'gpt-image-2.5-flare', 'gpt-image-2.5-sunburst'];
export const ACTIONS = ['getState','createTask','updateTask','renameTask','deleteTask','submitTask','pauseTask','resumeTask','retryFailed','clearTask','saveProvider','deleteProvider','testProvider','saveSettings','importRows','downloadBatchTemplate','selectReferences','removeReference','chooseOutputDirectory','openResult','copyResult','copyReference','saveResult','saveReference','favoriteResult','useResult','enhancePrompt','openLink','checkUpdate','windowMinimize','windowMaximize','windowClose'] as const;
export type Action = typeof ACTIONS[number];
export interface Bridge { invoke(action: Action, payload?: Record<string, unknown>): Promise<any>; subscribe(listener: (state: AppState) => void): () => void }
declare global { interface Window { qingtu: Bridge } }
