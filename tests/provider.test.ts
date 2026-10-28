import test from 'node:test';
import assert from 'node:assert/strict';
import { ImageProvider, ProviderError, PROVIDER_TIMEOUTS, MAX_IMAGE_BYTES,
  MAX_METADATA_BYTES, getModelInfo, validateGenerationParams, type GenerateRequest } from '../src/main/provider';

const credentials = { baseURL: 'https://api.example.test/v1/', key: 'sk-test-PRIVATE-123456789' };
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a3ioAAAAASUVORK5CYII=', 'base64');
const params = { providerId: 'example', model: 'gpt-image-2', size: '1024x1024', quality: 'medium', count: 1 };
const request = (patch: Partial<GenerateRequest> = {}): GenerateRequest => ({ ...credentials, params: { ...params }, prompt: '一只白猫', references: [], ...patch });
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), {
  status, headers: { 'content-type': 'application/json', ...headers },
});
const result = () => json({ data: [{ b64_json: png.toString('base64') }] });
const fake = (fn: (input: string | URL | Request, init?: RequestInit) => Response | Promise<Response>) => (async (input, init) => fn(input, init)) as typeof fetch;
const expectError = async (action: Promise<unknown>, code: string, outcome: 'rejected' | 'unknown', safeRetry = false): Promise<ProviderError> => {
  try { await action; assert.fail('Expected ProviderError'); }
  catch (error) {
    assert.ok(error instanceof ProviderError);
    assert.equal(error.code, code);
    assert.equal(error.outcome, outcome);
    assert.equal(error.safeRetry, safeRetry);
    assert.equal(error.elapsed, error.elapsedMs);
    assert.ok(error.elapsed >= 0);
    return error;
  }
};

test('GET /models authenticates without following redirects; unknown and text IDs stay conservative', async () => {
  let calls = 0;
  const provider = new ImageProvider({ fetch: fake((url, init) => {
    calls++;
    assert.equal(url, 'https://api.example.test/v1/models');
    assert.equal(init?.method, 'GET');
    assert.equal(init?.redirect, 'manual');
    assert.equal((init?.headers as Record<string, string>).Authorization, `Bearer ${credentials.key}`);
    assert.equal(init?.body, undefined);
    return json({ data: [ { id: 'gpt-image-2' }, { id: 'gpt-image-2.5' }, { id: 'gpt-image-2.5-flare' },
      { id: 'gpt-image-2.5-sunburst' }, { id: 'auto' }, { id: 'gpt-5.6' }, { id: 'unmapped-image-model' },
      { id: 'gpt-image-2' }, { id: credentials.key }, { id: '../\nunsafe' }, { id: 15 } ] });
  }) });
  const models = await provider.models(credentials);
  assert.equal(calls, 1);
  assert.equal(models.length, 7);
  assert.equal(models.filter(model => model.image).length, 4);
  assert.deepEqual(models.filter(model => model.text).map(model => model.id), ['gpt-5.6']);
  assert.equal(models.find(model => model.id === 'gpt-5.6')?.image, false);
  assert.equal(getModelInfo('gpt-5.6').verified, false);
  for (const model of models) assert.equal(model.verified, true);
  for (const model of models.filter(model => !model.image)) {
    assert.equal(model.reference, false); assert.equal(model.maxReferences, 0); assert.equal(model.maxImages, 1);
  }
  assert.equal(getModelInfo('gpt-image-2').verified, false);
});

test('model seed capabilities are detached copies and centrally validate all parameters', () => {
  const model = getModelInfo('gpt-image-2');
  model.sizes.length = 0;
  assert.equal(getModelInfo('gpt-image-2').sizes.length, 8);
  assert.equal(validateGenerationParams(params, 8).maxImages, 4);
  for (const change of [{ model: 'auto' }, { model: 'gpt-5.6' }, { model: 'unknown' }, { count: 0 }, { count: 5 },
    { count: 1.5 }, { size: '1216x832' }, { quality: 'ultra' }, { providerId: '' }]) {
    assert.throws(() => validateGenerationParams({ ...params, ...change }), ProviderError);
  }
  for (const count of [-1, 0.5, 9]) assert.throws(() => validateGenerationParams(params, count), ProviderError);
});

