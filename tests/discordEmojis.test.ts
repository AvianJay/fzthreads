/// <reference path="../src/types/application.d.ts" />
import assert from "node:assert/strict";
import {once} from "node:events";
import {promises as fs} from "node:fs";
import {AddressInfo} from "node:net";
import os from "node:os";
import path from "node:path";
import {TestContext, test} from "node:test";
import express from "express";
import fetch, {RequestInit, Response} from "node-fetch";
import sharp from "sharp";
import {createPostsRouter} from "../src/controllers/posts";
import {DiscordEmojiCache, DiscordEmojiError} from "../src/utils/discordEmojis";
import {componentJson, discordTextFormatter} from "../src/utils/discordComponents";
import {downloadEmojiImage, encodeEmojiImage, MAX_EMOJI_BYTES} from "../src/utils/emojiImage";
import {buildContentFromResponse} from "../src/utils/fetch/findPost";
import {buildPostComponents} from "../src/utils/renderPostComponents";
import renderSeo from "../src/utils/renderSeo";
import {emojiImageUrl, postEmojis, readInlineEmoji} from "../src/utils/threadsEmojis";
import {HttpError} from "../src/utils/utils";

const code = "DeP23AyE-3V";
const url = "https://media1.giphy.com/media/oQdZu3Q2cGpUEJw6xo/200.gif";
function sticker(id = "oQdZu3Q2cGpUEJw6xo", spoiler = false) {
  return {fragment_type: "inline_sticker", plaintext: "□",
    inline_sticker_fragment: {community_inline_sticker_id: null, sticker_id: id,
      sticker_url: `https://media1.giphy.com/media/${id}/200.gif`},
    styling_info: {is_spoiler: spoiler}};
}
function example() {
  return {
    code, caption: {text: "不負責民調 ▓看看?\n2026台北市長你愛誰"},
    user: {username: "power3067830678", full_name: "陳之漢"},
    text_post_app_info: {text_fragments: {fragments: [
      {plaintext: "不負責民調 "}, sticker(), {plaintext: "看看?\n2026台北市長你愛誰"},
    ]}},
  };
}
function content(raw: any = example()): ContentProps {
  const post = buildContentFromResponse({data: {data: {edges: [{node: {
    thread_items: [{post: raw}],
  }}]}}}, code, "4003659868678647253");
  assert.ok(post);
  return {...post, userAgent: "Discordbot/2.0"};
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => {resolve = done;});
  return {promise, resolve};
}
function json(value: unknown, status = 200, headers = {}) {
  return new Response(JSON.stringify(value), {status, headers});
}
function key(index: number) {return index.toString(16).padStart(24, "0");}
function source(index: number) {return {key: key(index), url};}

class DiscordMock {
  emojis: DiscordEmojiProps[] = [];
  calls: {url: string; method: string}[] = [];
  beforeCreate?: () => Promise<void>;
  beforeDelete?: () => Promise<void>;
  override?: (url: string, options: RequestInit) => Response | undefined;
  fetch = async (url: string, options: RequestInit = {}): Promise<Response> => {
    const method = options.method || "GET";
    this.calls.push({url, method});
    if (url.startsWith("https://media1.giphy.com/")) {
      assert.equal(options.headers, undefined, "CDNs must not receive bot credentials");
      return new Response(Buffer.from("image"));
    }
    const overridden = this.override?.(url, options);
    if (overridden) return overridden;
    assert.ok(url.startsWith("https://discord.com/api/v10/"));
    if (url.endsWith("/applications/@me")) return json({id: "123456"});
    if (method === "GET") return json({items: this.emojis});
    if (method === "POST") {
      await this.beforeCreate?.();
      const body = JSON.parse(String(options.body));
      assert.ok(body.image.startsWith("data:image/gif;base64,"));
      const emoji = {id: String(1800000000000000000n + BigInt(this.calls.length)), name: body.name, animated: true};
      this.emojis.push(emoji);
      return json(emoji);
    }
    assert.equal(method, "DELETE");
    await this.beforeDelete?.();
    this.emojis = this.emojis.filter(emoji => !url.endsWith(`/${emoji.id}`));
    return new Response(null, {status: 204});
  };
  count(method: string) {return this.calls.filter(call => call.method === method).length;}
}

