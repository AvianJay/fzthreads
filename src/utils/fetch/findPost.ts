import fetch from "node-fetch";
import {execFile} from "node:child_process";
import {randomUUID} from "node:crypto";
import {appendFileSync} from "node:fs";
import https from "node:https";
import {promisify} from "node:util";
import { login, refreshToken } from "./igLogin";
import {
  encodeThreadsPostCode,
  formatThreadsAuthorName,
  formatNumber,
  normalizeThreadsUsername,
  normalizeThreadsPostCode,
} from "../utils";

const THREADS_ICON_URL = "/favicon.png";
const THREADS_APP_ID = "238260118697367";
const THREADS_POST_PAGE_DOC_ID = "35925052163752604";
const THREADS_LEGACY_POST_DOC_ID = "7448594591874178";
const THREADS_DEFAULT_LSD = "hgmSkqDnLNFckqa7t1vJdn";
const THREADS_BROWSER_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36";
const THREADS_RUNTIME_DEBUG_FILE = "./runtime-debug.log";
// Reduced from 3 to 1 for faster response (Discord crawler timeout is ~10s)
const THREADS_POST_PAGE_MAX_ATTEMPTS = 1;
// Quick timeout for initial requests - will fallback to faster methods if fails
const THREADS_QUICK_TIMEOUT_MS = 8_000;
const FIND_POST_CACHE_TTL_MS = 60 * 1000;
const THREADS_WEB_SESSION_ID_LENGTH = 6;
const THREADS_SEC_CH_UA =
  '"Google Chrome";v="147", "Not.A/Brand";v="8", "Chromium";v="147"';
const THREADS_SEC_CH_UA_FULL_VERSION_LIST =
  '"Google Chrome";v="147.0.7727.137", "Not.A/Brand";v="8.0.0.0", "Chromium";v="147.0.7727.137"';
const THREADS_SEC_CH_UA_PLATFORM = '"macOS"';
const THREADS_SEC_CH_UA_PLATFORM_VERSION = '"15.5.0"';
const THREADS_SEC_CH_UA_MODEL = '""';
const THREADS_HTTPS_AGENT = new https.Agent({
  family: 4,
  keepAlive: true,
});
const THREADS_GENERATED_IG_DID = randomUUID().toUpperCase();
const execFileAsync = promisify(execFile);
const findPostCache = new Map<
  string,
  {
    expiresAt: number;
    value: Omit<ContentProps, "userAgent"> | false;
  }
>();
const findPostInflight = new Map<
  string,
  Promise<Omit<ContentProps, "userAgent"> | false>
>();

type ThreadsPageContext = {
  cookieHeader?: string;
  csrfToken?: string;
  csr?: string;
  dyn?: string;
  hblp?: string;
  hs?: string;
  hsdp?: string;
  lsd: string;
  referer: string;
  sjsp?: string;
  siteData: {
    clientRevision?: string;
    cometEnv?: string;
    hasteSession?: string;
    hsi?: string;
    spinB?: string;
    spinR?: string;
    spinT?: string;
  };
  webBloksVersionId?: string;
};

type ThreadsPostPageQueryResult = {
  host: string;
  responseJson?: any;
  responseMessage?: string;
  status: number;
};

function writeRuntimeDebug(
  step: string,
  details?: Record<string, string | number | boolean | undefined | null>
) {
  try {
    appendFileSync(
      THREADS_RUNTIME_DEBUG_FILE,
      `${JSON.stringify({
        time: new Date().toISOString(),
        step,
        ...details,
      })}\n`
    );
  } catch (e) {
    // Ignore debug logging errors.
  }
}

function getCount(...values: any[]): number {
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }

    if (typeof value === "string") {
      const parsedValue = Number(value.replace(/,/g, ""));
      if (Number.isFinite(parsedValue)) return parsedValue;
    }
  }

  return 0;
}

function getStringMatch(text: string, pattern: RegExp): string | undefined {
  return text.match(pattern)?.[1];
}

function getJazoest(token: string): string {
  return `2${Array.from(token).reduce(
    (sum, character) => sum + character.charCodeAt(0),
    0
  )}`;
}

function getRandomSessionID(): string {
  const part = () => Math.random().toString(36).slice(2, 8);
  return `${part()}:${part()}:${part()}`;
}

function getRandomRequestID(): string {
  return Math.random().toString(36).slice(2, 2 + THREADS_WEB_SESSION_ID_LENGTH);
}

function encodeFormBody(details: Record<string, string>): string {
  return new URLSearchParams(details).toString();
}

function parseCookieSegments(cookieHeader: string): Map<string, string> {
  const cookies = new Map<string, string>();

  for (const segment of cookieHeader.split(/;\s*/)) {
    const trimmedSegment = segment.trim();
    if (!trimmedSegment) continue;
    const separatorIndex = trimmedSegment.indexOf("=");
    if (separatorIndex <= 0) continue;

    const key = trimmedSegment.slice(0, separatorIndex).trim();
    const value = trimmedSegment.slice(separatorIndex + 1).trim();
    if (!key || !value) continue;
    if (/^(domain|expires|max-age|path|secure|httponly|samesite)$/i.test(key)) {
      continue;
    }

    cookies.set(key, value);
  }

  return cookies;
}

function mergeCookieHeaders(...headers: Array<string | undefined>): string | undefined {
  const cookies = new Map<string, string>();

  for (const header of headers) {
    if (!header) continue;
    for (const [key, value] of parseCookieSegments(header)) {
      cookies.set(key, value);
    }
  }

  if (cookies.size === 0) return;

  return Array.from(cookies.entries())
    .map(([key, value]) => `${key}=${value}`)
    .join("; ");
}

function getCookieHeaderFromSetCookieHeaders(setCookieHeaders: string[]): string | undefined {
  return mergeCookieHeaders(
    ...setCookieHeaders.map(setCookieHeader => setCookieHeader.split(";")[0]?.trim())
  );
}

async function getInstagramBootstrapCookieHeader(): Promise<string | undefined> {
  try {
    const response = await fetch("https://www.instagram.com/", {
      agent: THREADS_HTTPS_AGENT,
      headers: {
        Accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "zh-TW,zh;q=0.9,en-US;q=0.8,en;q=0.7",
        "User-Agent": THREADS_BROWSER_USER_AGENT,
      },
    });

    const setCookieHeaders = response.headers.raw()["set-cookie"] || [];
    const cookieHeader = getCookieHeaderFromSetCookieHeaders(setCookieHeaders);
    const cookies = cookieHeader ? parseCookieSegments(cookieHeader) : new Map();
    const mid = cookies.get("mid");
    const igDid = cookies.get("ig_did") || THREADS_GENERATED_IG_DID;

    return mergeCookieHeaders(
      mid ? `mid=${mid}` : undefined,
      `ig_did=${igDid}`,
      "ig_nrcb=1"
    );
  } catch (e) {
    writeRuntimeDebug("findPost:instagramBootstrap:error", {
      message: e instanceof Error ? e.message : String(e),
    });
    return mergeCookieHeaders(
      `ig_did=${THREADS_GENERATED_IG_DID}`,
      "ig_nrcb=1"
    );
  }
}

