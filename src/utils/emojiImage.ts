import fetch, {RequestInit, Response} from "node-fetch";
import sharp from "sharp";
import {Readable} from "node:stream";
import {emojiImageUrl} from "./threadsEmojis";

export type EmojiFetch = (url: string, init?: RequestInit) => Promise<Response>;
export const MAX_EMOJI_BYTES = 256 * 1024;
const MAX_DOWNLOAD_BYTES = 5 * 1024 * 1024;
export interface EmojiImageOptions {
  circle?: boolean;
}

export async function downloadEmojiImage(url: string, fetchImage: EmojiFetch = fetch): Promise<Buffer> {
  for (let redirects = 0; redirects <= 3; redirects++) {
    const safeUrl = emojiImageUrl(url);
    if (!safeUrl) throw new Error("Unsupported emoji image host");
    const response = await fetchImage(safeUrl, {
      redirect: "manual", size: MAX_DOWNLOAD_BYTES, signal: AbortSignal.timeout(10000),
    });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      if (response.body instanceof Readable) response.body.destroy();
      const location = response.headers.get("location");
      if (!location) break;
      url = new URL(location, safeUrl).href;
      continue;
    }
    if (!response.ok) {
      if (response.body instanceof Readable) response.body.destroy();
      throw new Error("Unable to download emoji image");
    }
    if (Number(response.headers.get("content-length")) > MAX_DOWNLOAD_BYTES) {
      if (response.body instanceof Readable) response.body.destroy();
      throw new Error("Emoji download is too large");
    }
    const buffer = Buffer.from(await response.arrayBuffer());
    if (!buffer.length || buffer.length > MAX_DOWNLOAD_BYTES) throw new Error("Invalid emoji image size");
    return buffer;
  }
  throw new Error("Too many emoji image redirects");
}

export async function encodeEmojiImage(input: Buffer, imageOptions: EmojiImageOptions = {}): Promise<string> {
  const options = {animated: true, limitInputPixels: 32 * 1024 * 1024};
  const metadata = await sharp(input, options).metadata();
  if (!["png", "jpeg", "gif", "webp", "heif"].includes(metadata.format || "")) {
    throw new Error("Unsupported emoji image format");
  }
  const animated = (metadata.pages || 1) > 1;
  // Preserve the original animation when it already fits Discord's limits.
  if (!imageOptions.circle && metadata.format === "gif" && input.length <= MAX_EMOJI_BYTES &&
    (metadata.width || 0) <= 128 && (metadata.pageHeight || metadata.height || 0) <= 128) {
    return `data:image/gif;base64,${input.toString("base64")}`;
  }
  for (const size of [128, 96, 64]) {
    let pipeline = sharp(input, options).resize(size, size, {
      fit: imageOptions.circle ? "cover" : "contain",
      background: {r: 0, g: 0, b: 0, alpha: 0},
    });
    if (imageOptions.circle) {
      const mask = Buffer.from(`<svg width="${size}" height="${size}"><circle cx="${size / 2}" cy="${size / 2}" r="${size / 2}" fill="white"/></svg>`);
      pipeline = pipeline.composite([{input: mask, blend: "dest-in"}]);
    }
    pipeline = pipeline.timeout({seconds: 10});
    const output = await (animated
      ? pipeline.gif({colours: size === 128 ? 128 : 64, effort: 3})
      : pipeline.png()).toBuffer();
    if (output.length <= MAX_EMOJI_BYTES) {
      return `data:image/${animated ? "gif" : "png"};base64,${output.toString("base64")}`;
    }
  }
  throw new Error("Emoji image is too large after resizing");
}
