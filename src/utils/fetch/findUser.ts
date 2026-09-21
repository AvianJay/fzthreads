import fetch from "node-fetch";
import {login} from "./igLogin";
import {Deadline, FINDUSER_FETCH_MS, TOTAL_BUDGET_MS} from "./http";
import {getThreadsUrl, normalizeThreadsUsername} from "../utils";
import {debugLog} from "../debugLog";
import {
  getPublicViewCount,
  hasCompleteProfile,
  object,
  profileContent,
  profileUserId,
  ProfileQuery,
  RawProfile,
  readProfilePage,
  readProfileResponse,
} from "./profileData";

const ORIGIN = "https://www.threads.com";
const USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36";
const DIRECT_QUERY = "BarcelonaProfilePageDirectQuery";
const FALLBACK_QUERY = "BarcelonaProfilePageFallbackQuery";
// Current web query IDs, used when the HTML omits its Relay descriptors.
const QUERY_IDS = {[DIRECT_QUERY]: "26774588645572510", [FALLBACK_QUERY]: "28575850328713053"};
const BASE_PROVIDERS = {
  BarcelonaIsLoggedIn: false,
  BarcelonaMessagesHasLiveChatMessaging: false,
  BarcelonaHasEventBadge: false,
  BarcelonaShouldShowFediverseM1Features: false,
};

function defaultVariables(direct: boolean): Record<string, unknown> {
  const providers = direct ? {
    ...BASE_PROVIDERS,
    BarcelonaHasMessaging: false,
    BarcelonaIsLoggedOut: true,
    BarcelonaHasInsightsProfileM2: false,
    BarcelonaIsInternalUser: false,
    BarcelonaHasCommunitiesOrLoggedOut: true,
    BarcelonaHasWebFavicons: false,
    BarcelonaHasCommunityTopContributors: false,
    BarcelonaHasPodcastV2Production: false,
  } : BASE_PROVIDERS;
  return Object.fromEntries(Object.entries(providers)
    .map(([key, value]) => [`__relay_internal__pv__${key}relayprovider`, value]));
}

export function profileCredentialHeaders(token?: string): Record<string, string> {
  if (!token) return {};
  if (token.startsWith("COOKIE:")) {
    try {
      const cookies = object(JSON.parse(token.slice(7)));
      if (!cookies) return {};
      const header = Object.entries(cookies)
        .filter(([key, value]) => /^[\w-]+$/.test(key) && typeof value === "string" && !/[;\r\n]/.test(value))
        .map(([key, value]) => `${key}=${value}`).join("; ");
      return header ? {Cookie: header} : {};
    } catch {
      return {};
    }
  }
  return token.startsWith("Bearer ") && !/[\r\n]/.test(token) ? {Authorization: token} : {};
}

function mergeCookies(...headers: (string | undefined)[]): string {
  const jar = new Map<string, string>();
  for (const header of headers) {
    for (const part of header?.split(/;\s*/) || []) {
      const index = part.indexOf("=");
      if (index > 0) jar.set(part.slice(0, index), part.slice(index + 1));
    }
  }
  return [...jar].map(([key, value]) => `${key}=${value}`).join("; ");
}

type Dependencies = {
  fetch: typeof fetch;
  getCredential: () => Promise<string | undefined>;
  totalBudgetMs: number;
};