// 輔助函數：使用登入 Cookie直接發送請求（在無法取得 LSD 時）
async function executePostQueryWithCookie(
  postID: string,
  threadID: string,
  targetHost: string,
  cookieHeader: string,
  authorization?: string
): Promise<ThreadsPostPageQueryResult | undefined> {
  const origin = `https://${targetHost}`;
  const referer = `${origin}/t/${threadID}`;
  const requestID = getRandomRequestID();
  const webSessionID = getRandomSessionID();
  const bootstrapCookieHeader = await getInstagramBootstrapCookieHeader();
  const effectiveCookieHeader = mergeCookieHeaders(
    bootstrapCookieHeader,
    cookieHeader
  );
  const cookies = effectiveCookieHeader
    ? parseCookieSegments(effectiveCookieHeader)
    : new Map<string, string>();
  const csrfToken = cookies.get("csrftoken");
  const loggedInUserId = cookies.get("ds_user_id") || "0";

  // 從 cookie 提取 csrf token

  // 使用預設 LSD 或從 cookie 提取
  const lsd = THREADS_DEFAULT_LSD;

  const details = {
    av: loggedInUserId,
    __user: loggedInUserId,
    __a: "1",
    __req: requestID,
    __hs: "",
    dpr: "2",
    __ccg: "UNKNOWN",
    __rev: "",
    __s: webSessionID,
    __hsi: "",
    __comet_req: "122",
    lsd,
    jazoest: getJazoest(lsd),
    __spin_r: "",
    __spin_b: "trunk",
    __spin_t: "",
    __crn: "comet.barcelonawebloggedout.BarcelonaLoggedOutFeedColumnRoute",
    fb_api_caller_class: "RelayModern",
    fb_api_req_friendly_name: "BarcelonaPostPageDirectQuery",
    server_timestamps: "true",
    variables: getPostPageVariables(postID),
    doc_id: THREADS_POST_PAGE_DOC_ID,
  };

  try {
    const response = await fetch(`${origin}/graphql/query`, {
      agent: THREADS_HTTPS_AGENT,
      method: "POST",
      headers: {
        Accept: "*/*",
        "Accept-Language": "zh-TW,zh;q=0.9,en-US;q=0.8,en;q=0.7",
        "Content-Type": "application/x-www-form-urlencoded",
        Origin: origin,
        Referer: referer,
        "Sec-Fetch-Dest": "empty",
        "Sec-Fetch-Mode": "cors",
        "Sec-Fetch-Site": "same-origin",
        "Sec-CH-Prefers-Color-Scheme": "dark",
        "Sec-CH-UA": THREADS_SEC_CH_UA,
        "Sec-CH-UA-Full-Version-List": THREADS_SEC_CH_UA_FULL_VERSION_LIST,
        "Sec-CH-UA-Mobile": "?0",
        "Sec-CH-UA-Model": THREADS_SEC_CH_UA_MODEL,
        "Sec-CH-UA-Platform": THREADS_SEC_CH_UA_PLATFORM,
        "Sec-CH-UA-Platform-Version": THREADS_SEC_CH_UA_PLATFORM_VERSION,
        "User-Agent": THREADS_BROWSER_USER_AGENT,
        Priority: "u=1, i",
        "X-Asbd-Id": "359341",
        ...(csrfToken ? {"X-Csrftoken": csrfToken} : {}),
        "X-Fb-Friendly-Name": "BarcelonaPostPageDirectQuery",
        "X-Fb-Lsd": lsd,
        "X-Ig-App-Id": THREADS_APP_ID,
        ...(loggedInUserId === "0"
          ? {"X-Logged-Out-Threads-Migrated-Request": "true"}
          : {}),
        "X-Root-Field-Name": "xdt_api__v1__text_feed__media_id__replies__connection",
        "X-Web-Session-Id": webSessionID,
        ...(authorization ? {Authorization: authorization} : {}),
        ...(effectiveCookieHeader ? {Cookie: effectiveCookieHeader} : {}),
      },
      body: encodeFormBody(details),
    });

    const responseText = await response.text();

    writeRuntimeDebug("findPost:postPageQuery:cookieOnlyResponse", {
      host: targetHost,
      postID,
      status: response.status,
      hasPostData: hasPostData(JSON.parse(responseText)),
      hasBootstrapCookie: Boolean(bootstrapCookieHeader),
      hasLoggedInUserId: loggedInUserId !== "0",
    });

    return {
      host: targetHost,
      responseJson: JSON.parse(responseText),
      status: response.status,
    };
  } catch (e) {
    writeRuntimeDebug("findPost:postPageQuery:cookieOnlyError", {
      host: targetHost,
      postID,
      message: e instanceof Error ? e.message : String(e),
      hasLoggedInUserId: loggedInUserId !== "0",
    });
    return undefined;
  }
}

