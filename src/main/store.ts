import initSqlJs, { type Database, type SqlJsStatic } from 'sql.js';
import { dirname } from 'node:path';
import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import type { EngineSnapshot, StateStore } from './engine';

/** One serialized snapshot transaction; no image bytes or credentials are stored here. */
export class SQLiteStore implements StateStore {
  private sql?: SqlJsStatic;
  private db?: Database;
  private serial: Promise<unknown> = Promise.resolve();
  constructor(private readonly filename: string, private readonly options: { wasmPath?: string; beforeReplace?: () => Promise<void> } = {}) {}
  private async database(): Promise<Database> {
    if (this.db) return this.db;
    this.sql = await initSqlJs(this.options.wasmPath ? { locateFile: () => this.options.wasmPath! } : {});
    let existing: Uint8Array | undefined;
    try { existing = await readFile(this.filename); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    const db = new this.sql.Database(existing);
    db.run('CREATE TABLE IF NOT EXISTS snapshots (id INTEGER PRIMARY KEY CHECK (id = 1), version INTEGER NOT NULL, payload TEXT NOT NULL)');
    this.db = db;
    return db;
  }
  async load(): Promise<EngineSnapshot | null> {
    return this.enqueue(async () => {
      const db = await this.database();
      const row = db.exec('SELECT payload FROM snapshots WHERE id = 1')[0]?.values[0]?.[0];
      if (typeof row !== 'string') return null;
      const parsed = JSON.parse(row) as EngineSnapshot;
      if (parsed.schemaVersion !== 1 || !parsed.state || !parsed.jobs) throw new Error('数据文件版本不支持或已损坏，请勿覆盖原文件。');
      return parsed;
    });
  }
  async save(snapshot: EngineSnapshot): Promise<void> {
    return this.enqueue(async () => {
      const current = await this.database();
      // Build a replacement database: a failed write cannot mutate the in-memory committed view.
      const replacement = new this.sql!.Database(current.export());
      const temporary = `${this.filename}.${randomUUID()}.tmp`;
      try {
        replacement.run('BEGIN IMMEDIATE');
        replacement.run('INSERT INTO snapshots (id, version, payload) VALUES (1, ?, ?) ON CONFLICT(id) DO UPDATE SET version = excluded.version, payload = excluded.payload', [snapshot.schemaVersion, JSON.stringify(snapshot)]);
        replacement.run('COMMIT');
        await mkdir(dirname(this.filename), { recursive: true });
        const file = await open(temporary, 'wx', 0o600);
        try { await file.writeFile(replacement.export()); await file.sync(); } finally { await file.close(); }
        await this.options.beforeReplace?.();
        await rename(temporary, this.filename);
        // Directory fsync is supported on Unix, but not on all Windows filesystems.
        if (process.platform !== 'win32') {
          const directory = await open(dirname(this.filename), 'r');
          try { await directory.sync(); } finally { await directory.close(); }
        }
        current.close(); this.db = replacement;
      } catch (error) { replacement.close(); await unlink(temporary).catch(() => undefined); throw error; }
    });
  }
  async close(): Promise<void> { await this.enqueue(async () => { this.db?.close(); this.db = undefined; }); }
  private enqueue<T>(work: () => Promise<T>): Promise<T> { const result = this.serial.then(work, work); this.serial = result.catch(() => undefined); return result; }
}

export class MemoryStore implements StateStore {
  private snapshot: EngineSnapshot | null = null;
  async load(): Promise<EngineSnapshot | null> { return this.snapshot ? structuredClone(this.snapshot) : null; }
  async save(snapshot: EngineSnapshot): Promise<void> { this.snapshot = structuredClone(snapshot); }
}