async function setup(t: TestContext, mock = new DiscordMock(), options = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "fzthreads-emojis-"));
  const cacheFile = path.join(directory, "cache.json");
  const caches: DiscordEmojiCache[] = [];
  const create = (extra = {}) => {
    const cache = new DiscordEmojiCache({token: "test-bot-token", cacheFile, fetch: mock.fetch,
      encodeImage: async () => "data:image/gif;base64,aW1hZ2U=", ...options, ...extra});
    caches.push(cache);
    return cache;
  };
  t.after(async () => {
    for (const cache of caches) await cache.flush();
    assert.equal(path.dirname(directory), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith("fzthreads-emojis-"));
    await fs.rm(directory, {recursive: true, force: true});
  });
  return {cache: create(), create, cacheFile, mock};
}

test("the real inline_sticker shape retains its exact position, ID and GIF URL", () => {
  const post = content();
  assert.equal(post.caption, "不負責民調 □看看?\n2026台北市長你愛誰");
  assert.equal(post.emojis?.length, 1);
  assert.equal(post.emojis![0].offset, 6);
  assert.equal(post.emojis![0].length, 1);
  assert.equal(post.emojis![0].url, url);
  const changedUrl = sticker();
  changedUrl.inline_sticker_fragment.sticker_url = "https://media2.giphy.com/media/v1.rotated/oQdZu3Q2cGpUEJw6xo/200.gif?rotated=1";
  assert.equal(readInlineEmoji(changedUrl)?.key, post.emojis![0].key);
  assert.equal(readInlineEmoji({plaintext: "🙂"}), undefined);
});

test("CV2 replaces only extracted spans and preserves spoilers, quotes, attachments and byte limits", () => {
  const raw: any = example();
  raw.text_post_app_info.text_fragments.fragments = [
    {plaintext: "🙂 ||literal|| "}, sticker("spoiler", true), {plaintext: " <a:fake:123> "}, sticker(),
  ];
  raw.text_post_app_info.share_info = {quoted_post: {code: "Quote", user: {username: "quote"},
    text_post_app_info: {text_fragments: {fragments: [{plaintext: "引言 "}, sticker()]}}}};
  raw.text_post_app_info.snippet_attachment_info = {text_fragments: {fragments: [{plaintext: "附件 "}, sticker()]}};
  const post = content(raw);
  const replacements = Object.fromEntries(postEmojis(post).map(emoji => [emoji.key,
    {id: "1800000000000000001", name: `ft_${emoji.key}`, animated: true}]));
  post.discordEmojis = replacements;
  const formatted = discordTextFormatter(post.caption!, post.emojis, replacements)(4000);
  assert.ok(formatted.includes(`||<a:ft_${post.emojis![0].key}:1800000000000000001>||`));
  assert.ok(formatted.includes("\\|\\|literal\\|\\|"));
  assert.ok(formatted.includes("\\<a:fake:123\\>"));
  const payload = buildPostComponents(post);
  const allText = JSON.stringify(payload);
  assert.ok(allText.includes("引言 <a:ft_"));
  assert.ok(allText.includes("附件 <a:ft_"));
  assert.ok(!allText.includes("```"));
  assert.ok(Buffer.byteLength(componentJson(payload)) <= 3000);
  for (let limit = 1; limit < formatted.length; limit++) {
    const shortened = discordTextFormatter(post.caption!, post.emojis, replacements)(limit);
    assert.ok(shortened.length <= limit);
    assert.equal(shortened.replace(/<a:ft_[a-f0-9]{24}:\d+>/g, "").includes("<a:ft_"), false);
  }
  const legacy = renderSeo({type: "post", content: post, host: "l.fzthreads.com"});
  assert.doesNotMatch(legacy, /discord:component-embed|ft_[a-f0-9]{24}/);
});