async function executeThreadsPostPageQueryWithCurl({
  cookieHeader,
  loginCookieHeader,
  csrfToken,
  details,
  authorization,
  lsd,
  referer,
  targetHost,
  webBloksVersionId,
}: {
  cookieHeader?: string;
  loginCookieHeader?: string;
  csrfToken?: string;
  details: Record<string, string>;
  authorization?: string;
  lsd: string;
  referer: string;
  targetHost: string;
  webBloksVersionId?: string;
}): Promise<ThreadsPostPageQueryResult | undefined> {
  // 合併頁面 cookie 和登入 cookie
  const effectiveCookieHeader = mergeCookieHeaders(cookieHeader, loginCookieHeader);
  const origin = `https://${targetHost}`;
  const args = [
    "-sS",
    "--compressed",
    "--max-time",
    "20",
    "--request",
    "POST",
    `${origin}/graphql/query`,
    "--header",
    "Accept: */*",
    "--header",
    "Accept-Language: zh-TW,zh;q=0.9,en-US;q=0.8,en;q=0.7",
    "--header",
    "Content-Type: application/x-www-form-urlencoded",
    "--header",
    `Origin: ${origin}`,
    "--header",
    `Referer: ${referer}`,
    "--header",
    "Sec-Fetch-Dest: empty",
    "--header",
    "Sec-Fetch-Mode: cors",
    "--header",
    "Sec-Fetch-Site: same-origin",
    "--header",
    "Sec-CH-Prefers-Color-Scheme: dark",
    "--header",
    `Sec-CH-UA: ${THREADS_SEC_CH_UA}`,
    "--header",
    `Sec-CH-UA-Full-Version-List: ${THREADS_SEC_CH_UA_FULL_VERSION_LIST}`,
    "--header",
    "Sec-CH-UA-Mobile: ?0",
    "--header",
    `Sec-CH-UA-Model: ${THREADS_SEC_CH_UA_MODEL}`,
    "--header",
    `Sec-CH-UA-Platform: ${THREADS_SEC_CH_UA_PLATFORM}`,
    "--header",
    `Sec-CH-UA-Platform-Version: ${THREADS_SEC_CH_UA_PLATFORM_VERSION}`,
    "--header",
    `User-Agent: ${THREADS_BROWSER_USER_AGENT}`,
    "--header",
    "Priority: u=1, i",
    "--header",
    "X-Asbd-Id: 359341",
    "--header",
    "X-Fb-Friendly-Name: BarcelonaPostPageDirectQuery",
    "--header",
    `X-Fb-Lsd: ${lsd}`,
    "--header",
    `X-Ig-App-Id: ${THREADS_APP_ID}`,
    "--header",
    "X-Logged-Out-Threads-Migrated-Request: true",
    "--header",
    "X-Root-Field-Name: xdt_api__v1__text_feed__media_id__replies__connection",
    "--data-raw",
    encodeFormBody(details),
    "--write-out",
    "\n__CURL_STATUS__:%{http_code}",
  ];

  if (webBloksVersionId) {
    args.push("--header", `X-Bloks-Version-Id: ${webBloksVersionId}`);
  }
  if (csrfToken) {
    args.push("--header", `X-Csrftoken: ${csrfToken}`);
  }
  if (authorization) {
    args.push("--header", `Authorization: ${authorization}`);
  }
  // 合併頁面 cookie 和登入 cookie，優先使用登入 cookie
  const finalCookieHeader = effectiveCookieHeader || cookieHeader;
  if (finalCookieHeader) {
    args.push("--cookie", finalCookieHeader);
  }

  try {
    const {stdout} = await execFileAsync("curl", args, {
      maxBuffer: 8 * 1024 * 1024,
      timeout: 25_000,
    });
    const statusMarker = "\n__CURL_STATUS__:";
    const markerIndex = stdout.lastIndexOf(statusMarker);
    const responseText =
      markerIndex >= 0 ? stdout.slice(0, markerIndex) : stdout;
    const status =
      markerIndex >= 0
        ? Number(stdout.slice(markerIndex + statusMarker.length).trim()) || 0
        : 0;
    const responseJson = JSON.parse(responseText);

    writeRuntimeDebug("findPost:postPageQuery:curlResponse", {
      host: targetHost,
      status,
      hasPostData: hasPostData(responseJson),
      hasErrors: Array.isArray(responseJson?.errors),
      responseStatus:
        typeof responseJson?.status === "string" ? responseJson.status : undefined,
      responseMessage:
        typeof responseJson?.message === "string"
          ? responseJson.message
          : undefined,
    });

    return {
      host: targetHost,
      responseJson,
      responseMessage:
        typeof responseJson?.message === "string"
          ? responseJson.message
          : undefined,
      status,
    };
  } catch (e) {
    writeRuntimeDebug("findPost:postPageQuery:curlError", {
      host: targetHost,
      message: e instanceof Error ? e.message : String(e),
    });
    return;
  }
}

function getPostPageVariables(postID: string): string {
  return JSON.stringify({
    postID,
    sort_order: "TOP",
    __relay_internal__pv__BarcelonaIsLoggedInrelayprovider: false,
    __relay_internal__pv__BarcelonaHasPostAuthorNotifControlsrelayprovider:
      true,
    __relay_internal__pv__BarcelonaShouldShowFediverseM1Featuresrelayprovider:
      false,
    __relay_internal__pv__BarcelonaHasInlineReplyComposerrelayprovider: false,
    __relay_internal__pv__BarcelonaHasDearAlgoConsumptionrelayprovider: true,
    __relay_internal__pv__BarcelonaHasEventBadgerelayprovider: false,
    __relay_internal__pv__BarcelonaIsSearchDiscoveryEnabledrelayprovider:
      false,
    __relay_internal__pv__BarcelonaHasCommunitiesrelayprovider: true,
    __relay_internal__pv__BarcelonaHasGameScoreSharerelayprovider: true,
    __relay_internal__pv__BarcelonaHasPublicViewCountCardrelayprovider: true,
    __relay_internal__pv__BarcelonaHasCommunityEntityCardrelayprovider: false,
    __relay_internal__pv__BarcelonaHasScorecardCommunityrelayprovider: false,
    __relay_internal__pv__BarcelonaHasMusicrelayprovider: false,
    __relay_internal__pv__BarcelonaHasNewspaperLinkStylerelayprovider: false,
    __relay_internal__pv__BarcelonaHasMessagingrelayprovider: false,
    __relay_internal__pv__BarcelonaHasGhostPostEmojiActivationrelayprovider:
      false,
    __relay_internal__pv__BarcelonaOptionalCookiesEnabledrelayprovider: true,
    __relay_internal__pv__BarcelonaHasDearAlgoWebProductionrelayprovider: false,
    __relay_internal__pv__BarcelonaIsCrawlerrelayprovider: false,
    __relay_internal__pv__BarcelonaHasCommunityTopContributorsrelayprovider:
      false,
    __relay_internal__pv__BarcelonaCanSeeSponsoredContentrelayprovider: false,
    __relay_internal__pv__BarcelonaShouldShowFediverseM075Featuresrelayprovider:
      false,
    __relay_internal__pv__BarcelonaIsInternalUserrelayprovider: false,
  });
}

function getLegacyPostVariables(postID: string): string {
  return JSON.stringify({
    check_for_unavailable_replies: true,
    first: 10,
    postID,
    __relay_internal__pv__BarcelonaIsLoggedInrelayprovider: true,
    __relay_internal__pv__BarcelonaIsThreadContextHeaderEnabledrelayprovider:
      false,
    __relay_internal__pv__BarcelonaIsThreadContextHeaderFollowButtonEnabledrelayprovider:
      false,
    __relay_internal__pv__BarcelonaUseCometVideoPlaybackEnginerelayprovider:
      false,
    __relay_internal__pv__BarcelonaOptionalCookiesEnabledrelayprovider: false,
    __relay_internal__pv__BarcelonaIsViewCountEnabledrelayprovider: false,
    __relay_internal__pv__BarcelonaShouldShowFediverseM075Featuresrelayprovider:
      false,
  });
}

function hasPostData(responseJson: any): boolean {
  return (
    Array.isArray(responseJson?.data?.data?.edges) &&
    responseJson.data.data.edges.length > 0
  );
}

