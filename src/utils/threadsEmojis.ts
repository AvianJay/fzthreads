import {createHash} from "node:crypto";

// Only Threads' image CDNs and its inline GIF provider are download sources.
// Apply this again to every redirect; never send the Discord token to a CDN.
export function emojiImageUrl(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 4096) return;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || url.port) return;
    if (!["giphy.com", "fbcdn.net", "cdninstagram.com", "threads.com", "threads.net", "instagram.com"].some(domain =>
      url.hostname === domain || url.hostname.endsWith(`.${domain}`)
    )) return;
    return url.href;
  } catch {
    return;
  }
}

export function avatarEmojiSource(value: unknown): EmojiSourceProps | undefined {
  const url = emojiImageUrl(value);
  if (!url) return;
  const parsed = new URL(url);
  const identity = `avatar:${parsed.origin}${parsed.pathname}`;
  return {
    key: createHash("sha256").update(identity).digest("hex").slice(0, 24),
    url,
    circle: true,
  };
}

export function readInlineEmoji(fragment: any): Pick<InlineEmojiProps, "key" | "url"> | undefined {
  const sticker = fragment?.inline_sticker_fragment;
  const url = emojiImageUrl(sticker?.sticker_url);
  if (!url) return;
  const id = sticker.community_inline_sticker_id || sticker.sticker_id;
  const identity = typeof id === "string" && id.length > 0 && id.length <= 200
    ? `${sticker.community_inline_sticker_id ? "community" : "sticker"}:${id}`
    : new URL(url).origin + new URL(url).pathname;
  return {key: createHash("sha256").update(identity).digest("hex").slice(0, 24), url};
}

export function postEmojis(post: ContentProps): EmojiSourceProps[] {
  return [
    ...(post.emojis || []),
    ...(post.textAttachmentEmojis || []),
    ...(post.quotedPost?.emojis || []),
    ...(post.avatarEmoji ? [post.avatarEmoji] : []),
  ];
}
