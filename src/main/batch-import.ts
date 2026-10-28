import { stat as statFile } from 'node:fs/promises';
import type { Reference } from '../shared/types';
import { resolveBatchReferencePath, type BatchSheetRow } from './files';

type Dependencies = {
  stat?: (path: string) => Promise<{ isFile(): boolean; size: number }>;
  importReferences: (paths: string[]) => Promise<Reference[]>;
};

/** Validate all named files before copying any of them; repeated paths reuse one managed image. */
export async function importBatchReferences(rows: BatchSheetRow[], workbookPath: string, deps: Dependencies): Promise<(Reference | null)[]> {
  const unique = new Map<string, { path: string; row: number }>();
  const keys: (string | null)[] = [];
  for (const row of rows) {
    if (!row.referencePath) { keys.push(null); continue; }
    let resolved: string;
    try { resolved = resolveBatchReferencePath(row.referencePath, workbookPath); }
    catch { throw new Error(`第 ${row.sourceRow} 行参考图路径无效，请填写本地 PNG、JPG 或 WebP 文件路径。`); }
    const key = process.platform === 'win32' ? resolved.toLowerCase() : resolved;
    keys.push(key);
    if (!unique.has(key)) unique.set(key, { path: resolved, row: row.sourceRow });
  }
  for (const item of unique.values()) {
    try { const stat = await (deps.stat ?? statFile)(item.path); if (!stat.isFile() || stat.size > 20 * 1024 * 1024) throw new Error('invalid'); }
    catch { throw new Error(`第 ${item.row} 行参考图不存在、不可读取或超过 20 MB，请检查路径。`); }
  }
  const imported = new Map<string, Reference>();
  for (const [key, item] of unique) {
    try {
      const [reference] = await deps.importReferences([item.path]);
      if (!reference) throw new Error('missing image');
      imported.set(key, reference);
    } catch { throw new Error(`第 ${item.row} 行参考图无法导入，请检查图片格式和内容。`); }
  }
  return keys.map(key => key ? imported.get(key)! : null);
}
