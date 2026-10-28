import React, { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { Action, AppState, GenerationParams, Job, ModelInfo, OutputLayout, Provider, QuotaInfo, Settings, Task, TaskKind } from '../shared/types';
import { activeJob, aspectRatio, is1kPreset, isAppState, modelChoices, normalizeParams, pendingImageSlots, sizeForRatio, sizeForResolution, statusLabels, summarizeTask, textModelChoices, textSelectionValue, selectedImageModel } from './model-utils';
import { IMAGE_RATIO_PRESETS } from '../shared/image-presets';
import { clearPromptIfUnchanged, findWorkspaceDraft, groupJobsByRun, hasNewSingleSubmission, visibleWorkspaceTasks, workspaceTaskLabel } from './workspace-utils';
import { affectedReferenceMarker, findMentionRange, insertReferenceMention, type MentionRange } from './reference-mentions';
import { Select } from './Select';
import { movePreview, selectPreview, type PreviewImage, type PreviewSelection } from './preview-utils';
import { isQuotaInfo, quotaDetails, quotaText } from './quota-utils';
import { NAMING_PRESETS, outputName, presetNamingMode } from '../shared/output-naming';
import { PRODUCT } from '../shared/product';

type Page = 'gen' | 'batch' | 'providers' | 'settings' | 'about';
type Notice = { message: string; error: boolean };
type API = { state: AppState | null; online: boolean; busy: (key: string) => boolean;
  request: (action: Action, payload?: Record<string, unknown>, key?: string) => Promise<unknown>;
  notify: (message: string, error?: boolean) => void };
const APIContext = createContext<API>(null!);
const useAPI = () => useContext(APIContext);
const messageOf = (error: unknown) => error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+':\s*(Error:\s*)?/, '') : '操作失败，请重试。';

function useBridge() {
  const [state, setState] = useState<AppState | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [pending, setPending] = useState<string[]>([]);
  const locks = useRef(new Set<string>());
  const publication = useRef(0);
  const alive = useRef(true);
  const online = typeof window.qingtu?.invoke === 'function';
  const notify = useCallback((message: string, error = false) => setNotice({ message, error }), []);
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(current => current === notice ? null : current), notice.error ? 6000 : 3000);
    return () => clearTimeout(timer);
  }, [notice]);
  const request = useCallback(async (action: Action, payload: Record<string, unknown> = {}, key: string = action): Promise<unknown> => {
    if (!window.qingtu?.invoke) { notify('未连接桌面服务。请在轻图桌面程序中打开。', true); return undefined; }
    if (locks.current.has(key)) return undefined;
    locks.current.add(key); setPending([...locks.current]);
    const before = publication.current;
    try {
      const result: unknown = await window.qingtu.invoke(action, payload);
      if (alive.current && isAppState(result) && publication.current === before) setState(result);
      return result;
    } catch (error) {
      if (alive.current) notify(messageOf(error), true);
      return undefined;
    } finally {
      locks.current.delete(key);
      if (alive.current) setPending([...locks.current]);
    }
  }, [notify]);
  useEffect(() => {
    alive.current = true;
    if (!online) return () => { alive.current = false; };
    let live = true;
    const unsubscribe = window.qingtu.subscribe(next => {
      if (!live || !isAppState(next)) return;
      publication.current++;
      setState(next);
      if (next.notice) notify(next.notice);
    });
    void request('getState');
    return () => { live = false; alive.current = false; unsubscribe(); };
  }, [online, request, notify]);
  const api = useMemo<API>(() => ({ state, online, busy: key => pending.includes(key), request, notify }), [state, online, pending, request, notify]);
  return { api, notice };
}

function Icon({ name }: { name: Page }) {
  const paths: Record<Page, React.ReactNode> = {
    gen: <><path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z" /><path d="M19 15l.9 2.1L22 18l-2.1.9L19 21l-.9-2.1L16 18l2.1-.9z" /></>,
    batch: <><rect x="3" y="3" width="8.5" height="8.5" rx="2" /><rect x="12.5" y="3" width="8.5" height="8.5" rx="2" /><rect x="3" y="12.5" width="8.5" height="8.5" rx="2" /><path d="M15 16.5h3.5M16.7 14.7v3.6" /></>,
    providers: <><rect x="3" y="5" width="18" height="14" rx="2.5" /><path d="M3 15.5l4.5-4.5 3.5 3.5 3-3 7 7" /><circle cx="15.5" cy="9" r="1.6" /></>,
    settings: <><circle cx="12" cy="12" r="3.2" /><path d="M12 2.8v3M12 18.2v3M4.3 7.6l2.6 1.5M17.1 14.9l2.6 1.5M4.3 16.4l2.6-1.5M17.1 9.1l2.6-1.5" /></>,
    about: <><circle cx="12" cy="12" r="9" /><path d="M12 11v6M12 7v.2" /></>,
  };
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">{paths[name]}</svg>;
}
function Status({ status, children }: { status: Job['status']; children?: React.ReactNode }) {
  const type = status === 'completed' ? 'ok' : ['failed', 'unknown'].includes(status) ? 'fail' : ['queued'].includes(status) ? 'queue' : 'run';
  return <span className={`st st-${type}`} title={typeof children === 'string' ? children : statusLabels[status]}><i aria-hidden="true" /><span className="st-label">{children ?? statusLabels[status]}</span></span>;
}
function Empty({ title, children }: { title: string; children?: React.ReactNode }) {
  return <div className="empty-state"><div className="empty-icon">◇</div><h3>{title}</h3><div>{children}</div></div>;
}
function QuotaStatus({ provider }: { provider?: Provider }) {
  const { state, online, notify } = useAPI();
  const [quota, setQuota] = useState<QuotaInfo | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const lock = useRef(false);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const enabled = online && state?.features?.quotaQuery && provider?.hasKey;
  const query = async () => {
    if (!enabled || !provider || lock.current) return;
    lock.current = true; setLoading(true); setError('');
    try {
      const result: unknown = await window.qingtu.invoke('queryQuota', { id: provider.id });
      if (!isQuotaInfo(result)) throw new Error('额度响应无法识别，请重启程序后重试。');
      if (alive.current) setQuota(result);
    } catch (cause) {
      if (alive.current) { const message = messageOf(cause); setQuota(null); setError(message); notify(message, true); }
    } finally { lock.current = false; if (alive.current) setLoading(false); }
  };
  const unavailable = !online ? '未连接' : !state ? '正在连接' : !provider ? '请选择模型' : !provider.hasKey ? '未配置 Key' : !state.features?.quotaQuery ? '重启后可查询' : '点击查询';
  const text = loading ? '额度 · 查询中…' : error ? '额度 · 查询失败' : quota ? quotaText(quota) : `额度 · ${unavailable}`;
  const title = [provider?.name, error || (quota ? quotaDetails(quota) : unavailable)].filter(Boolean).join('\n');
  return <button type="button" className={`quota-status ${error ? 'quota-status--error' : ''}`} disabled={!enabled || loading} title={title} aria-label={`${loading ? '正在查询' : '查询'}${provider?.name ?? ''}的额度`} onClick={() => void query()}><span>{text}</span><svg className={loading ? 'quota-refresh is-loading' : 'quota-refresh'} viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><path d="M15.5 6a6 6 0 1 0 .5 7M15.5 2.5V6H12" strokeLinecap="round" strokeLinejoin="round" /></svg></button>;
}
function Modal({ title, onClose, children, footer, busy = false, className = '' }: { title: string; onClose: () => void; children: React.ReactNode; footer?: React.ReactNode; busy?: boolean; className?: string }) {
  const panel = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose); closeRef.current = onClose;
  const busyRef = useRef(busy); busyRef.current = busy;
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const node = panel.current;
    const root = document.getElementById('root');
    const wasInert = root?.inert ?? false;
    if (root) root.inert = true;
    const initialFocus = node?.querySelector<HTMLElement>('input:not(:disabled), textarea:not(:disabled)')
      ?? node?.querySelector<HTMLElement>('button:not(:disabled), [tabindex="0"]');
    initialFocus?.focus();
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !busyRef.current) { event.preventDefault(); closeRef.current(); }
      if (event.key !== 'Tab') return;
      const nodes = [...(node?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), summary, a[href], [tabindex="0"]') ?? [])].filter(item => item.getClientRects().length > 0);
      if (!nodes.length) { event.preventDefault(); return; }
      if (!node?.contains(document.activeElement)) { event.preventDefault(); (event.shiftKey ? nodes[nodes.length - 1] : nodes[0]).focus(); return; }
      if (event.shiftKey && document.activeElement === nodes[0]) { event.preventDefault(); nodes[nodes.length - 1].focus(); }
      if (!event.shiftKey && document.activeElement === nodes[nodes.length - 1]) { event.preventDefault(); nodes[0].focus(); }
    };
    document.addEventListener('keydown', keydown);
    return () => { document.removeEventListener('keydown', keydown); if (root) root.inert = wasInert; if (previous?.isConnected) previous.focus(); };
  }, []);
  useEffect(() => {
    const node = panel.current;
    if (node && !node.contains(document.activeElement)) node.focus();
  }, [busy]);
  return createPortal(<div className="modal-mask" onMouseDown={event => { if (event.target === event.currentTarget && !busy) onClose(); }}>
    <div className={`modal ${className}`} role="dialog" aria-modal="true" aria-label={title} aria-busy={busy} tabIndex={-1} ref={panel}>
      <div className="modal-hd"><b>{title}</b><button className="modal-close" onClick={onClose} disabled={busy} aria-label="关闭弹窗">✕</button></div>
      <div className="modal-bd">{children}</div>{footer && <div className="modal-ft">{footer}</div>}
    </div>
  </div>, document.body);
}
function Confirm({ title, children, onClose, onConfirm, busy = false }: { title: string; children: React.ReactNode; onClose: () => void; onConfirm: () => void; busy?: boolean }) {
  return <Modal title={title} onClose={onClose} busy={busy} footer={<><button className="btn" onClick={onClose} disabled={busy}>取消</button><button className="btn btn--danger" onClick={onConfirm} disabled={busy}>{busy ? '处理中…' : '确认'}</button></>}>{children}</Modal>;
}

