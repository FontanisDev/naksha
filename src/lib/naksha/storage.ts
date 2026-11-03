/**
 * Naksha — Safe localStorage wrapper
 * Every operation is wrapped in try/catch. JSON parse errors fall back
 * to a provided default. Optional validation callback auto-recovers
 * from corrupted state.
 */

import { deepClone } from './utils';

interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
  clear(): void;
}

function getBackend(): StorageLike | null {
  if (typeof window === 'undefined') return null;
  try {
    const test = '__naksha_test__';
    window.localStorage.setItem(test, '1');
    window.localStorage.removeItem(test);
    return window.localStorage;
  } catch {
    return null;
  }
}

const backend = typeof window !== 'undefined' ? getBackend() : null;

/** In-memory fallback (used during SSR or when localStorage is blocked). */
const memoryStore = new Map<string, string>();

const store: StorageLike = {
  getItem(key) {
    if (backend) {
      try {
        return backend.getItem(key);
      } catch {
        return null;
      }
    }
    return memoryStore.get(key) ?? null;
  },
  setItem(key, value) {
    if (backend) {
      try {
        backend.setItem(key, value);
        return;
      } catch {
        // Quota or disabled — fall through to memory.
      }
    }
    memoryStore.set(key, value);
  },
  removeItem(key) {
    if (backend) {
      try {
        backend.removeItem(key);
        return;
      } catch {
        // ignore
      }
    }
    memoryStore.delete(key);
  },
  clear() {
    if (backend) {
      try {
        backend.clear();
        return;
      } catch {
        // ignore
      }
    }
    memoryStore.clear();
  },
};

export const Storage = {
  /** Get a parsed value, or `defaultValue` on any error. */
  get<T>(key: string, defaultValue: T): T {
    try {
      const raw = store.getItem(key);
      if (raw == null) return defaultValue;
      return JSON.parse(raw) as T;
    } catch (err) {
      console.warn(`[naksha] Storage.get(${key}) parse error:`, err);
      return defaultValue;
    }
  },

  /** Get the raw string (no JSON parse). */
  getRaw(key: string): string | null {
    try {
      return store.getItem(key);
    } catch (err) {
      console.warn(`[naksha] Storage.getRaw(${key}) error:`, err);
      return null;
    }
  },

  /** Set a value (JSON serialized). */
  set<T>(key: string, value: T): boolean {
    try {
      store.setItem(key, JSON.stringify(value));
      return true;
    } catch (err) {
      console.warn(`[naksha] Storage.set(${key}) error:`, err);
      return false;
    }
  },

  /** Remove a key. */
  remove(key: string): boolean {
    try {
      store.removeItem(key);
      return true;
    } catch (err) {
      console.warn(`[naksha] Storage.remove(${key}) error:`, err);
      return false;
    }
  },

  /** Clear all keys. */
  clear(): boolean {
    try {
      store.clear();
      return true;
    } catch (err) {
      console.warn('[naksha] Storage.clear() error:', err);
      return false;
    }
  },

  /**
   * Get a value with structure validation. If validation fails
   * (or the value is missing), `defaultValue` is returned (and
   * NOT written back — caller decides whether to save).
   */
  getValidated<T>(
    key: string,
    defaultValue: T,
    validate: (value: unknown) => value is T,
  ): T {
    try {
      const raw = store.getItem(key);
      if (raw == null) return defaultValue;
      const parsed = JSON.parse(raw);
      if (validate(parsed)) return parsed;
      console.warn(`[naksha] Storage.getValidated(${key}) failed validation, using default`);
      return defaultValue;
    } catch (err) {
      console.warn(`[naksha] Storage.getValidated(${key}) error:`, err);
      return defaultValue;
    }
  },

  /** Deep clone a value (useful before mutating). */
  clone<T>(value: T): T {
    return deepClone(value);
  },
};
