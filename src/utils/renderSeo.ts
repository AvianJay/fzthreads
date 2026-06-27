import escape from "escape-html";
import {
  formatThreadsAuthorName,
  getThreadsUrl,
  normalizeThreadsUsername,
} from "./utils";

const proxies = process.env.PROXIES?.split(",") || [];

const THREADS_PROVIDER_URL = "https://www.threads.com";
const THREADS_SITE_HANDLE = "@FzThreads";
const DEFAULT_THREADS_ICON_URL =
  "/favicon.png";
const DEFAULT_THREADS_FAVICON_URL =
  "/favicon.png";
const DEFAULT_THREADS_TOUCH_ICON_URL =
  "/favicon.png";
const DEFAULT_THEME_COLOR = "#FFFFFF";
const MAX_DESCRIPTION_LENGTH = 900;
const DESCRIPTION_SEPARATOR = "\n\n";

function getIconMimeType(url: string) {
  if (url.endsWith(".svg")) return "image/svg+xml";
  if (url.endsWith(".png")) return "image/png";
  if (url.endsWith(".webp")) return "image/webp";
  if (url.endsWith(".ico")) return "image/x-icon";

  return "";
}

function truncateText(text: string, maxLength: number) {
  if (maxLength <= 0) return "";
  if (maxLength <= 3) return ".".repeat(maxLength);
  if (text.length <= maxLength) return text;

  return `${text.slice(0, maxLength - 3).trimEnd()}...`;
}

function stripDiscordSpoilerMarkers(text: string) {
  let result = "";

  for (let i = 0; i < text.length; i++) {
    if (text.startsWith("\\|\\|", i)) {
      result += "||";
      i += 3;
      continue;
    }

    if (text.startsWith("||", i)) {
      i += 1;
      continue;
    }

    result += text[i];
  }

  return result;
}

function joinDescriptionParts(first: string, second: string) {
  if (first && second) return `${first}${DESCRIPTION_SEPARATOR}${second}`;
  return first || second;
}

function getEmbedDescription(content: ContentProps) {
  const stats = content.oembedStat?.trim() || "";
  const maxBodyLength = stats
    ? Math.max(
        MAX_DESCRIPTION_LENGTH - stats.length - DESCRIPTION_SEPARATOR.length,
        0
      )
    : MAX_DESCRIPTION_LENGTH;
  const body = content.description
    ? truncateText(content.description, maxBodyLength)
    : "";

  return joinDescriptionParts(body, stats);
}

function getActivityOrigin(activityUrl?: string) {
  if (!activityUrl) return "";

  try {
    return new URL(activityUrl).origin;
  } catch {
    return "";
  }
}

function getLocalPlayerUrl(content: ContentProps) {
  const activityOrigin = getActivityOrigin(content.activityUrl);
  if (!activityOrigin || !content.post) return "";

  return `${activityOrigin}/@${normalizeThreadsUsername(content.username)}/post/${
    content.post
  }/player`;
}

function getResolvedVideoUrl(content: ContentProps) {
  if (!content.video.length) return "";

  const primaryVideo = content.video[0];
  if (primaryVideo.type === "ddinstagram") return primaryVideo.url;

  if (primaryVideo.type === "instagram" && proxies.length > 0) {
    const proxy = proxies[Math.floor(Math.random() * proxies.length)];
    if (proxy) {
      return `https://${proxy}/${encodeURIComponent(primaryVideo.url)}`;
    }
  }

  return primaryVideo.url;
}

function getAbsoluteUrl(url: string, baseUrl: string) {
  if (!url || /^[a-z][a-z\d+.-]*:/i.test(url)) return url;

  try {
    return new URL(url, baseUrl).toString();
  } catch {
    return url;
  }
}

function getSeoTitle(content: ContentProps, authorName: string) {
  if (!content.title) return "FzThreads";
  if (!content.authorName) return content.title;

  return content.title.replace(content.authorName, authorName);
}

