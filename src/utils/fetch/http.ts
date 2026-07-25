function envMs(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

// Per-request total budget. Discord's crawler gives up around 5s, so the
// response must resolve (or fail) inside this window — enforced by the
// deadline race in loadPost, not by the per-fetch signals.
export const TOTAL_BUDGET_MS = envMs("TOTAL_BUDGET_MS", 4500);
// Per-fetch caps are deliberately larger than the response budget: they only
// exist to stop minutes-long TCP hangs. A query that outlives the response
// deadline keeps running and its result is salvaged into the post cache, so
// Discord's automatic re-crawl of the same link hits.
export const PAGE_CONTEXT_FETCH_MS = envMs("PAGE_CONTEXT_FETCH_MS", 6000);
export const GRAPHQL_POST_MS = envMs("GRAPHQL_POST_MS", 8000);
export const IG_BOOTSTRAP_MS = envMs("IG_BOOTSTRAP_MS", 3000);
export const LEGACY_QUERY_MS = envMs("LEGACY_QUERY_MS", 8000);
export const SHARE_RESOLVE_MS = envMs("SHARE_RESOLVE_MS", 3500);
export const FINDUSER_FETCH_MS = envMs("FINDUSER_FETCH_MS", 8000);

// Below this remaining budget it is not worth starting another upstream call.
export const MIN_REMAINING_MS = 250;

export class Deadline {
  private readonly expiresAt: number;

  constructor(totalMs: number) {
    this.expiresAt = Date.now() + totalMs;
  }

  remaining(): number {
    return Math.max(0, this.expiresAt - Date.now());
  }

  expired(): boolean {
    return this.remaining() <= MIN_REMAINING_MS;
  }
}

// The deadline decides when to STOP STARTING work (expired() checks) and when
// the response returns (the race in loadPost) — but an already-started fetch
// runs to its own cap even past the deadline, so its late result can be
// salvaged into the cache for the next crawl of the same link.
export function signalFor(
  _deadline: Deadline | undefined,
  capMs: number
): AbortSignal {
  return AbortSignal.timeout(capMs);
}

export {envMs};
