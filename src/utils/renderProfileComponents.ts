import {getThreadsUrl, normalizeThreadsUsername, publicHttpUrl} from "./utils";

type TextDisplay = {type: 10; content: string};
type LinkButton = {type: 2; style: 5; url: string; label: string};
type ProfileComponent =
  | TextDisplay
  | {
      type: 9;
      components: TextDisplay[];
      accessory: {type: 11; media: {url: string}};
    }
  | {type: 14; divider: true; spacing: 1}
  | {
      type: 1;
      components: LinkButton[];
    };

function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  // Do not split an emoji's surrogate pair or leave a dangling Markdown escape.
  return `${text.slice(0, maxLength - 1).replace(/[\\\uD800-\uDBFF]+$/, "")}…`;
}

function escapeMarkdown(text: string): string {
  return text.replace(/([\\`*_{}\[\]()<>#+\-.!|~])/g, "\\$1");
}

function formatBiography(text: string): string {
  const parts: {plain: string; markdown: string}[] = [];
  const literal = (plain: string) => parts.push({plain, markdown: escapeMarkdown(plain)});
  // Consume URLs as a whole. An @ inside a URL, email, or fediverse address
  // must not turn into a link to a different Threads account.
  const tokens = /(?:https?:\/\/|www\.)[^\s<>]+|(?<![a-z0-9_@.+%/\\-])@([a-z0-9_.]+)(?![a-z0-9_@])/gi;
  let offset = 0;
  for (const match of text.matchAll(tokens)) {
    literal(text.slice(offset, match.index));
    const handle = match[1]?.replace(/\.+$/, "");
    if (handle && handle.length <= 30) {
      const plain = `@${handle}`;
      parts.push({plain, markdown: `[${escapeMarkdown(plain)}](${getThreadsUrl(handle)})`});
      literal(match[0].slice(plain.length));
    } else {
      literal(match[0]);
    }
    offset = match.index! + match[0].length;
  }
  literal(text.slice(offset));

  const full = parts.map(part => part.markdown).join("");
  if (full.length <= 3000) return full;
  let result = "";
  for (const part of parts) {
    const remaining = 2999 - result.length;
    if (part.markdown.length <= remaining) {
      result += part.markdown;
    } else {
      // Keep generated links intact. If a link cannot fit, show its label as
      // plain text rather than leaving half a Markdown link in the preview.
      const plain = escapeMarkdown(part.plain);
      return result + (plain.length <= remaining ? `${plain}…` : truncate(plain, remaining + 1));
    }
  }
  return `${result}…`;
}

function compactViews(count: number): string {
  if (count < 1000) return String(count);
  const divisor = count >= 999950 ? 1_000_000 : 1000;
  return `${Number((count / divisor).toFixed(1))}${divisor === 1000 ? "K" : "M"}`;
}

export function buildProfileComponents(content: ContentProps) {
  if (!content.profile) return;
  const {profile} = content;
  const username = normalizeThreadsUsername(content.username);
  const stats: string[] = [];
  if (profile.followerCount !== undefined) {
    stats.push(`👤 ${profile.followerCount.toLocaleString("en-US")}`);
  }
  if (profile.publicViewCount !== undefined) {
    stats.push(`👀 ${compactViews(profile.publicViewCount)}`);
  }
  const links = profile.links
    ?.map(link => ({url: publicHttpUrl(link.url, 512), title: link.title}))
    .filter((link): link is {url: string; title: string} => Boolean(link.url));
  if (links) stats.push(`🔗 ${links.length}`);

  const badges: string[] = [];
  if (profile.isVerified === true) badges.push("✅");
  if (profile.isPrivate === true) badges.push("🔒");
  if (profile.isFederated === true) badges.push("🌐");

  const heading: TextDisplay = {
    type: 10,
    content: `### [${truncate(escapeMarkdown(profile.displayName || username), 256)}](${getThreadsUrl(username)})\n${escapeMarkdown(username)}${badges.length ? `\n-# ${badges.join(" · ")}` : ""}`,
  };
  const body = [
    formatBiography(content.description || ""),
    stats.length ? `**${stats.join(" ")}**` : "",
  ].filter(Boolean).join("\n\n");
  const text: TextDisplay[] = [heading];
  if (body) text.push({type: 10, content: body});
  const avatar = publicHttpUrl(content.authorIcon || content.images[0]?.url, 2048);
  const components: ProfileComponent[] = avatar
    ? [{type: 9, components: text, accessory: {type: 11, media: {url: avatar}}}]
    : [...text];
  const separator = {type: 14, divider: true, spacing: 1} as const;
  const buttons: LinkButton[] = (links || []).slice(0, 5).map(link => ({
    type: 2,
    style: 5,
    url: link.url,
    label: truncate(link.title.trim() || "連結", 80),
  }));
  const instagramUrl = publicHttpUrl(profile.instagramUrl, 512);
  if (instagramUrl) buttons.push({type: 2, style: 5, url: instagramUrl, label: "Instagram"});
  if (buttons.length) {
    components.push(separator);
    for (let offset = 0; offset < buttons.length; offset += 5) components.push({
      type: 1,
      components: buttons.slice(offset, offset + 5),
    });
  }
  components.push(separator, {type: 10, content: "-# FzThreads"});
  return {component: {type: 17 as const, accent_color: null, components}};
}

export default function renderProfileComponents(content: ContentProps): string {
  const payload = buildProfileComponents(content);
  if (!payload) return "";
  // Script raw text cannot use HTML entities. Escape JSON code points instead.
  const json = JSON.stringify(payload)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
  return `<script id="discord:component-embed" type="application/json">${json}</script>`;
}
