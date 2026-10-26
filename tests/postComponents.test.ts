/// <reference path="../src/types/application.d.ts" />
import assert from "node:assert/strict";
import {once} from "node:events";
import {AddressInfo} from "node:net";
import {test} from "node:test";
import express from "express";
import fetch from "node-fetch";
import {sendPostResponse} from "../src/controllers/posts";
import {buildContentFromResponse, enrichPostPoll} from "../src/utils/fetch/findPost";
import {
  ComponentEmbed,
  componentJson,
  formatDiscordText,
} from "../src/utils/discordComponents";
import renderPostComponents, {buildPostComponents} from "../src/utils/renderPostComponents";
import renderSeo from "../src/utils/renderSeo";
import renderActivity from "../src/utils/renderActivity";

const code = "Example123";
function rawPost() {
  return {
    code,
    user: {username: "nicko948787", full_name: "Nicko", is_verified: true,
      profile_pic_url: "https://example.com/avatar.png"},
    taken_at: 1789749600,
    like_count: 23,
    image_versions2: {candidates: [{url: "https://example.com/photo.jpg"}]},
    text_post_app_info: {
      direct_reply_count: 12, repost_count: 2, reshare_count: 18,
      tag_header: {display_name: "TestTAG"},
      reply_to_author: {username: "nicko948787"},
      text_fragments: {fragments: [
        {plaintext: "貼去dc騙你朋友\n"},
        {plaintext: "spoiler test", styling_info: {is_spoiler: true}},
      ]},
      snippet_attachment_info: {text_fragments: {fragments: [{plaintext: "文字內容..."}]}},
      share_info: {quoted_post: {code: "Quoted123", user: {username: "quoted_user"},
        caption: {text: "引用內容\n第二行"}}},
    },
  };
}

function content(raw: unknown = rawPost(), parents: unknown[] = []): ContentProps {
  const result = buildContentFromResponse({data: {data: {edges: [{node: {
    thread_items: [...parents, raw].map(post => ({post})),
  }}]}}}, code, "123456789");
  assert.ok(result);
  return {...result, userAgent: "Discordbot/2.0"};
}

function textOf(value: ComponentEmbed): string {
  return value.component.components.flatMap(c =>
    c.type === 10 ? [c.content] : c.type === 9 ? c.components.map(t => t.content) : []
  ).join("\n");
}

function gallery(value: ComponentEmbed) {
  return value.component.components.flatMap(c => c.type === 12 ? c.items : []);
}

function assertValid(value: ComponentEmbed) {
  const json = componentJson(value);
  assert.ok(Buffer.byteLength(json, "utf8") <= 3000);
  assert.deepEqual(JSON.parse(json), value);
  assert.ok(gallery(value).length <= 10);
  assert.ok(textOf(value).length <= 4000);
  for (const c of value.component.components) {
    if (c.type === 10) assert.ok(c.content);
    if (c.type === 9) assert.ok(c.components.length >= 1 && c.components.length <= 3);
    if (c.type === 12) assert.ok(c.items.length);
  }
}

test("post card matches the example's layout, metadata, reply, quote, attachment and timestamp", () => {
  const post = content();
  const value = buildPostComponents(post);
  assertValid(value);
  assert.equal(value.component.accent_color, 0);
  assert.deepEqual(value.component.components.map(c => c.type), [9, 14, 10, 12, 10]);
  const section = value.component.components[0];
  assert.equal(section.type, 9);
  if (section.type !== 9) return;
  assert.equal(section.accessory.media.url, "https://example.com/avatar.png");
  assert.equal(section.components[0].content,
    "**[Nicko](https://www.threads.com/@nicko948787)** <:verified:1557576231770128496>\n" +
    "[nicko948787](https://www.threads.com/@nicko948787) > [TestTAG](https://www.threads.com/search?q=TestTAG)\n\n" +
    "**❤️ 23 💬 12 🔄 2 ✈️ 18**");
  assert.equal(section.components[1].content,
    "⤴️ 正在回覆 [nicko948787](https://www.threads.com/@nicko948787)\n\n" +
    "> 引用 [@quoted_user](https://www.threads.com/@quoted_user/post/Quoted123)\n> 引用內容\n> 第二行\n\n" +
    "貼去dc騙你朋友\n||spoiler test||");
  assert.deepEqual(value.component.components[2], {type: 10, content: "```\n文字內容...\n```"});
  assert.deepEqual(value.component.components.at(-1), {type: 10,
    content: "-# <:fzthreads:1563516195968258058> FzThreads | <t:1789749600:f>"});
  assert.equal(post.caption, "貼去dc騙你朋友\n||spoiler test||");
  assert.match(post.description, /^⤴️ 正在回覆 @nicko948787/);
  // The old renderer still masks spoilers on the legacy surface.
  assert.ok(renderActivity(post).sensitive);
  assert.ok(!renderActivity(post).content.includes("spoiler test"));
});

