import type { Adapter, AdapterPayload } from "oidc-provider";

/**
 * Models whose tokens/codes are tied to a grant and need revocation support.
 */
const GRANTABLE_MODELS = new Set([
  "AccessToken",
  "AuthorizationCode",
  "RefreshToken",
  "DeviceCode",
  "BackchannelAuthenticationRequest",
]);

interface StoredEntry {
  payload: AdapterPayload;
  expiresAt?: number;
}

/** Primary store: model:id → entry */
const store = new Map<string, StoredEntry>();
/** Secondary index: grantId → set of primary keys */
const grantIndex = new Map<string, Set<string>>();
/** Secondary index: userCode → primary key */
const userCodeIndex = new Map<string, string>();
/** Secondary index: session uid → primary key */
const uidIndex = new Map<string, string>();

/**
 * In-memory adapter for oidc-provider. Simple and fast, but state is lost
 * when the process restarts. Suitable for local development only.
 */
export class MemoryAdapter implements Adapter {
  private readonly model: string;

  constructor(model: string) {
    this.model = model;
  }

  private key(id: string): string {
    return `${this.model}:${id}`;
  }

  private now(): number {
    return Math.floor(Date.now() / 1000);
  }

  private getIfValid(key: string): AdapterPayload | undefined {
    const entry = store.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt && entry.expiresAt < this.now()) {
      store.delete(key);
      return undefined;
    }
    return entry.payload;
  }

  async upsert(
    id: string,
    payload: AdapterPayload,
    expiresIn: number,
  ): Promise<void> {
    const key = this.key(id);

    const entry: StoredEntry = {
      payload,
      expiresAt: expiresIn ? this.now() + expiresIn : undefined,
    };

    store.set(key, entry);

    if (payload.uid) {
      uidIndex.set(payload.uid, key);
    }

    if (payload.userCode) {
      userCodeIndex.set(payload.userCode, key);
    }

    if (GRANTABLE_MODELS.has(this.model) && payload.grantId) {
      const existing = grantIndex.get(payload.grantId);
      if (existing) {
        existing.add(key);
      } else {
        grantIndex.set(payload.grantId, new Set([key]));
      }
    }
  }

  async find(id: string): Promise<AdapterPayload | undefined> {
    return this.getIfValid(this.key(id));
  }

  async findByUid(uid: string): Promise<AdapterPayload | undefined> {
    const key = uidIndex.get(uid);
    if (!key) return undefined;
    return this.getIfValid(key);
  }

  async findByUserCode(userCode: string): Promise<AdapterPayload | undefined> {
    const key = userCodeIndex.get(userCode);
    if (!key) return undefined;
    return this.getIfValid(key);
  }

  async consume(id: string): Promise<void> {
    const entry = store.get(this.key(id));
    if (entry) {
      entry.payload.consumed = this.now();
    }
  }

  async destroy(id: string): Promise<void> {
    store.delete(this.key(id));
  }

  async revokeByGrantId(grantId: string): Promise<void> {
    const keys = grantIndex.get(grantId);
    if (keys) {
      for (const key of keys) {
        store.delete(key);
      }
      grantIndex.delete(grantId);
    }
  }
}

/** Clears all stored data. Useful for testing. */
export function clearMemoryStore(): void {
  store.clear();
  grantIndex.clear();
  userCodeIndex.clear();
  uidIndex.clear();
}
