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

function formatNumber(num: number): string {
  return num.toLocaleString();
}

function getThreadsUrl(username: string, postCode?: string): string {
  const normalizedUsername = username.startsWith("@")
    ? username
    : `@${username}`;
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
  getThreadsUrl,
  normalizeThreadsPostCode,
  encodeThreadsPostCode,
  decodeThreadsPostId,
};
