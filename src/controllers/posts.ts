import express from "express";
import fetch from "node-fetch";
import findPost from "../utils/fetch/findPost";
import {SHARE_RESOLVE_MS} from "../utils/fetch/http";
import renderActivity from "../utils/renderActivity";
import renderPlayer from "../utils/renderPlayer";
import renderSeo from "../utils/renderSeo";
import {
  HttpError,
  decodeThreadsPostId,
  getThreadsUrl,
  normalizeThreadsPostCode,
} from "../utils/utils";

const router: express.Router = express.Router();
const THREADS_HOSTS = new Set([
  "threads.com",
  "www.threads.com",
  "threads.net",
  "www.threads.net",
]);
// Share-code → post-code mappings are stable; cache aggressively.
const SHARE_CACHE_SUCCESS_TTL_MS = 24 * 60 * 60 * 1000;
const SHARE_CACHE_FAILURE_TTL_MS = 60 * 1000;
const MAX_SHARE_CACHE_ENTRIES = 5000;
const shareCodeCache = new Map<
  string,
  {postCode: string | undefined; expiresAt: number}
>();
const shareCodeInflight = new Map<string, Promise<string | undefined>>();

function getActivityStatusId(post: ContentProps) {
  if (post.activityStatusId) return post.activityStatusId;
  if (post.postId) return `${post.postId}desc`;
  return post.post || "";
}

function getActivityPath(post: ContentProps) {
  const normalizedUsername = post.username.replace(/^@/, "");
  return `/users/${normalizedUsername}/statuses/${getActivityStatusId(post)}`;
}

function getContentWithActivityMeta(
  req: express.Request,
  post: ContentProps
): ContentProps {
  const host = req.get("host");
  const forwardedProto = req.get("x-forwarded-proto")?.split(",")[0]?.trim();
  const protocol = forwardedProto || req.protocol;
  const activityPath = getActivityPath(post);

  return {
    ...post,
    activityStatusId: getActivityStatusId(post),
    activityUrl: host ? `${protocol}://${host}${activityPath}` : activityPath,
  };
}