function Sidebar({ page, setPage }: { page: Page; setPage: (page: Page) => void }) {
  const { request, online } = useAPI();
  const [slide, setSlide] = useState(0);
  const [hover, setHover] = useState(false);
  const ads = [
    { key: 'ad0' as const, title: '✦ 生图模型', description: '连接供应商，启用你的生图模型', tone: '' },
    { key: 'ad1' as const, title: '⚡ 供应商服务', description: '查看节点服务与额度信息', tone: 'ad--hot' },
    { key: 'ad2' as const, title: '📚 提示词使用指南', description: '了解参考图与提示词的使用方式', tone: 'ad--cool' },
  ].filter(ad => Boolean(PRODUCT.links[ad.key]));
  const activeSlide = ads.length ? slide % ads.length : 0;
  useEffect(() => { if (hover || ads.length < 2) return; const timer = setInterval(() => setSlide(value => (value + 1) % ads.length), 5000); return () => clearInterval(timer); }, [hover, ads.length]);
  const navigation: [Page, string][] = [['gen', '生成'], ['batch', '批量生图'], ['providers', '供应商设置'], ['settings', '基础设置'], ['about', '关于']];
  return <aside className="sidebar"><nav className="nav" aria-label="主导航">
    {navigation.map(([id, label], index) => <React.Fragment key={id}>{(index === 0 || index === 2) && <div className="sec">{index === 0 ? '生成' : '系统'}</div>}<button className={`nav-item ${page === id ? 'on' : ''}`} aria-current={page === id ? 'page' : undefined} onClick={() => setPage(id)}><Icon name={id} />{label}</button></React.Fragment>)}
  </nav>{ads.length > 0 && <div className="adbox" onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}>
    <button className="ad-main" disabled={!online} onClick={() => void request('openLink', { name: ads[activeSlide].key })}><div className="ad-slides" style={{ transform: `translateX(-${activeSlide * 100}%)` }}>{ads.map(ad => <div className={`ad ${ad.tone}`} key={ad.key}><div className="ad-t">{ad.title}</div><div className="ad-d">{ad.description}</div></div>)}</div><span className="ad-go">了解详情 →</span></button>
    {ads.length > 1 && <div className="ad-dots">{ads.map((_, i) => <button key={i} aria-label={`资讯 ${i + 1}`} className={activeSlide === i ? 'on' : ''} onClick={() => setSlide(i)} />)}</div>}
  </div>}</aside>;
}

type Draft = Pick<Task, 'prompt' | 'params' | 'concurrency' | 'retry'>;
function draftOf(task: Task): Draft { return { prompt: task.prompt, params: task.params, concurrency: task.concurrency, retry: task.retry }; }
function useDraftStore(api: API) {
  const drafts = useRef(new Map<string, Draft>());
  const revisions = useRef(new Map<string, number>());
  const savedRevisions = useRef(new Map<string, number>());
  const hasUnsaved = useCallback((id: string) => (revisions.current.get(id) ?? 0) > (savedRevisions.current.get(id) ?? 0), []);
  const listeners = useRef(new Map<string, Set<(draft: Draft) => void>>());
  const subscribeDraft = useCallback((id: string, listener: (draft: Draft) => void) => { const set = listeners.current.get(id) ?? new Set(); set.add(listener); listeners.current.set(id, set); return () => { set.delete(listener); }; }, []);
  const syncPrompt = useCallback((id: string, prompt: string, revision: number, fallback: Draft) => {
    if ((revisions.current.get(id) ?? 0) !== revision) return;
    const next = { ...(drafts.current.get(id) ?? fallback), prompt };
    drafts.current.set(id, next); revisions.current.set(id, revision + 1); savedRevisions.current.set(id, revision + 1);
    listeners.current.get(id)?.forEach(listener => listener(next));
  }, []);
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const queues = useRef(new Map<string, Promise<unknown>>());
  const persist = useCallback((id: string, draft: Draft) => {
    const revision = revisions.current.get(id) ?? 0;
    const prior = queues.current.get(id) ?? Promise.resolve();
    const next = prior.then(() => api.request('updateTask', { id, ...draft }, `update:${id}`)).then(result => { if (result !== undefined) savedRevisions.current.set(id, revision); return result; });
    queues.current.set(id, next);
    return next;
  }, [api.request]);
  const change = useCallback((id: string, draft: Draft) => {
    drafts.current.set(id, draft); revisions.current.set(id, (revisions.current.get(id) ?? 0) + 1);
    clearTimeout(timers.current.get(id));
    timers.current.set(id, setTimeout(() => { timers.current.delete(id); void persist(id, draft); }, 450));
  }, [persist]);
  const flush = useCallback(async (id: string, draft?: Draft) => {
    clearTimeout(timers.current.get(id)); timers.current.delete(id);
    const current = draft ?? drafts.current.get(id);
    if (current) { drafts.current.set(id, current); return persist(id, current); }
    return queues.current.get(id);
  }, [persist]);
  const forget = useCallback((id: string) => {
    clearTimeout(timers.current.get(id)); timers.current.delete(id);
    drafts.current.delete(id); revisions.current.delete(id); savedRevisions.current.delete(id); queues.current.delete(id); listeners.current.delete(id);
  }, []);
  const clearSubmittedPrompt = useCallback(async (id: string, revision: number, fallback: Draft) => {
    const next = clearPromptIfUnchanged(drafts.current.get(id) ?? fallback, revision, revisions.current.get(id) ?? 0);
    if (!next) return;
    change(id, next);
    listeners.current.get(id)?.forEach(listener => listener(next));
    await flush(id, next);
  }, [change, flush]);
  useEffect(() => {
    if (!api.state) return;
    const choices = modelChoices(api.state.providers);
    for (const [id, cached] of drafts.current) {
      if ((!cached.params.providerId && !cached.params.model) || selectedImageModel(choices, cached.params)) continue;
      const next = { ...cached, params: normalizeParams(cached.params) };
      if (hasUnsaved(id)) change(id, next); else drafts.current.set(id, next);
      listeners.current.get(id)?.forEach(listener => listener(next));
    }
  }, [api.state?.providers, change, hasUnsaved]);
  useEffect(() => () => { for (const timer of timers.current.values()) clearTimeout(timer); }, []);
  return { drafts, revisions, change, flush, forget, clearSubmittedPrompt, subscribeDraft, syncPrompt, hasUnsaved };
}
type DraftStore = ReturnType<typeof useDraftStore>;

function TaskList({ kind, selected, select, startNew, deleteTask }: { kind: TaskKind; selected?: string; select: (id: string) => void; startNew: () => void; deleteTask: (task: Task) => Promise<boolean> }) {
  const { state, online, busy, request, notify } = useAPI();
  const [query, setQuery] = useState('');
  const [renaming, setRenaming] = useState<Task | null>(null);
  const [name, setName] = useState('');
  const [deleting, setDeleting] = useState<Task | null>(null);
  const [deletingBusy, setDeletingBusy] = useState(false);
  const taskTypeName = kind === 'single' ? '对话' : '批量任务';
  const renameInput = useRef<HTMLInputElement>(null);
  useEffect(() => { if (renaming) { renameInput.current?.focus(); renameInput.current?.select(); } }, [renaming]);
  const rename = async () => {
    if (!renaming || !name.trim() || busy(`rename:${renaming.id}`)) return;
    const result = await request('renameTask', { id: renaming.id, title: name }, `rename:${renaming.id}`);
    if (result !== undefined) { setRenaming(null); notify('名称已更新。'); }
  };
  const tasks = visibleWorkspaceTasks(state?.tasks ?? [], kind).filter(task => `${task.prompt} ${workspaceTaskLabel(task)} ${task.title}`.toLowerCase().includes(query.trim().toLowerCase()));
  return <aside className="panel panel--l"><div className="sec-box task-new">{kind === 'single' ? <><div className="task-list-heading"><b>创作记录</b><button className="btn task-add" onClick={startNew} disabled={!online || !state || busy(`create:${kind}`)}>{busy(`create:${kind}`) ? '准备中…' : '＋ 新建'}</button></div><input className="ipt task-search" aria-label="搜索任务" placeholder="搜索创作记录" value={query} onChange={event => setQuery(event.target.value)} /></> : <button className="btn full" onClick={startNew} disabled={!online || !state || busy(`create:${kind}`)}>{busy(`create:${kind}`) ? '准备中…' : '＋ 新建任务'}</button>}</div>
    <div className="sec-box task-list">{tasks.length ? tasks.map(task => { const stats = summarizeTask(task); const label = workspaceTaskLabel(task); return <div key={task.id} className={`task task-entry ${selected === task.id ? 'on' : ''}`}>
      <button type="button" className="task-select" onClick={() => select(task.id)} aria-current={selected === task.id ? 'true' : undefined}>
        {kind === 'single' && <div className="thumb">{stats.results[0] ? <img src={stats.results[0].url} alt="" /> : <span>◇</span>}</div>}
        <div className="info"><div className="pt" title={label}>{label}{kind === 'batch' && ` · ${task.rows.length} 条`}</div><div className="mt"><Status status={stats.status}>{task.jobs.length ? stats.label : '草稿'}</Status>{kind === 'single' && <span>{new Date(task.createdAt).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}</span>}</div>{(stats.active || stats.queued > 0) && <div className="pg" aria-label={`完成 ${stats.completed} / ${stats.total}`}><i style={{ width: `${stats.total ? stats.completed / stats.total * 100 : 0}%` }} /></div>}</div>
      </button>
      <div className="task-actions"><button type="button" className="task-action" aria-label={`重命名 ${label}`} title="重命名" onClick={() => { setName(label.slice(0, 100)); setRenaming(task); }}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><path d="m4 20 4-.8L19 8.2 15.8 5 4.8 16zM14.5 6.3l3.2 3.2" strokeLinejoin="round" /></svg></button><button type="button" className="task-action task-action-delete" aria-label={`删除 ${label}`} title={stats.active || stats.queued > 0 ? '任务进行中，暂不能删除' : '删除'} disabled={Boolean(stats.active || stats.queued > 0)} onClick={() => setDeleting(task)}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><path d="M4 7h16M9 7V4h6v3m-9 0 1 13h10l1-13M10 10v7m4-7v7" strokeLinecap="round" strokeLinejoin="round" /></svg></button></div>
    </div>; }) : <p className="empty-note">{query ? '没有匹配的创作记录' : online ? '提交任务后将在这里显示' : '桌面服务未连接'}</p>}</div>
    {renaming && <Modal title={`重命名${taskTypeName}`} onClose={() => setRenaming(null)} busy={busy(`rename:${renaming.id}`)} className="task-dialog" footer={<><button className="btn" onClick={() => setRenaming(null)} disabled={busy(`rename:${renaming.id}`)}>取消</button><button className="btn btn--pri" disabled={!name.trim() || busy(`rename:${renaming.id}`)} onClick={() => void rename()}>保存</button></>}><div className="frow"><label htmlFor="task-name">{taskTypeName}名称</label><input ref={renameInput} id="task-name" className="ipt" value={name} maxLength={100} disabled={busy(`rename:${renaming.id}`)} onChange={event => setName(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && !event.nativeEvent.isComposing) { event.preventDefault(); void rename(); } }} /></div></Modal>}
    {deleting && <Confirm title={`删除${taskTypeName}`} onClose={() => setDeleting(null)} busy={deletingBusy} onConfirm={() => { setDeletingBusy(true); void deleteTask(deleting).then(success => { if (success) { setDeleting(null); notify(`${taskTypeName}已删除。`); } }).finally(() => setDeletingBusy(false)); }}>确定删除“{workspaceTaskLabel(deleting)}”吗？{taskTypeName}会从列表移除，已生成的图片文件和历史数据会保留。</Confirm>}
  </aside>;
}