test("normal requests return before upload, concurrent preloads share it, and warm requests reuse it", async t => {
  const {cache, mock} = await setup(t);
  const started = deferred();
  const release = deferred();
  mock.beforeCreate = async () => {started.resolve(); await release.promise;};
  const first = await cache.prepare([source(1), source(1)]);
  assert.deepEqual(first, {});
  await started.promise;
  let finished = false;
  const preload = cache.prepare([source(1)], true).then(value => {finished = true; return value;});
  const second = cache.prepare([source(1)], true);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(finished, false);
  assert.equal(mock.count("POST"), 1);
  release.resolve();
  const [result, duplicate] = await Promise.all([preload, second]);
  assert.deepEqual(result, duplicate);
  assert.equal(result[key(1)].animated, true);
  assert.deepEqual(await cache.prepare([source(1)]), result);
  assert.equal(mock.count("POST"), 1);
});

test("CV2 omits only missing emoji spans in captions, quotes and attachments", () => {
  const raw: any = example();
  raw.text_post_app_info.text_fragments.fragments = [
    {plaintext: "before "}, sticker("ready"), {plaintext: " between "}, sticker("pending", true), {plaintext: " after"},
  ];
  raw.text_post_app_info.share_info = {quoted_post: {code: "Quote", user: {username: "quote"},
    text_post_app_info: {text_fragments: {fragments: [{plaintext: "quoted "}, sticker("pending")]}}}};
  raw.text_post_app_info.snippet_attachment_info = {text_fragments: {fragments: [{plaintext: "attachment "}, sticker("pending")]}};
  const post = content(raw);
  post.discordEmojis = {[post.emojis![0].key]: {id: "1800000000000000001", name: "ready_emoji", animated: true}};
  const partial = JSON.stringify(buildPostComponents(post));
  assert.ok(partial.includes("before <a:ready_emoji:1800000000000000001> between  after"));
  assert.ok(partial.includes("quoted ") && partial.includes("attachment "));
  assert.ok(!partial.includes("□") && !partial.includes("||||"));
  const missing = JSON.stringify(buildPostComponents({...post, discordEmojis: {}}));
  assert.ok(missing.includes("before  between  after"));
  assert.ok(!missing.includes("□") && !missing.includes("||||"));
  assert.equal(discordTextFormatter("literal □ and 🙂")(100), "literal □ and 🙂");
  assert.ok(post.caption!.includes("□"), "Source text and legacy fallbacks are preserved");
});

test("partial hits return immediately and fully cached preloads do not wait for queued refreshes", async t => {
  let now = 1800000000000;
  const {cache, mock} = await setup(t, new DiscordMock(), {now: () => now});
  const ready = await cache.prepare([source(1)], true);
  const started = deferred();
  const release = deferred();
  mock.beforeCreate = async () => {started.resolve(); await release.promise;};
  const partial = await cache.prepare([source(1), source(2)]);
  assert.deepEqual(partial, ready);
  await started.promise;
  now += 5 * 60 * 1000 + 1;
  let finished = false;
  const full = cache.prepare([source(1)], true).then(value => {finished = true; return value;});
  try {
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(finished, true, "Full hits must not wait for uploads or stale-cache revalidation");
    assert.deepEqual(await full, ready);
  } finally {
    release.resolve();
    await full;
    await cache.prepare([source(1), source(2)], true);
  }
  assert.equal(mock.count("POST"), 2);
});