async function getThreadsPageContext(
  threadID: string,
  targetHost: string,
  externalCookieHeader?: string
): Promise<ThreadsPageContext | undefined> {
  const fetchPage = async (cookieHeader?: string) => {
    const response = await fetch(`https://${targetHost}/t/${threadID}`, {
      agent: THREADS_HTTPS_AGENT,
      headers: {
        Accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "zh-TW,zh;q=0.9,en-US;q=0.8,en;q=0.7",
        "User-Agent": THREADS_BROWSER_USER_AGENT,
        ...(cookieHeader ? {Cookie: cookieHeader} : {}),
      },
    });

    return {
      response,
      html: await response.text(),
    };
  };

  try {
    let postPageResponse;
    let postPageHtml;
    let usedExternalCookie = false;

    if (externalCookieHeader) {
      ({response: postPageResponse, html: postPageHtml} = await fetchPage(
        externalCookieHeader
      ));
      usedExternalCookie = true;
    } else {
      ({response: postPageResponse, html: postPageHtml} = await fetchPage());
    }

    let lsd = getStringMatch(
      postPageHtml,
      /"LSD",\[\],\{"token":"([^"]+)"\}/
    );

    if (!lsd && externalCookieHeader && usedExternalCookie) {
      writeRuntimeDebug("findPost:pageContext:retryingWithoutExternalCookie", {
        host: targetHost,
        threadID,
        status: postPageResponse.status,
      });
      ({response: postPageResponse, html: postPageHtml} = await fetchPage());
      usedExternalCookie = false;
      lsd = getStringMatch(postPageHtml, /"LSD",\[\],\{"token":"([^"]+)"\}/);
    }

    if (!lsd) {
      writeRuntimeDebug("findPost:pageContext:missingLsd", {
        host: targetHost,
        threadID,
        status: postPageResponse.status,
        finalUrl: postPageResponse.url,
        usedExternalCookie,
      });
      return;
    }

    const setCookieHeaders = postPageResponse.headers.raw()["set-cookie"] || [];
    const cookieHeader = getCookieHeaderFromSetCookieHeaders(setCookieHeaders);

    const csrfToken = cookieHeader
      ? getStringMatch(cookieHeader, /csrftoken=([^;]+)/)
      : undefined;
    const hs =
      getStringMatch(postPageHtml, /"__hs":"([^"]+)"/) ||
      getStringMatch(postPageHtml, /"haste_session":"([^"]+)"/);

    return {
      cookieHeader: cookieHeader || undefined,
      csrfToken,
      csr: getStringMatch(postPageHtml, /"__csr":"([^"]+)"/),
      dyn: getStringMatch(postPageHtml, /"__dyn":"([^"]+)"/),
      hblp: getStringMatch(postPageHtml, /"__hblp":"([^"]+)"/),
      hs,
      hsdp: getStringMatch(postPageHtml, /"__hsdp":"([^"]+)"/),
      lsd,
      referer: postPageResponse.url,
      sjsp: getStringMatch(postPageHtml, /"__sjsp":"([^"]+)"/),
      siteData: {
        clientRevision: getStringMatch(
          postPageHtml,
          /"client_revision":(\d+)/
        ),
        cometEnv: getStringMatch(postPageHtml, /"comet_env":(\d+)/),
        hasteSession: getStringMatch(
          postPageHtml,
          /"haste_session":"([^"]+)"/
        ),
        hsi: getStringMatch(postPageHtml, /"hsi":"([^"]+)"/),
        spinB: getStringMatch(postPageHtml, /"__spin_b":"([^"]+)"/),
        spinR: getStringMatch(postPageHtml, /"__spin_r":(\d+)/),
        spinT: getStringMatch(postPageHtml, /"__spin_t":(\d+)/),
      },
      webBloksVersionId: getStringMatch(
        postPageHtml,
        /"WebBloksVersioningID",\[\],\{"versioningID":"([^"]+)"/
      ),
    };
  } catch (e) {
    writeRuntimeDebug("findPost:pageContext:error", {
      host: targetHost,
      threadID,
      message: e instanceof Error ? e.message : String(e),
    });
    return;
  }
}

