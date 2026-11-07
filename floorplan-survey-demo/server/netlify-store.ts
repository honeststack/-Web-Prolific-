import { getStore } from "@netlify/blobs";
import { DocStore, PutOptions } from "./store";

type NetlifyStore = ReturnType<typeof getStore>;

/** Netlify Blobs with strong consistency, so a read always sees the latest committed write. */
export class NetlifyBlobStore implements DocStore {
  private store: NetlifyStore;

  constructor(store?: NetlifyStore) {
    this.store = store ?? getStore({ name: "survey", consistency: "strong" });
  }

  async get(key: string) {
    const found = await this.store.getWithMetadata(key, { type: "text" });
    if (!found) return null;
    if (found.etag) return { text: found.data, etag: found.etag };

    // Netlify's local Blobs server (netlify dev) sends no etag on reads. Take it from
    // the listing, before re-reading the data: if the data then turns out newer than
    // the etag, the conditional write is refused and retried, so this order stays safe.
    const { blobs } = await this.store.list({ prefix: key });
    const etag = blobs.find((blob) => blob.key === key)?.etag;
    const text = await this.store.get(key, { type: "text" });
    return etag && text !== null ? { text, etag } : null;
  }

  async put(key: string, text: string, options: PutOptions = {}) {
    if (options.ifNew) return (await this.store.set(key, text, { onlyIfNew: true })).modified;
    if (options.ifMatch) return (await this.store.set(key, text, { onlyIfMatch: options.ifMatch })).modified;
    await this.store.set(key, text);
    return true;
  }

  async remove(key: string) {
    await this.store.delete(key);
  }

  async list(prefix: string) {
    const { blobs } = await this.store.list({ prefix });
    return blobs.map((blob) => blob.key);
  }
}