test("native spoiler fragments, literal pipes and current mention/link fields survive extraction", () => {
  const raw = rawPost();
  Object.assign(raw.text_post_app_info, {text_fragments: {fragments: [
    {plaintext: "literal ||pipes|| "},
    {mention_fragment: {mentioned_user: {username: "hello.world"}}},
    {plaintext: "\n"},
    {link_fragment: {uri: "https://example.com/path?q=yes&x=2"}},
    {plaintext: " secret ||literal|| \\ ending", styling_info: {is_spoiler: true}},
  ]}});
  const post = content(raw);
  const body = textOf(buildPostComponents(post));
  assert.ok(body.includes("literal \\|\\|pipes\\|\\| "));
  assert.ok(body.includes("[@hello.world](https://www.threads.com/@hello.world)"));
  assert.ok(body.includes("<https://example.com/path?q=yes&x=2>"));
  assert.ok(body.includes("|| secret \\|\\|literal\\|\\| \\\\ ending||"));
  const captionOnly = {...raw, caption: {text: "plain ||literal||"}, text_post_app_info: {}};
  assert.equal(content(captionOnly).caption, "plain \\|\\|literal\\|\\|");
  assert.equal(renderActivity(content(captionOnly)).sensitive, false);
});

test("reply_to_author wins over the previous item; older responses use the previous author", () => {
  const parent = {...rawPost(), code: "Parent", user: {username: "parent"}};
  const raw = rawPost();
  assert.equal(content(raw, [parent]).replyToUsername, "nicko948787");
  Object.assign(raw.text_post_app_info, {reply_to_author: null});
  assert.equal(content(raw, [parent]).replyToUsername, "parent");
  assert.equal(content(raw).replyToUsername, undefined);
});

test("mixed media keeps carousel order, plays videos, and carries item and post spoiler flags", () => {
  const image = (name: string, spoiler = false) => ({
    image_versions2: {candidates: [{url: `https://example.com/${name}.jpg`}]},
    text_post_app_info: {is_spoiler_media: spoiler}, accessibility_caption: name,
  });
  const raw = {...rawPost(), carousel_media: [
    image("first"),
    {...image("video-cover", true), video_versions: [{url: "https://example.com/second.mp4", width: 640, height: 480}]},
    image("third", true),
  ]};
  const post = content(raw);
  const media = gallery(buildPostComponents(post));
  assert.deepEqual(media.map(item => item.media.url), [
    "https://example.com/first.jpg", "https://example.com/second.mp4", "https://example.com/third.jpg",
  ]);
  assert.deepEqual(media.map(item => item.spoiler), [undefined, true, true]);
  assert.equal(media[2].description, "third");
  assert.equal(post.video[0].width, 640);
  Object.assign(raw.text_post_app_info, {is_spoiler_media: true});
  assert.ok(gallery(buildPostComponents(content(raw))).every(item => item.spoiler === true));
  const video = {...rawPost(), video_versions: [{url: "https://example.com/single.mp4"}]};
  assert.deepEqual(gallery(buildPostComponents(content(video))).map(item => item.media.url), ["https://example.com/single.mp4"]);
});

test("text-only and incomplete posts do not turn avatar fallbacks into media or empty sections", () => {
  const raw = {code, user: {username: "plain", profile_pic_url: "https://example.com/avatar.png"},
    caption: {text: "text only"}};
  const value = buildPostComponents(content(raw));
  assertValid(value);
  assert.equal(gallery(value).length, 0);
  assert.doesNotMatch(textOf(value), /verified:|正在回覆|引用|<t:/);
  const empty = buildPostComponents(content({code, user: {username: "plain"}}));
  assertValid(empty);
  assert.deepEqual(empty.component.components.map(c => c.type), [10, 10]);
  assert.equal(gallery(empty).length, 0);
});

test("polls and quoted polls retain options, totals, percentages and unavailable-results fallback", () => {
  const post = content();
  post.poll = {expired: true, votesCount: 3, options: [{title: "支持", votesCount: 2}, {title: "反對", votesCount: 1}]};
  post.quotedPost!.poll = {options: [{title: "引用選項", votesCount: 1}], votesCount: 1};
  const value = buildPostComponents(post);
  assertValid(value);
  const text = textOf(value);
  assert.ok(text.includes("支持 — 67%（2 票）"));
  assert.ok(text.includes("共 3 票"));
  assert.ok(text.includes("投票（已結束）"));
  assert.ok(text.includes("> ◯ 引用選項 — 100%（1 票）"));
  post.poll = {options: [], expired: true};
  assert.ok(textOf(buildPostComponents(post)).includes("選項與票數暫時無法取得"));
});

