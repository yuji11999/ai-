import test from 'node:test';
import assert from 'node:assert/strict';
import { isQuotaInfo, quotaText, quotaDetails } from './quota-utils';
import type { QuotaInfo } from '../shared/types';

const quota: QuotaInfo = { kind: 'balance', remaining: 0, currency: 'USD', valid: true, unlimited: false, checkedAt: 1234, limits: [] };
test('quota display keeps zero, small balances and account/key/subscription labels accurate', () => {
  assert.equal(quotaText(quota), '余额 · 0 USD');
  assert.equal(quotaText({ ...quota, remaining: .00001 }), '余额 · < 0.0001 USD');
  assert.equal(quotaText({ ...quota, remaining: -1 }), '余额 · -1 USD');
  assert.equal(quotaText({ ...quota, kind: 'key' }), 'Key 额度 · 0 USD');
  assert.equal(quotaText({ ...quota, kind: 'subscription', remaining: undefined, unlimited: true }), '订阅额度 · 无限额');
  assert.equal(quotaText({ ...quota, remaining: undefined }), '余额 · 上游未返回');
  assert.match(quotaText({ ...quota, status: 'expired' }), /已过期/);
  assert.match(quotaDetails(quota), /查询时间/);
});
test('quota IPC responses must be finite typed metadata, never an application snapshot', () => {
  assert.ok(isQuotaInfo(quota));
  assert.equal(isQuotaInfo({ ...quota, remaining: NaN }), false);
  assert.equal(isQuotaInfo({ ...quota, remaining: '0' }), false);
  assert.equal(isQuotaInfo({ tasks: [], providers: [] }), false);
  assert.equal(isQuotaInfo({ ...quota, limits: [{ window: '1d', remaining: '10' }] }), false);
});
