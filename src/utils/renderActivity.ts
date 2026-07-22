import escape from "escape-html";
import {
  HTML_BLANK_LINE,
  QUOTE_PREFIX,
  SPOILER_WARNING_TEXT,
  appendQuoteToPlainText,
  collectMentions,
  renderRichTextHtml,
  stripDiscordSpoilerMarkers,
} from "./contentFormat";
import {
  formatThreadsAuthorName,
  getThreadsUrl,
  normalizeThreadsUsername,
} from "./utils";

const APPLICATION_NAME = "fixthreads";
const APPLICATION_WEBSITE = "https://github.com/milanmdev/fixthreads";

function getDisplayName(content: ContentProps): string {
  const username = normalizeThreadsUsername(content.username);
  const authorName = formatThreadsAuthorName(content.authorName, username);
  const handleSuffix = ` (@${username})`;

  if (authorName.endsWith(handleSuffix)) {
    return authorName.slice(0, -handleSuffix.length);
  }

  if (authorName === `@${username}`) {
    return username;
  }

  return authorName.replace(/^@/, "");
}

function buildQuoteHtml(quotedPost: QuotedPostProps): {
  html: string;
  hasSpoiler: boolean;
} {
  const username = normalizeThreadsUsername(quotedPost.username);
  const header = `<b>${QUOTE_PREFIX} <a href="${getThreadsUrl(
    username
  )}">@${escape(username)}</a></b>`;
  const caption = quotedPost.caption.trim();

  if (!caption) {
    return {html: `<blockquote>${header}</blockquote>`, hasSpoiler: false};
  }

  const body = renderRichTextHtml(caption);

  return {
    html: `<blockquote>${header}${HTML_BLANK_LINE}${body.html}</blockquote>`,
    hasSpoiler: body.hasSpoiler,
  };
}

function buildHtmlContent(content: ContentProps): {
  html: string;
  hasSpoiler: boolean;
} {
  const parts: string[] = [];
  let hasSpoiler = false;
  const description = content.description?.trim();
  const stats = content.oembedStat?.trim();

  if (description) {
    const main = renderRichTextHtml(description);
    parts.push(main.html);
    hasSpoiler = hasSpoiler || main.hasSpoiler;
  }

  if (content.quotedPost?.quoted && content.quotedPost.username) {
    const quote = buildQuoteHtml(content.quotedPost);
    parts.push(quote.html);
    hasSpoiler = hasSpoiler || quote.hasSpoiler;
  }

  if (stats) {
    parts.push(`<b>${escape(stats)}</b>`);
  }

  return {html: parts.join(HTML_BLANK_LINE), hasSpoiler};
}

function buildPlainTextContent(content: ContentProps): string {
  const description = appendQuoteToPlainText(
    content.description?.trim() || "",
    content.quotedPost
  );
  const stats = content.oembedStat?.trim() || "";
  const combined =
    description && stats ? `${description}\n\n${stats}` : description || stats;

  return stripDiscordSpoilerMarkers(combined);
}

function getMentions(content: ContentProps) {
  const sources = [content.description || ""];

  if (content.quotedPost?.quoted && content.quotedPost.username) {
    sources.push(`@${content.quotedPost.username}`);
    sources.push(content.quotedPost.caption || "");
  }

  const usernames = new Set<string>();
  sources.forEach(source => {
    collectMentions(source).forEach(username =>
      usernames.add(normalizeThreadsUsername(username))
    );
  });

  return [...usernames].map(username => ({
    id: username,
    username,
    acct: username,
    url: getThreadsUrl(username),
  }));
}

function getProfileUrl(content: ContentProps, username: string): string {
  // const activityOrigin = getActivityOrigin(content);
  // if (activityOrigin) return `${activityOrigin}/@${username}`;

  return content.authorUrl || getThreadsUrl(username);
}

// Discord derives the fediverse handle (@user@domain) by parsing account.url
// as a Mastodon profile URL (https://host/@user). Pointing it at a post URL
// without an @-segment prevents that, so the embed shows a bare @username —
// same trick as FxEmbed. Falls back to the profile URL when there is no post.
function getAccountUrl(content: ContentProps, username: string): string {
  if (content.post) return `https://www.threads.com/t/${content.post}`;

  return getProfileUrl(content, username);
}