test("DeP23AyE-3V poll results reach CV2 and legacy previews after authenticated enrichment", async () => {
  // Public poll results observed on the user's example; no session data is stored.
  const postCode = "DeP23AyE-3V";
  const response = (tallies: {text: string; count: number}[] | null) => ({
    data: {data: {edges: [{node: {thread_items: [{post: {
      code: postCode,
      user: {username: "power3067830678", full_name: "陳之漢", is_verified: true,
        profile_pic_url: "https://example.com/avatar.jpg"},
      caption: {text: "不負責民調 □看看?\n2026台北市長你愛誰"},
      text_post_app_info: {repost_count: 15, direct_reply_count: 949, reshare_count: 94},
      like_count: 1819,
      taken_at: 1791493470,
      caption_add_on: {poll: {
        poll_id: "17934930039395754", expires_at: null, finished: true, tallies,
      }},
    }}]}}]}},
  });
  let authenticatedCalls = 0;
  const upstream = await enrichPostPoll(response(null), postCode, async () => {
    authenticatedCalls++;
    return response([{text: "將萬安", count: 18203}, {text: "沈柏洋", count: 14025}]);
  });
  assert.equal(authenticatedCalls, 1);
  const parsed = buildContentFromResponse(upstream, postCode, "4003659868678647253");
  assert.ok(parsed);
  const post = {...parsed, userAgent: "Discordbot/2.0"};
  assert.equal(post.poll?.votesCount, 32228);
  const html = renderSeo({type: "post", content: post, host: "fzthreads.com"});
  const json = html.match(/<script id="discord:component-embed" type="application\/json">(.*?)<\/script>/s)![1];
  const value = JSON.parse(json) as ComponentEmbed;
  assertValid(value);
  const legacy = renderSeo({type: "post", content: post, host: "l.fzthreads.com"});
  assert.doesNotMatch(legacy, /discord:component-embed/);
  for (const output of [textOf(value), legacy, renderActivity(post).text]) {
    for (const expected of ["投票（已結束）", "將萬安 — 56%（18,203 票）",
      "沈柏洋 — 44%（14,025 票）", "共 32,228 票"]) {
      assert.ok(output.includes(expected), `Missing poll result: ${expected}`);
    }
    assert.ok(!output.includes("選項與票數暫時無法取得"));
  }
});

test("author badges stay ordered and require explicit status flags, as do media spoilers", () => {
  for (const [isVerified, isFederated, expected] of [
    [true, true, " <:verified:1557576231770128496> <:fediverse:1564218539814944908>"],
    [false, true, " <:fediverse:1564218539814944908>"],
    [true, false, " <:verified:1557576231770128496>"],
    [false, false, ""],
  ] as const) {
    const raw = rawPost();
    Object.assign(raw.user, {is_verified: isVerified, text_post_app_has_fediverse_enabled: isFederated});
    const value = buildPostComponents(content(raw));
    assert.equal(textOf(value).split("\n")[0], `**[Nicko](https://www.threads.com/@nicko948787)**${expected}`);
    assertValid(value);
  }
  for (const flag of [false, null, undefined, "true", "false", 1]) {
    const raw = rawPost();
    Object.assign(raw.user, {is_verified: flag, text_post_app_has_fediverse_enabled: flag});
    Object.assign(raw.text_post_app_info, {is_spoiler_media: flag, tag_header: {display_name: "台灣 & A/B"}});
    const value = buildPostComponents(content(raw));
    assert.doesNotMatch(textOf(value), /verified:|fediverse:/);
    assert.ok(gallery(value).every(item => item.spoiler !== true));
    assert.ok(textOf(value).includes("https://www.threads.com/search?q=%E5%8F%B0%E7%81%A3%20%26%20A%2FB"));
  }
});

test("text shortening keeps escaped characters, mentions, Unicode and spoiler boundaries intact", () => {
  const source = "😀 ||劇透 @hello.world \\ ** || 後文";
  for (let limit = 1; limit < 110; limit++) {
    const text = formatDiscordText(source, limit);
    assert.ok(text.length <= limit);
    assert.ok(text.isWellFormed());
    assert.equal((text.match(/(?<!\\)\|\|/g) || []).length % 2, 0);
    if (text.includes("[@")) assert.ok(text.includes("](https://www.threads.com/@hello.world)"));
    assert.doesNotMatch(text, /(?<!\\)(?:\\\\)*\\$/);
  }
  const mentions = formatDiscordText("@test_user. me@example.com https://example.com/@path @name@server.tld");
  assert.ok(mentions.includes("[@test_user](https://www.threads.com/@test_user)\\."));
  assert.doesNotMatch(mentions, /threads\.com\/@(?:example|path|name|server)/);
});

