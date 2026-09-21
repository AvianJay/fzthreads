/// <reference path="../src/types/application.d.ts" />
import assert from "node:assert/strict";
import {test} from "node:test";
import fetch, {Headers, Response, RequestInit} from "node-fetch";
import {createUserFinder, profileCredentialHeaders} from "../src/utils/fetch/findUser";
import {
  hasCompleteProfile,
  profileContent,
  RawProfile,
  readProfilePage,
  readProfileResponse,
} from "../src/utils/fetch/profileData";
import {buildProfileComponents} from "../src/utils/renderProfileComponents";
import renderSeo from "../src/utils/renderSeo";

const username = "nicko948787";
const direct = "BarcelonaProfilePageDirectQuery";
const fallback = "BarcelonaProfilePageFallbackQuery";
const user: RawProfile = {
  username, pk: "78570161804", full_name: "尼摳",
  biography: "尼摳會來摳你\n真的還是假的？\nmain: @av1anjay",
  follower_count: 35,
  show_text_post_app_badge: true,
  is_verified: false,
  text_post_app_is_private: false,
  text_post_app_has_fediverse_enabled: null,
  text_post_app_public_views: null,
  profile_pic_url: "https://example.com/avatar-150.jpg",
  hd_profile_pic_versions: [
    {width: 320, url: "https://example.com/avatar-320.jpg"},
    {width: 640, url: "https://example.com/avatar-640.jpg"},
  ],
  bio_links: [
    {url: "https://dc.avianjay.sbs", title: "角蛙社群"},
    {url: "https://yee.avianjay.sbs", title: "非常牛逼的機器人（應該吧）"},
    {url: "https://discord.gg/earthonlinetw", title: ""},
  ],
};

function jsonScript(value: unknown): string {
  return `<script type="application/json">${JSON.stringify(value).replace(/</g, "\\u003c")}</script>`;
}

function preloaded(value: RawProfile, name = direct): string {
  return jsonScript({require: [["ScheduledServerJS", "handle", null, [{__bbox: {
    require: [["RelayPrefetchedStreamCache", "next", [], [
      `adp_${name}RelayPreloader_test`, {__bbox: {result: {data: {user: value}}}},
    ]]],
  }}]]]});
}

const context = jsonScript({define: [["LSD", [], {token: "test-page-context"}, 1]]});
function descriptor(name = direct) {
  return jsonScript({expectedPreloaders: [{
    queryName: name, queryID: "123456789", variables: {
      ...(name === direct ? {userID: user.pk} : {username}),
      __relay_internal__pv__BarcelonaIsLoggedInrelayprovider: false,
      __relay_internal__pv__BarcelonaShouldShowFediverseM1Featuresrelayprovider: false,
      ...(name === direct ? {__relay_internal__pv__BarcelonaIsLoggedOutrelayprovider: true} : {}),
      testProvider: true,
    },
  }]});
}

function payload(value: RawProfile = user) {
  return buildProfileComponents(profileContent(value, "Discordbot/2.0"))!;
}

function textOf(value: ReturnType<typeof payload>): string {
  return value.component.components.flatMap(component => {
    if (component.type === 10) return [component.content];
    if (component.type === 9) return component.components.map(text => text.content);
    return [];
  }).join("\n");
}

test("profile layout uses invisible spacing, ordered Markdown links, HD avatar and footer", () => {
  const value = payload();
  assert.equal(value.component.accent_color, null);
  assert.deepEqual(value.component.components.map(c => c.type), [9, 14, 10, 14, 10]);
  assert.ok(value.component.components.filter(c => c.type === 14).every(c => c.divider === false && c.spacing === 1));
  const section = value.component.components[0];
  assert.equal(section.type, 9);
  if (section.type !== 9) return;
  assert.equal(section.components[0].content, "### [尼摳](https://www.threads.com/@nicko948787)\nnicko948787");
  assert.equal(section.components[1].content, "尼摳會來摳你\n真的還是假的？\nmain: [@av1anjay](https://www.threads.com/@av1anjay)\n\n**👤 35 🔗 3**");
  assert.equal(section.accessory.media.url, "https://example.com/avatar-640.jpg");
  assert.deepEqual(value.component.components[2], {type: 10, content: [
    "[角蛙社群](https://dc.avianjay.sbs/)",
    "[非常牛逼的機器人（應該吧）](https://yee.avianjay.sbs/)",
    "[連結](https://discord.gg/earthonlinetw)",
    "[Instagram](https://www.instagram.com/nicko948787/)",
  ].join(" · ")});
  assert.deepEqual(value.component.components.at(-1), {type: 10, content: "-# FzThreads"});
});

