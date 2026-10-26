import {promises as fs} from "node:fs";
import path from "node:path";
import {setTimeout as delay} from "node:timers/promises";
import fetch from "node-fetch";
import {downloadEmojiImage, EmojiFetch, encodeEmojiImage} from "./emojiImage";
import {postEmojis} from "./threadsEmojis";

const API = "https://discord.com/api/v10";
const MANAGED_NAME = /^ft_([a-f0-9]{24})$/;
const SYNC_INTERVAL_MS = 5 * 60 * 1000;
const FAILURE_RETRY_MS = 30 * 1000;
type Entry = DiscordEmojiProps & {key: string; lastUsed: number};
type Source = Pick<InlineEmojiProps, "key" | "url">;

export class DiscordEmojiError extends Error {
  constructor(message = "Discord emoji upload failed", readonly statusCode = 502) {
    super(message);
  }
}

interface EmojiCacheOptions {
  token?: string;
  applicationId?: string;
  cacheFile?: string;
  limit?: number;
  cleanupBatchSize?: number;
  fetch?: EmojiFetch;
  encodeImage?: typeof encodeEmojiImage;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

function positiveInteger(value: unknown, fallback: number, max: number): number {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? Math.min(number, max) : fallback;
}

function readEmoji(value: any): DiscordEmojiProps | undefined {
  if (!value || typeof value.id !== "string" || !/^\d{1,20}$/.test(value.id) ||
    typeof value.name !== "string" || value.name.length < 2 || value.name.length > 32) return;
  return {id: value.id, name: value.name, animated: value.animated === true};
}

export class DiscordEmojiCache {
  private readonly token: string;
  private applicationId: string;
  private readonly cacheFile: string;
  private readonly limit: number;
  private readonly batchSize: number;
  private readonly fetch: EmojiFetch;
  private readonly encodeImage: typeof encodeEmojiImage;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly entries = new Map<string, Entry>();
  private readonly remote = new Map<string, DiscordEmojiProps>();
  private readonly inflight = new Map<string, Promise<void>>();
  private readonly deleting = new Set<string>();
  private readonly pins = new Map<string, number>();
  private readonly failures = new Map<string, number>();
  private tail: Promise<unknown> = Promise.resolve();
  private loaded = false;
  private syncedAt = -Infinity;
  private nextRequestAt = 0;
  private unavailableUntil = 0;
  private dirty = false;
  private saveTimer?: NodeJS.Timeout;

  constructor(options: EmojiCacheOptions = {}) {
    this.token = options.token?.trim().replace(/^Bot\s+/i, "") || "";
    this.applicationId = options.applicationId || "";
    this.cacheFile = options.cacheFile || path.join(process.cwd(), "generated", "discord-emojis.json");
    this.limit = positiveInteger(options.limit, 2000, 2000);
    this.batchSize = positiveInteger(options.cleanupBatchSize, 50, this.limit);
    this.fetch = options.fetch || fetch;
    this.encodeImage = options.encodeImage || encodeEmojiImage;
    this.now = options.now || Date.now;
    this.sleep = options.sleep || (async ms => {await delay(ms);});
  }

  private enqueue<T>(work: () => Promise<T>): Promise<T> {
    const result = this.tail.then(work);
    // A failed image must not poison the rest of the upload/delete queue.
    this.tail = result.catch(() => {});
    return result;
  }

  private cached(sources: Source[]): Record<string, DiscordEmojiProps> {
    const result: Record<string, DiscordEmojiProps> = {};
    for (const source of sources) {
      const entry = this.entries.get(source.key);
      if (!entry || this.deleting.has(source.key)) continue;
      entry.lastUsed = this.now();
      result[source.key] = {id: entry.id, name: entry.name, animated: entry.animated};
      this.dirty = true;
    }
    if (this.dirty && !this.saveTimer) {
      this.saveTimer = setTimeout(() => {
        this.saveTimer = undefined;
        void this.enqueue(() => this.persist());
      }, 1000);
      this.saveTimer.unref();
    }
    return result;
  }

  async prepare(sources: Source[], wait = false): Promise<Record<string, DiscordEmojiProps>> {
    const unique = [...new Map(sources.map(source => [source.key, source])).values()];
    if (!unique.length) return {};
    if (!this.token) {
      if (wait) throw new DiscordEmojiError("DISCORD_BOT_TOKEN is required to preload emojis", 503);
      return {};
    }
    const snapshot = this.cached(unique);
    if (unique.length > this.limit) {
      if (wait) throw new DiscordEmojiError("Post has more emojis than the configured cache capacity", 503);
      return snapshot;
    }
    for (const source of unique) this.pins.set(source.key, (this.pins.get(source.key) || 0) + 1);
    const completion = Promise.allSettled(unique.map(source => this.schedule(source))).then(results => {
      for (const result of results) if (result.status === "rejected") throw result.reason;
      return this.cached(unique);
    }).finally(() => {
      for (const source of unique) {
        const count = (this.pins.get(source.key) || 1) - 1;
        if (count) this.pins.set(source.key, count);
        else this.pins.delete(source.key);
      }
    });
    if (wait && unique.some(source => !snapshot[source.key])) return completion;
    // Return the snapshot taken before any network/disk work started.
    // Even /preload can return a full cache hit while revalidation runs behind it.
    void completion.catch(() => {});
    return snapshot;
  }

