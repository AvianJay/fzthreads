import {getThreadsUrl, normalizeThreadsUsername, publicHttpUrl} from "./utils";

type TextDisplay = {type: 10; content: string};
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
      components: {type: 2; style: 5; url: string; label: string}[];
    };

function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  // Do not split an emoji's surrogate pair or leave a dangling Markdown escape.
  return `${text.slice(0, maxLength - 1).replace(/[\\\uD800-\uDBFF]+$/, "")}…`;
}

function escapeMarkdown(text: string): string {
  return text.replace(/([\\`*_{}\[\]()<>#+\-.!|~])/g, "\\$1");
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

  const heading: TextDisplay = {
    type: 10,
    content: `### [${truncate(escapeMarkdown(profile.displayName || username), 256)}](${getThreadsUrl(username)})\n${escapeMarkdown(username)}`,
  };
  const body = [
    truncate(escapeMarkdown(content.description || ""), 3000),
    stats.length ? `**${stats.join(" ")}**` : "",
  ].filter(Boolean).join("\n\n");
  const text: TextDisplay[] = [heading];
  if (body) text.push({type: 10, content: body});
  const avatar = publicHttpUrl(content.authorIcon || content.images[0]?.url, 2048);
  const components: ProfileComponent[] = avatar
    ? [{type: 9, components: text, accessory: {type: 11, media: {url: avatar}}}]
    : [...text];
  const separator = {type: 14, divider: true, spacing: 1} as const;
  if (links?.length) {
    components.push(separator, {
      type: 1,
      components: links.slice(0, 5).map(link => ({
        type: 2,
        style: 5,
        url: link.url,
        label: truncate(link.title.trim() || "連結", 80),
      })),
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