test('requested 1K ratio presets pass validation and are sent as exact pixel sizes', async () => {
  for (const model of ['gpt-image-2', 'gpt-image-2.5', 'gpt-image-2.5-flare', 'gpt-image-2.5-sunburst']) {
    for (const size of ['1024x1024', '1024x1536', '1536x1024', '864x1152', '1152x864', '864x1536', '1536x864']) {
      assert.doesNotThrow(() => validateGenerationParams({ ...params, model, size, quality: 'high', count: 4 }));
      const [width, height] = size.split('x').map(Number);
      assert.equal(width % 16, 0); assert.equal(height % 16, 0);
      assert.ok(width * height >= 655360 && width * height <= 8294400);
    }
  }
  let calls = 0;
  const provider = new ImageProvider(fake((_url, init) => {
    calls++;
    const body = JSON.parse(init?.body as string);
    assert.equal(body.size, '864x1536');
    assert.equal(body.quality, 'medium');
    assert.equal(body.n, 4);
    return json({ data: Array.from({ length: 4 }, () => ({ b64_json: png.toString('base64') })) });
  }));
  const images = await provider.generate(request({ params: { ...params, model: 'gpt-image-2.5', size: '864x1536', quality: 'medium', count: 4 } }));
  assert.equal(images.length, 4); assert.equal(calls, 1);
});

test('JSON generations uses exactly the selected model and parameters and decodes all results', async () => {
  let calls = 0;
  const provider = new ImageProvider(fake((url, init) => {
    calls++;
    assert.equal(url, 'https://api.example.test/v1/images/generations');
    assert.equal(init?.method, 'POST');
    assert.equal(init?.redirect, 'manual');
    assert.deepEqual(JSON.parse(init?.body as string), { model: 'gpt-image-2.5-flare', prompt: '一只白猫', n: 2,
      size: '1536x1024', quality: 'high' });
    assert.equal((init?.headers as Record<string, string>)['Content-Type'], 'application/json');
    return json({ data: [{ b64_json: png.toString('base64') }, { url: 'https://cdn.example.test/second.png?token=signed' }] });
  }));
  const images = await provider.generate(request({ params: { ...params, model: 'gpt-image-2.5-flare', size: '1536x1024', quality: 'high', count: 2 } }));
  assert.deepEqual(images[0].bytes, png);
  assert.equal(images[0].mime, 'image/png');
  assert.equal(images[1].url, 'https://cdn.example.test/second.png?token=signed');
  assert.equal(calls, 1, 'result URLs must not be fetched with credentials by provider');
});

test('multipart edits transmits local bytes in ordered image[] files without leaking original paths', async () => {
  const provider = new ImageProvider(fake(async (url, init) => {
    assert.equal(url, 'https://api.example.test/v1/images/edits');
    assert.ok(init?.body instanceof FormData);
    const form = init.body;
    assert.equal((init.headers as Record<string, string>)['Content-Type'], undefined, 'fetch must set multipart boundary');
    assert.equal(form.get('model'), params.model);
    assert.equal(form.get('prompt'), '一只白猫');
    assert.equal(form.get('n'), '4');
    assert.equal(form.get('size'), '1024x1024');
    assert.equal(form.get('quality'), 'medium');
    const files = form.getAll('image[]') as File[];
    assert.equal(files.length, 2);
    assert.equal(files[0].name, 'reference-1.png');
    assert.equal(files[1].name, 'reference-2.png');
    assert.equal(files[0].type, 'image/png');
    assert.deepEqual(Buffer.from(await files[0].arrayBuffer()), png);
    return json({ data: Array.from({ length: 4 }, () => ({ b64_json: png.toString('base64') })) });
  }));
  await provider.generate(request({ params: { ...params, count: 4 }, references: [
    { name: 'C:\\Users\\private\\secret.png', mime: 'image/png', data: png },
    { name: '/home/user/private.png', mime: 'image/png', data: png },
  ] }));
});