  private schedule(source: Source): Promise<void> {
    const running = this.inflight.get(source.key);
    if (running) return running;
    if (this.entries.has(source.key) && !this.deleting.has(source.key) &&
      this.now() - this.syncedAt < SYNC_INTERVAL_MS) {
      return Promise.resolve();
    }
    if ((this.failures.get(source.key) || 0) > this.now()) {
      return Promise.reject(new DiscordEmojiError("Emoji upload is temporarily unavailable; retry shortly", 503));
    }
    const task = this.enqueue(async () => {
      await this.synchronize();
      if (this.entries.has(source.key)) return;
      if (!/^[a-f0-9]{24}$/.test(source.key)) throw new DiscordEmojiError("Invalid emoji key");
      const image = await this.encodeImage(await downloadEmojiImage(source.url, this.fetch));
      await this.makeRoom();
      const created = readEmoji(await this.request(`/applications/${this.applicationId}/emojis`, "POST", {
        name: `ft_${source.key}`, image,
      }));
      if (!created || created.name !== `ft_${source.key}`) throw new DiscordEmojiError("Invalid Discord emoji response");
      this.entries.set(source.key, {...created, key: source.key, lastUsed: this.now()});
      this.remote.set(created.id, created);
      this.failures.delete(source.key);
      this.dirty = true;
      await this.persist();
    }).catch(error => {
      // Reconcile before retrying: Discord may have created an emoji even if
      // the connection died before its response arrived. Names are stable.
      this.syncedAt = -Infinity;
      this.failures.delete(source.key);
      this.failures.set(source.key, this.now() + FAILURE_RETRY_MS);
      if (this.failures.size > 4000) this.failures.delete(this.failures.keys().next().value!);
      const safeError = error instanceof DiscordEmojiError ? error : new DiscordEmojiError();
      console.warn(`[DiscordEmoji] ${safeError.message}`);
      throw safeError;
    }).finally(() => {this.inflight.delete(source.key);});
    this.inflight.set(source.key, task);
    return task;
  }

  private async request(endpoint: string, method = "GET", body?: object): Promise<any> {
    for (let attempt = 0; attempt < 3; attempt++) {
      if (this.now() < this.unavailableUntil) throw new DiscordEmojiError("Discord emoji service is temporarily unavailable", 503);
      const wait = this.nextRequestAt - this.now();
      if (wait > 0) await this.sleep(wait);
      let response;
      try {
        response = await this.fetch(API + endpoint, {
          method, redirect: "error", signal: AbortSignal.timeout(10000), size: 2 * 1024 * 1024,
          headers: {Authorization: `Bot ${this.token}`, "Content-Type": "application/json"},
          ...(body ? {body: JSON.stringify(body)} : {}),
        });
      } catch {
        throw new DiscordEmojiError("Unable to reach Discord emoji service");
      }
      const data: any = response.status === 204 ? undefined : await response.json().catch(() => undefined);
      const reset = Number(response.headers.get("x-ratelimit-reset-after"));
      if (response.headers.get("x-ratelimit-remaining") === "0" && Number.isFinite(reset) && reset > 0) {
        this.nextRequestAt = this.now() + reset * 1000;
      }
      if (response.status === 429) {
        const retry = Number(data?.retry_after ?? response.headers.get("retry-after"));
        this.nextRequestAt = this.now() + (Number.isFinite(retry) && retry > 0 ? retry * 1000 : 1000);
        continue;
      }
      if (response.status === 401 || response.status === 403) {
        this.unavailableUntil = this.now() + 60 * 1000;
      }
      if (response.ok || (method === "DELETE" && response.status === 404)) return data;
      throw new DiscordEmojiError(`Discord emoji API returned HTTP ${response.status}`);
    }
    throw new DiscordEmojiError("Discord emoji rate limit exceeded; retry shortly", 503);
  }