test("escaped JSON stays below 3000 UTF-8 bytes for long text, spoilers, attachments and signed media URLs", () => {
  const post = content();
  post.caption = "正文 😀 ||暴雷 </script> & @someone||\n".repeat(300);
  post.textAttachment = "附件內容 😀 \\\" & </script>\n".repeat(500);
  post.images = Array.from({length: 20}, (_, i) => ({
    url: `https://example.com/${i}.jpg?signature=${"x".repeat(400)}&a=1&b=2`, position: i, spoiler: true,
  }));
  const value = buildPostComponents(post);
  assertValid(value);
  const json = renderPostComponents(post).match(/<script[^>]*>(.*?)<\/script>/s)![1];
  assert.ok(Buffer.byteLength(json, "utf8") <= 3000);
  assert.doesNotMatch(json, /[<>&]/);
  assert.ok(textOf(value).includes("…"));
  assert.ok(textOf(value).includes("||"));
  assert.ok(textOf(value).isWellFormed());
  assert.ok(gallery(value).length >= 1);
  assert.ok(gallery(value).every(item => item.spoiler === true));
  const plain = {...post, caption: "caption", textAttachment: undefined, quotedPost: undefined,
    images: Array.from({length: 20}, (_, i) => ({url: `https://example.com/${i}.jpg`}))};
  assert.equal(gallery(buildPostComponents(plain)).length, 10);
});

test("unsafe media is dropped; code fences and script text cannot escape their context", () => {
  const post = content();
  post.authorIcon = "javascript:bad";
  post.images = ["javascript:bad", "file:///private", "https://user:pass@example.com/image.png",
    `https://example.com/${"x".repeat(2048)}`, "https://example.com/good.jpg"]
    .map(url => ({url}));
  post.textAttachment = '`````\n</script><script>alert("&")</script>\n||literal||';
  // Native literal markers have already been escaped by the extractor.
  post.textAttachment = post.textAttachment.replace(/\|\|/g, "\\|\\|");
  const value = buildPostComponents(post);
  assertValid(value);
  assert.deepEqual(gallery(value).map(item => item.media.url), ["https://example.com/good.jpg"]);
  const attachment = value.component.components.filter(c => c.type === 10).find(c => c.content.startsWith("```"));
  assert.ok(attachment && attachment.type === 10);
  assert.equal(attachment.content.match(/```/g)?.length, 2);
  const script = renderPostComponents(post);
  assert.equal(script.match(/<script\b/g)?.length, 1);
  assert.equal(script.match(/<\/script>/g)?.length, 1);
  post.textAttachment = "public ||hidden||";
  const spoilerText = textOf(buildPostComponents(post));
  assert.ok(spoilerText.includes("public ||hidden||"));
  assert.ok(!spoilerText.includes("```"));
});

test("HTTP host selection serves CV2 normally and advertises/negotiates Mastodon only on legacy", async t => {
  const app = express();
  const post = content();
  app.get("/post", (req, res) => sendPostResponse(req, res, post));
  app.get("/profile", (req, res) => res.send(renderSeo({
    type: "user", content: {...post, profile: {displayName: "Nicko"}}, host: req.get("host"),
  })));
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  for (const host of ["fzthreads.com", "example.com", "l.fzthreads.com.example.com", "localhost:20061"]) {
    for (const path of ["/post", "/post?format=activity", "/profile"]) {
      const response = await fetch(origin + path, {headers: {
        Host: host, Accept: "application/activity+json", "X-Forwarded-Host": "l.fzthreads.com",
      }});
      const html = await response.text();
      assert.match(response.headers.get("content-type")!, /text\/html/);
      assert.match(html, /discord:component-embed/);
      assert.doesNotMatch(html, /type="application\/activity\+json"/);
      assert.match(html, /property="og:description"/);
      assert.match(html, /application\/json\+oembed/);
    }
  }
  for (const host of ["l.fzthreads.com", "L.FZTHREADS.COM", "l.fzthreads.com:20061"]) {
    const html = await (await fetch(origin + "/post", {headers: {Host: host}})).text();
    assert.doesNotMatch(html, /discord:component-embed/);
    assert.match(html, /type="application\/activity\+json"/);
    const profile = await (await fetch(origin + "/profile", {headers: {Host: host}})).text();
    assert.doesNotMatch(profile, /discord:component-embed/);
    for (const accept of ["application/activity+json", 'application/ld+json; profile="https://www.w3.org/ns/activitystreams"']) {
      const response = await fetch(origin + "/post", {headers: {Host: host, Accept: accept}});
      assert.match(response.headers.get("content-type")!, /application\/activity\+json/);
      const activity = await response.json() as {account: {username: string}};
      assert.equal(activity.account.username, post.username);
    }
    const explicit = await fetch(origin + "/post?format=activity", {headers: {Host: host}});
    assert.match(explicit.headers.get("content-type")!, /application\/activity\+json/);
    await explicit.text();
  }
});