test("disk cache survives restart, reconciles deleted IDs, and recovers uploads after a corrupt cache", async t => {
  const {cache, create, mock, cacheFile} = await setup(t);
  const first = await cache.prepare([source(1)], true);
  await cache.flush();
  const disk = await fs.readFile(cacheFile, "utf8");
  assert.ok(!disk.includes("test-bot-token") && !disk.includes("giphy.com"));
  assert.deepEqual(await create().prepare([source(1)], true), first);
  assert.equal(mock.count("POST"), 1);
  await fs.writeFile(cacheFile, "invalid json");
  assert.deepEqual(await create().prepare([source(1)], true), first);
  assert.equal(mock.count("POST"), 1);
  mock.emojis = [];
  const replacement = await create().prepare([source(1)], true);
  assert.notEqual(replacement[key(1)].id, first[key(1)].id);
  assert.equal(mock.count("POST"), 2);
});

test("capacity evicts 50 least-used managed emojis, retains other emojis and pins the current post", async t => {
  let now = 1800000000000;
  const {cache, mock} = await setup(t, new DiscordMock(), {limit: 53, now: () => now});
  mock.emojis = [{id: "10", name: "keep_me", animated: false}];
  for (let i = 1; i <= 52; i++) {
    now++;
    await cache.prepare([source(i)], true);
  }
  now++;
  await cache.prepare([source(1)], true); // Recently used: retain despite being created first.
  now++;
  const result = await cache.prepare([source(2), source(53)], true); // Pin another old emoji.
  assert.equal(mock.count("DELETE"), 50);
  assert.ok(mock.emojis.some(emoji => emoji.name === "keep_me"));
  assert.ok(mock.emojis.some(emoji => emoji.name === `ft_${key(1)}`));
  assert.ok(result[key(2)] && result[key(53)]);
  assert.equal(mock.emojis.length, 4);
});

test("failed deletions preserve IDs and prevent an upload into a full application", async t => {
  const {cache, mock, cacheFile} = await setup(t, new DiscordMock(), {limit: 2, cleanupBatchSize: 2});
  await cache.prepare([source(1)], true);
  await cache.prepare([source(2)], true);
  let deletes = 0;
  mock.override = (_url, options) => options.method === "DELETE" && ++deletes === 2 ? json({}, 500) : undefined;
  await assert.rejects(cache.prepare([source(3)], true), /HTTP 500/);
  assert.equal(mock.count("POST"), 2);
  assert.equal(mock.emojis.length, 1);
  const saved = JSON.parse(await fs.readFile(cacheFile, "utf8"));
  assert.equal(saved.entries.length, 1);
  assert.equal(saved.entries[0].id, mock.emojis[0].id);
});

test("a request arriving during deletion waits for a new ID instead of returning the deleting ID", async t => {
  let now = 1800000000000;
  const {cache, mock} = await setup(t, new DiscordMock(), {limit: 2, cleanupBatchSize: 1, now: () => now++});
  const original = await cache.prepare([source(1)], true);
  await cache.prepare([source(2)], true);
  const deleting = deferred();
  const release = deferred();
  mock.beforeDelete = async () => {deleting.resolve(); await release.promise;};
  const eviction = cache.prepare([source(3)], true);
  await deleting.promise;
  assert.deepEqual(await cache.prepare([source(1)]), {});
  let done = false;
  const preload = cache.prepare([source(1)], true).then(value => {done = true; return value;});
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(done, false);
  release.resolve();
  const [, replacement] = await Promise.all([eviction, preload]);
  assert.notEqual(replacement[key(1)].id, original[key(1)].id);
  assert.ok(mock.emojis.some(emoji => emoji.id === replacement[key(1)].id));
});

test("rate limits respect retry_after without creating duplicates", async t => {
  let now = 1800000000000;
  const waits: number[] = [];
  const {cache, mock} = await setup(t, new DiscordMock(), {
    now: () => now, sleep: async (ms: number) => {waits.push(ms); now += ms;},
  });
  let calls = 0;
  mock.override = (_url, options) => options.method === "POST" && calls++ === 0
    ? json({retry_after: 1.25}, 429) : undefined;
  const result = await cache.prepare([source(1)], true);
  assert.ok(result[key(1)]);
  assert.deepEqual(waits, [1250]);
  assert.equal(mock.emojis.length, 1);
});