export function createUserFinder(dependencies: Dependencies) {
  return async function findUser({username, userAgent}: {
    username: string;
    userAgent: string;
  }): Promise<ContentProps | false> {
    username = normalizeThreadsUsername(username);
    if (!/^[a-z0-9._]+$/i.test(username)) return false;
    const deadline = new Deadline(dependencies.totalBudgetMs);
    const controller = new AbortController();
    let bestUser: RawProfile | undefined;
    let pageCookies = "";
    let html = "";
    let credential: Record<string, string> = {};
    const signal = () => AbortSignal.any([
      controller.signal,
      AbortSignal.timeout(Math.max(1, Math.min(FINDUSER_FETCH_MS, deadline.remaining()))),
    ]);
    const absorbCookies = (response: Awaited<ReturnType<typeof fetch>>) => {
      const cookies = response.headers.raw()["set-cookie"] || [];
      pageCookies = mergeCookies(pageCookies, ...cookies.map(value => value.split(";")[0]));
    };
    const result = () => bestUser ? profileContent(bestUser, userAgent) : false;

    const work = async () => {
      // Carry the anonymous cookie jar across redirects without forwarding it off-site.
      let pageUrl = getThreadsUrl(username);
      for (let hop = 0; hop < 5 && !deadline.expired() && !controller.signal.aborted; hop++) {
        const response = await dependencies.fetch(pageUrl, {
          signal: signal(),
          redirect: "manual",
          headers: {
            Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            "Accept-Language": "zh-TW,zh;q=0.9,en-US;q=0.8,en;q=0.7",
            "User-Agent": USER_AGENT,
            ...(pageCookies ? {Cookie: pageCookies} : {}),
          },
        });
        absorbCookies(response);
        const location = response.headers.get("location");
        if (response.status >= 300 && response.status < 400 && location) {
          const nextUrl = new URL(location, pageUrl);
          await response.arrayBuffer();
          if (nextUrl.origin !== ORIGIN) return;
          pageUrl = nextUrl.href;
          continue;
        }
        html = await response.text();
        if (!response.ok) return;
        break;
      }
      const page = readProfilePage(html, username);
      bestUser = page.user;
      const needsPublicViews = () => getPublicViewCount(bestUser) === undefined;
      debugLog("findUser:page", {
        username,
        hasProfile: Boolean(bestUser),
        hasPublicViews: !needsPublicViews(),
      });
      if ((hasCompleteProfile(bestUser) && !needsPublicViews()) || deadline.expired()) return;
      const lsd = html.match(/"LSD",\s*\[\],\s*\{"token":"([^"]+)"\}/)?.[1];
      if (!lsd) return;

      const query = async (direct: boolean) => {
        if (deadline.expired() || controller.signal.aborted) return;
        const name = direct ? DIRECT_QUERY : FALLBACK_QUERY;
        const descriptor: ProfileQuery | undefined = page.queries[name];
        const userID = profileUserId(bestUser) || page.queries[DIRECT_QUERY]?.variables.userID;
        if (direct && (typeof userID !== "string" || !/^\d+$/.test(userID))) return;
        const variables = {
          ...defaultVariables(direct),
          ...(direct ? {canSeeFeedsTab: true, showLinkedIGStats: false} : {}),
          ...descriptor?.variables,
          ...(direct ? {userID} : {username}),
          // A descriptor from the anonymous HTML must not override the
          // authenticated request's viewer state.
          ...(Object.keys(credential).length ? {
            __relay_internal__pv__BarcelonaIsLoggedInrelayprovider: true,
            ...(direct ? {__relay_internal__pv__BarcelonaIsLoggedOutrelayprovider: false} : {}),
          } : {}),
        };
        const cookies = mergeCookies(pageCookies, credential.Cookie);
        const csrf = cookies.match(/(?:^|;\s*)csrftoken=([^;]+)/)?.[1];
        const actor = cookies.match(/(?:^|;\s*)ds_user_id=(\d+)/)?.[1] || "0";
        const details: Record<string, string> = {
          av: actor, __user: actor, __a: "1", __comet_req: "122", lsd,
          jazoest: `2${Array.from(lsd).reduce((sum, letter) => sum + letter.charCodeAt(0), 0)}`,
          fb_api_caller_class: "RelayModern",
          fb_api_req_friendly_name: name,
          server_timestamps: "true",
          doc_id: descriptor?.queryID || QUERY_IDS[name],
          variables: JSON.stringify(variables),
        };
        const fields: Record<string, RegExp> = {
          __rev: /"client_revision":(\d+)/,
          __hsi: /"hsi":"([^"]+)"/,
          __hs: /"haste_session":"([^"]+)"/,
          __spin_r: /"__spin_r":(\d+)/,
          __spin_b: /"__spin_b":"([^"]+)"/,
          __spin_t: /"__spin_t":(\d+)/,
          __comet_req: /"comet_env":(\d+)/,
        };
        for (const [key, pattern] of Object.entries(fields)) {
          const value = html.match(pattern)?.[1];
          if (value) details[key] = value;
        }
        try {
          const response = await dependencies.fetch(`${ORIGIN}/graphql/query`, {
            method: "POST", signal: signal(), redirect: "error",
            headers: {
              "User-Agent": USER_AGENT,
              "Content-Type": "application/x-www-form-urlencoded",
              Origin: ORIGIN, Referer: getThreadsUrl(username),
              "X-Fb-Lsd": lsd,
              "X-Ig-App-Id": "238260118697367",
              "X-Fb-Friendly-Name": name,
              "X-Root-Field-Name": direct ? "xdt_text_app_user" : "xdt_text_app_user_by_username",
              ...(!Object.keys(credential).length ? {"X-Logged-Out-Threads-Migrated-Request": "true"} : {}),
              ...(csrf ? {"X-Csrftoken": csrf} : {}),
              ...credential,
              ...(cookies ? {Cookie: cookies} : {}),
            },
            body: new URLSearchParams(details).toString(),
          });
          absorbCookies(response);
          const text = await response.text();
          debugLog("findUser:query", {
            username,
            query: name,
            authenticated: Boolean(Object.keys(credential).length),
            status: response.status,
          });
          if (!response.ok) return;
          const json: unknown = JSON.parse(text.replace(/^for\s*\(;;\);\s*/, ""));
          const user = readProfileResponse(json, username);
          if (user) bestUser = {...bestUser, ...user};
          debugLog("findUser:queryResult", {
            username,
            hasProfile: Boolean(user),
            hasPublicViews: getPublicViewCount(user) !== undefined,
          });
          return user;
        } catch {
          // Do not log request details: headers and upstream errors can contain credentials.
          return;
        }
      };

      const canQueryDirect = () => Boolean(profileUserId(bestUser) || page.queries[DIRECT_QUERY]?.variables.userID);
      let usedDirectQuery = canQueryDirect();
      // A complete anonymous profile with null views needs authentication,
      // not another copy of the same anonymous result.
      let queriedUser = hasCompleteProfile(bestUser) ? bestUser : await query(usedDirectQuery);
      if ((!queriedUser || needsPublicViews()) && !deadline.expired() && !controller.signal.aborted) {
        credential = profileCredentialHeaders(await dependencies.getCredential());
        debugLog("findUser:credential", {
          username,
          kind: credential.Cookie ? "cookie" : credential.Authorization ? "bearer" : "none",
        });
        if (Object.keys(credential).length) {
          usedDirectQuery = canQueryDirect();
          queriedUser = await query(usedDirectQuery);
        }
      }
      // The username query omits public views; resolve its ID, then enrich once.
      // An authenticated DirectQuery returning null is final: never loop.
      if (!usedDirectQuery && queriedUser && !hasCompleteProfile(bestUser) && profileUserId(bestUser)) {
        await query(true);
      }
    };

    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<void>(resolve => {
      timer = setTimeout(() => { controller.abort(); resolve(); }, deadline.remaining());
    });
    try {
      await Promise.race([work().catch(() => {}), timeout]);
      return result();
    } finally {
      clearTimeout(timer);
      controller.abort();
    }
  };
}

export default createUserFinder({
  fetch,
  getCredential: async () => {
    const credential = await login();
    return credential ? credential.token : undefined;
  },
  totalBudgetMs: TOTAL_BUDGET_MS,
});
