import {getThreadsUrl, publicHttpUrl} from "./utils";

export type TextDisplay = {type: 10; content: string};
export type GalleryItem = {
  media: {url: string};
  spoiler?: boolean;
  description?: string;
};
export type DiscordComponent =
  | TextDisplay
  | {type: 9; components: TextDisplay[]; accessory: {type: 11; media: {url: string}}}
  | {type: 12; items: GalleryItem[]}
  | {type: 14; divider: boolean; spacing: 1};
export type ComponentEmbed = {
  component: {type: 17; accent_color: number | null; components: DiscordComponent[]};
};

// This is a byte limit on the escaped JSON, including media URLs and metadata.
export const COMPONENT_EMBED_MAX_BYTES = 3000;

export function authorBadges(author: {isVerified?: boolean; isFederated?: boolean}): string {
  return [
    author.isVerified === true ? "<:verified:1557576231770128496>" : "",
    author.isFederated === true ? "<:fediverse:1564218539814944908>" : "",
  ].filter(Boolean).join(" ");
}

export function componentJson(payload: ComponentEmbed): string {
  return JSON.stringify(payload)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

export function componentScript(payload: ComponentEmbed): string {
  return `<script id="discord:component-embed" type="application/json">${componentJson(payload)}</script>`;
}

export function truncateText(text: string, limit: number): string {
  if (limit <= 0) return "";
  if (text.length <= limit) return text;
  return `${text.slice(0, limit - 1).replace(/[\uD800-\uDBFF]$/, "")}…`;
}

export function escapeMarkdown(text: string): string {
  return text.replace(/([\\`*_{}\[\]()<>#+\-.!|~])/g, "\\$1");
}

export function markdownLink(label: string, url: string): string {
  const destination = url.replace(/\(/g, "%28").replace(/\)/g, "%29")
    .replace(/</g, "%3C").replace(/>/g, "%3E").replace(/\\/g, "%5C");
  // These brackets and parentheses are the link delimiters themselves. Do
  // not put backslashes inside the generated `[]()` syntax.
  const linkLabel = escapeMarkdown(label).replace(/\\([\[\]()_.-])/g, "$1");
  return `[${linkLabel}](${destination})`;
}

function textTokens(text: string): string[] {
  const tokens: string[] = [];
  const literal = (value: string) => {
    for (const character of value) tokens.push(escapeMarkdown(character));
  };
  // URLs, email addresses and fediverse handles must not become Threads mentions.
  const pattern = /(?:https?:\/\/|www\.)[^\s<>]+|(?<![a-z0-9_@.+%/\\-])@([a-z0-9_.]+)(?![a-z0-9_@])/gi;
  let offset = 0;
  for (const match of text.matchAll(pattern)) {
    literal(text.slice(offset, match.index));
    const handle = match[1]?.replace(/\.+$/, "");
    if (handle && handle.length <= 30) {
      tokens.push(markdownLink(`@${handle}`, getThreadsUrl(handle)));
      literal(match[0].slice(handle.length + 1));
    } else {
      const url = publicHttpUrl(match[0], 2048);
      if (url) tokens.push(`<${url.replace(/\|/g, "%7C")}>`);
      else literal(match[0]);
    }
    offset = match.index! + match[0].length;
  }
  literal(text.slice(offset));
  return tokens;
}

// Only the upstream spoiler markers are interpreted as markup. All generated
// links and escaped characters remain atomic when a long preview is shortened.
export function discordTextFormatter(
  text: string,
  emojis: InlineEmojiProps[] = [],
  resolved: Record<string, DiscordEmojiProps> = {}
): (limit: number) => string {
  const replacements = new Map<number, {length: number; markup: string}>();
  for (const emoji of emojis) {
    if (!Number.isInteger(emoji.offset) || !Number.isInteger(emoji.length) ||
      emoji.offset < 0 || emoji.length <= 0 || emoji.offset + emoji.length > text.length) continue;
    const cached = resolved[emoji.key];
    const available = cached && /^\d{1,20}$/.test(cached.id) && /^[A-Za-z0-9_]{2,32}$/.test(cached.name);
    replacements.set(emoji.offset, {
      length: emoji.length,
      markup: available ? `<${cached.animated ? "a" : ""}:${cached.name}:${cached.id}>` : "",
    });
  }
  // Interpret only extracted emoji spans. User-authored <:name:id> stays escaped.
  // Scan the original text so escaped literal pipes do not shift emoji offsets.
  const segments: {tokens: string[]; wrapper: string}[] = [];
  let tokens: string[] = [];
  let literal = "";
  let wrapper = "";
  const flush = () => {tokens.push(...textTokens(literal)); literal = "";};
  for (let i = 0; i < text.length;) {
    const emoji = replacements.get(i);
    if (emoji) {
      flush();
      if (emoji.markup) tokens.push(emoji.markup);
      i += emoji.length;
    } else if (text.startsWith("\\|\\|", i)) {
      literal += "||";
      i += 4;
    } else if (text.startsWith("||", i)) {
      flush();
      if (tokens.length) segments.push({tokens, wrapper});
      tokens = [];
      wrapper = wrapper ? "" : "||";
      i += 2;
    } else {
      literal += text[i++];
    }
  }
  flush();
  if (tokens.length) segments.push({tokens, wrapper});
  const full = segments.map(({tokens, wrapper}) => wrapper + tokens.join("") + wrapper).join("");
  return (limit: number) => {
    if (limit <= 0) return "";
    if (full.length <= limit) return full;
    let result = "";
    for (const {tokens, wrapper} of segments) {
      const available = limit - result.length - wrapper.length * 2 - 1;
      if (available < 0) return `${result}…`;
      let part = "";
      for (const token of tokens) {
        if (part.length + token.length > available) {
          return `${result}${wrapper}${part}…${wrapper}`;
        }
        part += token;
      }
      result += wrapper + part + wrapper;
    }
    return result;
  };
}

export function formatDiscordText(text: string, limit = 4000): string {
  return discordTextFormatter(text)(limit);
}