async function executeThreadsPostPageQuery(
  postID: string,
  threadID: string,
  targetHost: string,
  authorization?: string,
  externalCookieHeader?: string
): Promise<ThreadsPostPageQueryResult | undefined> {
  const pageContext = await getThreadsPageContext(
    threadID,
    targetHost,
    externalCookieHeader
  );

  // 如果有登入 cookie 但頁面上下文獲取失敗，仍然嘗試用登入 cookie 發送請求
  if (!pageContext && externalCookieHeader) {
    writeRuntimeDebug("findPost:pageContext:usingExternalCookieOnly", {
      host: targetHost,
      threadID,
      hasExternalCookie: Boolean(externalCookieHeader),
    });

    // 使用登入 cookie 直接發送請求（即使沒有 LSD）
    return await executePostQueryWithCookie(
      postID,
      threadID,
      targetHost,
      externalCookieHeader,
      authorization
    );
  }

  if (!pageContext) return;

  const {
    cookieHeader: pageCookieHeader,
    csrfToken,
    csr,
    dyn,
    hblp,
    hs,
    hsdp,
    lsd,
    referer,
    siteData,
    sjsp,
    webBloksVersionId,
  } = pageContext;
  let instagramBootstrapCookieHeader: string | undefined;
  const initialCookieHeader = mergeCookieHeaders(
    externalCookieHeader,
    pageCookieHeader
  );
  const initialCookies = initialCookieHeader
    ? parseCookieSegments(initialCookieHeader)
    : new Map<string, string>();
  const loggedInUserId = initialCookies.get("ds_user_id") || "0";
  const effectiveCsrfToken = initialCookies.get("csrftoken") || csrfToken;
  let cookieHeader = initialCookieHeader;
  const requestID = getRandomRequestID();
  const webSessionID = getRandomSessionID();
  const details = {
    av: loggedInUserId,
    __user: loggedInUserId,
    __a: "1",
    __req: requestID,
    __hs: hs || siteData.hasteSession || "",
    dpr: "2",
    __ccg: "UNKNOWN",
    __rev: siteData.clientRevision || "",
    __s: webSessionID,
    __hsi: siteData.hsi || "",
    __comet_req: siteData.cometEnv || "122",
    lsd,
    jazoest: getJazoest(lsd),
    __spin_r: siteData.spinR || "",
    __spin_b: siteData.spinB || "trunk",
    __spin_t: siteData.spinT || "",
    ...(dyn ? {__dyn: dyn} : {}),
    ...(csr ? {__csr: csr} : {}),
    ...(hsdp ? {__hsdp: hsdp} : {}),
    ...(hblp ? {__hblp: hblp} : {}),
    ...(sjsp ? {__sjsp: sjsp} : {}),
    __crn: "comet.barcelonawebloggedout.BarcelonaLoggedOutFeedColumnRoute",
    fb_api_caller_class: "RelayModern",
    fb_api_req_friendly_name: "BarcelonaPostPageDirectQuery",
    server_timestamps: "true",
    variables: getPostPageVariables(postID),
    doc_id: THREADS_POST_PAGE_DOC_ID,
  };

  const sendPostPageQuery = async (cookieValue?: string) => {
    const origin = `https://${targetHost}`;
    const response = await fetch(`${origin}/graphql/query`, {
      agent: THREADS_HTTPS_AGENT,
      method: "POST",
      headers: {
        Accept: "*/*",
        "Accept-Language": "zh-TW,zh;q=0.9,en-US;q=0.8,en;q=0.7",
        "Content-Type": "application/x-www-form-urlencoded",
        Origin: origin,
        Referer: referer,
        "Sec-Fetch-Dest": "empty",
        "Sec-Fetch-Mode": "cors",
        "Sec-Fetch-Site": "same-origin",
        "Sec-CH-Prefers-Color-Scheme": "dark",
        "Sec-CH-UA": THREADS_SEC_CH_UA,
        "Sec-CH-UA-Full-Version-List": THREADS_SEC_CH_UA_FULL_VERSION_LIST,
        "Sec-CH-UA-Mobile": "?0",
        "Sec-CH-UA-Model": THREADS_SEC_CH_UA_MODEL,
        "Sec-CH-UA-Platform": THREADS_SEC_CH_UA_PLATFORM,
        "Sec-CH-UA-Platform-Version": THREADS_SEC_CH_UA_PLATFORM_VERSION,
        "User-Agent": THREADS_BROWSER_USER_AGENT,
        Priority: "u=1, i",
        "X-Asbd-Id": "359341",
        ...(webBloksVersionId
          ? {"X-Bloks-Version-Id": webBloksVersionId}
          : {}),
        ...(effectiveCsrfToken ? {"X-Csrftoken": effectiveCsrfToken} : {}),
        "X-Fb-Friendly-Name": "BarcelonaPostPageDirectQuery",
        "X-Fb-Lsd": lsd,
        "X-Ig-App-Id": THREADS_APP_ID,
        ...(loggedInUserId === "0"
          ? {"X-Logged-Out-Threads-Migrated-Request": "true"}
          : {}),
        "X-Root-Field-Name":
          "xdt_api__v1__text_feed__media_id__replies__connection",
        "X-Web-Session-Id": webSessionID,
        ...(authorization ? {Authorization: authorization} : {}),
        ...(cookieValue ? {Cookie: cookieValue} : {}),
      },
      body: encodeFormBody(details),
    });

    return {
      response,
      responseText: await response.text(),
      responseCookieHeader: getCookieHeaderFromSetCookieHeaders(
        response.headers.raw()["set-cookie"] || []
      ),
      responseMid: response.headers.get("ig-set-x-mid") || undefined,
    };
  };

  let {
    response: fetchThreadsAPI,
    responseText,
    responseCookieHeader,
    responseMid,
  } = await sendPostPageQuery(cookieHeader);

  if (fetchThreadsAPI.status === 401 && !authorization) {
    instagramBootstrapCookieHeader = await getInstagramBootstrapCookieHeader();
    cookieHeader = mergeCookieHeaders(
      cookieHeader,
      responseCookieHeader,
      instagramBootstrapCookieHeader,
      responseMid ? `mid=${responseMid}` : undefined
    );

    if (cookieHeader) {
      writeRuntimeDebug("findPost:postPageQuery:retryingWithResponseCookies", {
        postID,
        hadResponseMid: Boolean(responseMid),
        hadResponseCookies: Boolean(responseCookieHeader),
      });

      ({
        response: fetchThreadsAPI,
        responseText,
        responseCookieHeader,
        responseMid,
      } = await sendPostPageQuery(cookieHeader));
    }
  }

  try {
    const responseJson = JSON.parse(responseText);
    const responseMessage =
      typeof responseJson?.message === "string" ? responseJson.message : undefined;

    if (!authorization && fetchThreadsAPI.status === 401 && responseMessage) {
      writeRuntimeDebug("findPost:postPageQuery:tryingCurlFallback", {
        host: targetHost,
        postID,
      });
      const curlResult = await executeThreadsPostPageQueryWithCurl({
        cookieHeader,
        loginCookieHeader: externalCookieHeader,
        csrfToken,
        details,
        authorization,
        lsd,
        referer,
        targetHost,
        webBloksVersionId,
      });

      if (curlResult?.responseJson && hasPostData(curlResult.responseJson)) {
        return curlResult;
      }
    }

    writeRuntimeDebug("findPost:postPageQuery:response", {
      host: targetHost,
      postID,
      status: fetchThreadsAPI.status,
      hasPostData: hasPostData(responseJson),
      hasErrors: Array.isArray(responseJson?.errors),
      errorSummary:
        typeof responseJson?.errors?.[0]?.summary === "string"
          ? responseJson.errors[0].summary
          : undefined,
      errorMessage:
        typeof responseJson?.errors?.[0]?.message === "string"
          ? responseJson.errors[0].message
          : undefined,
      responseStatus:
        typeof responseJson?.status === "string" ? responseJson.status : undefined,
      responseMessage,
      hasAuthorization: Boolean(authorization),
      hasCookieHeader: Boolean(cookieHeader),
      hasInstagramBootstrapCookieHeader: Boolean(instagramBootstrapCookieHeader),
      hasResponseCookieHeader: Boolean(responseCookieHeader),
      hasResponseMid: Boolean(responseMid),
      hasDyn: Boolean(dyn),
      hasCsr: Boolean(csr),
      hasHsdp: Boolean(hsdp),
      hasHblp: Boolean(hblp),
      hasSjsp: Boolean(sjsp),
    });
    return {
      host: targetHost,
      responseJson,
      responseMessage,
      status: fetchThreadsAPI.status,
    };
  } catch (e) {
    writeRuntimeDebug("findPost:postPageQuery:parseError", {
      host: targetHost,
      postID,
      status: fetchThreadsAPI.status,
      message: e instanceof Error ? e.message : String(e),
      bodySnippet: responseText.slice(0, 300),
      hasAuthorization: Boolean(authorization),
      hasCookieHeader: Boolean(cookieHeader),
    });
    return {
      host: targetHost,
      status: fetchThreadsAPI.status,
    };
  }
}

async function fetchThreadsPostPageQuery(
  postID: string,
  threadID: string,
  authorization?: string,
  cookieHeader?: string
): Promise<any | undefined> {
  const primaryResult = await executeThreadsPostPageQuery(
    postID,
    threadID,
    "www.threads.com",
    authorization,
    cookieHeader
  );

  const shouldTryThreadsNet =
    !authorization &&
    Boolean(
      primaryResult &&
        (primaryResult.status === 401 ||
          primaryResult.responseMessage?.includes("請幾分鐘後再試一次") ||
          primaryResult.responseMessage
            ?.toLowerCase()
            .includes("please wait a few minutes"))
    );

  if (shouldTryThreadsNet) {
    writeRuntimeDebug("findPost:postPageQuery:fallbackHost", {
      postID,
      fromHost: primaryResult?.host,
      toHost: "www.threads.net",
    });

    const fallbackResult = await executeThreadsPostPageQuery(
      postID,
      threadID,
      "www.threads.net",
      authorization,
      cookieHeader
    );

    if (
      fallbackResult?.responseJson &&
      hasPostData(fallbackResult.responseJson)
    ) {
      return fallbackResult.responseJson;
    }
  }

  return primaryResult?.responseJson;
}

