import escape from "escape-html";
import { getThreadsUrl } from "./utils";

const APPLICATION_NAME = "fixthreads";
const APPLICATION_WEBSITE = "https://github.com/milanmdev/fixthreads";

function getDisplayName(content: ContentProps): string {
  const username = content.username.replace(/^@/, "");
  const authorName = content.authorName?.trim() || `@${username}`;
  const handleSuffix = ` (@${username})`;

  if (authorName.endsWith(handleSuffix)) {
    return authorName.slice(0, -handleSuffix.length);
  }

  if (authorName === `@${username}`) {
    return username;
  }

  return authorName.replace(/^@/, "");
}

type SpoilerSegment = {
  text: string;
  isSpoiler: boolean;
};

function parseDiscordSpoilerSegments(text: string): SpoilerSegment[] {
  const segments: SpoilerSegment[] = [];
  let buffer = "";
  let isSpoiler = false;

  for (let i = 0; i < text.length; i++) {
    if (text.startsWith("\\|\\|", i)) {
      buffer += "||";
      i += 3;
      continue;
    }

    if (text.startsWith("||", i)) {
      if (buffer) {
        segments.push({
          text: buffer,
          isSpoiler,
        });
        buffer = "";
      }
      isSpoiler = !isSpoiler;
      i += 1;
      continue;
    }

    buffer += text[i];
  }

  if (buffer) {
    segments.push({
      text: buffer,
      isSpoiler,
    });
  }

  return segments;
}

function renderDiscordSpoilersAsHtml(text: string): string {
  return parseDiscordSpoilerSegments(text)
    .map(segment => {
      const html = escape(segment.text).replace(/\r?\n/g, "<br>");
      if (!segment.isSpoiler) return html;

      return `<span class="spoiler" data-spoiler="true" aria-label="Spoiler">${html}</span>`;
    })
    .join("");
}

function buildHtmlContent(content: ContentProps): string {
  const parts: string[] = [];
  const description = content.description?.trim();
  const stats = content.oembedStat?.trim();

  if (description) {
    parts.push(renderDiscordSpoilersAsHtml(description));
  }

  if (stats) {
    parts.push(`<b>${escape(stats)}</b>`);
  }

  return parts.join("<br><br>");
}

function buildPlainTextContent(content: ContentProps): string {
  const description = content.description?.trim() || "";
  const stats = content.oembedStat?.trim() || "";

  if (description && stats) {
    return `${description}\n\n${stats}`;
  }

  return description || stats;
}

function getProfileUrl(content: ContentProps, username: string): string {
  // const activityOrigin = getActivityOrigin(content);
  // if (activityOrigin) return `${activityOrigin}/@${username}`;

  return content.authorUrl || getThreadsUrl(username);
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
  const username = content.username.replace(/^@/, "");
  const statusUrl = getLocalPostUrl(content, username);
  const profileUrl = getProfileUrl(content, username);
  const authorIcon = content.authorIcon || null;
  const displayName = getDisplayName(content);
  const activityId =
    content.activityStatusId || content.postId || content.post || statusUrl;
  const htmlContent = buildHtmlContent(content);
  const plainTextContent = buildPlainTextContent(content);

  return {
    id: activityId,
    url: statusUrl,
    uri: content.activityUrl || statusUrl,
    created_at: content.publishedTime || null,
    content: htmlContent,
    text: plainTextContent,
    spoiler_text: "",
    sensitive: false,
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
      url: profileUrl,
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
    mentions: [],
    tags: [],
    emojis: [],
    filtered: [],
  };
}