test('local input errors are rejected before any network call', async () => {
  let calls = 0;
  const provider = new ImageProvider(fake(() => { calls++; return result(); }));
  for (const input of [request({ prompt: '' }), request({ prompt: 'x'.repeat(32_001) }), request({ key: '' }),
    request({ key: 'bad\nkey' }), request({ baseURL: 'http://api.example.test/v1' }),
    request({ baseURL: 'https://user:pass@api.example.test/v1' }), request({ baseURL: 'https://api.example.test/v1?key=x' }),
    request({ baseURL: 'https://api.example.test/v1#fragment' }), request({ params: { ...params, count: 5 } }),
    request({ references: [{ name: 'fake.png', mime: 'image/png', data: new Uint8Array([1, 2, 3]) }] }),
    request({ references: [{ name: 'fake.jpg', mime: 'image/jpeg', data: png }] }),
  ]) await expectError(provider.generate(input), 'VALIDATION', 'rejected');
  assert.equal(calls, 0);
});

test('text enhancement explicitly requires configured model and never guesses a text model', async () => {
  let calls = 0;
  const provider = new ImageProvider(fake(() => { calls++; return result(); }));
  const error = await expectError(provider.enhance({ ...credentials, prompt: '猫', mode: 'optimize' }), 'TEXT_MODEL_REQUIRED', 'rejected');
  assert.match(error.message, /尚未配置文本模型/);
  assert.equal(calls, 0);
});

test('configured enhancement uses chat completions with chosen mode and redacts echoed credentials', async () => {
  const provider = new ImageProvider(fake((url, init) => {
    assert.equal(url, 'https://api.example.test/v1/chat/completions');
    const body = JSON.parse(init?.body as string);
    assert.equal(body.model, 'gpt-5.6');
    assert.equal(body.stream, false);
    assert.match(body.messages[0].content, /Translate/);
    assert.deepEqual(body.messages[1], { role: 'user', content: '一只白猫' });
    return json({ choices: [{ message: { content: `A white cat. ${credentials.key}` } }] });
  }));
  const text = await provider.enhance({ ...credentials, model: 'gpt-5.6', prompt: '一只白猫', mode: 'translate' });
  assert.equal(text, 'A white cat. [已隐藏]');
});

test('only a clear HTTP 429 is safe to retry; no request is automatically replayed', async () => {
  for (const status of [400, 401, 403, 404, 408, 409, 413, 422, 429, 500, 502, 503, 504]) {
    let calls = 0;
    const provider = new ImageProvider(fake(() => { calls++; return json({ error: { message: `SECRET ${credentials.key}` } }, status, { 'retry-after': '120' }); }));
    const rejected = [400, 401, 403, 404, 413, 422, 429].includes(status);
    const error = await expectError(provider.generate(request()), 'HTTP', rejected ? 'rejected' : 'unknown', status === 429);
    assert.equal(error.status, status);
    assert.equal(error.retryAfterMs, status === 429 ? 60_000 : undefined);
    assert.equal(calls, 1);
    assert.ok(!JSON.stringify(error).includes(credentials.key));
    assert.ok(!error.stack?.includes(credentials.key));
  }
  assert.equal(new ProviderError('NETWORK', { outcome: 'unknown', safeRetry: true, status: 429 }).safeRetry, false);
});

test('malformed retry-after cannot trigger unbounded immediate retries', async () => {
  const provider = new ImageProvider(fake(() => json({}, 429, { 'retry-after': 'garbage' })));
  const error = await expectError(provider.generate(request()), 'HTTP', 'rejected', true);
  assert.equal(error.retryAfterMs, 1000);
});

test('POST transport failures are unknown and error objects never contain secrets, prompt, endpoint, or raw cause', async () => {
  let calls = 0;
  let now = 100;
  const provider = new ImageProvider({ now: () => now, fetch: fake(() => {
    calls++; now = 200;
    throw new Error(`failed Bearer ${credentials.key} at ${credentials.baseURL} with 一只白猫`);
  }) });
  const error = await expectError(provider.generate(request()), 'NETWORK', 'unknown');
  assert.equal(error.elapsed, 100);
  assert.equal(calls, 1);
  for (const leak of [credentials.key, credentials.baseURL, '一只白猫']) {
    assert.ok(!String(error.stack).includes(leak)); assert.ok(!JSON.stringify(error).includes(leak));
  }
  assert.equal('cause' in error, false);
});