test("unknown counts are omitted; zero is preserved; views use K/M with one decimal", () => {
  const unknown = textOf(payload({...user, follower_count: null, bio_links: null}));
  assert.doesNotMatch(unknown, /👤|👀|🔗/);
  for (const [count, label] of [[0, "0"], [999, "999"], [1234, "1.2K"], [150000, "150K"], [999999, "1M"], [1234567, "1.2M"]] as const) {
    const text = textOf(payload({...user, follower_count: 0, bio_links: [],
      text_post_app_public_views: {text_post_app_public_view_count: count}}));
    assert.ok(text.includes(`👤 0 👀 ${label} 🔗 0`));
  }
  for (const count of [-1, Infinity, NaN, "", "1K"]) {
    assert.doesNotMatch(textOf(payload({...user, follower_count: count})), /👤/);
  }
});

test("missing avatar uses text components; missing biography/links leave no empty sections", () => {
  const value = payload({...user, biography: "", bio_links: [],
    profile_pic_url: "javascript:bad", hd_profile_pic_versions: [], show_text_post_app_badge: false});
  assert.deepEqual(value.component.components.map(c => c.type), [10, 10, 14, 10]);
  assert.doesNotMatch(textOf(value), /\n\n/);
  const minimal = payload({username});
  assert.deepEqual(minimal.component.components.map(c => c.type), [10, 14, 10]);
});

test("invalid links are filtered and Markdown links share the text budget with the biography", () => {
  const links = [
    {title: "bad", url: "javascript:alert(1)"},
    {title: "relative", url: "/relative"},
    {title: "credentials", url: "https://user:pass@example.com"},
    {title: "long", url: `https://example.com/${"x".repeat(600)}`},
    ...Array.from({length: 7}, (_, i) => ({title: "😀".repeat(100), url: `https://example.com/${i}/${"x".repeat(400)}`})),
  ];
  const value = payload({...user, bio_links: links, full_name: "*".repeat(1000), biography: "[x] </script> 😀\n".repeat(1000)});
  const linkText = value.component.components[2];
  assert.equal(linkText.type, 10);
  if (linkText.type !== 10) return;
  const matches = [...linkText.content.matchAll(/\[([^\]]+)\]\(([^)]+)\)/g)];
  assert.equal(matches.length, 6);
  assert.ok(matches.every(match => match[1].length <= 80 && !/[\uD800-\uDBFF]$/.test(match[1])));
  assert.doesNotMatch(linkText.content, /javascript:|relative|user:pass/);
  const textLength = value.component.components.reduce((sum, c) => sum +
    (c.type === 10 ? c.content.length : c.type === 9 ? c.components.reduce((n, t) => n + t.content.length, 0) : 0), 0);
  assert.ok(textLength <= 4000);
  assert.ok(textOf(value).includes("🔗 7"));
});

