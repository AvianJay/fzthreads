/// <reference path="../src/types/application.d.ts" />
import assert from "node:assert/strict";
import {test} from "node:test";
import {
  buildContentFromResponse,
  enrichPostPoll,
  getPostPageVariables,
} from "../src/utils/fetch/findPost";
import {formatPollPlainText, isPollExpired, readPoll} from "../src/utils/poll";
import renderSeo from "../src/utils/renderSeo";
import renderActivity from "../src/utils/renderActivity";

const code = "DdWlVVUE-KT";
// The example's public response includes this poll, with tallies hidden.
const hiddenPoll = {
  poll_id: "18082006088686538", expires_at: null, finished: true,
  tallies: null, viewer_can_vote: false, viewer_is_owner: false, viewer_vote: null,
};
const results = {...hiddenPoll, tallies: [
  {text: "支持", count: 2}, {text: "反對", count: 1}, {text: "其他", count: 0},
]};

function rawPost(poll: unknown = results, postCode = code) {
  return {
    code: postCode, caption: {text: "Vibe 您的想法是？"},
    user: {username: "nyankohost", full_name: "作者", profile_pic_url: "https://example.com/avatar.jpg"},
    image_versions2: {candidates: []}, like_count: 3, taken_at: 1789516800,
    text_post_app_info: {repost_count: 1, direct_reply_count: 2},
    caption_add_on: {poll},
  };
}

function response(poll: unknown = results, postCode = code) {
  return {data: {data: {edges: [{node: {thread_items: [{post: rawPost(poll, postCode)}]}}]}}};
}

function content(poll: unknown = results): ContentProps {
  const parsed = buildContentFromResponse(response(poll), code, "123");
  assert.ok(parsed);
  return {...parsed, userAgent: "Discordbot/2.0"};
}

test("getpost reads the example poll separately from its caption and keeps zero-vote options", () => {
  const post = content();
  assert.equal(post.description, "Vibe 您的想法是？");
  assert.equal(post.poll?.id, hiddenPoll.poll_id);
  assert.equal(post.poll?.votesCount, 3);
  assert.deepEqual(post.poll?.options.map(option => option.votesCount), [2, 1, 0]);
  const text = formatPollPlainText(post.poll);
  assert.ok(text.includes("投票（已結束）"));
  assert.ok(text.includes("支持 — 67%（2 票）"));
  assert.ok(text.includes("反對 — 33%（1 票）"));
  assert.ok(text.includes("其他 — 0%（0 票）"));
  assert.ok(text.includes("共 3 票"));
});

test("unavailable tallies remain unknown and show a fallback in OG and Activity", () => {
  const post = content(hiddenPoll);
  assert.deepEqual(post.poll?.options, []);
  assert.equal(post.poll?.votesCount, undefined);
  const html = renderSeo({type: "post", content: post});
  const activity = renderActivity(post);
  for (const text of [html, activity.content, activity.text]) {
    assert.ok(text.includes("投票（已結束）"));
    assert.ok(text.includes("選項與票數暫時無法取得"));
    assert.ok(!text.includes("共 0 票"));
  }
  assert.equal(activity.poll, null);
});

test("unknown counts do not manufacture totals or percentages; real zeros do", () => {
  for (const count of [null, undefined, "", " ", -1, 1.5, Infinity, "bad", Number.MAX_SAFE_INTEGER + 1]) {
    const poll = readPoll({...hiddenPoll, tallies: [{text: "A", count}, {text: "B", count: 0}]})!;
    assert.equal(poll.options[0].votesCount, undefined);
    assert.equal(poll.votesCount, undefined);
    assert.ok(!formatPollPlainText(poll).includes("%"));
  }
  const zero = readPoll({...hiddenPoll, tallies: [{text: "A", count: "0"}, {text: "B", count: 0}]})!;
  assert.equal(zero.votesCount, 0);
  assert.ok(formatPollPlainText(zero).includes("共 0 票"));
  assert.ok(!formatPollPlainText(zero).includes("NaN"));
  const malformed = readPoll({...hiddenPoll, tallies: [null, {count: 5}, {text: " ", count: 4}, {text: "A", count: 1}]})!;
  assert.equal(malformed.options.length, 1);
  assert.equal(malformed.votesCount, undefined);
  for (const value of [null, undefined, false, "poll", []]) assert.equal(readPoll(value), undefined);
  const unknown = renderActivity(content({...hiddenPoll, tallies: [{text: "A", count: null}, {text: "B", count: null}]}));
  assert.equal(unknown.poll, null);
  assert.ok(unknown.text.includes("◯ A"));
  assert.ok(!unknown.text.includes("%"));
});

test("finished and time-based expiry work, including invalid or missing timestamps", () => {
  const future = Math.floor(Date.now() / 1000) + 3600;
  const active = readPoll({...results, finished: false, expires_at: String(future)})!;
  assert.equal(active.expiresAt, new Date(future * 1000).toISOString());
  assert.equal(isPollExpired(active), false);
  assert.equal(isPollExpired(readPoll({...results, finished: false, expires_at: 1})!), true);
  assert.equal(isPollExpired(readPoll({...results, expires_at: future})!), true);
  for (const time of [null, "bad", -1, Number.MAX_SAFE_INTEGER]) {
    assert.equal(readPoll({...results, expires_at: time})?.expiresAt, undefined);
  }
});