function resolvePostFromActivityStatusId(statusId: string) {
  const normalizedStatusId = statusId
    .split("?")[0]
    .replace(/\//g, "")
    .replace(/desc$/i, "");

  const decodedPostCode = decodeThreadsPostId(normalizedStatusId);
  return normalizeThreadsPostCode(decodedPostCode || normalizedStatusId);
}

function redirectToOriginalThreadsPost(
  req: express.Request,
  res: express.Response
) {
  const username = req.params.username;
  const post = req.params.post;

  if (typeof post === "string" && typeof username === "string") {
    return res.redirect(getThreadsUrl(username, post));
  }

  if (typeof post === "string") {
    return res.redirect(`https://www.threads.com/t/${post}`);
  }

  if (typeof username !== "string") {
    return res.redirect("/");
  }

  return res.redirect(getThreadsUrl(username));
}

function redirectToOriginalThreadsShare(
  req: express.Request,
  res: express.Response
) {
  const shareCode = req.params.shareCode;

  if (typeof shareCode !== "string") return res.redirect("/");

  return res.redirect(
    `https://www.threads.com/share/${encodeURIComponent(shareCode)}/`
  );
}

async function resolveThreadsShareCode(
  shareCode: string,
  userAgent: string
): Promise<string | undefined> {
  if (!/^[A-Za-z0-9_-]+$/.test(shareCode)) return;

  const cached = shareCodeCache.get(shareCode);
  if (cached && cached.expiresAt > Date.now()) return cached.postCode;

  const inflight = shareCodeInflight.get(shareCode);
  if (inflight) return inflight;

  const resolution = (async () => {
    const response = await fetch(
      `https://www.threads.com/share/${encodeURIComponent(shareCode)}/`,
      {
        method: "HEAD",
        redirect: "follow",
        follow: 10,
        signal: AbortSignal.timeout(SHARE_RESOLVE_MS),
        headers: userAgent ? {"User-Agent": userAgent} : undefined,
      }
    );
    const resolvedUrl = new URL(response.url);

    if (!THREADS_HOSTS.has(resolvedUrl.hostname.toLowerCase())) return undefined;

    const pathMatch = resolvedUrl.pathname.match(
      /^\/(?:@[^/]+\/post|t)\/([A-Za-z0-9_-]+)\/?$/
    );
    return pathMatch?.[1];
  })();

  shareCodeInflight.set(shareCode, resolution);
  try {
    const postCode = await resolution;
    const ttl = postCode
      ? SHARE_CACHE_SUCCESS_TTL_MS
      : SHARE_CACHE_FAILURE_TTL_MS;
    shareCodeCache.delete(shareCode);
    shareCodeCache.set(shareCode, {postCode, expiresAt: Date.now() + ttl});
    while (shareCodeCache.size > MAX_SHARE_CACHE_ENTRIES) {
      const oldestKey = shareCodeCache.keys().next().value;
      if (oldestKey === undefined) break;
      shareCodeCache.delete(oldestKey);
    }
    return postCode;
  } finally {
    shareCodeInflight.delete(shareCode);
  }
}

function wantsActivityJson(req: express.Request) {
  const format =
    typeof req.query.format === "string"
      ? req.query.format.trim().toLowerCase()
      : "";

  if (
    format === "activity" ||
    format === "activity+json" ||
    format === "application/activity+json"
  ) {
    return true;
  }

  const acceptHeader = req.get("accept")?.toLowerCase() || "";
  return (
    acceptHeader.includes("application/activity+json") ||
    (acceptHeader.includes("application/ld+json") &&
      acceptHeader.includes("activitystreams"))
  );
}

function sendActivityResponse(
  req: express.Request,
  res: express.Response,
  post: ContentProps
) {
  const content = getContentWithActivityMeta(req, post);

  res.vary("Accept");
  return res
    .status(200)
    .type("application/activity+json; charset=utf-8")
    .send(JSON.stringify(renderActivity(content)));
}

function sendPostResponse(
  req: express.Request,
  res: express.Response,
  post: ContentProps
) {
  const content = getContentWithActivityMeta(req, post);

  res.vary("Accept");

  if (wantsActivityJson(req)) {
    return sendActivityResponse(req, res, post);
  }

  return res.send(
    renderSeo({
      type: "post",
      content,
    })
  );
}

function sendPlayerResponse(
  req: express.Request,
  res: express.Response,
  post: ContentProps
) {
  const content = getContentWithActivityMeta(req, post);
  return res.type("text/html; charset=utf-8").send(renderPlayer(content));
}

async function handlePostRequest(
  req: express.Request,
  res: express.Response,
  next: express.NextFunction
) {
  try {
    if (!req.params.post) return next(new HttpError(400, "No post provided"));

    const post = await findPost({
      post: String(req.params.post),
      userAgent: req.headers["user-agent"] || "",
    });

    if (!post || !post.title) {
      return next(new HttpError(404, "Post not found"));
    }

    return sendPostResponse(req, res, post);
  } catch (e: unknown) {
    if (wantsActivityJson(req)) {
      return next(new HttpError(502, "Unable to render activity JSON"));
    }

    return redirectToOriginalThreadsPost(req, res);
  }
}

async function handleShareRequest(
  req: express.Request,
  res: express.Response,
  next: express.NextFunction
) {
  try {
    const shareCode = req.params.shareCode;
    if (!shareCode) return next(new HttpError(400, "No share code provided"));

    const resolvedPost = await resolveThreadsShareCode(
      String(shareCode),
      req.headers["user-agent"] || ""
    );
    if (!resolvedPost) return redirectToOriginalThreadsShare(req, res);

    const post = await findPost({
      post: resolvedPost,
      userAgent: req.headers["user-agent"] || "",
    });

    if (!post || !post.title) {
      return next(new HttpError(404, "Post not found"));
    }

    return sendPostResponse(req, res, post);
  } catch {
    return redirectToOriginalThreadsShare(req, res);
  }
}

async function handlePlayerRequest(
  req: express.Request,
  res: express.Response,
  next: express.NextFunction
) {
  try {
    if (!req.params.post) return next(new HttpError(400, "No post provided"));

    const post = await findPost({
      post: String(req.params.post),
      userAgent: req.headers["user-agent"] || "",
    });

    if (!post || !post.title || !post.video.length) {
      return redirectToOriginalThreadsPost(req, res);
    }

    return sendPlayerResponse(req, res, post);
  } catch {
    return redirectToOriginalThreadsPost(req, res);
  }
}

async function handleActivityRequest(
  req: express.Request,
  res: express.Response,
  next: express.NextFunction
) {
  try {
    const requestedPost =
      typeof req.params.post === "string"
        ? req.params.post
        : typeof req.params.statusId === "string"
          ? resolvePostFromActivityStatusId(req.params.statusId)
          : "";

    if (!requestedPost) {
      console.error("[ActivityPub] No post provided in request");
      return next(new HttpError(400, "No post provided"));
    }

    console.log(`[ActivityPub] Fetching post: ${requestedPost}`);
    const post = await findPost({
      post: requestedPost,
      userAgent: req.headers["user-agent"] || "",
    });

    if (!post) {
      console.error(`[ActivityPub] Post not found: ${requestedPost}`);
      return next(new HttpError(404, "Post not found"));
    }

    if (!post.title) {
      console.error(`[ActivityPub] Post missing title: ${requestedPost}`, { hasDescription: !!post.description });
      return next(new HttpError(404, "Post not found (missing title)"));
    }

    console.log(`[ActivityPub] Rendering ActivityPub response for: ${requestedPost}`);
    return sendActivityResponse(req, res, post);
  } catch (e: unknown) {
    const errorMessage = e instanceof Error ? e.message : String(e);
    const errorStack = e instanceof Error ? e.stack : undefined;
    console.error(`[ActivityPub] Error handling request:`, errorMessage);
    if (errorStack) console.error(errorStack);
    return next(new HttpError(502, `Unable to render activity JSON: ${errorMessage}`));
  }
}

// Mastodon API compatible endpoints for ActivityPub
router.get("/api/v1/statuses/:statusId", handleActivityRequest);
router.get("/users/:username/statuses/:statusId", handleActivityRequest);
router.get("/t/:post/activity", handleActivityRequest);
router.get("/:username/post/:post/activity", handleActivityRequest);
router.get("/t/:post/player", handlePlayerRequest);
router.get("/:username/post/:post/player", handlePlayerRequest);
router.get("/share/:shareCode", handleShareRequest);
router.get("/t/:post", handlePostRequest);
router.get("/:username/post/:post", handlePostRequest);

export default router;