function getActivityOrigin(content: ContentProps): string | undefined {
  if (!content.activityUrl) return;

  try {
    return new URL(content.activityUrl).origin;
  } catch {
    return;
  }
}

function getLocalPostUrl(content: ContentProps, username: string): string {
  const activityOrigin = getActivityOrigin(content);

  if (activityOrigin && content.post) {
    return `${activityOrigin}/@${username}/post/${content.post}`;
  }

  return getThreadsUrl(username, content.post);
}

function getVideoMeta(video: VideoProps) {
  if (!video.width || !video.height) return null;

  const aspect = video.width / video.height;
  const shape = {
    width: video.width,
    height: video.height,
    size: `${video.width}x${video.height}`,
    aspect,
  };

  return {
    original: shape,
    small: shape,
  };
}

function getMediaAttachments(content: ContentProps) {
  const authorIcon = content.authorIcon || "";
  const images = (content.images || []).filter(
    (image): image is ImageProps => Boolean(image?.url)
  );
  const attachments: Array<Record<string, unknown>> = [];
  const postIdentifier =
    content.activityStatusId ||
    content.postId ||
    content.post ||
    content.username;
  const videoPreviewUrls = new Set<string>();

  content.video.forEach((video, index) => {
    const previewUrl = video.previewUrl || null;
    if (previewUrl) videoPreviewUrls.add(previewUrl);

    attachments.push({
      id: `${postIdentifier}-video-${index}`,
      type: "video",
      url: video.url,
      preview_url: previewUrl,
      remote_url: null,
      preview_remote_url: null,
      text_url: null,
      description: null,
      ...(getVideoMeta(video) ? {meta: getVideoMeta(video)} : {}),
    });
  });

  const mediaImages = images.filter(image => {
    if (image.url === authorIcon) return false;
    if (videoPreviewUrls.has(image.url)) return false;
    return true;
  });

  mediaImages.forEach((image, index) => {
    attachments.push({
      id: `${postIdentifier}-image-${index}`,
      type: "image",
      url: image.url,
      preview_url: image.url,
      remote_url: null,
      preview_remote_url: null,
      text_url: null,
      description: null,
    });
  });

  return attachments;
}

export default function renderActivity(content: ContentProps) {
  const username = normalizeThreadsUsername(content.username);
  const statusUrl = getLocalPostUrl(content, username);
  const accountUrl = getAccountUrl(content, username);
  const authorIcon = content.authorIcon || null;
  const displayName = getDisplayName(content);
  const activityId =
    content.activityStatusId || content.postId || content.post || statusUrl;
  const {html: htmlContent, hasSpoiler} = buildHtmlContent(content);
  const plainTextContent = buildPlainTextContent(content);

  return {
    id: activityId,
    url: statusUrl,
    uri: content.activityUrl || statusUrl,
    created_at: content.publishedTime || null,
    content: htmlContent,
    text: plainTextContent,
    spoiler_text: hasSpoiler ? SPOILER_WARNING_TEXT : "",
    sensitive: hasSpoiler,
    language: null,
    visibility: "public",
    // replies_count: content.replyCount || 0,
    // reblogs_count: content.repostCount || 0,
    // favourites_count: content.likeCount || 0,
    favourited: false,
    reblogged: false,
    muted: false,
    bookmarked: false,
    pinned: false,
    in_reply_to_id: null,
    in_reply_to_account_id: null,
    reblog: null,
    poll: null,
    card: null,
    application: {
      name: APPLICATION_NAME,
      website: APPLICATION_WEBSITE,
    },
    media_attachments: getMediaAttachments(content),
    account: {
      id: username,
      display_name: displayName,
      username,
      acct: username,
      note: "",
      url: accountUrl,
      uri: accountUrl,
      created_at: content.publishedTime || null,
      locked: false,
      bot: false,
      discoverable: true,
      indexable: false,
      group: false,
      avatar: authorIcon,
      avatar_static: authorIcon,
      header: null,
      header_static: null,
      statuses_count: 0,
      hide_collections: false,
      noindex: false,
      last_status_at: content.publishedTime
        ? content.publishedTime.slice(0, 10)
        : null,
      emojis: [],
      roles: [],
      fields: [],
    },
    mentions: getMentions(content),
    tags: [],
    emojis: [],
    filtered: [],
  };
}
