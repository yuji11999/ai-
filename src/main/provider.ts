import { Readable } from 'node:stream';
import { Agent, FormData as UndiciFormData, request as undiciRequest, type Dispatcher } from 'undici';
import { BUILTIN_MODELS, type GenerationParams, type ModelInfo, type QuotaInfo } from '../shared/types';
import { IMAGE_RATIO_PRESETS } from '../shared/image-presets';
import { parseSub2APIQuota } from './quota';

export interface ProviderImage { bytes?: Uint8Array; url?: string; mime?: string }
export interface ProviderReference { name: string; mime: string; data: Uint8Array }
export interface ProviderCredentials { baseURL: string; key: string; signal?: AbortSignal }
export interface GenerateRequest extends ProviderCredentials {
  params: GenerationParams; prompt: string; references: ProviderReference[];
}
export interface EnhanceRequest extends ProviderCredentials {
  model?: string; prompt: string; mode: 'optimize' | 'translate';
}
export interface ProviderTimeouts {
  connectMs: number; modelsMs: number; generationMs: number; enhanceMs: number; bodyMs: number;
}
export const PROVIDER_TIMEOUTS: Readonly<ProviderTimeouts> = Object.freeze({
  connectMs: 30_000, modelsMs: 30_000, generationMs: 20 * 60_000, enhanceMs: 90_000, bodyMs: 120_000,
});
export const MAX_IMAGE_BYTES = 32 * 1024 * 1024;
export const MAX_METADATA_BYTES = 1024 * 1024;
export const MAX_GENERATION_RESPONSE_BYTES = 4 * Math.ceil(MAX_IMAGE_BYTES / 3) * 4 + MAX_METADATA_BYTES;
const MAX_REFERENCE_BYTES = 128 * 1024 * 1024;
const MAX_PROMPT_LENGTH = 32_000;
// Pixel presets for auto and the 1K-class aspect ratios exposed in the UI.
const SIZES = IMAGE_RATIO_PRESETS.map(preset => preset.size);
const QUALITIES = ['auto', 'low', 'medium', 'high'];

export type ProviderErrorCode = 'VALIDATION' | 'TEXT_MODEL_REQUIRED' | 'CANCELLED' | 'TIMEOUT' |
  'NETWORK' | 'HTTP' | 'REDIRECT' | 'INVALID_RESPONSE' | 'RESPONSE_TOO_LARGE' | 'PARTIAL_RESULT' | 'REFERENCE_MISMATCH' | 'QUOTA_UNAVAILABLE';
const ERROR_MESSAGES: Record<ProviderErrorCode, string> = {
  VALIDATION: '请求参数无效，请检查供应商、模型、尺寸、质量、数量和参考图。',
  TEXT_MODEL_REQUIRED: '提示词优化和翻译暂不可用：尚未配置文本模型。',
  CANCELLED: '请求已取消；已提交的生成可能仍在服务端执行，请勿直接重试。',
  TIMEOUT: '等待服务端响应超时；生成结果尚不确定，请勿直接重试。',
  NETWORK: '网络连接中断；生成结果尚不确定，请勿直接重试。',
  HTTP: '供应商拒绝请求或暂不可用，请检查配置和服务状态。',
  REDIRECT: '供应商返回了重定向，已阻止转发凭据。请检查 API 地址。',
  INVALID_RESPONSE: '供应商返回的结果无法识别；请勿重新提交生成以尝试下载。',
  RESPONSE_TOO_LARGE: '供应商返回的数据超过安全大小限制，已停止接收。',
  PARTIAL_RESULT: '供应商仅返回部分有效图片；已保留有效结果，请勿自动补生。',
  REFERENCE_MISMATCH: '优化或翻译结果改变了参考图引用标记，已拒绝替换并保留原提示词。',
  QUOTA_UNAVAILABLE: '上游未返回可识别的额度信息，请在供应商控制台查看。',
};
export class ProviderError extends Error {
  readonly code: ProviderErrorCode;
  readonly outcome: 'rejected' | 'unknown';
  readonly safeRetry: boolean;
  readonly status?: number;
  readonly elapsed: number;
  readonly elapsedMs: number;
  readonly retryAfterMs?: number;
  readonly partialImages?: ProviderImage[];
  constructor(code: ProviderErrorCode, options: {
    outcome?: 'rejected' | 'unknown'; safeRetry?: boolean; status?: number; elapsed?: number;
    retryAfterMs?: number; partialImages?: ProviderImage[];
  } = {}) {
    // Deliberately never retain raw API error text, URLs, request bodies or causes.
    super(ERROR_MESSAGES[code]);
    this.name = 'ProviderError';
    this.code = code;
    this.outcome = options.outcome ?? 'rejected';
    this.safeRetry = options.safeRetry === true && options.status === 429 && this.outcome === 'rejected';
    this.status = options.status;
    this.elapsed = this.elapsedMs = Math.max(0, options.elapsed ?? 0);
    this.retryAfterMs = this.safeRetry ? options.retryAfterMs : undefined;
    this.partialImages = options.partialImages;
  }
}

