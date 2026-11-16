import fs from 'fs';
import path from 'path';
import { config } from '../config.js';

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
  storedAt: number;
}

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const DEFAULT_MAX_ENTRIES = 1200;

/**
 * 24-hour TTL + LRU cache with optional disk persistence for external biomedical APIs
 * (NCBI efetch, elink, idconv, ClinicalTrials.gov v2, and ISRCTN XML API).
 */
export class ApiTtlCache {
  private store = new Map<string, CacheEntry<unknown>>();
  private readonly maxEntries: number;
  private readonly defaultTtlMs: number;
  private readonly cacheFilePath: string | null;
  private persistTimer: NodeJS.Timeout | null = null;
  private dirty = false;

  constructor(options?: {
    maxEntries?: number;
    defaultTtlMs?: number;
    cacheFilePath?: string | null;
  }) {
    this.maxEntries = options?.maxEntries ?? DEFAULT_MAX_ENTRIES;
    this.defaultTtlMs = options?.defaultTtlMs ?? DEFAULT_TTL_MS;
    this.cacheFilePath =
      options?.cacheFilePath !== undefined
        ? options.cacheFilePath
        : path.join(config.dataDir, 'biomedical-api-cache.json');

    this.loadFromDisk();
  }

  private loadFromDisk(): void {
    if (!this.cacheFilePath) return;
    try {
      if (!fs.existsSync(this.cacheFilePath)) return;
      const raw = fs.readFileSync(this.cacheFilePath, 'utf-8');
      const parsed = JSON.parse(raw) as Record<string, CacheEntry<unknown>>;
      if (!parsed || typeof parsed !== 'object') return;
      const now = Date.now();
      for (const [k, entry] of Object.entries(parsed)) {
        if (entry && typeof entry.expiresAt === 'number' && entry.expiresAt > now) {
          this.store.set(k, entry);
        }
      }
      this.evictIfNeeded();
    } catch {
      // Ignore corrupt or unreadable cache files on startup
    }
  }

  private schedulePersist(): void {
    if (!this.cacheFilePath) return;
    this.dirty = true;
    if (this.persistTimer) return;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      if (!this.dirty) return;
      this.dirty = false;
      this.flushToDisk();
    }, 1500);
    if (typeof this.persistTimer.unref === 'function') {
      this.persistTimer.unref();
    }
  }

  public flushToDisk(): void {
    if (!this.cacheFilePath) return;
    try {
      const dir = path.dirname(this.cacheFilePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      const now = Date.now();
      const serializable: Record<string, CacheEntry<unknown>> = {};
      for (const [k, entry] of this.store.entries()) {
        if (entry.expiresAt > now) {
          serializable[k] = entry;
        }
      }
      fs.writeFileSync(this.cacheFilePath, JSON.stringify(serializable), 'utf-8');
    } catch {
      // Never throw on cache disk write failure
    }
  }

  private evictIfNeeded(): void {
    while (this.store.size > this.maxEntries) {
      const oldestKey = this.store.keys().next().value;
      if (oldestKey === undefined) break;
      this.store.delete(oldestKey);
    }
  }

  public get<T>(key: string): T | undefined {
    const entry = this.store.get(key);
    if (!entry) return undefined;
    if (Date.now() >= entry.expiresAt) {
      this.store.delete(key);
      this.schedulePersist();
      return undefined;
    }
    // Refresh LRU recency by re-inserting at the tail of Map
    this.store.delete(key);
    this.store.set(key, entry);
    return entry.value as T;
  }

  public set<T>(key: string, value: T, ttlMs = this.defaultTtlMs): void {
    const now = Date.now();
    if (this.store.has(key)) {
      this.store.delete(key);
    }
    this.store.set(key, {
      value,
      storedAt: now,
      expiresAt: now + Math.max(1, ttlMs)
    });
    this.evictIfNeeded();
    this.schedulePersist();
  }

  public has(key: string): boolean {
    return this.get(key) !== undefined;
  }

  public delete(key: string): boolean {
    const removed = this.store.delete(key);
    if (removed) this.schedulePersist();
    return removed;
  }

  public clear(): void {
    this.store.clear();
    this.schedulePersist();
  }

  public async getOrFetch<T>(
    key: string,
    fetcher: () => Promise<T>,
    options?: { ttlMs?: number; shouldCache?: (val: T) => boolean }
  ): Promise<{ value: T; cached: boolean }> {
    const hit = this.get<T>(key);
    if (hit !== undefined) {
      return { value: hit, cached: true };
    }
    const fresh = await fetcher();
    const allowCache = options?.shouldCache ? options.shouldCache(fresh) : fresh !== undefined && fresh !== null;
    if (allowCache) {
      this.set(key, fresh, options?.ttlMs ?? this.defaultTtlMs);
    }
    return { value: fresh, cached: false };
  }

  public stats(): { size: number; maxEntries: number; ttlMs: number } {
    const now = Date.now();
    for (const [k, entry] of this.store.entries()) {
      if (entry.expiresAt <= now) {
        this.store.delete(k);
      }
    }
    return {
      size: this.store.size,
      maxEntries: this.maxEntries,
      ttlMs: this.defaultTtlMs
    };
  }
}

export const apiCache = new ApiTtlCache();