type LocalSubmission = { taskId: string; count: number; previousJobs: number; prompt: string; referenceIds: string[] };
function PendingImage({ phase, paused = false, run }: { phase: string; paused?: boolean; run: number }) {
  return <div className="image-pending" role="status" aria-label={`第 ${run} 轮，${phase}，等待图片`}><div className="image-pending-inner"><span className={`image-pending-spinner ${paused ? 'is-paused' : ''}`} aria-hidden="true" /><span className="image-pending-title">正在处理图片</span><span className="image-pending-phase">{phase}</span></div></div>;
}
function UserMessage({ prompt, referenceIds, onPreview }: { prompt: string; referenceIds: string[]; onPreview: (image: PreviewImage, images: PreviewImage[]) => void }) {
  const { state } = useAPI();
  const images: PreviewImage[] = referenceIds.flatMap(id => { const reference = state?.references.find(item => item.id === id); return reference ? [{ kind: 'reference' as const, id: reference.id, name: reference.name }] : []; });
  return <div className="conversation-user"><div className="conversation-prompt">{prompt}</div>{referenceIds.length > 0 && <div className="conversation-references" aria-label="本轮参考图">{referenceIds.map(id => { const ref = state?.references.find(item => item.id === id); return ref ? <button type="button" className="conversation-reference" key={id} aria-label={`预览参考图 ${ref.name}`} title="点击预览参考图" onClick={() => onPreview({ kind: 'reference', id: ref.id, name: ref.name }, images)}><img src={ref.url} alt="" /></button> : <span key={id} className="conversation-reference-missing">参考图不可用</span>; })}</div>}</div>;
}
function ResultCanvas({ task, localSubmission }: { task: Task; localSubmission: LocalSubmission | null }) {
  const { request, busy } = useAPI();
  const stats = summarizeTask(task);
  const [retryUnknown, setRetryUnknown] = useState(false);
  const [preview, setPreview] = useState<PreviewSelection | null>(null);
  const resultImages: PreviewImage[] = stats.results.map(result => ({ kind: 'result', id: result.id, name: result.name }));
  const openPreview = (image: PreviewImage, images: PreviewImage[]) => setPreview(selectPreview(images, image));
  const scrollPanel = useRef<HTMLDivElement>(null);
  const followLatest = useRef(true);
  const runs = groupJobsByRun(task.jobs);
  const local = localSubmission?.taskId === task.id && task.jobs.length === localSubmission.previousJobs ? localSubmission : null;
  const localCount = local?.count ?? 0;
  const nextRun = task.jobs.reduce((highest, job) => Math.max(highest, job.run), 0) + 1;
  useLayoutEffect(() => { const node = scrollPanel.current; if (node && (followLatest.current || localCount > 0)) { node.scrollTop = node.scrollHeight; followLatest.current = true; } }, [task.id, task.jobs.length, localCount]);
  return <main className="canvas"><div className="canvas-h"><span className="title">{task.title || '生成'} · <b>{stats.results.length} 张</b></span>{stats.failed > 0 && <button className="text-link" disabled={busy(`task:${task.id}`)} onClick={() => void request('retryFailed', { id: task.id }, `task:${task.id}`)}>重试失败</button>}</div>
    <div className="canvas-scroll" ref={scrollPanel} onScroll={event => { const node = event.currentTarget; followLatest.current = node.scrollHeight - node.scrollTop - node.clientHeight < 100; }}>
      {stats.unknown > 0 && <div className="warnbox canvas-warning">部分请求结果未知，可能已在供应商生成或计费。不会自动重试，请先核对供应商记录。<button className="text-link" disabled={busy(`task:${task.id}`) || stats.active || stats.queued > 0} onClick={() => setRetryUnknown(true)}>手动重试未知请求</button></div>}
      {(runs.length > 0 || local) && <div className="conversation">
        {runs.map(({ run, jobs }) => <div className="conversation-turn" key={run}><UserMessage prompt={jobs[0].prompt} referenceIds={jobs[0].referenceIds ?? []} onPreview={openPreview} /><div className="conversation-assistant"><span className="conversation-avatar" aria-hidden="true">✦</span>
          <div className="imggrid conversation-results">{jobs.flatMap(job => job.results).map(result => <button className="imgcard" key={result.id} aria-label={`预览 ${result.name}`} title="点击预览图片" onClick={() => openPreview({ kind: 'result', id: result.id, name: result.name }, resultImages)}><img src={result.url} alt="" loading="lazy" /></button>)}
            {jobs.flatMap(job => Array.from({ length: pendingImageSlots(job) }, (_, index) => ({ job, index }))).map(({ job, index }) => { const paused = task.paused && job.status === 'queued'; return <PendingImage key={`${job.id}:${index}`} run={run} paused={paused} phase={paused ? '队列已暂停' : statusLabels[job.status]} />; })}</div>
          {jobs.filter(job => job.status !== 'completed' && pendingImageSlots(job) === 0).map(job => <div className="job-notice" key={job.id}><Status status={job.status} /><span>{job.error || (activeJob(job) ? '等待服务返回真实结果，请勿重复提交。' : '')}</span></div>)}
        </div></div>)}
        {local && <div className="conversation-turn"><UserMessage prompt={local.prompt} referenceIds={local.referenceIds} onPreview={openPreview} /><div className="conversation-assistant"><span className="conversation-avatar" aria-hidden="true">✦</span><div className="imggrid conversation-results">{Array.from({ length: localCount }, (_, index) => <PendingImage key={`local:${index}`} run={nextRun} phase="正在提交" />)}</div></div></div>}
      </div>}
      {!task.jobs.length && !localCount && <div className="creation-welcome"><div className="welcome-mark">✦</div><h1>让想象，成为画面</h1><p>描述你的创意，选择模型，即可开始生成。</p></div>}
    </div>
    {retryUnknown && <UnknownRetry task={task} onClose={() => setRetryUnknown(false)} />}
    {preview && <ImagePreview selection={preview} onMove={direction => setPreview(current => current ? movePreview(current, direction) : null)} onClose={() => setPreview(null)} />}
  </main>;
}

function ImagePreview({ selection, onMove, onClose }: { selection: PreviewSelection; onMove: (direction: -1 | 1) => void; onClose: () => void }) {
  const { request, busy, notify } = useAPI();
  const [failed, setFailed] = useState(false);
  const image = selection.images[selection.index];
  const copyKey = `copy:${image.kind}:${image.id}`, saveKey = `save:${image.kind}:${image.id}`;
  const copying = busy(copyKey), saving = busy(saveKey);
  useLayoutEffect(() => { setFailed(false); }, [image.kind, image.id]);
  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if (copying || saving || event.altKey || event.ctrlKey || event.metaKey || event.isComposing) return;
      if (event.key === 'ArrowLeft' && selection.index > 0) { event.preventDefault(); onMove(-1); }
      if (event.key === 'ArrowRight' && selection.index < selection.images.length - 1) { event.preventDefault(); onMove(1); }
    };
    document.addEventListener('keydown', keydown);
    return () => document.removeEventListener('keydown', keydown);
  }, [copying, saving, selection.index, selection.images.length, onMove]);
  const payload = image.kind === 'result' ? { resultId: image.id } : { referenceId: image.id };
  return <Modal title="图片预览" className="image-preview" onClose={onClose} busy={copying || saving} footer={<>
    {selection.images.length > 1 && <span className="preview-position" aria-live="polite">{selection.index + 1} / {selection.images.length}</span>}
    <button className="btn" disabled={copying || saving} onClick={() => { void request(image.kind === 'result' ? 'copyResult' : 'copyReference', payload, copyKey).then(value => { if (value === true) notify('图片已复制到剪贴板。'); }); }}>{copying ? '复制中…' : '复制图片'}</button>
    <button className="btn btn--pri" disabled={copying || saving} onClick={() => { void request(image.kind === 'result' ? 'saveResult' : 'saveReference', payload, saveKey).then(value => { if (value !== undefined && value !== false) notify('图片已保存。'); }); }}>{saving ? '保存中…' : '下载图片'}</button>
  </>}>
    <div className={`preview-stage ${selection.images.length > 1 ? 'has-navigation' : ''}`}>
      {selection.images.length > 1 && <button type="button" className="preview-nav preview-nav--previous" aria-label="上一张" disabled={copying || saving || selection.index === 0} onClick={() => onMove(-1)}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="m15 5-7 7 7 7" strokeLinecap="round" strokeLinejoin="round" /></svg></button>}
      {failed ? <div className="preview-error" role="alert">原图加载失败，请检查图片是否仍然可用。</div> : <img key={`${image.kind}:${image.id}`} className="preview-image" src={`qingtu-asset://asset/${image.kind}/${encodeURIComponent(image.id)}`} alt={image.name} onError={() => setFailed(true)} />}
      {selection.images.length > 1 && <button type="button" className="preview-nav preview-nav--next" aria-label="下一张" disabled={copying || saving || selection.index === selection.images.length - 1} onClick={() => onMove(1)}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="m9 5 7 7-7 7" strokeLinecap="round" strokeLinejoin="round" /></svg></button>}
    </div>
  </Modal>;
}