test('GET transport failure has no generation ambiguity', async () => {
  const provider = new ImageProvider(fake(() => Promise.reject(new Error(credentials.key))));
  await expectError(provider.models(credentials), 'NETWORK', 'rejected');
});

test('API redirects are not followed or replayed, preventing key forwarding', async () => {
  let calls = 0;
  const provider = new ImageProvider(fake((_url, init) => {
    calls++; assert.equal(init?.redirect, 'manual');
    return new Response(null, { status: 307, headers: { location: 'https://other.example.test/steal' } });
  }));
  await expectError(provider.generate(request()), 'REDIRECT', 'unknown');
  assert.equal(calls, 1);
});

test('generation has independent 20 minute headers deadline, not models 30 seconds', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const provider = new ImageProvider(fake((_url, init) => new Promise((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
  })));
  assert.equal(PROVIDER_TIMEOUTS.generationMs, 20 * 60_000);
  assert.equal(provider.timeouts.generationMs, 20 * 60_000);
  let settled = false;
  const outcome = expectError(provider.generate(request()), 'TIMEOUT', 'unknown').then(error => { settled = true; return error; });
  t.mock.timers.tick(30_001);
  await Promise.resolve();
  assert.equal(settled, false);
  t.mock.timers.tick(20 * 60_000 - 30_001);
  await outcome;
});

test('model timeout and generation response-body timeout are separate and bounded', async () => {
  const noResponse = new ImageProvider({ fetch: fake(() => new Promise(() => {})), timeouts: { modelsMs: 5 } });
  await expectError(noResponse.models(credentials), 'TIMEOUT', 'rejected');
  const bodyStalls = new ImageProvider({ fetch: fake(() => new Response(new ReadableStream({ start() {} }))),
    timeouts: { generationMs: 100, bodyMs: 5 } });
  await expectError(bodyStalls.generate(request()), 'TIMEOUT', 'unknown');
});

test('abort before dispatch is rejected; abort after dispatch is unknown; fetch receives linked signal', async () => {
  let calls = 0;
  const before = new AbortController(); before.abort();
  const provider = new ImageProvider(fake(() => { calls++; return result(); }));
  await expectError(provider.generate(request({ signal: before.signal })), 'CANCELLED', 'rejected');
  assert.equal(calls, 0);
  const after = new AbortController();
  let observed: AbortSignal | undefined;
  const pending = new ImageProvider(fake((_url, init) => {
    calls++; observed = init?.signal as AbortSignal;
    return new Promise(() => {});
  }));
  const outcome = expectError(pending.generate(request({ signal: after.signal })), 'CANCELLED', 'unknown');
  after.abort(); await outcome;
  assert.equal(observed?.aborted, true);
  assert.equal(calls, 1);
});

test('partial output is preserved but cannot be automatically regenerated', async () => {
  for (const data of [ [{ b64_json: png.toString('base64') }], [{ b64_json: png.toString('base64') }, { b64_json: 'broken' }] ]) {
    const provider = new ImageProvider(fake(() => json({ data })));
    const error = await expectError(provider.generate(request({ params: { ...params, count: 2 } })), 'PARTIAL_RESULT', 'unknown');
    assert.equal(error.partialImages?.length, 1);
    assert.deepEqual(error.partialImages?.[0].bytes, png);
  }
});

test('too many outputs are bounded and flagged instead of silently claiming requested count', async () => {
  const provider = new ImageProvider(fake(() => json({ data: Array.from({ length: 5 }, () => ({ b64_json: png.toString('base64') })) })));
  const error = await expectError(provider.generate(request()), 'PARTIAL_RESULT', 'unknown');
  assert.equal(error.partialImages?.length, 1);
});

test('invalid and non-image response data cannot be mistaken for successful generation', async () => {
  for (const body of [{}, { error: { message: credentials.key } }, { data: [] }, { data: [null] },
    { data: [{ b64_json: 'broken' }] }, { data: [{ b64_json: Buffer.from('<svg>bad</svg>').toString('base64') }] }]) {
    const provider = new ImageProvider(fake(() => json(body)));
    await expectError(provider.generate(request()), 'INVALID_RESPONSE', 'unknown');
  }
  const provider = new ImageProvider(fake(() => new Response(`not json ${credentials.key}`)));
  const error = await expectError(provider.generate(request()), 'INVALID_RESPONSE', 'unknown');
  assert.ok(!String(error).includes(credentials.key));
});