/** Seed adapter capabilities, NOT evidence of availability on a particular provider.
 * /models verifies visibility only. The generic gpt-image-2.5 is a node alias.
 * Pixel presets follow the Images API constraints; the generic alias and third-party
 * providers may implement a narrower subset, so availability still needs verification.
 * https://developers.openai.com/api/reference/resources/images/methods/generate
 * https://developers.openai.com/api/reference/resources/images/methods/edit
 */
export function getModelInfo(id: string, verified = false): ModelInfo {
  const known = BUILTIN_MODELS.includes(id);
  // Explicitly authorized node text candidate; presence in /models only verifies
  // visibility, not a live chat-completions call. Never infer text from a prefix.
  const text = id === 'gpt-5.6';
  return { id, name: id, image: known, text, reference: known, maxReferences: known ? 8 : 0,
    maxImages: known ? 4 : 1, sizes: known ? [...SIZES] : ['auto'],
    qualities: known ? [...QUALITIES] : ['auto'], verified };
}
export function validateGenerationParams(params: GenerationParams, referenceCount = 0): ModelInfo {
  if (!params || typeof params.model !== 'string' || typeof params.providerId !== 'string' ||
    !params.providerId.trim() || !Number.isInteger(referenceCount) || referenceCount < 0) {
    throw new ProviderError('VALIDATION');
  }
  const model = getModelInfo(params.model);
  if (!model.image || !Number.isInteger(params.count) || params.count < 1 || params.count > model.maxImages ||
    !model.sizes.includes(params.size) || !model.qualities.includes(params.quality) ||
    referenceCount > model.maxReferences || (referenceCount > 0 && !model.reference)) {
    throw new ProviderError('VALIDATION');
  }
  return model;
}