test("inline JSON and Markdown remain safe, with OG/oEmbed preserved and posts unchanged", () => {
  const content = profileContent({...user, full_name: "[Name](https://bad.test) *name*",
    biography: '</script><script>alert("&")</script>\n@everyone',
    bio_links: [{title: '[x](bad)\n</script><script>', url: "https://example.com/path(test)?a=1&b=2"}],
  }, "Discordbot/2.0");
  const html = renderSeo({type: "user", content});
  assert.equal([...html.matchAll(/<script\b/g)].length, 1);
  const json = html.match(/<script id="discord:component-embed" type="application\/json">(.*?)<\/script>/s)![1];
  assert.doesNotMatch(json, /[<>&]/);
  assert.ok(textOf(JSON.parse(json)).includes("\\[Name\\]\\(https://bad\\.test\\)"));
  assert.ok(textOf(JSON.parse(json)).includes("[\\[x\\]\\(bad\\) \\</script\\>\\<script\\>](https://example.com/path%28test%29?a=1&b=2)"));
  assert.match(html, /property="og:title"/);
  assert.match(html, /property="og:image"/);
  assert.match(html, /application\/json\+oembed/);
  assert.match(html, /http-equiv="refresh"/);
  const post = {...content, post: "ABC", video: [{url: "https://example.com/video.mp4"}]};
  const legacy = {...post};
  delete legacy.profile;
  assert.equal(renderSeo({type: "post", content: post}), renderSeo({type: "post", content: legacy}));
  assert.doesNotMatch(renderSeo({type: "post", content: post}), /discord:component-embed/);
});

test("parser selects profile-query data, keeps whitespace, and ignores viewer/post authors", () => {
  const html = jsonScript({data: {user: {...user, full_name: "Viewer"}}}) +
    preloaded({...user, full_name: "Post author"}, "BarcelonaProfileThreadsTabDirectQuery") +
    preloaded({...user, username: "someone_else"}) +
    '<script type="application/json">broken</script>' + preloaded(user) + descriptor();
  const result = readProfilePage(html, username);
  assert.deepEqual(result.user, user);
  assert.equal(result.queries[direct]?.queryID, "123456789");
  assert.equal(result.queries[direct]?.variables.testProvider, true);
  assert.ok(hasCompleteProfile(result.user));
  assert.equal(readProfilePage(preloaded({...user, username: "wrong"}), username).user, undefined);
  assert.deepEqual(readProfileResponse({data: {xdt_text_app_user_by_username: user}}, username), user);
  assert.equal(readProfileResponse({data: {user: {...user, username: "wrong"}}}, username), undefined);
});

type Step = Response | ((init?: RequestInit) => Response | Promise<Response>);
function finder(steps: Step[], token?: string, budget = 1500) {
  const calls: {url: string; init?: RequestInit}[] = [];
  let credentialsRead = 0;
  const run = createUserFinder({
    totalBudgetMs: budget,
    getCredential: async () => { credentialsRead++; return token; },
    fetch: (async (url, init) => {
      calls.push({url: String(url), init});
      const step = steps.shift();
      assert.ok(step, "Unexpected upstream request");
      return typeof step === "function" ? step(init) : step;
    }) as typeof fetch,
  });
  return {run: () => run({username, userAgent: "Discordbot/2.0"}), calls,
    credentialReads: () => credentialsRead};
}
const response = (value: unknown) => new Response(JSON.stringify(value));
const queryBody = (call: {init?: RequestInit}) => new URLSearchParams(String(call.init?.body));

test("null views without a configured credential return the anonymous profile without repeating queries", async () => {
  const f = finder([new Response(context + preloaded(user))]);
  const content = await f.run();
  assert.ok(content);
  assert.equal(content.description, user.biography);
  assert.equal(content.profile?.publicViewCount, undefined);
  assert.equal(f.calls.length, 1);
  assert.equal(f.credentialReads(), 1);
});

test("available public views, including zero, need no credential lookup or extra request", async () => {
  for (const count of [0, 156102]) {
    const f = finder([new Response(context + preloaded({...user,
      text_post_app_public_views: {text_post_app_public_view_count: count},
    }))]);
    const content = await f.run();
    assert.ok(content);
    assert.equal(content.profile?.publicViewCount, count);
    assert.equal(f.calls.length, 1);
    assert.equal(f.credentialReads(), 0);
  }
});

const testCookie = 'COOKIE:{"sessionid":"fake-session","csrftoken":"fake-csrf","ds_user_id":"12"}';
const browserUser = {...user,
  text_post_app_public_views: {text_post_app_public_view_count: "156102"},
};

