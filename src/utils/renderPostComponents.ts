import {
  COMPONENT_EMBED_MAX_BYTES,
  ComponentEmbed,
  DiscordComponent,
  GalleryItem,
  TextDisplay,
  componentJson,
  componentScript,
  discordTextFormatter,
  formatDiscordText,
  markdownLink,
  truncateText,
} from "./discordComponents";
import {parseDiscordSpoilerSegments, stripDiscordSpoilerMarkers} from "./contentFormat";
import {appendPollToPlainText, formatPollPlainText} from "./poll";
import {
  formatNumber,
  formatThreadsAuthorName,
  getThreadsUrl,
  normalizeThreadsUsername,
  publicHttpUrl,
} from "./utils";

function postMedia(content: ContentProps): GalleryItem[] {
  const previews = new Set(content.video.map(video => video.previewUrl));
  const images = (content.images || []).filter(image =>
    image.url !== content.authorIcon && !previews.has(image.url)
  );
  const seen = new Set<string>();
  return [...images, ...content.video]
    .sort((a, b) => (a.position ?? 0) - (b.position ?? 0))
    .flatMap(item => {
      const url = publicHttpUrl(item.url, 2048);
      if (!url || seen.has(url)) return [];
      seen.add(url);
      return [{
        media: {url},
        ...(item.spoiler === true ? {spoiler: true} : {}),
        ...(item.description ? {description: truncateText(item.description, 160)} : {}),
      }];
    }).slice(0, 10);
}