export interface ImageProviderOptions {
  fetch?: typeof globalThis.fetch;
  /** Optional dispatcher for transport-level tests; caller owns its lifecycle. */
  dispatcher?: Dispatcher;
  now?: () => number;
  timeouts?: Partial<ProviderTimeouts>;
}

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
function endpoint(baseURL: string, path: string): string {
  try {
    if (typeof baseURL !== 'string' || baseURL.length > 2048 || /[\s\\]/.test(baseURL)) throw 0;
    const url = new URL(baseURL);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw 0;
    return `${url.href.replace(/\/+$/, '')}/${path}`;
  } catch { throw new ProviderError('VALIDATION'); }
}
function validatedKey(key: string): string {
  if (typeof key !== 'string' || !key.trim() || key.length > 8192 || /[\s\x00-\x1f\x7f]/.test(key.trim())) {
    throw new ProviderError('VALIDATION');
  }
  return key.trim();
}
function validatePrompt(prompt: string): void {
  if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > MAX_PROMPT_LENGTH) {
    throw new ProviderError('VALIDATION');
  }
}
function imageMime(bytes: Uint8Array): string | undefined {
  if (bytes.length >= 8 && [137, 80, 78, 71, 13, 10, 26, 10].every((byte, i) => bytes[i] === byte)) return 'image/png';
  if (bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg';
  if (bytes.length >= 12 && Buffer.from(bytes.subarray(0, 4)).toString() === 'RIFF' &&
    Buffer.from(bytes.subarray(8, 12)).toString() === 'WEBP') return 'image/webp';
  return undefined;
}
function validateReferences(references: ProviderReference[]): void {
  if (!Array.isArray(references)) throw new ProviderError('VALIDATION');
  let total = 0;
  for (const ref of references) {
    if (!ref || typeof ref.name !== 'string' || !ref.name || !(ref.data instanceof Uint8Array) ||
      ref.data.byteLength === 0 || ref.data.byteLength > MAX_IMAGE_BYTES ||
      !['image/png', 'image/jpeg', 'image/webp'].includes(ref.mime) || imageMime(ref.data) !== ref.mime) {
      throw new ProviderError('VALIDATION');
    }
    total += ref.data.byteLength;
    if (total > MAX_REFERENCE_BYTES) throw new ProviderError('VALIDATION');
  }
}
function raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new Error('aborted'));
  return new Promise<T>((resolve, reject) => {
    const aborted = () => { cleanup(); reject(new Error('aborted')); };
    const cleanup = () => signal.removeEventListener('abort', aborted);
    signal.addEventListener('abort', aborted, { once: true });
    promise.then(value => { cleanup(); resolve(value); }, () => { cleanup(); reject(new Error('transport')); });
  });
}
function resultURL(value: unknown, key: string): string | undefined {
  if (typeof value !== 'string' || !value || value.length > 16_384 || value.includes(key)) return undefined;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.hash ||
      decodeURIComponent(value).includes(key)) return undefined;
    // Main's file service additionally resolves/validates DNS and each download destination.
    return url.href;
  } catch { return undefined; }
}
function referenceTokens(value: string): string[] {
  // Match whole supported markers, not @handles or prefixes of @图12 / @图十二.
  // Compare occurrences as well as spelling: no adding, deleting or renumbering.
  return [...value.matchAll(/@图[1-8一二三四五六七八](?![0-9A-Za-z_一二三四五六七八九十百千万零〇两])/gu)]
    .map(match => match[0]).sort();
}
function cleanText(value: string, key: string): string {
  return value.split(key).join('[已隐藏]').replace(/Bearer\s+[^\s"'<>]+/gi, 'Bearer [已隐藏]')
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, '[已隐藏]');
}

export class ImageProvider {
  readonly timeouts: Readonly<ProviderTimeouts>;
  private readonly fetcher: typeof globalThis.fetch;
  private readonly now: () => number;
  private readonly agent?: Agent;
  constructor(options: ImageProviderOptions | typeof globalThis.fetch = {}) {
    const config = typeof options === 'function' ? { fetch: options } : options;
    const timeouts = { ...PROVIDER_TIMEOUTS, ...config.timeouts };
    for (const value of Object.values(timeouts)) {
      if (!Number.isInteger(value) || value <= 0 || value > 2_147_483_647) throw new ProviderError('VALIDATION');
    }
    this.timeouts = Object.freeze(timeouts);
    this.now = config.now ?? Date.now;
    if (config.fetch) this.fetcher = config.fetch;
    else {
      // Do NOT use fetch for the production POST transport: Fetch may replay a
      // request automatically on HTTP 421. Low-level request has no such retry or
      // redirect behavior, and marks every request non-idempotent explicitly.
      // The dedicated dispatcher also avoids Node fetch's default ~5m timeout.
      this.agent = config.dispatcher ? undefined : new Agent({ connect: { timeout: timeouts.connectMs },
        headersTimeout: Math.max(timeouts.generationMs, timeouts.enhanceMs, timeouts.modelsMs),
        bodyTimeout: timeouts.bodyMs, maxResponseSize: MAX_GENERATION_RESPONSE_BYTES,
        allowH2: false, pipelining: 1 });
      const dispatcher = config.dispatcher ?? this.agent!;
      this.fetcher = (async (input, init) => {
        let body: string | UndiciFormData | undefined;
        if (typeof init?.body === 'string') body = init.body;
        else if (init?.body instanceof FormData) {
          // Undici's request API requires its own FormData, not Node's global one.
          const form = new UndiciFormData();
          for (const [name, value] of init.body.entries()) {
            if (typeof value === 'string') form.append(name, value);
            else form.append(name, value, value.name);
          }
          body = form;
        }
        const headers = new Headers(init?.headers);
        headers.set('accept-encoding', 'identity');
        const response = await undiciRequest(String(input), { dispatcher,
          method: init?.method as 'GET' | 'POST', headers: Object.fromEntries(headers), body,
          signal: init?.signal, idempotent: false,
        });
        const responseHeaders = new Headers();
        for (const [name, value] of Object.entries(response.headers)) {
          for (const entry of Array.isArray(value) ? value : value === undefined ? [] : [value]) {
            responseHeaders.append(name, entry);
          }
        }
        // Error bodies are never exposed. Dispose them before adapting streams:
        // cancelling Node's Web-stream adapter can race a late close event.
        if (response.statusCode >= 300 || [204, 205].includes(response.statusCode)) {
          response.body.on('error', () => undefined);
          response.body.destroy();
          return new Response(null, { status: response.statusCode, headers: responseHeaders });
        }
        const stream = Readable.toWeb(response.body) as ReadableStream<Uint8Array>;
        return new Response(stream, { status: response.statusCode, headers: responseHeaders });
      }) as typeof globalThis.fetch;
    }
  }
  async close(): Promise<void> { await this.agent?.close(); }

  async quota(input: ProviderCredentials): Promise<QuotaInfo> {
    const response = await this.request(input, 'usage', 'GET', undefined, Math.min(this.timeouts.modelsMs, 15_000), MAX_METADATA_BYTES, Math.min(this.timeouts.bodyMs, 15_000));
    const quota = parseSub2APIQuota(response, this.now());
    if (!quota) throw new ProviderError('QUOTA_UNAVAILABLE', { outcome: 'rejected' });
    return quota;
  }

  async models(input: ProviderCredentials): Promise<ModelInfo[]> {
    const started = this.now();
    const key = validatedKey(input.key);
    const response = await this.request(input, 'models', 'GET', undefined, this.timeouts.modelsMs, MAX_METADATA_BYTES);
    if (!record(response) || !Array.isArray(response.data) || response.data.length > 10_000) {
      throw this.error('INVALID_RESPONSE', started, false);
    }
    const models = new Map<string, ModelInfo>();
    for (const item of response.data) {
      if (!record(item) || typeof item.id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/.test(item.id) ||
        item.id.includes(key) || /^sk-/i.test(item.id)) continue;
      models.set(item.id, getModelInfo(item.id, true));
    }
    return [...models.values()];
  }

  async generate(input: GenerateRequest): Promise<ProviderImage[]> {
    const started = this.now();
    if (!Array.isArray(input.references)) throw new ProviderError('VALIDATION');
    validateGenerationParams(input.params, input.references.length);
    validatePrompt(input.prompt);
    validateReferences(input.references);
    const key = validatedKey(input.key);
    let body: string | FormData;
    const fields = { model: input.params.model, prompt: input.prompt, n: input.params.count,
      size: input.params.size, quality: input.params.quality };
    if (input.references.length) {
      const form = new FormData();
      for (const [name, value] of Object.entries(fields)) form.append(name, String(value));
      input.references.forEach((ref, index) => {
        // Do not transmit local absolute paths or other original filename metadata.
        const extension = ref.mime === 'image/jpeg' ? 'jpg' : ref.mime === 'image/webp' ? 'webp' : 'png';
        form.append('image[]', new Blob([new Uint8Array(ref.data)], { type: ref.mime }), `reference-${index + 1}.${extension}`);
      });
      body = form;
    } else body = JSON.stringify(fields);
    const limit = input.params.count * Math.ceil(MAX_IMAGE_BYTES / 3) * 4 + MAX_METADATA_BYTES;
    const response = await this.request(input, input.references.length ? 'images/edits' : 'images/generations',
      'POST', body, this.timeouts.generationMs, limit);
    if (!record(response) || !Array.isArray(response.data) || !response.data.length) {
      throw this.error('INVALID_RESPONSE', started, true);
    }
    const images: ProviderImage[] = [];
    let invalid = response.data.length !== input.params.count;
    let oversized = false;
    for (const item of response.data.slice(0, input.params.count)) {
      if (!record(item)) { invalid = true; continue; }
      if (typeof item.b64_json === 'string' && item.b64_json) {
        const b64 = item.b64_json;
        if (b64.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4) { oversized = true; invalid = true; continue; }
        const padding = b64.indexOf('=');
        if (b64.length % 4 !== 0 || /[^A-Za-z0-9+/=]/.test(b64) ||
          (padding !== -1 && (padding < b64.length - 2 || !/^={1,2}$/.test(b64.slice(padding))))) {
          invalid = true; continue;
        }
        const bytes = Buffer.from(b64, 'base64');
        if (bytes.length > MAX_IMAGE_BYTES) { oversized = true; invalid = true; continue; }
        const mime = imageMime(bytes);
        if (!mime) { invalid = true; continue; }
        images.push({ bytes, mime });
      } else {
        const url = resultURL(item.url, key);
        if (url) images.push({ url }); else invalid = true;
      }
    }
    if (invalid || images.length !== input.params.count) {
      throw new ProviderError(images.length ? 'PARTIAL_RESULT' : oversized ? 'RESPONSE_TOO_LARGE' : 'INVALID_RESPONSE', {
        outcome: 'unknown', elapsed: this.now() - started, partialImages: images.length ? images : undefined,
      });
    }
    return images;
  }

  async enhance(input: EnhanceRequest): Promise<string> {
    const started = this.now();
    if (!input.model?.trim()) throw new ProviderError('TEXT_MODEL_REQUIRED');
    if (!getModelInfo(input.model).text || !['optimize', 'translate'].includes(input.mode)) {
      throw new ProviderError('VALIDATION');
    }
    validatePrompt(input.prompt);
    const key = validatedKey(input.key);
    const taskInstruction = input.mode === 'translate'
      ? 'Translate the user image-generation prompt into English. Preserve its meaning and details. Return only the translation.'
      : 'Improve the user image-generation prompt for clarity and visual specificity. Preserve the requested content, intent, and language. Return only the improved prompt.';
    const instruction = `${taskInstruction} Preserve every reference marker @图1 through @图8 and @图一 through @图八 exactly as written, including its spelling and occurrence count. Do not add, remove, translate, or renumber any reference marker.`;
    const response = await this.request(input, 'chat/completions', 'POST', JSON.stringify({
      model: input.model, stream: false, messages: [{ role: 'system', content: instruction },
        { role: 'user', content: input.prompt }],
    }), this.timeouts.enhanceMs, MAX_METADATA_BYTES);
    if (!record(response) || !Array.isArray(response.choices)) throw this.error('INVALID_RESPONSE', started, true);
    const choice = response.choices[0];
    if (!record(choice) || !record(choice.message) || typeof choice.message.content !== 'string' ||
      !choice.message.content.trim() || choice.message.content.length > MAX_PROMPT_LENGTH) {
      throw this.error('INVALID_RESPONSE', started, true);
    }
    const enhanced = cleanText(choice.message.content.trim(), key);
    if (JSON.stringify(referenceTokens(input.prompt)) !== JSON.stringify(referenceTokens(enhanced))) {
      throw new ProviderError('REFERENCE_MISMATCH', { outcome: 'unknown', elapsed: this.now() - started });
    }
    return enhanced;
  }

  private error(code: ProviderErrorCode, started: number, submitted: boolean): ProviderError {
    return new ProviderError(code, { elapsed: this.now() - started, outcome: submitted ? 'unknown' : 'rejected' });
  }
  private async request(input: ProviderCredentials, path: string, method: 'GET' | 'POST', body: string | FormData | undefined,
    headersMs: number, maxBytes: number, bodyMs = this.timeouts.bodyMs): Promise<unknown> {
    const started = this.now();
    const url = endpoint(input.baseURL, path);
    const key = validatedKey(input.key);
    if (input.signal?.aborted) throw this.error('CANCELLED', started, false);
    const controller = new AbortController();
    let timedOut = false;
    let submitted = false;
    const aborted = () => controller.abort();
    input.signal?.addEventListener('abort', aborted, { once: true });
    let timer = setTimeout(() => { timedOut = true; controller.abort(); }, headersMs);
    try {
      submitted = method === 'POST';
      const response = await raceAbort(this.fetcher(url, { method, body, redirect: 'manual', signal: controller.signal,
        headers: { Authorization: `Bearer ${key}`, Accept: 'application/json',
          ...(typeof body === 'string' ? { 'Content-Type': 'application/json' } : {}) },
      }), controller.signal);
      clearTimeout(timer);
      timer = setTimeout(() => { timedOut = true; controller.abort(); }, bodyMs);
      if (response.status >= 300 && response.status < 400) {
        void response.body?.cancel().catch(() => undefined);
        throw this.error('REDIRECT', started, submitted);
      }
      if (!response.ok) {
        void response.body?.cancel().catch(() => undefined);
        const rejected = [400, 401, 403, 404, 405, 413, 415, 422, 429].includes(response.status);
        const retryHeader = response.headers.get('retry-after');
        const seconds = retryHeader && /^\d+(?:\.\d+)?$/.test(retryHeader) ? Number(retryHeader) : NaN;
        const dateDelay = retryHeader ? Date.parse(retryHeader) - this.now() : NaN;
        const delay = Number.isFinite(seconds) ? seconds * 1000 : Number.isFinite(dateDelay) ? dateDelay : 1000;
        throw new ProviderError('HTTP', { status: response.status, outcome: !submitted || rejected ? 'rejected' : 'unknown',
          safeRetry: response.status === 429, retryAfterMs: Math.max(1000, Math.min(60_000, delay)), elapsed: this.now() - started });
      }
      const contentLength = response.headers.get('content-length');
      if (contentLength && /^\d+$/.test(contentLength) && Number(contentLength) > maxBytes) {
        void response.body?.cancel().catch(() => undefined);
        throw this.error('RESPONSE_TOO_LARGE', started, submitted);
      }
      if (!response.body) throw this.error('INVALID_RESPONSE', started, submitted);
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let length = 0;
      try {
        for (;;) {
          const { done, value } = await raceAbort(reader.read(), controller.signal);
          if (done) break;
          length += value.byteLength;
          if (length > maxBytes) throw this.error('RESPONSE_TOO_LARGE', started, submitted);
          chunks.push(value);
        }
      } finally {
        void reader.cancel().catch(() => undefined);
        reader.releaseLock();
      }
      const data = new Uint8Array(length);
      let offset = 0;
      for (const chunk of chunks) { data.set(chunk, offset); offset += chunk.length; }
      try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(data)); }
      catch { throw this.error('INVALID_RESPONSE', started, submitted); }
    } catch (error) {
      if (error instanceof ProviderError) throw error;
      throw this.error(timedOut ? 'TIMEOUT' : controller.signal.aborted ? 'CANCELLED' : 'NETWORK', started, submitted);
    } finally {
      clearTimeout(timer);
      input.signal?.removeEventListener('abort', aborted);
    }
  }
}