test("anonymous preloaded null views are enriched once with configured credentials and logged-in variables", async () => {
  const f = finder([
    new Response(context + descriptor() + preloaded(user)),
    response({data: {user: browserUser}}),
  ], testCookie);
  const content = await f.run();
  assert.ok(content);
  assert.equal(content.profile?.publicViewCount, 156102);
  assert.ok(textOf(buildProfileComponents(content)!).includes("👀 156.1K"));
  assert.equal(f.credentialReads(), 1);
  assert.equal(f.calls.length, 2);
  const headers = new Headers(f.calls[1].init?.headers);
  assert.match(headers.get("Cookie")!, /sessionid=fake-session/);
  assert.equal(headers.get("X-Logged-Out-Threads-Migrated-Request"), null);
  assert.equal(headers.get("Authorization"), null);
  const body = queryBody(f.calls[1]);
  assert.equal(body.get("doc_id"), "123456789");
  const variables = JSON.parse(body.get("variables")!);
  assert.equal(variables.__relay_internal__pv__BarcelonaIsLoggedInrelayprovider, true);
  assert.equal(variables.__relay_internal__pv__BarcelonaIsLoggedOutrelayprovider, false);
  assert.equal(variables.testProvider, true);
  assert.equal(variables.__relay_internal__pv__BarcelonaShouldShowFediverseM1Featuresrelayprovider, true);
});

test("Instagram follows the profile badge setting and does not increase the bio link count", () => {
  for (const flag of [false, undefined, null, "true", 1]) {
    const content = profileContent({...user, show_text_post_app_badge: flag}, "Discordbot/2.0");
    assert.equal(content.profile?.instagramUrl, undefined);
    const linkText = buildProfileComponents(content)!.component.components[2];
    assert.equal(linkText.type, 10);
    if (linkText.type !== 10) continue;
    assert.equal(linkText.content.split(" · ").length, 3);
    assert.ok(!linkText.content.includes("Instagram"));
  }
  const value = payload({...user, bio_links: []});
  assert.deepEqual(value.component.components[2], {type: 10, content: "[Instagram](https://www.instagram.com/nicko948787/)"});
  assert.ok(textOf(value).includes("🔗 0"));
});

test("five bio links plus Instagram are all retained as Markdown links", () => {
  const value = payload({...user, bio_links: Array.from({length: 5}, (_, i) => ({
    title: `Link ${i}`, url: `https://example.com/${i}`,
  }))});
  const links = value.component.components[2];
  assert.equal(links.type, 10);
  if (links.type !== 10) return;
  assert.equal(links.content.split(" · ").length, 6);
  assert.ok(links.content.endsWith("[Instagram](https://www.instagram.com/nicko948787/)"));
  assert.ok(links.content.includes("[Link 4](https://example.com/4)"));
  assert.ok(textOf(value).includes("🔗 5"));
});

test("only explicit public flags produce status badges", () => {
  const value = payload({...user, is_verified: true, text_post_app_is_private: true,
    text_post_app_has_fediverse_enabled: true});
  const text = textOf(value);
  assert.ok(text.includes("-# ✅ · 🔒 · 🌐"));
  for (const flag of [false, null, undefined, "true", "false", 1]) {
    assert.doesNotMatch(textOf(payload({...user, is_verified: flag,
      text_post_app_is_private: flag, text_post_app_has_fediverse_enabled: flag})), /✅|🔒|🌐/);
  }
  // Instagram privacy must not be mistaken for the Threads privacy setting.
  assert.doesNotMatch(textOf(payload({...user, is_private: true})), /🔒/);
});

