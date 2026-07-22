import escape from "escape-html";
import {getThreadsUrl, normalizeThreadsUsername} from "./utils";

const HAIR_SPACE = " ";
// Discord collapses consecutive <br> tags; a hair space between them keeps the blank line.
const HTML_BLANK_LINE = `<br>${HAIR_SPACE}<br>`;
// Discord's Mastodon renderer has no spoiler markup (span is unsupported, raw ||
// gets markdown-escaped), so spoiler segments are masked in the activity HTML.
const SPOILER_MASK = "⬛劇透⬛";
const SPOILER_WARNING_TEXT = "劇透";
const QUOTE_PREFIX = "↪ 引用";

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

function stripDiscordSpoilerMarkers(text: string): string {
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

// The URL lookbehind class includes #;=& so HTML entities produced by escape()
// (e.g. &#39;) inside a URL still suppress mention matching.
const MENTION_REGEX =
  /(?<!https?:\/\/[\w.\-%$@&?!:;/'()*#=~+]+)(?<![\w.@])@([A-Za-z0-9._]+)/g;

function linkifyMentions(escapedHtml: string): string {
  return escapedHtml.replace(MENTION_REGEX, (match, capture: string) => {
    const trailingDots = capture.match(/\.+$/)?.[0] || "";
    const username = trailingDots
      ? capture.slice(0, -trailingDots.length)
      : capture;

    if (!username) return match;

    return `<a href="${getThreadsUrl(username)}">@${username}</a>${trailingDots}`;
  });
}

function renderRichTextHtml(text: string): {html: string; hasSpoiler: boolean} {
  const segments = parseDiscordSpoilerSegments(text);
  const html = segments
    .map(segment => {
      if (segment.isSpoiler) return SPOILER_MASK;

      return linkifyMentions(escape(segment.text)).replace(/\r?\n/g, "<br>");
    })
    .join("");

  return {
    html,
    hasSpoiler: segments.some(segment => segment.isSpoiler),
  };
}

function collectMentions(text: string): string[] {
  const usernames = new Set<string>();

  for (const match of text.matchAll(MENTION_REGEX)) {
    const username = match[1].replace(/\.+$/, "");
    if (username) usernames.add(username);
  }

  return [...usernames];
}

function buildQuotePlainText(quotedPost?: QuotedPostProps): string {
  if (!quotedPost?.quoted || !quotedPost.username) return "";

  const username = normalizeThreadsUsername(quotedPost.username);
  const header = `${QUOTE_PREFIX} @${username}`;
  const caption = quotedPost.caption.trim();

  if (!caption) return header;

  const quotedLines = caption
    .split("\n")
    .map(line => `> ${line}`)
    .join("\n");

  return `${header}\n${quotedLines}`;
}

function appendQuoteToPlainText(
  description: string,
  quotedPost?: QuotedPostProps
): string {
  const quoteText = buildQuotePlainText(quotedPost);

  if (!quoteText) return description;
  if (!description) return quoteText;

  return `${description}\n\n${quoteText}`;
}

export {
  HTML_BLANK_LINE,
  QUOTE_PREFIX,
  SPOILER_MASK,
  SPOILER_WARNING_TEXT,
  appendQuoteToPlainText,
  collectMentions,
  linkifyMentions,
  parseDiscordSpoilerSegments,
  renderRichTextHtml,
  stripDiscordSpoilerMarkers,
};
