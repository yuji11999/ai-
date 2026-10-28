import type { NamingMode } from './types';

export const NAMING_PRESETS = { sequence: '{序号}', date: '{日期}', 'date-sequence': '{日期}_{序号}' } as const;
export function namingModeForTemplate(template: string): NamingMode {
  return (Object.entries(NAMING_PRESETS).find(([, value]) => value === template)?.[0] as NamingMode | undefined) ?? 'custom';
}
export function presetNamingMode(mode?: NamingMode, template = ''): keyof typeof NAMING_PRESETS {
  if (mode && mode !== 'custom' && Object.hasOwn(NAMING_PRESETS, mode)) return mode;
  const inferred = mode === 'custom' ? 'custom' : namingModeForTemplate(template);
  return inferred === 'custom' ? 'date-sequence' : inferred;
}
export function localOutputDate(timestamp: number): string {
  const date = new Date(timestamp);
  if (!Number.isFinite(date.getTime())) throw new Error('任务时间无效');
  return `${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, '0')}${String(date.getDate()).padStart(2, '0')}`;
}
export interface NamingContext { naming: string; namingMode?: NamingMode; sequence?: number; row: number; index: number; run: number; createdAt: number }
export function outputName(context: NamingContext, collision = 0): { base: string; sequence?: { prefix: string; value: number } } {
  const date = localOutputDate(context.createdAt);
  if (!context.namingMode) {
    const base = context.naming.replace(/\{序号\}/g, `${String(context.row).padStart(4, '0')}-${String(context.index).padStart(2, '0')}`).replace(/\{日期\}/g, date);
    return { base: `${base}_run-${context.run}_row-${context.row}_image-${context.index}${collision ? `_${collision}` : ''}` };
  }
  const value = (context.sequence ?? context.row) + context.index - 1;
  if (context.namingMode === 'sequence' || context.namingMode === 'date-sequence') {
    const prefix = context.namingMode === 'date-sequence' ? `${date}_` : '';
    return { base: `${prefix}${String(value + collision).padStart(4, '0')}`, sequence: { prefix, value } };
  }
  const template = context.namingMode === 'date' ? NAMING_PRESETS.date : context.naming;
  return { base: template.replace(/\{序号\}/g, String(value).padStart(4, '0')).replace(/\{日期\}/g, date) + (collision ? `_${collision}` : '') };
}
