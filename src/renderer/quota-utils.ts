import type { QuotaInfo } from '../shared/types';

export function isQuotaInfo(value: unknown): value is QuotaInfo {
  if (!value || typeof value !== 'object') return false;
  const q = value as Partial<QuotaInfo>;
  return ['balance', 'key', 'subscription', 'periodic'].includes(q.kind ?? '') && typeof q.valid === 'boolean' && typeof q.unlimited === 'boolean'
    && typeof q.checkedAt === 'number' && Number.isFinite(q.checkedAt)
    && (q.remaining === undefined || typeof q.remaining === 'number' && Number.isFinite(q.remaining))
    && (q.currency === undefined || ['USD', 'CNY', 'EUR', 'GBP', 'JPY'].includes(q.currency))
    && (q.status === undefined || ['active', 'expired', 'quota_exhausted', 'disabled'].includes(q.status))
    && Array.isArray(q.limits) && q.limits.every(limit => limit && ['5h', '1d', '7d'].includes(limit.window) && typeof limit.remaining === 'number' && Number.isFinite(limit.remaining));
}

const formatAmount = (amount: number) => amount > 0 && amount < .0001 ? '< 0.0001' : new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 4 }).format(amount);
const labels = { balance: '余额', key: 'Key 额度', subscription: '订阅额度', periodic: '周期额度' };
const windows = { '5h': '5 小时', '1d': '每日', '7d': '每周' };

export function quotaText(quota: QuotaInfo): string {
  if (!quota.valid || quota.status === 'disabled') return '额度 · Key 不可用';
  if (quota.status === 'expired') return '额度 · Key 已过期';
  if (quota.status === 'quota_exhausted') return '额度 · 已用尽';
  const amount = quota.remaining;
  const value = quota.unlimited ? '无限额' : amount !== undefined ? `${formatAmount(amount)}${quota.currency ? ` ${quota.currency}` : ''}` : quota.limits.length ? '查看周期限制' : '上游未返回';
  return `${labels[quota.kind]} · ${value}`;
}

export function quotaDetails(quota: QuotaInfo): string {
  return [quotaText(quota), ...(quota.remaining !== undefined ? [`上游返回：${quota.remaining}${quota.currency ? ` ${quota.currency}` : ''}`] : []), ...quota.limits.map(limit => `${windows[limit.window]}剩余：${limit.remaining}${quota.currency ? ` ${quota.currency}` : ''}`), `查询时间：${new Date(quota.checkedAt).toLocaleString('zh-CN')}`, '点击刷新额度'].join('\n');
}