test("biography mentions are linked safely without changing plain OG text or view labels", () => {
  const biography = "找@av1anjay\n(@hello.world) @test_user.\nmail: me@example.com\nhttps://example.com/@path www.example.com/@other @name@server.tld\n[spoof](https://bad.test) *text*";
  const content = profileContent({...user, biography,
    text_post_app_public_views: {text_post_app_public_view_count: 156201}}, "Discordbot/2.0");
  const text = textOf(buildProfileComponents(content)!);
  assert.ok(text.includes("找[@av1anjay](https://www.threads.com/@av1anjay)"));
  assert.ok(text.includes("[@hello\\.world](https://www.threads.com/@hello.world)"));
  assert.ok(text.includes("[@test\\_user](https://www.threads.com/@test_user)\\."));
  for (const handle of ["example.com", "path", "other", "name", "server.tld"]) {
    assert.ok(!text.includes(`https://www.threads.com/@${handle}`));
  }
  assert.ok(text.includes("\\[spoof\\]\\(https://bad\\.test\\) \\*text\\*"));
  assert.ok(text.includes("👀 156.2K"));
  assert.doesNotMatch(text, /近\s*30|30\s*天/);
  assert.equal(content.description, biography);
  const html = renderSeo({type: "user", content});
  const og = html.match(/<meta property="og:description" content="([^"]*)"/s)![1];
  assert.ok(og.includes("找@av1anjay"));
  assert.ok(!og.includes("https://www.threads.com/@av1anjay"));
});

test("truncating a biography never cuts through a generated mention link", () => {
  const content = profileContent({...user, biography: `${"x".repeat(2975)} @av1anjay ${"more ".repeat(10)}`}, "Discordbot/2.0");
  const section = buildProfileComponents(content)!.component.components[0];
  assert.equal(section.type, 9);
  if (section.type !== 9) return;
  const biography = section.components[1].content.split("\n\n")[0];
  assert.ok(biography.length <= 3000);
  assert.ok(biography.endsWith("…"));
  assert.ok(biography.includes("@av1anjay"));
  assert.ok(!biography.includes("[@av1anjay]"));
  assert.doesNotMatch(biography, /https:\/\/www\.threads/);
});

test("successful anonymous GraphQL with null views also triggers authenticated enrichment", async () => {
  const f = finder([
    new Response(context + descriptor()), response({data: {user}}),
    response({data: {user: browserUser}}),
  ], "Bearer fake-test-token");
  const content = await f.run();
  assert.ok(content);
  assert.equal(content.profile?.publicViewCount, 156102);
  assert.equal(f.calls.length, 3);
  assert.equal(f.credentialReads(), 1);
  const headers = new Headers(f.calls[2].init?.headers);
  assert.equal(headers.get("Authorization"), "Bearer fake-test-token");
  assert.equal(headers.get("X-Logged-Out-Threads-Migrated-Request"), null);
  const variables = JSON.parse(queryBody(f.calls[2]).get("variables")!);
  assert.equal(variables.__relay_internal__pv__BarcelonaIsLoggedInrelayprovider, true);
  assert.equal(variables.__relay_internal__pv__BarcelonaIsLoggedOutrelayprovider, false);
});

test("authenticated null/error responses keep the base profile and do not retry", async () => {
  for (const upstream of [response({data: {user}}), new Response("denied", {status: 403}),
    new Response("invalid JSON"), response({errors: [{summary: "Not Logged In"}]})]) {
    const f = finder([new Response(context + preloaded(user)), upstream], testCookie);
    const content = await f.run();
    assert.ok(content);
    assert.equal(content.profile?.publicViewCount, undefined);
    assert.equal(content.description, user.biography);
    assert.equal(content.profile?.followerCount, 35);
    assert.equal(content.profile?.links?.length, 3);
    assert.equal(f.calls.length, 2);
    assert.equal(f.credentialReads(), 1);
  }
});

test("DirectQuery honors page query ID and variables, and matches the returned username", async () => {
  const f = finder([new Response(context + descriptor()), response({data: {user}})]);
  assert.ok(await f.run());
  const body = queryBody(f.calls[1]);
  assert.equal(body.get("doc_id"), "123456789");
  assert.equal(body.get("fb_api_req_friendly_name"), direct);
  const variables = JSON.parse(body.get("variables")!);
  assert.equal(variables.userID, user.pk);
  assert.equal(variables.testProvider, true);
});