function UnknownRetry({ task, onClose }: { task: Task; onClose: () => void }) {
  const { request, busy } = useAPI();
  return <Confirm title="重试未知请求可能重复计费" onClose={onClose} busy={busy(`task:${task.id}`)} onConfirm={() => { void request('retryFailed', { id: task.id, confirmUnknown: true }, `task:${task.id}`).then(result => { if (result !== undefined) onClose(); }); }}>原请求可能已经生成并计费，请先核对供应商记录。确认后将重试未知请求及失败项；生成阶段未知的请求可能再次生成、再次消耗额度。</Confirm>;
}

function BatchCanvas({ task, drafts }: { task: Task; drafts: DraftStore }) {
  const { state, request, busy, notify } = useAPI();
  const templateReady = Boolean(state?.features?.batchReferencePaths);
  const referencesById = useMemo(() => new Map((state?.references ?? []).map(reference => [reference.id, reference])), [state?.references]);
  const [clear, setClear] = useState(false);
  const importLock = useRef(false);
  const [importing, setImporting] = useState(false);
  const [retryUnknown, setRetryUnknown] = useState(false);
  const [preview, setPreview] = useState<PreviewSelection | null>(null);
  const stats = summarizeTask(task);
  const locked = busy(`task:${task.id}`) || importing;
  const importRows = async () => { if (importLock.current || !templateReady) return; importLock.current = true; setImporting(true); try { await drafts.flush(task.id); await request('importRows', { id: task.id }, `task:${task.id}`); } finally { importLock.current = false; setImporting(false); } };
  const rows = task.jobs.length && !task.rowsPending ? task.jobs.map(job => ({ id: job.id, row: job.row, prompt: job.prompt, referenceId: job.referenceIds?.[0], job })) : task.rows.map((prompt, index) => ({ id: `draft-${index}`, row: index + 1, prompt, referenceId: task.rowReferenceIds?.[index], job: undefined }));
  return <main className="canvas batch-canvas"><div className="canvas-h"><button className="btn btn--sm" disabled={!templateReady || busy('batch-template')} onClick={() => { void request('downloadBatchTemplate', {}, 'batch-template').then(result => { if (result === true) notify('表格模板已保存。'); }); }}>{busy('batch-template') ? '保存中…' : '下载表格模板'}</button><button className="btn btn--sm" disabled={!templateReady || locked || stats.active || stats.queued > 0} onClick={() => void importRows()}>导入表格</button><span className="title">{task.customTitle || task.title} · <b>{task.rows.length} 条</b></span><span className="sp" />
    <button className="text-link" disabled={locked || (!stats.queued && !stats.active)} onClick={() => void request(task.paused ? 'resumeTask' : 'pauseTask', { id: task.id }, `task:${task.id}`)}>{task.paused ? '继续任务' : '暂停任务'}</button>
    <button className="text-link" disabled={locked || !stats.failed || stats.active || stats.queued > 0} onClick={() => void request('retryFailed', { id: task.id }, `task:${task.id}`)}>重试失败</button>
    <button className="text-link danger-text" disabled={locked || stats.active || stats.queued > 0 || (!task.rows.length && !task.jobs.length)} onClick={() => setClear(true)}>清空列表</button></div>
    {state && !templateReady && <div className="warnbox canvas-warning" role="status">请重启轻图开发版，以启用表格参考图功能。</div>}
    {task.paused && <div className="queue-note">队列已暂停；已发出的请求仍会继续完成。</div>}
    {stats.unknown > 0 && <div className="warnbox canvas-warning">有 {stats.unknown} 项结果未知，可能已产生费用，未自动重跑。请先核对供应商记录。<button className="text-link" disabled={locked || stats.active || stats.queued > 0} onClick={() => setRetryUnknown(true)}>手动重试未知请求</button></div>}
    {!rows.length ? <Empty title="导入你的批量提示词">下载 Excel 模板，填写提示词和可选的本地参考图路径，每行一条。<br />请替换示例路径；最多 10,000 条，表格不超过 20 MB。</Empty> : <div className="tbwrap"><table className="tb"><colgroup><col className="batch-col-number" /><col className="batch-col-prompt" /><col className="batch-col-reference" /><col className="batch-col-result" /><col className="batch-col-count" /><col className="batch-col-status" /><col className="batch-col-time" /></colgroup><thead><tr><th>序号</th><th>提示词</th><th>参考图</th><th>成图</th><th className="batch-count-heading">数量</th><th>状态</th><th>耗时</th></tr></thead><tbody>{rows.map(({ id, row, prompt, referenceId, job }) => { const reference = referenceId ? referencesById.get(referenceId) : undefined; const results = job?.results ?? []; const cover = results[0]; return <tr key={id}>
      <td className="mono" title={`第 ${row} 条${job ? ` · 第 ${job.run} 轮` : ''}`}>{String(row).padStart(3, '0')}</td><td className="pt"><span className="batch-prompt-text" title={prompt}>{prompt}</span></td><td>{reference ? <button type="button" className="batch-reference" aria-label={`预览参考图 ${reference.name}`} onClick={() => { const image: PreviewImage = { kind: 'reference', id: reference.id, name: reference.name }; setPreview(selectPreview([image], image)); }}><img src={reference.url} alt="" loading="lazy" /></button> : referenceId ? <span className="row-error">参考图不可用</span> : '—'}</td>
      <td>{cover && <button type="button" className="batch-thumb" aria-label={`预览本条成图，共 ${results.length} 张`} title={results.length > 1 ? `点击预览，可左右切换 ${results.length} 张成图` : '点击预览图片'} onClick={() => { const images: PreviewImage[] = results.map(result => ({ kind: 'result', id: result.id, name: result.name })); setPreview(selectPreview(images, { kind: 'result', id: cover.id, name: cover.name })); }}><img src={cover.url} alt="" loading="lazy" /></button>}</td>
      <td className="mono batch-result-count" title={results.length ? `已生成 ${results.length} 张` : '暂无成图'}>{results.length || '—'}</td>
      <td><Status status={job?.status ?? 'queued'}>{job ? statusLabels[job.status] : '待提交'}</Status>{job?.error && <div className="row-error" title={job.error}>{job.error}</div>}</td><td className="mono" title={job?.startedAt && job.endedAt ? `${Math.max(0, (job.endedAt - job.startedAt) / 1000).toFixed(1)}s` : undefined}>{job?.startedAt && job.endedAt ? `${Math.max(0, (job.endedAt - job.startedAt) / 1000).toFixed(1)}s` : '—'}</td>
    </tr>; })}</tbody></table></div>}
    {retryUnknown && <UnknownRetry task={task} onClose={() => setRetryUnknown(false)} />}
    {clear && <Confirm title="清空批量列表" onClose={() => setClear(false)} busy={locked} onConfirm={() => { void request('clearTask', { id: task.id }, `task:${task.id}`).then(result => { if (result !== undefined) setClear(false); }); }}>确定清空此任务的导入列表和任务记录吗？已导出的文件不会因此删除。</Confirm>}
    {preview && <ImagePreview selection={preview} onMove={direction => setPreview(current => current ? movePreview(current, direction) : null)} onClose={() => setPreview(null)} />}
  </main>;
}