test('unsafe or credential-reflecting result URLs are rejected and never downloaded', async () => {
  for (const url of ['http://cdn.example.test/image.png', 'file:///etc/passwd', 'data:image/png;base64,xxx',
    'https://user:password@cdn.example.test/image.png', 'https://cdn.example.test/image.png#secret',
    `https://cdn.example.test/image.png?key=${credentials.key}`, `https://cdn.example.test/image.png?key=${encodeURIComponent(credentials.key)}`]) {
    let calls = 0;
    const provider = new ImageProvider(fake(() => { calls++; return json({ data: [{ url }] }); }));
    await expectError(provider.generate(request()), 'INVALID_RESPONSE', 'unknown');
    assert.equal(calls, 1);
  }
});

test('Content-Length rejects oversized image response before reading', async () => {
  let cancelled = false;
  const provider = new ImageProvider(fake(() => new Response(new ReadableStream({ cancel() { cancelled = true; } }), {
    headers: { 'content-length': String(Math.ceil(MAX_IMAGE_BYTES / 3) * 4 + MAX_METADATA_BYTES + 1) },
  })));
  await expectError(provider.generate(request()), 'RESPONSE_TOO_LARGE', 'unknown');
  assert.equal(cancelled, true);
});

test('streaming byte counter enforces bounds even without Content-Length', async () => {
  let cancelled = false;
  const provider = new ImageProvider(fake(() => new Response(new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array(MAX_METADATA_BYTES + 1)); },
    cancel() { cancelled = true; },
  }))));
  await expectError(provider.models(credentials), 'RESPONSE_TOO_LARGE', 'rejected');
  assert.equal(cancelled, true);
});

test('a base64 image exceeding decoded 32 MiB is refused before exposing bytes', async () => {
  const bytes = Buffer.alloc(MAX_IMAGE_BYTES + 1); png.copy(bytes);
  const provider = new ImageProvider(fake(() => json({ data: [{ b64_json: bytes.toString('base64') }] })));
  await expectError(provider.generate(request()), 'RESPONSE_TOO_LARGE', 'unknown');
});

test('truncated HTTP body is unknown and no raw transport message escapes', async () => {
  const provider = new ImageProvider(fake(() => new Response(new ReadableStream({
    start(controller) { controller.enqueue(new TextEncoder().encode('{"data":[')); controller.error(new Error(credentials.key)); },
  }))));
  const error = await expectError(provider.generate(request()), 'NETWORK', 'unknown');
  assert.ok(!String(error).includes(credentials.key));
});

test('production undici request transport does not replay POST on 421 or follow 307', async () => {
  const { MockAgent } = await import('undici');
  for (const status of [421, 307]) {
    const mock = new MockAgent({ enableCallHistory: true });
    mock.disableNetConnect();
    const pool = mock.get('https://api.example.test');
    pool.intercept({ path: '/v1/images/generations', method: 'POST' }).reply(status, JSON.stringify({ error: 'rejected' }), {
      headers: { location: 'https://other.example.test/should-not-follow', 'content-type': 'application/json' },
    }).persist();
    const provider = new ImageProvider({ dispatcher: mock });
    await expectError(provider.generate(request()), status === 307 ? 'REDIRECT' : 'HTTP', 'unknown');
    assert.equal(mock.getCallHistory()?.calls().length, 1, 'must be exactly one POST at transport level');
    await mock.close();
  }
});

test('production transport parses JSON and encodes multipart files via undici without network', async () => {
  const { MockAgent } = await import('undici');
  const mock = new MockAgent({ enableCallHistory: true }); mock.disableNetConnect();
  const pool = mock.get('https://api.example.test');
  pool.intercept({ path: '/v1/models', method: 'GET' }).reply(200, { data: [{ id: 'gpt-image-2' }] });
  pool.intercept({ path: '/v1/images/generations', method: 'POST' }).reply(200, { data: [{ b64_json: png.toString('base64') }] });
  pool.intercept({ path: '/v1/images/edits', method: 'POST' }).reply(200, { data: [{ b64_json: png.toString('base64') }] });
  const provider = new ImageProvider({ dispatcher: mock });
  assert.equal((await provider.models(credentials))[0].id, 'gpt-image-2');
  assert.deepEqual((await provider.generate(request()))[0].bytes, png);
  assert.deepEqual((await provider.generate(request({ references: [{ name: 'input.png', mime: 'image/png', data: png }] })))[0].bytes, png);
  assert.equal(mock.getCallHistory()?.calls().length, 3);
  mock.assertNoPendingInterceptors();
  await mock.close();
});


