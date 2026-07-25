import {promises as fsPromises} from "node:fs";

const DEBUG_LOG_FILE = "./runtime-debug.log";
const FLUSH_INTERVAL_MS = 500;
const FLUSH_THRESHOLD_BYTES = 64 * 1024;

const enabled = Boolean(
  process.env.RUNTIME_DEBUG && process.env.RUNTIME_DEBUG !== "0"
);

let buffer: string[] = [];
let bufferBytes = 0;
let flushing = false;
let flushTimer: NodeJS.Timeout | undefined;

async function flush() {
  if (flushing || buffer.length === 0) return;
  flushing = true;

  const pending = buffer.join("");
  buffer = [];
  bufferBytes = 0;

  try {
    await fsPromises.appendFile(DEBUG_LOG_FILE, pending);
  } catch {
    // Ignore debug logging errors.
  } finally {
    flushing = false;
  }
}

function ensureFlushTimer() {
  if (flushTimer) return;
  flushTimer = setInterval(() => {
    void flush();
  }, FLUSH_INTERVAL_MS);
  flushTimer.unref();
  process.on("beforeExit", () => {
    void flush();
  });
}

export function debugLog(
  step: string,
  details?: Record<string, string | number | boolean | undefined | null>
) {
  if (!enabled) return;

  const line = `${JSON.stringify({
    time: new Date().toISOString(),
    step,
    ...details,
  })}\n`;
  buffer.push(line);
  bufferBytes += line.length;

  ensureFlushTimer();
  if (bufferBytes >= FLUSH_THRESHOLD_BYTES) void flush();
}