function TaskEditor({ task, drafts, onSubmissionChange }: { task: Task; drafts: DraftStore; onSubmissionChange?: (value: LocalSubmission | null) => void }) {
  const { state, busy, request, notify } = useAPI();
  const settingsPanel = useRef<HTMLDetailsElement>(null);
  const composer = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const node = composer.current;
    const workspace = node?.closest<HTMLElement>('.single-workspace');
    if (!node || !workspace) return;
    const update = () => {
      const available = Math.max(0, Math.floor(node.getBoundingClientRect().top - workspace.getBoundingClientRect().top - 18));
      node.style.setProperty('--composer-above-space', `${available}px`);
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(node); observer.observe(workspace);
    window.addEventListener('resize', update);
    return () => { observer.disconnect(); window.removeEventListener('resize', update); };
  }, [task.kind]);
  useEffect(() => {
    const closeOnOutside = (event: MouseEvent) => { if (settingsPanel.current?.open && !settingsPanel.current.contains(event.target as Node)) settingsPanel.current.open = false; };
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === 'Escape' && settingsPanel.current?.open) { settingsPanel.current.open = false; settingsPanel.current.querySelector('summary')?.focus(); } };
    document.addEventListener('mousedown', closeOnOutside);
    document.addEventListener('keydown', closeOnEscape);
    return () => { document.removeEventListener('mousedown', closeOnOutside); document.removeEventListener('keydown', closeOnEscape); };
  }, []);
  const [draft, setDraft] = useState<Draft>(() => drafts.drafts.current.get(task.id) ?? draftOf(task));
  const promptInput = useRef<HTMLTextAreaElement>(null);
  const pendingCaret = useRef<number | null>(null);
  const composing = useRef(false);
  const mentionOptions = useRef<HTMLDivElement>(null);
  const [mentionRange, setMentionRange] = useState<MentionRange | null>(null);
  const [mentionIndex, setMentionIndex] = useState(0);
  useLayoutEffect(() => {
    const input = promptInput.current;
    if (!input) return;
    const resize = () => { input.style.height = 'auto'; input.style.height = `${Math.min(160, Math.max(55, input.scrollHeight))}px`; };
    resize();
    if (pendingCaret.current !== null) { const caret = pendingCaret.current; pendingCaret.current = null; input.focus(); input.setSelectionRange(caret, caret); }
    window.addEventListener('resize', resize);
    return () => window.removeEventListener('resize', resize);
  }, [draft.prompt, task.id]);
  const draftRef = useRef(draft); draftRef.current = draft;
  useEffect(() => drafts.subscribeDraft(task.id, next => { draftRef.current = next; setDraft(next); }), [drafts.subscribeDraft, task.id]);
  const [submitting, setSubmitting] = useState(false);
  const submitLock = useRef(false);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const [confirmUnknown, setConfirmUnknown] = useState(false);
  const choices = useMemo(() => modelChoices(state?.providers ?? []), [state?.providers]);
  const choice = selectedImageModel(choices, draft.params);
  const params = normalizeParams(draft.params, choice);
  const model = choice?.model;
  const references = task.referenceIds.flatMap((id, position) => { const ref = state?.references.find(item => item.id === id); return ref ? [{ ...ref, position }] : []; });
  const referenceLimit = model?.reference ? Math.min(8, model.maxReferences) : 0;
  const invalidReferences = task.kind === 'batch' ? Boolean(task.rowReferenceIds?.some(Boolean) && (!model?.reference || model.maxReferences < 1)) : task.referenceIds.length > referenceLimit;
  const stats = summarizeTask(task);
  const locked = busy(`task:${task.id}`) || submitting;
  const edit = (patch: Partial<Draft>) => { const current = draftRef.current; const currentChoice = selectedImageModel(choices, current.params); const next = { ...current, params: normalizeParams(current.params, currentChoice), ...patch }; draftRef.current = next; setDraft(next); drafts.change(task.id, next); };
  const setParams = (patch: Partial<GenerationParams>) => edit({ params: { ...params, ...patch } });
  const updateMention = (input: HTMLTextAreaElement) => {
    if (composing.current) return;
    setMentionRange(findMentionRange(input.value, input.selectionStart, input.selectionEnd));
    setMentionIndex(0);
  };
  const chooseMention = (position: number) => {
    const input = promptInput.current;
    if (!input) return;
    const range = findMentionRange(input.value, input.selectionStart, input.selectionEnd);
    if (!range) { setMentionRange(null); return; }
    const next = insertReferenceMention(input.value, range, position);
    pendingCaret.current = next.caret;
    setMentionRange(null);
    edit({ prompt: next.text });
  };
  const activeMention = Math.min(mentionIndex, Math.max(0, references.length - 1));
  const mentionListId = `reference-mentions-${task.id}`;
  useEffect(() => {
    if (!mentionRange) return;
    const list = mentionOptions.current;
    const option = list?.children[activeMention] as HTMLElement | undefined;
    if (!list || !option) return;
    const bounds = list.getBoundingClientRect(), item = option.getBoundingClientRect();
    if (item.top < bounds.top) list.scrollTop -= bounds.top - item.top;
    else if (item.bottom > bounds.bottom) list.scrollTop += item.bottom - bounds.bottom;
  }, [mentionRange, activeMention, references.length]);
  const handleMentionKey = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (!mentionRange || composing.current || event.nativeEvent.isComposing) return;
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setMentionRange(null); return; }
    if (!references.length) return;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); setMentionIndex((activeMention + (event.key === 'ArrowDown' ? 1 : -1) + references.length) % references.length); }
    else if ((event.key === 'Enter' || event.key === 'Tab') && !event.shiftKey) { event.preventDefault(); chooseMention(references[activeMention].position); }
  };
  const removeReference = (id: string, position: number) => {
    const affected = affectedReferenceMarker(draftRef.current.prompt, position);
    if (affected) { notify(`请先移除提示词中的 ${affected}，再删除该图片，以免引用编号发生变化。`, true); return; }
    void request('removeReference', { id: task.id, referenceId: id }, `task:${task.id}`);
  };
  const enhance = async (mode: 'optimize' | 'translate') => {
    if (submitLock.current) return;
    submitLock.current = true; setSubmitting(true);
    const revision = drafts.revisions.current.get(task.id) ?? 0;
    try {
      const saved = await drafts.flush(task.id, { ...draft, params });
      if (saved === undefined) return;
      const result = await request('enhancePrompt', { id: task.id, mode }, `task:${task.id}`);
      if (isAppState(result)) { const updated = result.tasks.find(item => item.id === task.id); if (updated) drafts.syncPrompt(task.id, updated.prompt, revision, { ...draft, params }); }
    } finally { submitLock.current = false; if (mounted.current) setSubmitting(false); }
  };
  const submit = async (explicitUnknown = false) => {
    if (submitLock.current) return;
    submitLock.current = true; setSubmitting(true); setConfirmUnknown(false);
    const revision = drafts.revisions.current.get(task.id) ?? 0;
    if (task.kind === 'single') onSubmissionChange?.({ taskId: task.id, count: params.count, previousJobs: task.jobs.length, prompt: draft.prompt.trim(), referenceIds: [...task.referenceIds] });
    try {
      const submissionDraft = task.kind === 'batch' ? { ...draft, params, concurrency: 5, retry: false } : { ...draft, params };
      const saved = await drafts.flush(task.id, submissionDraft);
      if (saved !== undefined) {
        const result = await request('submitTask', { id: task.id, ...(explicitUnknown ? { confirmUnknown: true } : {}) }, `task:${task.id}`);
        if (hasNewSingleSubmission(task, result)) await drafts.clearSubmittedPrompt(task.id, revision, { ...draft, params });
      }
    } finally { submitLock.current = false; onSubmissionChange?.(null); if (mounted.current) setSubmitting(false); }
  };
  const selectReferences = async () => {
    if (submitLock.current) return; submitLock.current = true; setSubmitting(true);
    try { const saved = await drafts.flush(task.id, { ...draftRef.current, params }); if (saved !== undefined) await request('selectReferences', { id: task.id }, `task:${task.id}`); }
    finally { submitLock.current = false; if (mounted.current) setSubmitting(false); }
  };
  if (task.kind === 'single') return <div className="composer-wrap"><div className="composer" ref={composer}>
    {mentionRange && <div className="mention-menu"><div className="mention-heading">选择参考图 <span>↑↓ 选择 · Enter 确认</span></div>{references.length ? <div ref={mentionOptions} className="mention-options" id={mentionListId} role="listbox" aria-label="参考图">{references.map((ref, index) => <button type="button" role="option" aria-selected={index === activeMention} id={`${mentionListId}-${index}`} tabIndex={-1} className={`mention-option ${index === activeMention ? 'on' : ''}`} key={ref.id} onMouseDown={event => event.preventDefault()} onMouseEnter={() => setMentionIndex(index)} onClick={() => chooseMention(ref.position)}><img src={ref.url} alt="" /><span className="mention-name"><b>图 {ref.position + 1}</b><small>{ref.name}</small></span><span className="mention-token">@图{ref.position + 1}</span></button>)}</div> : <div className="mention-empty">请先用下方“＋ 图片”添加参考图。</div>}</div>}
    {references.length > 0 && <div className="composer-references">{references.map(ref => <div className="composer-reference" key={ref.id}><img src={ref.url} alt={ref.name} /><span>图 {ref.position + 1}</span><button aria-label={`移除 ${ref.name}`} disabled={locked} onClick={() => removeReference(ref.id, ref.position)}>✕</button></div>)}</div>}
    <textarea ref={promptInput} className="composer-input" rows={2} aria-label="提示词" aria-autocomplete="list" aria-controls={mentionRange && references.length ? mentionListId : undefined} aria-activedescendant={mentionRange && references.length ? `${mentionListId}-${activeMention}` : undefined} value={draft.prompt} disabled={locked} onChange={event => { edit({ prompt: event.target.value }); updateMention(event.currentTarget); }} onSelect={event => updateMention(event.currentTarget)} onFocus={event => updateMention(event.currentTarget)} onBlur={() => setMentionRange(null)} onKeyDown={handleMentionKey} onCompositionStart={() => { composing.current = true; setMentionRange(null); }} onCompositionEnd={event => { composing.current = false; updateMention(event.currentTarget); }} placeholder="输入你想生成的画面，输入 @ 可选择参考图" />
    {invalidReferences && <p className="inline-error">参考图超过当前模型限制，请移除后再生成。</p>}
    <div className="composer-toolbar">
      <button className="composer-action reference-action" title={model?.reference ? `添加参考图（${task.referenceIds.length}/${referenceLimit}）` : '请先选择支持参考图的模型'} aria-label="添加参考图" disabled={locked || !model?.reference || task.referenceIds.length >= referenceLimit} onClick={() => void selectReferences()}>＋ 图片</button>
      <button className="composer-action" disabled={locked || !draft.prompt.trim()} onClick={() => void enhance('optimize')}>✦ 提示词优化</button>
      <button className="composer-action" disabled={locked || !draft.prompt.trim()} onClick={() => void enhance('translate')}>中译英</button>
      <div className="composer-primary-settings" role="group" aria-label="常用生图参数">
        <div className="composer-picker composer-model-picker"><label htmlFor="single-model">模型</label><Select id="single-model" compact menuMinWidth={280} value={choice?.value ?? ''} disabled={locked || !choices.length} options={[...(!choice ? [{ value: '', label: choices.length ? '请选择模型' : '暂无启用的生图模型', disabled: true }] : []), ...choices.map(option => ({ value: option.value, label: `${option.model.name || option.model.id} · ${option.provider.name}` }))]} onChange={value => { const next = choices.find(option => option.value === value); edit({ params: normalizeParams(params, next) }); }} /></div>
        <div className="composer-picker composer-ratio-picker"><label htmlFor="single-ratio">比例</label>
          <Select id="single-ratio" compact value={params.size} disabled={locked || !model} title={params.size && params.size !== 'auto' ? `请求尺寸：${params.size}` : '自动尺寸'} options={[...(!IMAGE_RATIO_PRESETS.some(preset => preset.size === params.size) ? [{ value: params.size, label: params.size ? `${aspectRatio(params.size)}（当前尺寸）` : '未配置', disabled: true }] : []), ...IMAGE_RATIO_PRESETS.map(({ ratio, size }) => ({ value: size, label: ratio, disabled: !sizeForRatio(model, ratio), title: size === 'auto' ? undefined : `请求尺寸：${size}` }))]} onChange={size => { if (model?.sizes.includes(size)) setParams({ size }); }} />
        </div>
        <div className="composer-picker composer-count-picker"><label htmlFor="single-count">数量</label>
          <Select id="single-count" compact menuMinWidth={100} value={String(params.count)} disabled={locked || !model} options={[1, 2, 3, 4].map(count => ({ value: String(count), label: `${count} 张`, disabled: !model || count > model.maxImages }))} onChange={value => { const count = Number(value); if (model && count >= 1 && count <= Math.min(4, model.maxImages)) setParams({ count }); }} />
        </div>
      </div>
      <details className="composer-settings" ref={settingsPanel}><summary className="composer-action">☷ 生图设置 <span aria-hidden="true">⌄</span></summary><div className="settings-popover">
        <div className="settings-popover-title">生图设置 <span>质量与分辨率</span></div>

        {choice && !choice.provider.hasKey && <p className="inline-error model-hint">请先在供应商设置中填写 API Key。</p>}
        {model && !model.verified && <p className="hinttxt model-hint">预置候选模型，尚未通过连接测试验证。</p>}
        <fieldset className="param-group"><legend>质量</legend><div className="param-grid param-grid--four">{([['auto', '自动'], ['low', '低'], ['medium', '中'], ['high', '高']] as const).map(([value, label]) => <button type="button" key={value} className={`param-option ${params.quality === value ? 'on' : ''}`} aria-pressed={params.quality === value} disabled={locked || !model?.qualities.includes(value)} onClick={() => setParams({ quality: value })}>{label}</button>)}</div></fieldset>
        <fieldset className="param-group"><legend>分辨率</legend><div className="param-grid param-grid--four">{([['auto', '自动'], ['1k', '1K']] as const).map(([value, label]) => { const size = sizeForResolution(model, value, params.size); const selected = value === 'auto' ? params.size === 'auto' : is1kPreset(params.size); return <button type="button" key={value} className={`param-option ${selected ? 'on' : ''}`} aria-pressed={selected} disabled={locked || !size} onClick={() => { if (size) setParams({ size }); }}>{label}</button>; })}</div><p className="hinttxt param-hint">{params.size && params.size !== 'auto' ? `请求尺寸：${params.size.replace(/x/i, ' × ')}。` : '选择 1K 默认使用 1:1；选择比例会使用对应的像素尺寸。'} 实际支持以供应商为准。</p></fieldset>
      </div></details>

      <button className="composer-submit" disabled={locked || !choice || !choice.provider.hasKey || invalidReferences || stats.active || stats.queued > 0 || !draft.prompt.trim()} onClick={() => stats.unknown > 0 ? setConfirmUnknown(true) : void submit()}>{submitting ? '处理中…' : stats.active || stats.queued ? '生成中…' : '生成 ↑'}</button>
    </div>
    {!choice && <div className="composer-hint">请选择模型；如无可用模型，请先前往供应商设置。</div>}
    {choice && !choice.provider.hasKey && <div className="composer-hint">请先在供应商设置中填写 API Key。</div>}
  </div>{confirmUnknown && <Confirm title="再次提交可能重复计费" onClose={() => setConfirmUnknown(false)} onConfirm={() => void submit(true)} busy={submitting}>此任务有结果未知的请求，供应商可能已经完成并计费。请先核对供应商记录；确认后将作为新一轮生成提交，不会恢复原请求。</Confirm>}</div>;
  return <aside className="panel panel--r">
    <div className="sec-h">生图配置</div>
    <div className="sec-box"><div className="frow"><label htmlFor="model">模型</label><Select id="model" value={choice?.value ?? ''} disabled={locked || !choices.length} options={[...(!choice ? [{ value: '', label: choices.length ? '请选择模型' : '暂无启用的生图模型', disabled: true }] : []), ...choices.map(option => ({ value: option.value, label: `${option.model.name || option.model.id} · ${option.provider.name}` }))]} onChange={value => { const next = choices.find(option => option.value === value); edit({ params: normalizeParams(params, next) }); }} /></div>
      {choice && !choice.provider.hasKey && <p className="inline-error model-hint">请先在供应商设置中填写 API Key。</p>}
      {model && !model.verified && <p className="hinttxt model-hint">预置候选模型，尚未通过连接测试验证。</p>}
      {invalidReferences && <p className="inline-error">表格包含参考图，请选择支持参考图的模型。</p>}
      <div className="frow"><label htmlFor="quality">质量</label><Select id="quality" value={params.quality} disabled={locked || !model?.qualities.length} options={!model?.qualities.length ? [{ value: '', label: '由模型决定' }] : model.qualities.map(quality => ({ value: quality, label: { auto: '自动', low: '低', medium: '中', high: '高', standard: '标准', hd: '高清' }[quality] ?? quality }))} onChange={quality => setParams({ quality })} /></div>
      <div className="frow"><label htmlFor="size">分辨率</label><Select id="size" value={params.size} disabled={locked || !model?.sizes.length} options={!model?.sizes.length ? [{ value: '', label: '由模型决定' }] : model.sizes.map(size => ({ value: size, label: size === 'auto' ? '自动' : `${size.replace(/x/i, ' × ')}（${aspectRatio(size)}）` }))} onChange={size => setParams({ size })} /></div>
      <div className="frow"><label>比例</label><div className="ratio-chips">{[...new Set((model?.sizes ?? []).map(aspectRatio))].map(ratio => <button className={`chip ${aspectRatio(params.size) === ratio ? 'on' : ''}`} key={ratio} aria-pressed={aspectRatio(params.size) === ratio} disabled={locked} onClick={() => { const size = model?.sizes.find(value => aspectRatio(value) === ratio); if (size) setParams({ size }); }}>{ratio}</button>)}{!model?.sizes.length && <span className="hinttxt">由模型决定</span>}</div></div>
      <div className="frow count-row"><label>数量{task.kind === 'batch' ? '（每条）' : ''}</label><div className="stepper"><button aria-label="减少图片数量" disabled={locked || params.count <= 1} onClick={() => setParams({ count: params.count - 1 })}>−</button><span className="n" aria-live="polite">{params.count}</span><button aria-label="增加图片数量" disabled={locked || params.count >= Math.min(4, model?.maxImages ?? 1)} onClick={() => setParams({ count: params.count + 1 })}>＋</button></div></div>
    </div>
    <div className="sec-box"><button className="btn btn--pri full generate" disabled={locked || !choice || !choice.provider.hasKey || invalidReferences || stats.active || stats.queued > 0 || !task.rows.length} onClick={() => stats.unknown > 0 ? setConfirmUnknown(true) : void submit()}>{submitting ? '正在处理…' : stats.active || stats.queued ? '任务进行中' : task.kind === 'batch' ? '▶ 提交批量任务' : '✦ 生成'}</button></div>
    {confirmUnknown && <Confirm title="再次提交可能重复计费" onClose={() => setConfirmUnknown(false)} onConfirm={() => void submit(true)} busy={submitting}>此任务有结果未知的请求，供应商可能已经完成并计费。请先核对供应商记录；确认后将作为新一轮生成提交，不会恢复原请求。</Confirm>}
  </aside>;
}