test('text capability never comes from auto, embeddings, image names, or unknown model prefixes', async () => {
  const ids = ['auto', 'text-embedding-3-small', 'gpt-image-2', 'gpt-image-2.5-flare',
    'unknown-text-model', 'gpt-5.6-image', 'gpt-5.6-embedding', 'gpt-5.6-fake', 'gpt-5.6'];
  const provider = new ImageProvider(fake(() => json({ data: ids.map(id => ({ id })) })));
  const models = await provider.models(credentials);
  assert.equal(models.length, ids.length, 'all model categories remain visible in settings');
  assert.deepEqual(models.filter(model => model.text).map(model => model.id), ['gpt-5.6']);
  for (const model of models.filter(model => model.text)) {
    assert.equal(model.image, false); assert.equal(model.reference, false); assert.equal(model.verified, true);
  }
  let calls = 0;
  const guarded = new ImageProvider(fake(() => { calls++; return result(); }));
  for (const model of ids.filter(id => id !== 'gpt-5.6')) {
    await expectError(guarded.enhance({ ...credentials, model, prompt: '猫', mode: 'optimize' }), 'VALIDATION', 'rejected');
  }
  await expectError(guarded.enhance({ ...credentials, model: 'gpt-5.6', key: '', prompt: '猫', mode: 'optimize' }), 'VALIDATION', 'rejected');
  assert.equal(calls, 0);
});

test('enhancement instructs and verifies exact numbered and Chinese reference preservation', async () => {
  for (const mode of ['translate', 'optimize'] as const) {
    const provider = new ImageProvider(fake((_url, init) => {
      const body = JSON.parse(init?.body as string);
      assert.match(body.messages[0].content, /Preserve every reference marker/);
      assert.match(body.messages[0].content, /Do not add, remove, translate, or renumber/);
      return json({ choices: [{ message: { content: 'Combine @图1 with @图八, using @图1 as the background.' } }] });
    }));
    const enhanced = await provider.enhance({ ...credentials, model: 'gpt-5.6', mode,
      prompt: '把@图1与@图八结合，以@图1为背景。' });
    assert.equal(enhanced, 'Combine @图1 with @图八, using @图1 as the background.');
  }
});

test('enhancement rejects dropped, translated, renumbered, newly added or duplicated reference markers', async () => {
  for (const content of ['Combine Image 1 with @图八.', 'Combine @图2 with @图八.',
    'Combine @图一 with @图八.', 'Combine @图1 with @图八 and @图3.',
    'Combine @图1 and @图1 with @图八.', 'Combine @图12 with @图八.']) {
    const provider = new ImageProvider(fake(() => json({ choices: [{ message: { content } }] })));
    const error = await expectError(provider.enhance({ ...credentials, model: 'gpt-5.6', mode: 'translate',
      prompt: '把@图1与@图八结合。' }), 'REFERENCE_MISMATCH', 'unknown');
    assert.match(error.message, /保留原提示词/);
  }
});

test('ordinary at-signs and unsupported longer numeric tokens are not treated as references', async () => {
  const provider = new ImageProvider(fake(() => json({ choices: [{ message: { content: 'A white cat.' } }] })));
  assert.equal(await provider.enhance({ ...credentials, model: 'gpt-5.6', mode: 'translate',
    prompt: '联系 @alice 或 cat@example.test；文字 @图12 @图十二 @图1abc，一只白猫。' }), 'A white cat.');
  const newRef = new ImageProvider(fake(() => json({ choices: [{ message: { content: 'A white cat in @图1.' } }] })));
  await expectError(newRef.enhance({ ...credentials, model: 'gpt-5.6', mode: 'translate', prompt: '一只白猫。' }), 'REFERENCE_MISMATCH', 'unknown');
});