test("OG reserves room for poll results and stats when the caption is long", () => {
  const post = {...content(), description: "長".repeat(1400)};
  const html = renderSeo({type: "post", content: post});
  const og = html.match(/<meta property="og:description" content="([^"]*)"/s)![1];
  assert.ok(og.length <= 900);
  assert.ok(og.includes("..."));
  assert.ok(og.includes("支持 — 67%（2 票）"));
  assert.ok(og.includes("共 3 票"));
  assert.ok(og.endsWith(post.oembedStat));
});

test("Activity exposes structured results with text fallback and safely escapes option labels", () => {
  const label = '<script>alert("x")</script> ||literal||';
  const post = content({...results, tallies: [{text: label, count: 1}]});
  const activity = renderActivity(post);
  assert.deepEqual(activity.poll, {
    id: hiddenPoll.poll_id, expires_at: null, expired: true, multiple: false,
    votes_count: 1, voters_count: null, options: [{title: label, votes_count: 1}], emojis: [],
  });
  assert.ok(activity.content.includes("&lt;script&gt;"));
  assert.ok(!activity.content.includes("<script>"));
  assert.ok(activity.content.includes("||literal||"));
  assert.ok(activity.text.includes("||literal||"));
  assert.equal(activity.sensitive, false);
  assert.ok(renderSeo({type: "post", content: post}).includes("&lt;script&gt;"));
});

test("quoted polls display under the quote without replacing the main post's poll", () => {
  const upstream = response();
  const main = upstream.data.data.edges[0].node.thread_items[0].post;
  Object.assign(main.text_post_app_info, {share_info: {quoted_post: rawPost({...results, tallies: [{text: "引用選項", count: 4}]}, "another")}});
  const parsed = buildContentFromResponse(upstream, code, "123");
  assert.ok(parsed);
  const post = {...parsed, userAgent: "Discordbot/2.0"};
  assert.equal(post.poll?.votesCount, 3);
  assert.equal(post.quotedPost?.poll?.votesCount, 4);
  assert.ok(renderSeo({type: "post", content: post}).includes("引用選項"));
  const activity = renderActivity(post);
  assert.ok(activity.content.includes("引用選項"));
  assert.ok(activity.text.includes("> ◯ 引用選項"));
  assert.equal(activity.poll?.votes_count, 3);
});

test("non-poll posts keep their previews and do not trigger authenticated enrichment", async () => {
  const post = content(null);
  assert.equal(post.poll, undefined);
  assert.equal(renderActivity(post).poll, null);
  assert.ok(!renderSeo({type: "post", content: post}).includes("📊"));
  let calls = 0;
  for (const poll of [null, results]) {
    const base = response(poll);
    assert.equal(await enrichPostPoll(base, code, async () => {calls++; return response();}), base);
  }
  assert.equal(calls, 0);
});

test("hidden polls are enriched once; failure, unavailable data and mismatches retain the base", async () => {
  const base = response(hiddenPoll);
  const full = response();
  let calls = 0;
  assert.equal(await enrichPostPoll(base, code, async () => {calls++; return full;}), full);
  assert.equal(calls, 1);
  assert.equal(base.data.data.edges[0].node.thread_items[0].post.caption_add_on.poll, hiddenPoll);
  assert.equal(await enrichPostPoll(base, code), base);
  for (const failure of [undefined, {errors: [{}]}, response(hiddenPoll), response(results, "wrong")]) {
    let retries = 0;
    assert.equal(await enrichPostPoll(base, code, async () => {retries++; return failure;}), base);
    assert.equal(retries, 1);
  }
  assert.equal(await enrichPostPoll(base, code, async () => {throw new Error("denied");}), base);
});

test("authenticated post queries use logged-in variables, including bearer requests", () => {
  assert.equal(JSON.parse(getPostPageVariables("123")).__relay_internal__pv__BarcelonaIsLoggedInrelayprovider, false);
  assert.equal(JSON.parse(getPostPageVariables("123", true)).__relay_internal__pv__BarcelonaIsLoggedInrelayprovider, true);
});

test("the logged-in example's results match Threads percentages and total", () => {
  const post = content({...hiddenPoll, tallies: [
    {text: "夯爆了", count: 9}, {text: "拉完了", count: 4},
    {text: "在看看", count: 8}, {text: "其他（寫底下留言區我看看）", count: 2},
  ]});
  const text = renderActivity(post).text;
  for (const expected of ["夯爆了 — 39%（9 票）", "拉完了 — 17%（4 票）",
    "在看看 — 35%（8 票）", "其他（寫底下留言區我看看） — 9%（2 票）", "共 23 票"]) {
    assert.ok(text.includes(expected));
  }
  const thirds = formatPollPlainText(readPoll({...results, tallies: [
    {text: "A", count: 1}, {text: "B", count: 1}, {text: "C", count: 1},
  ]}));
  const total = [...thirds.matchAll(/(\d+)%/g)].reduce((sum, match) => sum + Number(match[1]), 0);
  assert.equal(total, 100);
});