function attachmentFormatter(
  text: string, emojis: InlineEmojiProps[] = [], resolved: Record<string, DiscordEmojiProps> = {}
): (limit: number) => string {
  // Discord does not render spoilers or emoji in code blocks. Use the same
  // formatter for cached and missing emoji so pending placeholders stay hidden.
  if (parseDiscordSpoilerSegments(text).some(segment => segment.isSpoiler) ||
    emojis.length > 0) {
    return discordTextFormatter(text, emojis, resolved);
  }
  const literal = stripDiscordSpoilerMarkers(text).replace(/`/g, "`\u200b");
  return (limit: number) => literal && limit >= 9
    ? `\`\`\`\n${truncateText(literal, limit - 8)}\n\`\`\`` : "";
}

function shareTextBudget(lengths: number[], budget: number): number[] {
  const limits = lengths.map(() => 0);
  while (budget > 0) {
    const pending = lengths.map((length, index) => ({length, index}))
      .filter(({length, index}) => limits[index] < length);
    if (!pending.length) break;
    const share = Math.max(1, Math.floor(budget / pending.length));
    for (const {length, index} of pending) {
      const amount = Math.min(share, length - limits[index], budget);
      limits[index] += amount;
      budget -= amount;
    }
  }
  return limits;
}

export function buildPostComponents(content: ContentProps): ComponentEmbed {
  const username = normalizeThreadsUsername(content.username);
  const profileUrl = getThreadsUrl(username);
  const displayName = content.authorDisplayName ||
    formatThreadsAuthorName(content.authorName, username).replace(` (@${username})`, "");
  const author = `**${markdownLink(truncateText(displayName, 128), profileUrl)}**` +
    (content.isVerified === true ? " <:verified:1557576231770128496>" : "");
  const topic = content.topicTag?.trim();
  const handle = markdownLink(username, profileUrl) + (topic
    ? ` > ${markdownLink(truncateText(topic, 80), `https://www.threads.com/search?q=${encodeURIComponent(topic)}`)}` : "");
  const counts = [content.likeCount, content.replyCount, content.repostCount, content.sendCount];
  const stats = ["❤️", "💬", "🔄", "✈️"].flatMap((emoji, i) => {
    const count = counts[i];
    return typeof count === "number" && Number.isFinite(count) && count >= 0
      ? [`${emoji} ${formatNumber(count)}`] : [];
  }).join(" ") || formatDiscordText(content.oembedStat || "", 200);
  const heading: TextDisplay = {
    type: 10, content: `${author}\n${handle}${stats ? `\n\n**${stats}**` : ""}`,
  };
  const reply = content.replyToUsername
    ? `⤴️ 正在回覆 ${markdownLink(content.replyToUsername, getThreadsUrl(content.replyToUsername))}` : "";
  const quote = content.quotedPost?.quoted && content.quotedPost.username ? content.quotedPost : undefined;
  const quoteHeader = quote
    ? `> 引用 ${markdownLink(`@${quote.username}`, getThreadsUrl(quote.username, quote.post))}` : "";
  const quoteText = quote ? appendPollToPlainText(quote.caption, quote.poll) : "";
  const caption = content.caption ?? content.description ?? "";
  const poll = formatPollPlainText(content.poll);
  const attachment = content.textAttachment || "";
  const renderers = [
    discordTextFormatter(caption, content.emojis, content.discordEmojis),
    discordTextFormatter(quoteText, quote?.emojis, content.discordEmojis),
    discordTextFormatter(poll),
    attachmentFormatter(attachment, content.textAttachmentEmojis, content.discordEmojis),
  ];
  const fullText = renderers.map(render => render(4000));
  const lengths = fullText.map(text => text.length);
  const timestamp = content.publishedTime ? Date.parse(content.publishedTime) : NaN;
  const footer = "-# <:fzthreads:1563516195968258058> FzThreads" +
    (Number.isFinite(timestamp) ? ` | <t:${Math.floor(timestamp / 1000)}:f>` : "");
  const media = postMedia(content);
  const avatar = publicHttpUrl(content.authorIcon, 2048);

  const makePayload = (textBudget: number, mediaLimit: number, includeAvatar: boolean): ComponentEmbed => {
    const limits = shareTextBudget(lengths, textBudget);
    const [bodyText, quotedText, pollText, attachmentBody] = renderers.map((render, i) => render(limits[i]));
    const quoted = quoteHeader + (quotedText ? `\n${quotedText.split("\n").map(line => `> ${line}`).join("\n")}` : "");
    const body = [reply, quoted, bodyText, pollText].filter(Boolean).join("\n\n");
    const text: TextDisplay[] = [heading];
    if (body) text.push({type: 10, content: body});
    const components: DiscordComponent[] = includeAvatar && avatar
      ? [{type: 9, components: text, accessory: {type: 11, media: {url: avatar}}}]
      : [...text];
    if (attachmentBody) {
      components.push({type: 14, divider: true, spacing: 1}, {type: 10, content: attachmentBody});
    }
    if (mediaLimit > 0) components.push({type: 12, items: media.slice(0, mediaLimit)});
    components.push({type: 10, content: footer});
    return {component: {type: 17, accent_color: 0, components}};
  };
  const fits = (payload: ComponentEmbed) =>
    Buffer.byteLength(componentJson(payload), "utf8") <= COMPONENT_EMBED_MAX_BYTES;

  // Reserve some text before admitting more CDN URLs, which can be very long.
  let mediaLimit = media.length;
  let includeAvatar = Boolean(avatar);
  const minimumText = Math.min(256, lengths.reduce((sum, length) => sum + length, 0));
  while (mediaLimit > 1 && !fits(makePayload(minimumText, mediaLimit, includeAvatar))) mediaLimit--;
  if (!fits(makePayload(minimumText, mediaLimit, includeAvatar))) includeAvatar = false;
  if (!fits(makePayload(minimumText, mediaLimit, includeAvatar))) mediaLimit = 0;
  let low = 0;
  let high = 4000;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (fits(makePayload(mid, mediaLimit, includeAvatar))) low = mid;
    else high = mid - 1;
  }
  return makePayload(low, mediaLimit, includeAvatar);
}

export default function renderPostComponents(content: ContentProps): string {
  const payload = buildPostComponents(content);
  // Malformed upstream metadata must still leave Open Graph as a usable fallback.
  if (Buffer.byteLength(componentJson(payload), "utf8") > COMPONENT_EMBED_MAX_BYTES) return "";
  return componentScript(payload);
}