async function fetchThreadsPostPageQueryWithRetries({
  postCode,
  postID,
  threadID,
  authorization,
  cookieHeader,
  step,
}: {
  postCode: string;
  postID: string;
  threadID: string;
  authorization?: string;
  cookieHeader?: string;
  step: string;
}): Promise<any | undefined> {
  let lastResponse: any;

  // 如果提供了 cookieHeader 但沒有 authorization，將 cookieHeader 作為 credentials 使用
  const effectiveCookieHeader = cookieHeader ||
    (authorization?.startsWith("COOKIE:") ? authorization.substring(7) : undefined);

  const effectiveAuth = authorization?.startsWith("COOKIE:") ? undefined : authorization;

  for (let attempt = 1; attempt <= THREADS_POST_PAGE_MAX_ATTEMPTS; attempt++) {
    lastResponse = await fetchThreadsPostPageQuery(postID, threadID, effectiveAuth, effectiveCookieHeader);
    const hasData = hasPostData(lastResponse);
    const hasModernData = hasModernPostData(lastResponse, postCode);

    writeRuntimeDebug(step, {
      post: postCode,
      attempt,
      hasPostData: hasData,
      hasModernPostData: hasModernData,
      hasErrors: Array.isArray(lastResponse?.errors),
      hasCookieHeader: Boolean(effectiveCookieHeader),
      hasAuthorization: Boolean(effectiveAuth),
    });

    if (hasData && hasModernData) {
      return lastResponse;
    }
  }

  return lastResponse;
}

async function fetchThreadsLegacyPostQuery(
  postID: string,
  authorization?: string
): Promise<any> {
  const finalFormBody = encodeFormBody({
    variables: getLegacyPostVariables(postID),
    doc_id: THREADS_LEGACY_POST_DOC_ID,
    lsd: THREADS_DEFAULT_LSD,
  });

  const fetchThreadsAPI = await fetch("https://www.threads.com/api/graphql", {
    agent: THREADS_HTTPS_AGENT,
    method: "POST",
    headers: {
      "Sec-Fetch-Mode": "cors",
      "Sec-Fetch-Site": "same-origin",
      "User-Agent": THREADS_BROWSER_USER_AGENT,
      "X-Fb-Lsd": THREADS_DEFAULT_LSD,
      "X-Ig-App-Id": THREADS_APP_ID,
      "Content-Type": "application/x-www-form-urlencoded",
      ...(authorization ? {Authorization: authorization} : {}),
    },
    body: finalFormBody,
  });

  return await fetchThreadsAPI.json();
}

function formatStatsLine(
  likeCount: number,
  replyCount: number,
  repostCount: number,
  sendCount: number
) {
  return [
    `❤️ ${formatNumber(likeCount)}`,
    `💬 ${formatNumber(replyCount)}`,
    `🔄 ${formatNumber(repostCount)}`,
    `✈️ ${formatNumber(sendCount)}`,
  ].join("   ");
}

function escapeDiscordSpoilerText(text: string): string {
  return text.replace(/\|\|/g, "\\|\\|");
}

function getFragmentText(fragment: any): string {
  if (typeof fragment?.plaintext === "string") return fragment.plaintext;
  if (typeof fragment?.linkified_web_url === "string") {
    return fragment.linkified_web_url;
  }
  if (typeof fragment?.linkified_in_app_url === "string") {
    return fragment.linkified_in_app_url;
  }

  const mentionUsername = fragment?.mention_fragment?.username;
  if (typeof mentionUsername === "string" && mentionUsername) {
    return `@${mentionUsername}`;
  }

  const linkUrl = fragment?.link_fragment?.url;
  if (typeof linkUrl === "string") return linkUrl;

  return "";
}

function buildCaptionFromFragments(post: any): string {
  const fragments = post?.text_post_app_info?.text_fragments?.fragments;
  if (!Array.isArray(fragments) || fragments.length === 0) {
    return post?.caption?.text || "";
  }

  return fragments
    .map((fragment: any) => {
      const text = getFragmentText(fragment);
      if (!text) return "";

      if (fragment?.styling_info?.is_spoiler) {
        return `||${escapeDiscordSpoilerText(text)}||`;
      }

      return text;
    })
    .join("");
}

function hasModernPostData(responseJson: any, postCode: string): boolean {
  const threadItems = responseJson?.data?.data?.edges?.[0]?.node?.thread_items;
  if (!Array.isArray(threadItems)) return false;

  const postObj = threadItems.find((item: any) => item?.post?.code === postCode);
  const postAppInfo = postObj?.post?.text_post_app_info;
  if (!postAppInfo || typeof postAppInfo !== "object") return false;

  return (
    Object.prototype.hasOwnProperty.call(postAppInfo, "repost_count") ||
    Object.prototype.hasOwnProperty.call(postAppInfo, "reshare_count") ||
    Array.isArray(postAppInfo?.text_fragments?.fragments)
  );
}