  private async synchronize(): Promise<void> {
    if (this.now() - this.syncedAt < SYNC_INTERVAL_MS) return;
    if (!this.applicationId) {
      const application = await this.request("/applications/@me");
      if (typeof application?.id !== "string" || !/^\d{1,20}$/.test(application.id)) {
        throw new DiscordEmojiError("Unable to identify Discord application");
      }
      this.applicationId = application.id;
    }
    if (!/^\d{1,20}$/.test(this.applicationId)) throw new DiscordEmojiError("Invalid Discord application ID", 503);
    if (!this.loaded) {
      try {
        const stored = JSON.parse(await fs.readFile(this.cacheFile, "utf8"));
        if (stored.version === 1 && stored.applicationId === this.applicationId && Array.isArray(stored.entries)) {
          for (const entry of stored.entries) {
            const emoji = readEmoji(entry);
            if (emoji && emoji.name === `ft_${entry.key}` && MANAGED_NAME.test(emoji.name) &&
              Number.isFinite(entry.lastUsed) && entry.lastUsed >= 0) {
              this.entries.set(entry.key, {...emoji, key: entry.key, lastUsed: Math.min(entry.lastUsed, this.now())});
            }
          }
        }
      } catch {
        // Missing/corrupt caches are rebuilt from the managed name prefix.
      }
      this.loaded = true;
    }
    const result = await this.request(`/applications/${this.applicationId}/emojis`);
    if (!Array.isArray(result?.items)) throw new DiscordEmojiError("Invalid Discord emoji list");
    this.remote.clear();
    const next = new Map<string, Entry>();
    for (const value of result.items) {
      const emoji = readEmoji(value);
      if (!emoji) continue;
      this.remote.set(emoji.id, emoji);
      const key = emoji.name.match(MANAGED_NAME)?.[1];
      if (!key || value.available === false) continue;
      next.set(key, {...emoji, key, lastUsed: this.entries.get(key)?.lastUsed ||
        Number((BigInt(emoji.id) >> 22n) + 1420070400000n)});
    }
    this.entries.clear();
    for (const [key, entry] of next) this.entries.set(key, entry);
    this.syncedAt = this.now();
    this.dirty = true;
    await this.persist();
  }

  private async makeRoom(): Promise<void> {
    while (this.remote.size >= this.limit) {
      const needed = this.remote.size - this.limit + 1;
      const candidates = [...this.remote.values()].flatMap(emoji => {
        const key = emoji.name.match(MANAGED_NAME)?.[1];
        return key && !this.pins.has(key)
          ? [{...emoji, key, lastUsed: this.entries.get(key)?.lastUsed || 0}] : [];
      }).sort((a, b) => a.lastUsed - b.lastUsed);
      if (candidates.length < needed) throw new DiscordEmojiError("No unused managed emoji slots available", 503);
      // Only this feature's ft_<hash> namespace is eligible for batch eviction.
      let removed = 0;
      try {
        for (const emoji of candidates) {
          if (removed >= this.batchSize) break;
          // New requests can pin a candidate while earlier DELETEs await I/O.
          if (this.pins.has(emoji.key)) continue;
          this.deleting.add(emoji.key);
          try {
            await this.request(`/applications/${this.applicationId}/emojis/${emoji.id}`, "DELETE");
            this.remote.delete(emoji.id);
            if (this.entries.get(emoji.key)?.id === emoji.id) this.entries.delete(emoji.key);
            this.dirty = true;
            removed++;
          } finally {
            this.deleting.delete(emoji.key);
          }
        }
      } finally {
        await this.persist();
      }
      if (!removed) throw new DiscordEmojiError("No unused managed emoji slots available", 503);
    }
  }

  private async persist(): Promise<void> {
    if (!this.dirty) return;
    const snapshot = JSON.stringify({version: 1, applicationId: this.applicationId, entries: [...this.entries.values()]});
    this.dirty = false;
    try {
      await fs.mkdir(path.dirname(this.cacheFile), {recursive: true});
      const temporary = `${this.cacheFile}.${process.pid}.tmp`;
      await fs.writeFile(temporary, snapshot, "utf8");
      await fs.rename(temporary, this.cacheFile);
    } catch {
      this.dirty = true;
      console.warn("[DiscordEmoji] Unable to persist emoji cache");
    }
  }

  async flush(): Promise<void> {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = undefined;
    await this.enqueue(() => this.persist());
  }
}

let defaultCache: DiscordEmojiCache | undefined;
export async function preparePostEmojis(post: ContentProps, preload = false): Promise<ContentProps> {
  defaultCache ??= new DiscordEmojiCache({
    token: process.env.DISCORD_BOT_TOKEN,
    applicationId: process.env.DISCORD_APPLICATION_ID,
    cacheFile: process.env.DISCORD_EMOJI_CACHE_FILE,
    limit: positiveInteger(process.env.DISCORD_EMOJI_CACHE_LIMIT, 2000, 2000),
    cleanupBatchSize: positiveInteger(process.env.DISCORD_EMOJI_CLEANUP_BATCH_SIZE, 50, 2000),
  });
  return {...post, discordEmojis: await defaultCache.prepare(postEmojis(post), preload)};
}