export default function renderSeo({ type, content }: DataProps) {
  if (!type || !content) {
    return "No type/content provided - this is not expected so if you're a client, report this to GitHub.";
  }

  const username = normalizeThreadsUsername(content.username);
  const url = getThreadsUrl(username, content.post);
  const authorUrl = content.authorUrl || getThreadsUrl(username);
  const rawAuthorName = formatThreadsAuthorName(content.authorName, username);
  const authorName = escape(rawAuthorName);
  const authorHandle = `@${username}`;
  const authorIcon = content.authorIcon || content.images?.[0]?.url || "";
  const footerName = "FzThreads";
  const footerIcon = content.footerIcon || DEFAULT_THREADS_ICON_URL;
  const footerFavicon =
    footerIcon === DEFAULT_THREADS_ICON_URL
      ? DEFAULT_THREADS_FAVICON_URL
      : footerIcon;
  const appleTouchIcon = DEFAULT_THREADS_TOUCH_ICON_URL;
  const footerIconMimeType = getIconMimeType(footerIcon);
  const footerFaviconMimeType = getIconMimeType(footerFavicon);
  const escapedTitle = escape(getSeoTitle(content, rawAuthorName));
  const publishedTime = content.publishedTime
    ? escape(content.publishedTime)
    : "";
  const oembedBaseUrl =
    getActivityOrigin(content.activityUrl) || "https://fzthreads.com";
  const oembedFooterIcon = getAbsoluteUrl(footerIcon, oembedBaseUrl);
  const videoUrl = getResolvedVideoUrl(content);
  const playerUrl = getLocalPlayerUrl(content);
  const hasVideo =
    !content.userAgent.includes("Telegram") && content.video.length > 0;
  const videoWidth = content.video[0]?.width || 1280;
  const videoHeight = content.video[0]?.height || 720;
  const embedDescription = getEmbedDescription(content);
  const description = escape(embedDescription);
  const htmlDescription = escape(stripDiscordSpoilerMarkers(embedDescription));
  const images = content.images || [];
  const previewImage =
    content.video[0]?.previewUrl || (images.length > 0 ? images[0].url : "") || authorIcon;
  const oembedUrl = `${oembedBaseUrl}/oembed?url=${encodeURIComponent(
    url
  )}&title=${encodeURIComponent("Embed")}&authorName=${encodeURIComponent(
    rawAuthorName
  )}&authorUrl=${encodeURIComponent(url)}&authorIcon=${encodeURIComponent(
    authorIcon
  )}&providerName=${encodeURIComponent(
    content.footerName || "FzThreads"
  )}&providerUrl=${encodeURIComponent(
    `${THREADS_PROVIDER_URL}/`
  )}&providerIcon=${encodeURIComponent(
    oembedFooterIcon
  )}&thumbnailUrl=${encodeURIComponent(
    authorIcon || previewImage
  )}&text=${encodeURIComponent(content.oembedStat)}`;
  const activityUrl = content.activityUrl || "";
  const imageTags = (
    images.length > 0 ? images : authorIcon ? [{url: authorIcon}] : []
  )
    .map(img => `<meta property="og:image" content="${img.url}" />`)
    .join("");

  return `
    <!DOCTYPE html>
    <html>
      <head>
        <link rel="canonical" href="${url}" />
        <link rel="apple-touch-icon" href="${appleTouchIcon}" />
        <link rel="icon" href="${footerFavicon}"${
          footerFaviconMimeType ? ` type="${footerFaviconMimeType}"` : ""
        } />
        <link rel="icon" href="${footerIcon}" sizes="180x180"${
          footerIconMimeType ? ` type="${footerIconMimeType}"` : ""
        } />
        <link rel="shortcut icon" href="${footerFavicon}" />
        <link rel="author" href="${authorUrl}" />
        <meta content="text/html; charset=UTF-8" http-equiv="Content-Type" />
        <meta name="theme-color" content="${DEFAULT_THEME_COLOR}" />
        <meta property="theme-color" content="${DEFAULT_THEME_COLOR}" />
        <meta property="og:url" content="${url}" />
        <meta property="og:type" content="${
          type === "post" ? "article" : "website"
        }" />
        <meta property="og:site_name" content="${footerName}" />
        <meta property="og:description" content="${description}" />
        <meta property="og:title" content="${escapedTitle}">
        <meta name="description" content="${htmlDescription}" />
        <meta name="author" content="${authorName}" />
        <meta itemprop="author" content="${authorName}" />
        <meta itemprop="headline" content="${escapedTitle}" />
        <meta itemprop="description" content="${htmlDescription}" />
        <meta name="twitter:title" content="${escapedTitle}" />
        <meta name="twitter:description" content="${description}" />
        <meta name="twitter:site" content="${THREADS_SITE_HANDLE}" />
        <meta name="twitter:creator" content="${authorHandle}" />
        ${
          type === "post"
            ? `
        <meta property="article:author" content="${authorUrl}" />
        <meta property="article:section" content="${footerName}" />`
            : ""
        }
        ${
          type === "post" && publishedTime
            ? `
        <meta property="article:published_time" content="${publishedTime}" />
        <meta property="og:article:published_time" content="${publishedTime}" />
        <meta property="article:modified_time" content="${publishedTime}" />
        <meta property="og:updated_time" content="${publishedTime}" />
        <meta name="date" content="${publishedTime}" />
        <meta itemprop="datePublished" content="${publishedTime}" />
        <meta itemprop="dateModified" content="${publishedTime}" />`
            : ""
        }

        ${
          !hasVideo
            ? `
            <meta name="twitter:card" content="${
              content.imageType === "carousel" ? "summary_large_image" : "summary"
            }" />
            ${imageTags}
            ${
              previewImage
                ? `<meta name="twitter:image" content="${previewImage}" />`
                : ""
            }`
            : `
            <meta name="twitter:card" content="player" />
            <meta name="twitter:player" content="${playerUrl || videoUrl}" />
            <meta name="twitter:player:width" content="${videoWidth}" />
            <meta name="twitter:player:height" content="${videoHeight}" />
            <meta name="twitter:player:stream" content="${videoUrl}" />
            <meta name="twitter:player:stream:content_type" content="video/mp4" />
            <meta property="og:video" content="${videoUrl}">
            <meta property="og:video:url" content="${videoUrl}">
            <meta property="og:video:secure_url" content="${videoUrl}">
            <meta property="og:video:type" content="video/mp4">
            <meta property="og:video:width" content="${videoWidth}">
            <meta property="og:video:height" content="${videoHeight}">
            ${
              previewImage
                ? `<meta property="og:image" content="${previewImage}" />
            <meta name="twitter:image" content="${previewImage}" />`
                : ""
            }
            `
        }

        ${
          activityUrl
            ? `<link rel="alternate" href="${activityUrl}" type="application/activity+json" title="${escapedTitle}">`
            : ""
        }
        <link rel="alternate" href="${oembedUrl}" type="application/json+oembed" title="${escapedTitle}">
        <meta http-equiv="refresh" content="0;url=${url}" />
      </head>
    </html>
  `;
}