async function loadPost(post: string): Promise<Omit<ContentProps, "userAgent"> | false> {
  writeRuntimeDebug("findPost:start", {post});
  // Credit to threads-api for this snippet
  const threadID = normalizeThreadsPostCode(post);
  const postID = encodeThreadsPostCode(threadID);
  writeRuntimeDebug("findPost:postID", {
    post,
    postID,
    threadID,
  });

  // 首先嘗試獲取登入 cookie
  const loginCookieHeader = await Promise.race([
    getLoginCookieHeader(),
    new Promise<string | undefined>(resolve => setTimeout(() => resolve(undefined), 2000))
  ]);
  writeRuntimeDebug("findPost:loginCookie", {post, hasCookie: Boolean(loginCookieHeader)});

  // OPTIMIZATION: Start both directQuery and legacyQuery in parallel
  // Legacy query is often faster (~1-2s) vs directQuery (~5-8s)
  // We'll use whichever returns first with valid data
  writeRuntimeDebug("findPost:parallelQuery:start", {post});

  const directQueryPromise = (async () => {
    const anonymousResult = await fetchThreadsPostPageQueryWithRetries({
      postCode: post,
      postID,
      threadID,
      step: "findPost:directQuery:attempt",
    });

    if (
      hasPostData(anonymousResult) &&
      hasModernPostData(anonymousResult, post)
    ) {
      return {
        source: "direct" as const,
        result: anonymousResult,
        hasData: true,
      };
    }

    if (loginCookieHeader) {
      const cookieResult = await fetchThreadsPostPageQueryWithRetries({
        postCode: post,
        postID,
        threadID,
        cookieHeader: loginCookieHeader,
        step: "findPost:directQueryWithCookie:attempt",
      });

      return {
        source: "direct" as const,
        result: cookieResult || anonymousResult,
        hasData:
          hasPostData(cookieResult) && hasModernPostData(cookieResult, post),
      };
    }

    return {
      source: "direct" as const,
      result: anonymousResult,
      hasData: false,
    };
  })().catch(err => {
    writeRuntimeDebug("findPost:directQuery:error", {
      post,
      message: err.message,
    });
    return {source: "direct" as const, result: null, hasData: false};
  });

  const legacyQueryPromise = fetchThreadsLegacyPostQuery(postID).then(result => ({
    source: 'legacy' as const,
    result,
    hasData: hasPostData(result)
  })).catch(err => {
    writeRuntimeDebug("findPost:legacyQuery:error", {post, message: err.message});
    return {source: 'legacy' as const, result: null, hasData: false};
  });

  // Race the two queries with a shorter timeout (8s for Discord crawler compatibility)
  const timeoutPromise = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error('Parallel query timeout')), THREADS_QUICK_TIMEOUT_MS)
  );

  let fetchThreadsAPIJson: any = null;
  let usedSource = 'none';

  try {
    // Wait for first successful result or timeout
    const winner = await Promise.race([
      Promise.all([directQueryPromise, legacyQueryPromise]).then(([direct, legacy]) => {
        // Prefer direct if it has modern data, otherwise use whichever has data
        if (direct.hasData) return direct;
        if (legacy.hasData) return legacy;
        return direct; // fallback to direct even without data
      }),
      timeoutPromise
    ]);

    fetchThreadsAPIJson = winner.result;
    usedSource = winner.source;
    writeRuntimeDebug("findPost:parallelQuery:winner", {post, source: winner.source, hasData: winner.hasData});

    // If direct won but doesn't have modern data, try to get login cookie and retry
    if (winner.source === 'direct' && !winner.hasData) {
      // Try to use login cookie for authorized request
      try {
        const newToken = await Promise.race([
          login(),
          new Promise<false>(resolve => setTimeout(() => resolve(false), 3000))
        ]);
        if (newToken && newToken.token) {
          // Check if it's a cookie-based login
          if (newToken.token.startsWith("COOKIE:")) {
            const cookieJson = newToken.token.substring(7);
            const cookies = JSON.parse(cookieJson);
            const cookieHeader = Object.entries(cookies)
              .map(([key, value]) => `${key}=${value}`)
              .join("; ");

            const authResult = await fetchThreadsPostPageQueryWithRetries({
              postCode: post,
              postID,
              threadID,
              cookieHeader: cookieHeader,
              step: "findPost:loginCookieFallback:attempt",
            });
            if (hasPostData(authResult) && hasModernPostData(authResult, post)) {
              fetchThreadsAPIJson = authResult;
              usedSource = 'direct+cookie';
            }
          } else {
            // Legacy token-based login
            const authResult = await fetchThreadsPostPageQueryWithRetries({
              postCode: post,
              postID,
              threadID,
              authorization: newToken.token,
              step: "findPost:loginFallback:attempt",
            });
            if (hasPostData(authResult) && hasModernPostData(authResult, post)) {
              fetchThreadsAPIJson = authResult;
              usedSource = 'direct+login';
            }
          }
        }
      } catch {
        // Ignore login errors, use what we have
      }
    }
  } catch (timeoutErr) {
    // Timeout - use whatever we have from the promises
    writeRuntimeDebug("findPost:parallelQuery:timeout", {post, timeoutMs: THREADS_QUICK_TIMEOUT_MS});

    // Check if any of them completed despite timeout
    const [direct, legacy] = await Promise.all([
      directQueryPromise.catch(() => ({source: 'direct' as const, result: null, hasData: false})),
      legacyQueryPromise.catch(() => ({source: 'legacy' as const, result: null, hasData: false}))
    ]);

    if (direct.hasData) {
      fetchThreadsAPIJson = direct.result;
      usedSource = 'direct';
    } else if (legacy.hasData) {
      fetchThreadsAPIJson = legacy.result;
      usedSource = 'legacy';
    } else {
      fetchThreadsAPIJson = direct.result || legacy.result;
      usedSource = direct.result ? 'direct' : 'legacy';
    }
  }

  writeRuntimeDebug("findPost:queryComplete", {post, source: usedSource, hasData: hasPostData(fetchThreadsAPIJson)});

  writeRuntimeDebug("findPost:responseValidation:start", {post});
  if (fetchThreadsAPIJson.errors && fetchThreadsAPIJson.errors.length > 0) {
    if (
      fetchThreadsAPIJson.errors[0].summary == "Not Logged In" ||
      fetchThreadsAPIJson.errors[0].summary == "Not Found" ||
      (fetchThreadsAPIJson.errors[0].message &&
        fetchThreadsAPIJson.errors[0].message.includes("limit exceeded"))
    ) {
      let fetchWithAuth: any;
      let generalFetchAuthErr = false;
      try {
        let newToken = await login();
        if (newToken == false) {
          return false;
        } else {
          fetchWithAuth = await fetchThreadsLegacyPostQuery(
            postID,
            newToken.token ? newToken.token : ""
          );
          fetchThreadsAPIJson = fetchWithAuth;
        }
      } catch (e) {
        generalFetchAuthErr = true;
      }

      if (
        (fetchThreadsAPIJson.errors && fetchThreadsAPIJson.errors.length > 0) ||
        generalFetchAuthErr
      ) {
        if (
          fetchThreadsAPIJson.errors[0].summary == "Not Logged In" ||
          fetchThreadsAPIJson.errors[0].api_error_code == 368 || // you're temporarily blocked error code
          (fetchThreadsAPIJson.errors[0].message &&
            fetchThreadsAPIJson.errors[0].message.includes("limit exceeded")) ||
          generalFetchAuthErr
        ) {
          console.log(
            `Error using token. Requesting new token... ${new Date().toLocaleString()} ${post}`
          );
          let tokenRefresh = await refreshToken();
          if (tokenRefresh == false) return false;
        }
      }
    } else {
      return false;
    }
  } else if (!fetchThreadsAPIJson.data) {
    return false;
  }

  /* Handle Post Finding */
  writeRuntimeDebug("findPost:postProcessing:start", {post});
  const thread_items = fetchThreadsAPIJson.data.data.edges[0].node.thread_items;
  const postIndex = thread_items.findIndex((item: any) => item.post.code === post);
  writeRuntimeDebug("findPost:postProcessing:index", {
    post,
    threadItemCount: Array.isArray(thread_items) ? thread_items.length : -1,
    postIndex,
  });
  if (postIndex === -1) return false;
  const postObj = thread_items[postIndex];
  const postAppInfo = postObj.post.text_post_app_info || {};
  const publishedTime =
    typeof postObj.post.taken_at === "number"
      ? new Date(postObj.post.taken_at * 1000).toISOString()
      : undefined;
  const likeCount = getCount(postObj.post.like_count);
  const replyCount = getCount(postAppInfo.direct_reply_count);
  const repostCount = getCount(
    postAppInfo.repost_count,
    postObj.post.repost_count,
    postAppInfo.share_info?.repost_count
  );
  const sendCount = getCount(
    postAppInfo.reshare_count,
    postObj.post.reshare_count,
    postAppInfo.share_info?.reshare_count,
    postAppInfo.share_count,
    postObj.post.share_count,
    postAppInfo.send_count,
    postObj.post.send_count,
    postAppInfo.forward_count,
    postObj.post.forward_count
  );
  const statsLine = formatStatsLine(
    likeCount,
    replyCount,
    repostCount,
    sendCount
  );

  /* Handle Captions */
  let caption = buildCaptionFromFragments(postObj.post);
  if (postIndex > 0) {
    const replyUsername = normalizeThreadsUsername(
      thread_items[postIndex - 1].post.user.username
    );
    caption = `⤴️ 正在回覆 @${replyUsername}\n\n${caption}`;
  }
  let description = caption;

  /* Setup oEmbed */
  let oembedStat = statsLine;

  /* Handle Images */
  let images;
  let vidData: VideoProps[] = [];
  let imgType = "";
  let hasReel = false;
  if (postObj.post.carousel_media && postObj.post.carousel_media.length > 0) {
    images = postObj.post.carousel_media
      .map((item: any) => {
        const previewCandidate = item.image_versions2?.candidates?.[0];
        const primaryVideo = item.video_versions?.[0];

        if (primaryVideo) {
          vidData.push({
            url: primaryVideo.url,
            type: "instagram",
            previewUrl: previewCandidate?.url,
            width:
              primaryVideo.width ||
              previewCandidate?.width ||
              item.original_width,
            height:
              primaryVideo.height ||
              previewCandidate?.height ||
              item.original_height,
          });
          return;
        }

        if (!previewCandidate?.url) return;
        return {
          url: previewCandidate.url,
        };
      })
      .filter((item: ImageProps | undefined): item is ImageProps =>
        Boolean(item?.url)
      );
    imgType = "carousel";
  } else if (
    postAppInfo.link_preview_attachment &&
    postAppInfo.link_preview_attachment.image_url
  ) {
    if (
      postAppInfo.link_preview_attachment.url &&
      postAppInfo.link_preview_attachment.url.includes(
        "instagram.com/reel"
      )
    )
      hasReel = true;
    else {
      images = [
        {
          url: postAppInfo.link_preview_attachment.image_url,
        },
      ];
      imgType = "carousel";
    }
  } else {
    if (postObj.post.image_versions2.candidates.length > 0) {
      images = [
        {
          url: postObj.post.image_versions2.candidates[0].url,
        },
      ];
      imgType = "carousel";
    } else {
      images = [
        {
          url: postObj.post.user.profile_pic_url,
        },
      ];
      imgType = "single";
    }
  }
  if (hasReel) {
    let reelId = postAppInfo.link_preview_attachment.url
      .split("/reel/")[1]
      .split("/")[0];
    if (reelId) {
      vidData.push({
        url: `https://d.ddinstagram.com/reel/${reelId}/`,
        type: "ddinstagram",
        previewUrl: postAppInfo.link_preview_attachment.image_url,
      });
    }
  }

  /* Handle Videos */
  let video: VideoProps[] = [];
  if (postObj.post.video_versions || vidData.length >= 1) {
    if (vidData.length > 0) {
      video = vidData.map((item: any) => {
        return {
          url: item.url,
          type: item.type,
          previewUrl: item.previewUrl,
          width: item.width,
          height: item.height,
        };
      });
    } else {
      if (postObj.post.video_versions.length > 0) {
        const previewCandidate = postObj.post.image_versions2?.candidates?.[0];
        const primaryVideo = postObj.post.video_versions[0];
        video = [
          {
            url: primaryVideo.url,
            type: "instagram",
            previewUrl: previewCandidate?.url,
            width:
              primaryVideo.width ||
              previewCandidate?.width ||
              postObj.post.original_width,
            height:
              primaryVideo.height ||
              previewCandidate?.height ||
              postObj.post.original_height,
          },
        ];
      }
    }
  }

  /* Handle Quote Repost Posts */
  let quotedPost: QuotedPostProps = {
    username: "",
    caption: "",
    quoted: false,
  };
  if (postAppInfo.share_info?.quoted_post != null) {
    quotedPost = {
      username: normalizeThreadsUsername(
        postAppInfo.share_info.quoted_post.user.username
      ),
      caption: buildCaptionFromFragments(postAppInfo.share_info.quoted_post),
      quoted: true,
    };

    description =
      description +
      `\n\n↪ 引用 @${quotedPost.username}\n> ` +
      quotedPost.caption;
  }

  const username = normalizeThreadsUsername(postObj.post.user.username);
  const authorName = formatThreadsAuthorName(
    postObj.post.user.full_name,
    username
  );

  let returnJson = {
    description,
    title: authorName,
    images,
    post,
    postId: postID,
    username,
    publishedTime,
    imageType: imgType,
    video,
    oembedStat,
    likeCount,
    replyCount,
    repostCount,
    sendCount,
    authorName,
    authorUrl: `https://www.threads.com/@${username}`,
    authorIcon: postObj.post.user.profile_pic_url,
    footerName: "Threads",
    footerIcon: THREADS_ICON_URL,
    quotedPost,
  };

  return returnJson;
}