test("username fallback resolves ID and enriches only once with DirectQuery", async () => {
  const partial = {...user};
  delete partial.text_post_app_public_views;
  const f = finder([new Response(context), response({data: {xdt_text_app_user_by_username: partial}}),
    response({data: {user: {...user, text_post_app_public_views: {text_post_app_public_view_count: 150000}}}})]);
  const content = await f.run();
  assert.ok(content);
  assert.equal(content.profile?.publicViewCount, 150000);
  assert.equal(queryBody(f.calls[1]).get("doc_id"), "28575850328713053");
  assert.equal(queryBody(f.calls[2]).get("doc_id"), "26774588645572510");
  assert.equal(JSON.parse(queryBody(f.calls[1]).get("variables")!).username, username);
  assert.equal(JSON.parse(queryBody(f.calls[2]).get("variables")!).userID, user.pk);
  assert.equal(f.calls.length, 3);
});

test("Cookie credentials use Cookie/CSRF headers while Bearer uses Authorization", async () => {
  for (const token of ['COOKIE:{"sessionid":"fake-session","csrftoken":"fake-csrf","ds_user_id":"12"}', "Bearer fake-test-token"]) {
    const f = finder([new Response(context + descriptor()), new Response("denied", {status: 403}), response({data: {user}})], token);
    assert.ok(await f.run());
    assert.equal(f.credentialReads(), 1);
    const headers = new Headers(f.calls[2].init?.headers);
    if (token.startsWith("COOKIE:")) {
      assert.equal(headers.get("Authorization"), null);
      assert.match(headers.get("Cookie")!, /sessionid=fake-session/);
      assert.equal(headers.get("X-Csrftoken"), "fake-csrf");
      assert.equal(queryBody(f.calls[2]).get("av"), "12");
    } else {
      assert.equal(headers.get("Authorization"), token);
      assert.equal(headers.get("Cookie"), null);
    }
  }
  for (const token of [undefined, "bad", "COOKIE:invalid", "COOKIE:null", "Bearer x\r\nInjected: y"]) {
    assert.deepEqual(profileCredentialHeaders(token), {});
  }
});

test("403, invalid JSON, GraphQL errors and mismatched users preserve available profile data", async () => {
  for (const failure of [new Response("denied", {status: 403}), new Response("not JSON"),
    response({errors: [{summary: "Not Logged In"}]}), response({data: {user: {...user, username: "wrong"}}})]) {
    const partial = {...user};
    delete partial.text_post_app_public_views;
    const f = finder([new Response(context + preloaded(partial)), failure]);
    const content = await f.run();
    assert.ok(content);
    assert.equal(content.profile?.followerCount, 35);
    assert.equal(content.profile?.links?.length, 3);
    assert.equal(f.calls.length, 2);
  }
  const empty = finder([new Response(context), new Response("denied", {status: 403})]);
  assert.equal(await empty.run(), false);
});

test("one total deadline aborts requests and retains partial data", async () => {
  const partial = {...user};
  delete partial.text_post_app_public_views;
  let aborted = false;
  const pending: Step = init => new Promise((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => {aborted = true; reject(new Error("aborted"));}, {once: true});
  });
  const f = finder([new Response(context + preloaded(partial)), pending], undefined, 350);
  const start = Date.now();
  const content = await f.run();
  assert.ok(content);
  assert.equal(content.profile?.followerCount, 35);
  assert.ok(aborted);
  assert.ok(Date.now() - start < 1000);
  assert.equal(f.credentialReads(), 0);
});

test("redirect cookie jar is retained and cannot leave the Threads origin", async () => {
  const f = finder([new Response("", {status: 302, headers: {Location: "/@nicko948787?ok=1", "Set-Cookie": "test=anonymous; Path=/"}}), new Response(preloaded(user))]);
  assert.ok(await f.run());
  assert.equal(new Headers(f.calls[1].init?.headers).get("Cookie"), "test=anonymous");
  const offsite = finder([new Response("", {status: 302, headers: {Location: "https://example.com"}})]);
  assert.equal(await offsite.run(), false);
  assert.equal(offsite.calls.length, 1);
});