test("successful responses also defer the next API call when their rate-limit bucket is exhausted", async t => {
  let now = 1800000000000;
  const waits: number[] = [];
  const {cache, mock} = await setup(t, new DiscordMock(), {
    now: () => now, sleep: async (ms: number) => {waits.push(ms); now += ms;},
  });
  mock.override = (url, options) => url.endsWith("/emojis") && options.method === "GET"
    ? json({items: []}, 200, {"x-ratelimit-remaining": "0", "x-ratelimit-reset-after": "0.5"}) : undefined;
  await cache.prepare([source(1)], true);
  assert.deepEqual(waits, [500]);
});

test("reconciliation recovers a POST that succeeded remotely before a connection error", async t => {
  let now = 1800000000000;
  const {cache, mock} = await setup(t, new DiscordMock(), {now: () => now});
  mock.override = (_url, options) => {
    if (options.method === "POST") {
      mock.emojis.push({id: "123", name: `ft_${key(1)}`, animated: true});
      throw new Error("connection closed");
    }
    return undefined;
  };
  await assert.rejects(cache.prepare([source(1)], true), /Unable to reach Discord/);
  mock.override = undefined;
  now += 30001;
  assert.equal((await cache.prepare([source(1)], true))[key(1)].id, "123");
  assert.equal(mock.count("POST"), 1);
});

test("ordinary previews tolerate disabled/failed uploads and preloads report an error", async t => {
  const {cache, mock, create} = await setup(t);
  const disabled = create({token: ""});
  assert.deepEqual(await disabled.prepare([source(1)]), {});
  await assert.rejects(disabled.prepare([source(1)], true), /DISCORD_BOT_TOKEN/);
  assert.deepEqual(await disabled.prepare([], true), {});
  mock.override = () => json({message: "sensitive upstream error"}, 401);
  assert.deepEqual(await cache.prepare([source(1)]), {});
  await assert.rejects(cache.prepare([source(1)], true), error =>
    error instanceof DiscordEmojiError && !error.message.includes("sensitive"));
  assert.deepEqual(await cache.prepare([source(1)]), {});
  assert.equal(mock.calls.length, 1);
});

test("failed uploads retry after cooldown and do not poison the queue", async t => {
  let now = 1800000000000;
  const {cache, mock} = await setup(t, new DiscordMock(), {now: () => now});
  mock.override = (_url, options) => options.method === "POST" ? json({}, 500) : undefined;
  await assert.rejects(cache.prepare([source(1)], true), /HTTP 500/);
  mock.override = undefined;
  await assert.rejects(cache.prepare([source(1)], true), /retry shortly/);
  assert.ok((await cache.prepare([source(2)], true))[key(2)]);
  now += 30001;
  assert.ok((await cache.prepare([source(1)], true))[key(1)]);
});

test("emoji downloads reject unsafe sources/redirects and oversize bodies", async () => {
  for (const url of ["http://media1.giphy.com/a.gif", "https://giphy.com.evil.test/a", "https://127.0.0.1/a",
    "https://user:pass@media1.giphy.com/a", "https://media1.giphy.com:123/a", "file:///image.gif"]) {
    assert.equal(emojiImageUrl(url), undefined);
  }
  let calls = 0;
  await assert.rejects(downloadEmojiImage(url, async () => {
    calls++;
    return new Response(null, {status: 302, headers: {location: "https://127.0.0.1/private"}});
  }), /Unsupported emoji image host/);
  assert.equal(calls, 1);
  await assert.rejects(downloadEmojiImage(url, async () =>
    new Response("large", {headers: {"content-length": String(6 * 1024 * 1024)}})), /too large/);
});

