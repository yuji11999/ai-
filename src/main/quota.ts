import type { QuotaInfo } from '../shared/types';

const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const amount = (value: unknown): number | undefined => typeof value === 'number' && Number.isFinite(value) ? value : undefined;

/** Sub2API /v1/usage; consume only published quota fields, never usage.cost. */
export function parseSub2APIQuota(value: unknown, checkedAt: number): QuotaInfo | undefined {
  if (!object(value) || !['unrestricted', 'quota_limited'].includes(String(value.mode)) || typeof value.isValid !== 'boolean') return;
  const quota = object(value.quota) ? value.quota : undefined;
  const subscription = object(value.subscription);
  const balance = amount(value.balance);
  const remaining = amount(value.remaining) ?? amount(quota?.remaining) ?? (!subscription && value.mode === 'unrestricted' ? balance : undefined);
  const currency = [value.unit, quota?.unit].find(unit => typeof unit === 'string' && ['USD', 'CNY', 'EUR', 'GBP', 'JPY'].includes(unit)) as string | undefined;
  const limits: QuotaInfo['limits'] = [];
  if (Array.isArray(value.rate_limits)) for (const item of value.rate_limits.slice(0, 20)) {
    if (!object(item) || !['5h', '1d', '7d'].includes(String(item.window))) continue;
    const available = amount(item.remaining);
    if (available !== undefined && available >= 0) limits.push({ window: item.window as QuotaInfo['limits'][number]['window'], remaining: available });
  }
  const isSubscription = subscription || typeof value.planName === 'string' && value.planName !== '钱包余额' && balance === undefined;
  const kind: QuotaInfo['kind'] = value.mode === 'quota_limited' ? remaining === undefined ? 'periodic' : 'key' : isSubscription ? 'subscription' : 'balance';
  // Only a subscription's explicit -1 sentinel means unlimited; wallet debt does not.
  const unlimited = kind === 'subscription' && remaining === -1;
  const status = ['active', 'expired', 'quota_exhausted', 'disabled'].includes(String(value.status)) ? value.status as QuotaInfo['status'] : undefined;
  if (remaining === undefined && !limits.length && kind !== 'subscription' && value.isValid && (!status || status === 'active')) return;
  return { kind, remaining: unlimited ? undefined : remaining, currency, unlimited, valid: value.isValid, status, limits, checkedAt };
}
