import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface StoredDoc {
  text: string;
  etag: string;
}

export interface PutOptions {
  ifMatch?: string;
  ifNew?: boolean;
}

/** Key-value storage with compare-and-swap. A write with a stale etag is refused, never merged. */
export interface DocStore {
  get(key: string): Promise<StoredDoc | null>;
  put(key: string, text: string, options?: PutOptions): Promise<boolean>;
  remove(key: string): Promise<void>;
  list(prefix: string): Promise<string[]>;
}

export class MemoryStore implements DocStore {
  private docs = new Map<string, StoredDoc>();
  private counter = 0;
  /** Simulated round-trip so tests exercise real interleaving of concurrent requests. */
  constructor(private latencyMs = 0) {}

  private async wait() {
    if (this.latencyMs) await new Promise((resolve) => setTimeout(resolve, Math.random() * this.latencyMs));
  }

  async get(key: string) {
    await this.wait();
    return this.docs.get(key) ?? null;
  }

  async put(key: string, text: string, options: PutOptions = {}) {
    await this.wait();
    const existing = this.docs.get(key);
    if (options.ifNew && existing) return false;
    if (options.ifMatch && existing?.etag !== options.ifMatch) return false;
    this.docs.set(key, { text, etag: String(++this.counter) });
    return true;
  }

  async remove(key: string) {
    this.docs.delete(key);
  }

  async list(prefix: string) {
    return [...this.docs.keys()].filter((key) => key.startsWith(prefix));
  }
}

/** Local development store: survives restarts of the dev server. One process only. */
export class FileStore implements DocStore {
  private memory = new MemoryStore();
  private loaded = false;

  constructor(private dir: string) {}

  private load() {
    if (this.loaded) return;
    this.loaded = true;
    mkdirSync(this.dir, { recursive: true });
    for (const name of readdirSync(this.dir)) {
      const key = decodeURIComponent(name);
      void this.memory.put(key, readFileSync(join(this.dir, name), "utf8"));
    }
  }

  async get(key: string) {
    this.load();
    return this.memory.get(key);
  }

  async put(key: string, text: string, options?: PutOptions) {
    this.load();
    const ok = await this.memory.put(key, text, options);
    if (ok) writeFileSync(join(this.dir, encodeURIComponent(key)), text);
    return ok;
  }

  async remove(key: string) {
    this.load();
    await this.memory.remove(key);
    const path = join(this.dir, encodeURIComponent(key));
    if (existsSync(path)) rmSync(path);
  }

  async list(prefix: string) {
    this.load();
    return this.memory.list(prefix);
  }
}
