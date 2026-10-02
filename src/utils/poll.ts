import {formatNumber} from "./utils";

function record(value: unknown): Record<string, unknown> | undefined {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return;
}

function voteCount(value: unknown): number | undefined {
  if (typeof value !== "number" && typeof value !== "string") return;
  if (typeof value === "string" && !/^\d+$/.test(value)) return;
  const count = Number(value);
  return Number.isSafeInteger(count) && count >= 0 ? count : undefined;
}

export function readPoll(value: unknown): PollProps | undefined {
  const raw = record(value);
  if (!raw) return;

  const options: PollOptionProps[] = [];
  const tallies = Array.isArray(raw.tallies) ? raw.tallies : [];
  for (const tally of tallies) {
    const option = record(tally);
    if (typeof option?.text !== "string" || !option.text.trim()) continue;
    options.push({title: option.text.trim(), votesCount: voteCount(option.count)});
  }

  // Null counts mean hidden/unavailable results, rather than zero votes.
  const hasAllCounts = options.length > 0 &&
    options.length === tallies.length &&
    options.every(option => option.votesCount !== undefined);
  const total = hasAllCounts
    ? options.reduce((sum, option) => sum + option.votesCount!, 0)
    : undefined;
  const expiresAtSeconds = voteCount(raw.expires_at);
  const expiresAtDate = expiresAtSeconds === undefined
    ? undefined
    : new Date(expiresAtSeconds * 1000);
  const expiresAt = expiresAtDate && Number.isFinite(expiresAtDate.getTime())
    ? expiresAtDate.toISOString()
    : undefined;

  return {
    id: typeof raw.poll_id === "string" || typeof raw.poll_id === "number"
      ? String(raw.poll_id)
      : undefined,
    expiresAt,
    expired: typeof raw.finished === "boolean" ? raw.finished : undefined,
    options,
    votesCount: total !== undefined && Number.isSafeInteger(total) ? total : undefined,
  };
}

export function isPollExpired(poll: PollProps): boolean {
  return poll.expired === true || Boolean(
    poll.expiresAt && Date.parse(poll.expiresAt) <= Date.now()
  );
}

function pollPercentages(poll: PollProps): number[] | undefined {
  if (poll.votesCount === undefined) return;
  if (poll.votesCount === 0) return poll.options.map(() => 0);
  const exact = poll.options.map(option => option.votesCount! / poll.votesCount! * 100);
  const percentages = exact.map(value => Math.floor(value));
  let remaining = 100 - percentages.reduce((sum, value) => sum + value, 0);
  const indices = exact.map((_, index) => index).sort((a, b) =>
    (exact[b] - percentages[b]) - (exact[a] - percentages[a])
  );
  for (const index of indices) {
    if (remaining <= 0) break;
    percentages[index]++;
    remaining--;
  }
  return percentages;
}

export function formatPollPlainText(poll?: PollProps): string {
  if (!poll) return "";
  const lines = [isPollExpired(poll) ? "📊 投票（已結束）" : "📊 投票"];
  if (poll.options.length === 0) {
    lines.push("選項與票數暫時無法取得");
  } else {
    const percentages = pollPercentages(poll);
    for (const [index, option] of poll.options.entries()) {
      const count = option.votesCount;
      const percentage = percentages ? `${percentages[index]}%` : undefined;
      const result = count === undefined ? "" : percentage === undefined
        ? ` — ${formatNumber(count)} 票`
        : ` — ${percentage}（${formatNumber(count)} 票）`;
      // Literal || in an option must not turn into Discord spoiler markup.
      lines.push(`◯ ${option.title.replace(/\|\|/g, "\\|\\|")}${result}`);
    }
    if (poll.votesCount !== undefined) {
      lines.push(`🗳️ 共 ${formatNumber(poll.votesCount)} 票`);
    }
  }
  return lines.join("\n");
}

export function appendPollToPlainText(description: string, poll?: PollProps): string {
  const text = formatPollPlainText(poll);
  return description && text ? `${description}\n\n${text}` : description || text;
}

export function renderPoll(poll: PollProps | undefined, fallbackId: string) {
  // Mastodon's votes_count is required to be an integer. Unknown results
  // remain visible through the text fallback instead of an invalid poll object.
  if (!poll?.options.length || poll.votesCount === undefined) return null;
  return {
    id: poll.id || `${fallbackId}-poll`,
    expires_at: poll.expiresAt || null,
    expired: isPollExpired(poll),
    multiple: false,
    votes_count: poll.votesCount,
    voters_count: null,
    options: poll.options.map(option => ({
      title: option.title,
      votes_count: option.votesCount ?? null,
    })),
    emojis: [],
  };
}
