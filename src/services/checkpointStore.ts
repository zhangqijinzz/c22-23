import type { AnalysisCheckpoint } from '../domain/ruleAnalysis';

/**
 * 检查点独立于项目文档保存：取消后随时可按“项目分析签名”找回最近一次进度。
 * 签名由影响结论的字段/规则内容派生，项目一改就自动失效，绝不会串算。
 */
interface StoredCheckpoint extends AnalysisCheckpoint {
  savedAt: number;
}

const DATABASE_NAME = 'ruleweave-checkpoints';
const STORE_NAME = 'checkpoint';
const DATABASE_VERSION = 1;
/** 只保留最近若干个项目的快照，避免无限增长。 */
const MAX_ENTRIES = 8;

export class CheckpointStore {
  static async get(signature: string): Promise<AnalysisCheckpoint | null> {
    const database = await this.openDatabase();
    if (!database) return null;
    try {
      const stored = await new Promise<StoredCheckpoint | undefined>((resolve, reject) => {
        const request = database.transaction(STORE_NAME, 'readonly').objectStore(STORE_NAME).get(signature);
        request.onsuccess = () => resolve(request.result as StoredCheckpoint | undefined);
        request.onerror = () => reject(request.error ?? new Error('读取检查点失败'));
      });
      return stored ?? null;
    } finally {
      database.close();
    }
  }

  /** 写入当前签名的快照，并顺手淘汰其它项目的旧快照。 */
  static async put(signature: string, checkpoint: AnalysisCheckpoint): Promise<void> {
    const database = await this.openDatabase();
    if (!database) return;
    try {
      await new Promise<void>((resolve, reject) => {
        const transaction = database.transaction(STORE_NAME, 'readwrite');
        const store = transaction.objectStore(STORE_NAME);
        const entry: StoredCheckpoint = { ...checkpoint, savedAt: Date.now() };
        store.put(entry, signature);
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error ?? new Error('写入检查点失败'));
        transaction.onabort = () => reject(transaction.error ?? new Error('检查点写入已中止'));
      });
      await CheckpointStore.prune(database, signature);
    } finally {
      database.close();
    }
  }

  static async delete(signature: string): Promise<void> {
    const database = await this.openDatabase();
    if (!database) return;
    try {
      await new Promise<void>((resolve, reject) => {
        const transaction = database.transaction(STORE_NAME, 'readwrite');
        transaction.objectStore(STORE_NAME).delete(signature);
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error ?? new Error('清理检查点失败'));
      });
    } finally {
      database.close();
    }
  }

  private static async prune(database: IDBDatabase, activeSignature: string): Promise<void> {
    const entries = await new Promise<StoredCheckpoint[]>((resolve, reject) => {
      const request = database.transaction(STORE_NAME, 'readonly').objectStore(STORE_NAME).getAll();
      request.onsuccess = () => resolve((request.result as StoredCheckpoint[] | undefined) ?? []);
      request.onerror = () => reject(request.error);
    });
    const others = entries.filter((entry) => entry.signature !== activeSignature);
    const stale = others
      .sort((a, b) => b.savedAt - a.savedAt)
      // 保留最近 MAX_ENTRIES-1 个其它项目，加上当前项目共至多 MAX_ENTRIES 条。
      .slice(MAX_ENTRIES - 1);
    if (!stale.length) return;
    await new Promise<void>((resolve) => {
      const transaction = database.transaction(STORE_NAME, 'readwrite');
      const store = transaction.objectStore(STORE_NAME);
      for (const entry of stale) store.delete(entry.signature);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => resolve();
    });
  }

  /** Worker 与主线程都可能调用；环境不支持 IndexedDB 时静默降级为不可续算。 */
  private static openDatabase(): Promise<IDBDatabase | null> {
    if (typeof globalThis.indexedDB === 'undefined') return Promise.resolve(null);
    return new Promise((resolve, reject) => {
      const request = globalThis.indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(STORE_NAME)) request.result.createObjectStore(STORE_NAME);
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error('打开检查点数据库失败'));
    });
  }
}