function ProviderEditor({ provider, onClose }: { provider?: Provider; onClose: () => void }) {
  const { request, busy, notify } = useAPI();
  const [name, setName] = useState(provider?.name ?? '');
  const [baseURL, setBaseURL] = useState(provider?.baseURL ?? '');
  const [key, setKey] = useState('');
  const [models, setModels] = useState<ModelInfo[]>(provider?.models ?? []);
  const [enabled, setEnabled] = useState(provider?.enabledModels ?? []);
  const [tested, setTested] = useState(false);
  const [testMessage, setTestMessage] = useState('');
  const mounted = useRef(true);
  const identity = useRef(`provider-editor:${provider?.id ?? 'new'}:${Date.now()}`);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const saving = busy(`${identity.current}:save`), testing = busy(`${identity.current}:test`);
  const urlChanged = !!provider && baseURL.trim().replace(/\/+$/, '') !== provider.baseURL.trim().replace(/\/+$/, '');
  const urlValid = (() => { try { const url = new URL(baseURL.trim()); return url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash; } catch { return false; } })();
  const canUseKey = !!key.trim() || (!!provider?.hasKey && !urlChanged);
  const changedCredentials = () => { setTested(false); setTestMessage('连接信息已更改，请重新测试。'); setModels([]); setEnabled([]); };
  const test = async () => {
    setTestMessage('正在测试连接并获取模型…');
    const result = await request('testProvider', { ...(provider ? { id: provider.id } : {}), baseURL: baseURL.trim(), ...(key.trim() ? { key: key.trim() } : {}) }, `${identity.current}:test`);
    if (!mounted.current) return;
    if (Array.isArray(result)) {
      const found = result as ModelInfo[]; setModels(found); setEnabled(current => current.filter(id => found.some(model => model.id === id && (model.image || model.text))));
      setTested(true); setTestMessage(`获取到 ${found.length} 个模型，勾选需要启用的生图或文本模型。`);
    } else { setTested(false); setTestMessage('连接测试未成功。请检查地址、API Key 或网络后重试。'); }
  };
  const save = async () => {
    const result = await request('saveProvider', { ...(provider ? { id: provider.id } : {}), name: name.trim(), baseURL: baseURL.trim(), ...(key.trim() ? { key: key.trim() } : {}), enabledModels: enabled.filter(id => models.some(model => model.id === id && (model.image || model.text))) }, `${identity.current}:save`);
    if (result !== undefined && mounted.current) { setKey(''); notify('供应商已保存。'); onClose(); }
  };
  return <Modal title={provider ? '编辑供应商' : '添加供应商'} onClose={() => { setKey(''); onClose(); }} busy={saving} footer={<><button className="btn" onClick={() => { setKey(''); onClose(); }} disabled={saving}>取消</button><button className="btn btn--pri" disabled={saving || testing || !name.trim() || !urlValid || !canUseKey || (urlChanged && !key.trim())} onClick={() => void save()}>{saving ? '保存中…' : '保存供应商'}</button></>}>
    <div className="editor-grid"><div className="frow"><label htmlFor="provider-name">供应商名称</label><input id="provider-name" className="ipt" value={name} disabled={saving || testing} onChange={event => setName(event.target.value)} autoComplete="off" /></div><div className="frow"><label htmlFor="protocol">协议</label><input id="protocol" className="ipt" value="OpenAI 兼容" disabled /></div>
      <div className="frow full"><label htmlFor="provider-url">接口地址（Base URL）</label><input id="provider-url" className="ipt ipt--mono" value={baseURL} disabled={saving || testing} placeholder="https://api.example.com/v1" autoComplete="off" aria-invalid={!!baseURL.trim() && !urlValid} aria-describedby={baseURL.trim() && !urlValid ? 'provider-url-error' : undefined} onChange={event => { setBaseURL(event.target.value); changedCredentials(); }} />{baseURL.trim() && !urlValid && <p className="inline-error" id="provider-url-error">请输入 HTTPS 地址，且不要包含账号、密码或查询参数。</p>}</div>
      <div className="frow full"><label htmlFor="provider-key">API Key</label><input id="provider-key" className="ipt ipt--mono" type="password" value={key} disabled={saving || testing} placeholder={provider?.hasKey && !urlChanged ? '已安全保存；留空保留原 Key' : '请输入 API Key'} autoComplete="new-password" spellCheck={false} onChange={event => { setKey(event.target.value); changedCredentials(); }} /></div></div>
    {urlChanged && <div className="warnbox">接口地址已改变，必须输入新 Key。不会向新地址发送原 Key。</div>}
    <div className="get-row"><button className="btn btn--sm" disabled={saving || testing || !urlValid || !canUseKey} onClick={() => void test()}>{testing ? '连接测试中…' : '测试连接并获取模型'}</button><span className={`hinttxt ${tested ? 'success-text' : ''}`} role="status">{testMessage || (models.length ? `${models.length} 个模型，勾选启用的模型` : '测试成功后获取可用模型')}</span></div>
    <div className="model-list">{models.length ? models.map(model => <label className="model-row" key={model.id}><input type="checkbox" className="model-checkbox" checked={enabled.includes(model.id)} disabled={(!model.image && !model.text) || testing || saving} onChange={event => setEnabled(current => event.target.checked ? [...current, model.id] : current.filter(id => id !== model.id))} /><span className="model-name">{model.id}</span><span className="model-kind">{model.image ? model.reference ? '文生图 / 图生图' : '文生图' : model.text ? '文本模型' : '暂不支持'}{!model.verified && ' · 未验证'}</span></label>) : <div className="empty-note model-empty">暂无模型，请先测试连接。</div>}</div>
  </Modal>;
}
function Providers() {
  const { state, online, request, busy, notify } = useAPI();
  const [editor, setEditor] = useState<Provider | 'new' | null>(null);
  const [deleting, setDeleting] = useState<Provider | null>(null);
  return <section className="set-wrap"><div className="set-hd"><h2>供应商设置</h2><span className="sp" /><button className="btn" disabled={!online || !state} onClick={() => setEditor('new')}>＋ 添加供应商</button></div><div className="prov-grid">{state?.providers.map(provider => <article className="prov" key={provider.id}><div className="prov-name">{provider.name}</div><div className="prov-url" title={provider.baseURL}>{provider.baseURL}</div><div className="models">{provider.enabledModels.length ? provider.enabledModels.map(id => <span className="mchip" key={id}>{id}</span>) : <span className="hinttxt">尚未启用模型</span>}</div><div className="prov-foot"><span>{provider.enabledModels.length} 个模型 · {provider.connection === 'connected' ? '已连接' : provider.connection === 'failed' ? '连接失败' : provider.hasKey ? '待验证' : '未配置 Key'}</span><div className="prov-actions"><button className="btn" onClick={() => setEditor(provider)}>编辑</button><button className="btn btn--danger" onClick={() => setDeleting(provider)}>删除</button></div></div></article>)}</div>
    {!state?.providers.length && <Empty title={online ? '暂无供应商' : '桌面服务未连接'}>{online ? '添加 OpenAI 兼容供应商，连接后勾选启用的生图与文本模型。' : '请在轻图桌面程序中管理供应商。'}</Empty>}
    {editor && <ProviderEditor provider={editor === 'new' ? undefined : editor} onClose={() => setEditor(null)} />}
    {deleting && <Confirm title="删除供应商" onClose={() => setDeleting(null)} busy={busy(`delete:${deleting.id}`)} onConfirm={() => { void request('deleteProvider', { id: deleting.id }, `delete:${deleting.id}`).then(result => { if (result !== undefined) { notify('供应商已删除。'); setDeleting(null); } }); }}>确定删除“{deleting.name}”及其保存的 API Key 吗？此操作不会删除已生成的图片。</Confirm>}
  </section>;
}
function Basic() {
  const { state, online, request, busy, notify } = useAPI();
  const [settings, setSettings] = useState<Settings>(state?.settings ?? { outputDirectory: '', format: 'png' });
  const dirty = useRef(false);
  const textChoices = textModelChoices(state?.providers ?? []);
  const textChoice = textChoices.find(option => option.provider.id === settings.textProviderId && option.model.id === settings.textModel);
  const namingMode = presetNamingMode(settings.namingMode, settings.naming);
  const organizationReady = Boolean(state?.features?.outputOrganization);
  const nameExample = outputName({ naming: settings.naming ?? '{序号}_{日期}', namingMode, sequence: 1, row: 1, index: 1, run: 1, createdAt: Date.now() }).base;
  useEffect(() => { if (!dirty.current && state) setSettings(state.settings); }, [state?.settings]);
  const edit = (patch: Partial<Settings>) => { dirty.current = true; setSettings(current => ({ ...current, ...patch })); };
  const save = async () => { const result = await request('saveSettings', { ...settings, namingMode, naming: NAMING_PRESETS[namingMode] }, 'settings:save'); if (result !== undefined) { dirty.current = false; notify('设置已保存。'); } };
  return <section className="set-wrap preferences-page"><div className="preferences-content">
    <header className="preferences-heading"><div><h2>基础设置</h2></div><button className="btn btn--pri" disabled={!online || !state || busy('settings:save') || busy('settings:directory')} onClick={() => void save()}>{busy('settings:save') ? '保存中…' : '保存设置'}</button></header>
    <div className="preferences-sections">
      {state && !organizationReady && <div className="warnbox" role="status">重启轻图后可使用新的命名方式与集中保存功能。</div>}
      <section className="card settings-card" aria-labelledby="output-settings-heading"><div className="settings-section-heading"><h3 id="output-settings-heading">图片保存</h3><p>保存后对新提交的任务生效。</p></div>
        <div className="settings-field"><label htmlFor="default-directory">默认保存目录</label><div className="settings-control"><div className="directory-input"><input id="default-directory" className="ipt ipt--mono" value={settings.outputDirectory} disabled={!state || busy('settings:save')} placeholder="选择保存目录" readOnly title={settings.outputDirectory || undefined} /><button className="btn btn--sm" aria-label="选择默认保存目录" disabled={!state || busy('settings:save') || busy('settings:directory')} onClick={() => { void request('chooseOutputDirectory', {}, 'settings:directory').then(result => { if (typeof result === 'string') edit({ outputDirectory: result }); }); }}>选择目录</button></div></div></div>
        <div className="settings-field"><label htmlFor="naming-mode">文件命名</label><div className="settings-control"><Select id="naming-mode" value={namingMode} disabled={!organizationReady || busy('settings:save')} options={[{ value: 'sequence', label: '按序号' }, { value: 'date', label: '按日期' }, { value: 'date-sequence', label: '日期加序号' }]} onChange={value => { const mode = value as keyof typeof NAMING_PRESETS; edit({ namingMode: mode, naming: NAMING_PRESETS[mode] }); }} /><p className="hinttxt naming-example" title="同名文件自动编号，不会覆盖已有图片。">示例：<span className="mono">{nameExample}.{settings.format}</span></p></div></div>
        <div className="settings-field"><label htmlFor="output-layout">保存方式</label><div className="settings-control"><Select id="output-layout" value={settings.outputLayout ?? 'grouped'} disabled={!organizationReady || busy('settings:save')} options={[{ value: 'grouped', label: '按任务分文件夹' }, { value: 'flat', label: '全部保存到同一文件夹' }]} onChange={value => edit({ outputLayout: value as OutputLayout })} /></div></div>
        <div className="settings-field"><label htmlFor="format">默认格式</label><div className="settings-control settings-control--short"><Select id="format" value={settings.format} disabled={!state || busy('settings:save')} options={[{ value: 'png', label: 'PNG' }, { value: 'jpg', label: 'JPG' }, { value: 'webp', label: 'WebP' }]} onChange={value => edit({ format: value as Settings['format'] })} /></div></div>
      </section>
      <section className="card settings-card" aria-labelledby="text-settings-heading"><div className="settings-section-heading"><h3 id="text-settings-heading">提示词辅助</h3></div><div className="settings-field"><label htmlFor="text-model" title="用于提示词优化和中译英">默认文本模型</label><div className="settings-control"><Select id="text-model" value={textSelectionValue(textChoices, settings.textProviderId, settings.textModel)} disabled={!state || busy('settings:save')} options={[{ value: '', label: '未配置' }, ...(!textChoice && (settings.textProviderId || settings.textModel) ? [{ value: '__missing__', label: '原文本模型已停用，请重新选择', disabled: true }] : []), ...textChoices.map(option => ({ value: option.value, label: `${option.model.name || option.model.id} · ${option.provider.name}` }))]} onChange={value => { const selected = textChoices.find(option => option.value === value); edit({ textProviderId: selected?.provider.id ?? '', textModel: selected?.model.id ?? '' }); }} />{(!textChoice || !textChoice.model.verified) && <p className="hinttxt">{!textChoice ? '请选择文本模型以启用提示词优化和中译英。' : '此模型尚未验证，请先测试供应商连接。'}</p>}</div></div></section>
    </div>
  </div></section>;
}
function About() {
  const { state, request, online, busy } = useAPI();
  const [update, setUpdate] = useState('尚未检查更新');
  const check = async () => { setUpdate('正在检查…'); const result = await request('checkUpdate'); setUpdate(typeof result === 'string' ? result : result && typeof result === 'object' && 'message' in result ? String(result.message) : result === undefined ? '检查未完成，请查看错误提示' : '检查完成，请查看通知'); };
  return <section className="about-wrap preferences-page"><div className="preferences-content">
    <header className="preferences-heading"><div><h2>关于轻图</h2></div></header>
    <div className="preferences-sections">
      <div className="card about-overview"><div className="about-brand"><div className="logo" aria-hidden="true">轻</div><div><div className="name">轻图 QingTu</div><div className="ver">桌面生图工具 · 单图创作与批量生成</div></div></div><div className="about-version"><span>当前版本</span><b>{state?.version ? `v${state.version}` : '—'}</b></div></div>
      <section className="card about-resources" aria-labelledby="about-resources-heading"><div className="settings-section-heading"><h3 id="about-resources-heading">项目与支持</h3></div>
        <div className="rowline"><div className="grow"><div className="name">GitHub 仓库</div></div><button className="btn btn--sm" disabled={!online} onClick={() => void request('openLink', { name: 'github' })}>打开仓库</button></div>
        {PRODUCT.updateManifest && <div className="rowline"><div className="grow"><div className="name">版本更新</div><div className="meta" role="status">{update}</div></div><button className="btn btn--sm" disabled={!online || busy('checkUpdate')} onClick={() => void check()}>{busy('checkUpdate') ? '检查中…' : '检查更新'}</button></div>}
        {PRODUCT.links.help && <div className="rowline"><div className="grow"><div className="name">帮助文档</div></div><button className="btn btn--sm" disabled={!online} onClick={() => void request('openLink', { name: 'help' })}>查看帮助</button></div>}
      </section>
    </div>
  </div></section>;
}

