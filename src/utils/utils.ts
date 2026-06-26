/* Error Builder */
class HttpError {
  statusCode: number;
  errMessage: string;

  constructor(statusCode: number, errMessage: string) {
    this.statusCode = statusCode;
    this.errMessage = errMessage;
  }
}

let GlobalVars = {
  name: "FixThreads",
};

const THREADS_POST_ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const THREADS_ACCOUNT_DOMAIN_SUFFIX =
  /@(?:www\.)?threads\.(?:com|net)$/i;

function formatNumber(num: number): string {
  return num.toLocaleString();
}

function normalizeThreadsUsername(username: string): string {
  return username
    .trim()
    .replace(/^@+/, "")
    .replace(THREADS_ACCOUNT_DOMAIN_SUFFIX, "");
}

function stripThreadsAuthorHandleSuffix(
  authorName: string,
  username: string
): string {
  const normalizedUsername = normalizeThreadsUsername(username);
  const trimmedAuthorName = authorName.trim();
  const suffixes = [
    ` (@${normalizedUsername})`,
    ` (@${normalizedUsername}@www.threads.com)`,
    ` (@${normalizedUsername}@threads.com)`,
    ` (@${normalizedUsername}@www.threads.net)`,
    ` (@${normalizedUsername}@threads.net)`,
  ];
  const matchedSuffix = suffixes.find(suffix =>
    trimmedAuthorName.toLowerCase().endsWith(suffix.toLowerCase())
  );

  if (!matchedSuffix) return trimmedAuthorName;

  return trimmedAuthorName.slice(0, -matchedSuffix.length).trim();
}

function formatThreadsAuthorName(
  authorName: string | null | undefined,
  username: string
): string {
  const normalizedUsername = normalizeThreadsUsername(username);
  const trimmedAuthorName = authorName?.trim() || "";

  if (!trimmedAuthorName) return `@${normalizedUsername}`;

  const displayName = stripThreadsAuthorHandleSuffix(
    trimmedAuthorName,
    normalizedUsername
  );
  const normalizedDisplayName = normalizeThreadsUsername(displayName);

  if (
    normalizedDisplayName.toLowerCase() === normalizedUsername.toLowerCase()
  ) {
    return normalizedUsername;
  }

  return `${displayName} (@${normalizedUsername})`;
}

function getThreadsUrl(username: string, postCode?: string): string {
  const normalizedUsername = `@${normalizeThreadsUsername(username)}`;
  return `https://www.threads.com/${normalizedUsername}${postCode ? `/post/${postCode}` : ""}`;
}

function normalizeThreadsPostCode(postCode: string): string {
  return postCode.split("?")[0].replace(/\s/g, "").replace(/\//g, "");
}

function encodeThreadsPostCode(postCode: string): string {
  const normalizedPostCode = normalizeThreadsPostCode(postCode);
  let postId = 0n;

  for (const letter of normalizedPostCode) {
    postId =
      postId * 64n + BigInt(THREADS_POST_ALPHABET.indexOf(letter));
  }

  return postId.toString();
}

function decodeThreadsPostId(postId: string): string | undefined {
  if (!/^\d+$/.test(postId)) return;

  let remainingValue = BigInt(postId);
  if (remainingValue === 0n) return THREADS_POST_ALPHABET[0];

  let postCode = "";

  while (remainingValue > 0n) {
    const currentIndex = Number(remainingValue % 64n);
    postCode = THREADS_POST_ALPHABET[currentIndex] + postCode;
    remainingValue /= 64n;
  }

  return postCode;
}

export {
  HttpError,
  GlobalVars,
  formatNumber,
  formatThreadsAuthorName,
  getThreadsUrl,
  normalizeThreadsUsername,
  normalizeThreadsPostCode,
  encodeThreadsPostCode,
  decodeThreadsPostId,
};
