"use strict";

/**
 * High-performance, zero-dependency in-memory caching layer with TTL.
 * Prevents redundant Supabase queries and protects database quota.
 */
class MemoryCache {
  constructor(defaultTtlMs = 3600000) { // Default: 1 hour
    this.cache = new Map();
    this.defaultTtlMs = defaultTtlMs;
    this.hits = 0;
    this.misses = 0;

    // Periodic cleanup of expired keys every 5 minutes
    this.cleanupInterval = setInterval(() => {
      this.cleanup();
    }, 300000);

    if (this.cleanupInterval.unref) {
      this.cleanupInterval.unref();
    }
  }

  get(key) {
    if (!key) return null;
    const entry = this.cache.get(key);
    if (!entry) {
      this.misses++;
      return null;
    }

    if (Date.now() > entry.expiresAt) {
      this.cache.delete(key);
      this.misses++;
      return null;
    }

    this.hits++;
    return entry.value;
  }

  set(key, value, ttlMs = this.defaultTtlMs) {
    if (!key) return;
    this.cache.set(key, {
      value,
      expiresAt: Date.now() + Math.max(1000, ttlMs),
    });
  }

  has(key) {
    return this.get(key) !== null;
  }

  del(key) {
    return this.cache.delete(key);
  }

  clear() {
    this.cache.clear();
  }

  cleanup() {
    const now = Date.now();
    for (const [key, entry] of this.cache.entries()) {
      if (now > entry.expiresAt) {
        this.cache.delete(key);
      }
    }
  }

  stats() {
    return {
      size: this.cache.size,
      hits: this.hits,
      misses: this.misses,
    };
  }
}

// Global shared singleton for the application
const memoryCache = new MemoryCache(3600000); // 1 Hour TTL

module.exports = {
  MemoryCache,
  memoryCache,
};