async function findPost({
  post,
  userAgent,
}: {
  post: string;
  userAgent: string;
}) {
  const normalizedPost = normalizeThreadsPostCode(post);
  const cachedPost = findPostCache.get(normalizedPost);
  const now = Date.now();

  if (cachedPost && cachedPost.expiresAt > now) {
    if (!cachedPost.value) return false;
    return {
      ...cachedPost.value,
      userAgent,
    };
  }

  const inflightPost = findPostInflight.get(normalizedPost);
  if (inflightPost) {
    const result = await inflightPost;
    if (!result) return false;
    return {
      ...result,
      userAgent,
    };
  }

  const request = loadPost(normalizedPost)
    .then(result => {
      findPostCache.set(normalizedPost, {
        expiresAt: Date.now() + FIND_POST_CACHE_TTL_MS,
        value: result,
      });
      return result;
    })
    .finally(() => {
      findPostInflight.delete(normalizedPost);
    });

  findPostInflight.set(normalizedPost, request);

  const result = await request;
  if (!result) return false;

  return {
    ...result,
    userAgent,
  };
}

export default findPost;

// 避免循環依賴的輔助函數：從 igLogin 獲取 cookie 但不引入循環依賴
async function getLoginCookieHeader(): Promise<string | undefined> {
  // 動態匯入避免頂層依賴，使用 .js 擴展名符合 ESM 規範
  const {login: getLogin} = await import("./igLogin.js");
  try {
    const result = await getLogin();
    if (result && result.token && result.token.startsWith("COOKIE:")) {
      const cookieJson = result.token.substring(7);
      const cookies = JSON.parse(cookieJson);
      return Object.entries(cookies)
        .map(([key, value]) => `${key}=${value}`)
        .join("; ");
    }
  } catch {
    // 忽略錯誤
  }
  return undefined;
}