export default function App() {
  const { api, notice } = useBridge();
  const [page, setPage] = useState<Page>('gen');
  const [selected, setSelected] = useState<Partial<Record<TaskKind, string>>>({});
  const [localSubmission, setLocalSubmission] = useState<LocalSubmission | null>(null);
  const selectedRef = useRef(selected); selectedRef.current = selected;
  const selectionRevision = useRef<Partial<Record<TaskKind, number>>>({});
  const preparing = useRef(new Set<TaskKind>());
  const initialized = useRef(new Set<TaskKind>());
  const drafts = useDraftStore(api);
  const kind: TaskKind = page === 'batch' ? 'batch' : 'single';
  const selectTask = (taskKind: TaskKind, id: string) => {
    selectionRevision.current[taskKind] = (selectionRevision.current[taskKind] ?? 0) + 1;
    setSelected(current => ({ ...current, [taskKind]: id }));
  };
  const prepareDraft = useCallback(async (taskKind: TaskKind, initial = false) => {
    if (!api.online || !api.state || preparing.current.has(taskKind)) return;
    const revision = selectionRevision.current[taskKind] ?? 0;
    const choose = (id: string) => {
      if ((selectionRevision.current[taskKind] ?? 0) !== revision || (initial && selectedRef.current[taskKind])) return;
      setSelected(current => ({ ...current, [taskKind]: id }));
    };
    const existing = findWorkspaceDraft(api.state.tasks, taskKind);
    if (existing) { choose(existing.id); return; }
    preparing.current.add(taskKind);
    try {
      const before = new Set(api.state.tasks.map(item => item.id));
      const result = await api.request('createTask', { kind: taskKind }, `create:${taskKind}`);
      if (isAppState(result)) {
        const created = result.tasks.find(item => item.kind === taskKind && !before.has(item.id));
        if (created) choose(created.id);
      }
    } finally { preparing.current.delete(taskKind); }
  }, [api.online, api.state, api.request]);
  const deleteTask = async (target: Task): Promise<boolean> => {
    if (drafts.hasUnsaved(target.id) && await drafts.flush(target.id) === undefined) return false;
    const result = await api.request('deleteTask', { id: target.id }, `delete-task:${target.id}`);
    if (!isAppState(result)) return false;
    drafts.forget(target.id);
    if (selectedRef.current[target.kind] !== target.id) return true;
    const revision = (selectionRevision.current[target.kind] ?? 0) + 1;
    selectionRevision.current[target.kind] = revision;
    const choose = (id: string) => { if (selectionRevision.current[target.kind] === revision) setSelected(current => ({ ...current, [target.kind]: id })); };
    const existing = findWorkspaceDraft(result.tasks, target.kind);
    if (existing) choose(existing.id);
    else {
      const before = new Set(result.tasks.map(item => item.id));
      const created = await api.request('createTask', { kind: target.kind }, `create:${target.kind}`);
      if (isAppState(created)) {
        const draft = created.tasks.find(item => item.kind === target.kind && !before.has(item.id));
        if (draft) choose(draft.id);
      }
    }
    return true;
  };
  useEffect(() => {
    if ((page !== 'gen' && page !== 'batch') || !api.online || !api.state || selected[kind] || initialized.current.has(kind)) return;
    initialized.current.add(kind);
    void prepareDraft(kind, true);
  }, [page, kind, api.online, api.state, selected, prepareDraft]);
  const task = api.state?.tasks.find(item => item.id === selected[kind] && item.kind === kind);
  const allJobs = api.state?.tasks.flatMap(item => item.jobs) ?? [];
  const active = allJobs.filter(activeJob).length;
  const queued = allJobs.filter(job => job.status === 'queued').length;
  const quotaProvider = page === 'gen' || page === 'batch' ? api.state?.providers.find(item => item.id === task?.params.providerId) : api.state?.providers.find(item => item.builtin) ?? api.state?.providers[0];
  const closeLock = useRef(false);
  const close = async () => {
    if (closeLock.current) return; closeLock.current = true;
    try {
      do {
        for (const id of drafts.drafts.current.keys()) {
          if (!drafts.hasUnsaved(id)) continue;
          const saved = await drafts.flush(id);
          if (saved === undefined) return; // Preserve unsaved edits and the visible save error.
        }
      } while ([...drafts.drafts.current.keys()].some(drafts.hasUnsaved));
      await api.request('windowClose');
    } finally { closeLock.current = false; }
  };
  return <APIContext.Provider value={api}><div className="app"><header className="titlebar"><div className="logo">轻</div><div className="brand"><b>轻图 QingTu</b><span>桌面生图工具{api.state?.version ? ` v${api.state.version}` : ''}</span></div><div className="tb-right">{PRODUCT.links.help && <button className="tb-link" disabled={!api.online} onClick={() => void api.request('openLink', { name: 'help' })}>帮助</button>}<button className="tb-link" disabled={!api.online} onClick={() => void api.request('openLink', { name: 'github' })}>GitHub</button><button className="wbtn" aria-label="最小化窗口" disabled={!api.online} onClick={() => void api.request('windowMinimize')}>─</button><button className="wbtn" aria-label="最大化或还原窗口" disabled={!api.online} onClick={() => void api.request('windowMaximize')}>▢</button><button className="wbtn close" aria-label="关闭窗口" disabled={!api.online} onClick={() => void close()}>✕</button></div></header>
    {!api.online && <div className="connection-banner" role="alert">未连接桌面服务 — 当前页面不是可运行的轻图桌面程序，不会显示模拟任务或发送生图请求。</div>}
    {api.online && !api.state && <div className="connection-banner" role="status">正在读取本地数据… <button className="text-link" disabled={api.busy('getState')} onClick={() => void api.request('getState')}>重新连接</button></div>}
    <div className="body"><Sidebar page={page} setPage={setPage} /><div className="stage">{page === 'gen' || page === 'batch' ? <div className={`work ${kind === 'single' ? 'single-work' : 'batch-work'}`}><TaskList key={kind} kind={kind} selected={task?.id} select={id => selectTask(kind, id)} deleteTask={deleteTask} startNew={() => { selectionRevision.current[kind] = (selectionRevision.current[kind] ?? 0) + 1; void prepareDraft(kind); }} />{task ? kind === 'single' ? <div className="single-workspace"><ResultCanvas key={`result:${task.id}`} task={task} localSubmission={localSubmission} /><TaskEditor key={`editor:${task.id}`} task={task} drafts={drafts} onSubmissionChange={value => setLocalSubmission(current => value ?? (current?.taskId === task.id ? null : current))} /></div> : <><BatchCanvas key={`batch:${task.id}`} task={task} drafts={drafts} /><TaskEditor key={`editor:${task.id}`} task={task} drafts={drafts} /></> : <main className="canvas"><Empty title={!api.online ? '未连接桌面服务' : !api.state || api.busy(`create:${kind}`) ? '正在准备创作界面' : '无法准备新任务'}>{!api.online ? '请启动轻图桌面程序，连接本地数据与供应商服务。' : !api.state || api.busy(`create:${kind}`) ? '请稍候。' : '请查看提示，或点击左侧新建任务重试。'}</Empty></main>}</div> : page === 'providers' ? <Providers /> : page === 'settings' ? <Basic /> : <About />}</div></div>
    <footer className="taskbar"><span className={`dot ${active ? 'run' : ''} ${!api.online ? 'offline' : ''}`} /><span className="taskbar-status">{!api.online ? '未连接' : !api.state ? '正在连接' : active ? `进行中 · ${active} 项请求${queued ? ` · 排队 ${queued} 项` : ''}` : queued ? `等待队列 · ${queued} 项` : '就绪'}</span><span className="sp" /><QuotaStatus key={`${quotaProvider?.id}:${quotaProvider?.baseURL}:${quotaProvider?.configurationRevision}:${quotaProvider?.hasKey}`} provider={quotaProvider} /></footer>
    {notice && createPortal(<div className={`toast ${notice.error ? 'toast-error' : ''}`} role={notice.error ? 'alert' : 'status'}>{notice.message}</div>, document.body)}
  </div></APIContext.Provider>;
}