test("image conversion bounds file size/dimensions and retains multiple animated frames", async () => {
  const pixels = Buffer.alloc(256 * 512 * 4, 0);
  for (let i = 0; i < pixels.length; i += 4) {
    pixels[i + (i < pixels.length / 2 ? 0 : 1)] = 255;
    pixels[i + 3] = 255;
  }
  const gif = await sharp(pixels, {raw: {width: 256, height: 512, channels: 4, pageHeight: 256}})
    .gif({delay: [100, 100]}).toBuffer();
  const encoded = await encodeEmojiImage(gif);
  assert.ok(encoded.startsWith("data:image/gif;base64,"));
  const image = Buffer.from(encoded.split(",")[1], "base64");
  assert.ok(image.length <= MAX_EMOJI_BYTES);
  const metadata = await sharp(image, {animated: true}).metadata();
  assert.equal(metadata.pages, 2);
  assert.equal(metadata.width, 128);
  assert.equal(metadata.pageHeight, 128);
  assert.equal(await encodeEmojiImage(image), encoded);
  const png = await sharp({create: {width: 300, height: 200, channels: 4, background: "red"}}).png().toBuffer();
  assert.ok((await encodeEmojiImage(png)).startsWith("data:image/png;base64,"));
  await assert.rejects(encodeEmojiImage(Buffer.from('<svg width="1" height="1"></svg>')));
});

test("all post/share preload routes wait for uploads and return ready CV2 HTML", async t => {
  const {cache, mock} = await setup(t);
  const started = deferred();
  const release = deferred();
  mock.beforeCreate = async () => {started.resolve(); await release.promise;};
  const post = content();
  const app = express();
  app.use(createPostsRouter({findPost: async () => post, resolveShare: async () => code,
    prepareEmojis: async (post, preload) => ({...post, discordEmojis: await cache.prepare(postEmojis(post), preload)})}));
  app.use((error: HttpError, _req: express.Request, res: express.Response, _next: express.NextFunction) =>
    res.status(error.statusCode).json({message: error.errMessage}));
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  for (const endpoint of [`/t/${code}`, `/@power3067830678/post/${code}`, "/share/example"]) {
    const response = await fetch(origin + endpoint, {signal: AbortSignal.timeout(2000)});
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.doesNotMatch(await response.text(), /ft_[a-f0-9]{24}/);
  }
  await started.promise;
  let done = 0;
  const requests = [`/t/${code}/preload`, `/@power3067830678/post/${code}/preload`, "/share/example/preload/"].map(async endpoint => {
    const response = await fetch(origin + endpoint);
    done++;
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type")!, /text\/html/);
    assert.match(await response.text(), /ft_[a-f0-9]{24}/);
  });
  await new Promise(resolve => setTimeout(resolve, 25));
  assert.equal(done, 0);
  release.resolve();
  await Promise.all(requests);
  assert.equal(mock.count("POST"), 1);
  assert.equal(post.discordEmojis, undefined, "The shared post cache must not retain evictable Discord IDs");
});

test("preload HTTP errors are explicit and normal routes still serve fallback previews", async t => {
  const {cache} = await setup(t, new DiscordMock(), {token: ""});
  const post = content();
  const app = express();
  app.use(createPostsRouter({findPost: async () => post, resolveShare: async share => share === "bad" ? undefined : code,
    prepareEmojis: async (post, preload) => ({...post, discordEmojis: await cache.prepare(postEmojis(post), preload)})}));
  app.use((error: HttpError, _req: express.Request, res: express.Response, _next: express.NextFunction) =>
    res.status(error.statusCode).json({message: error.errMessage}));
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  for (const endpoint of [`/t/${code}/preload`, "/share/example/preload"]) {
    const response = await fetch(origin + endpoint);
    assert.equal(response.status, 503);
    assert.match(await response.text(), /DISCORD_BOT_TOKEN/);
  }
  assert.equal((await fetch(origin + "/share/bad/preload")).status, 502);
  assert.equal((await fetch(origin + `/t/${code}`)).status, 200);
});
