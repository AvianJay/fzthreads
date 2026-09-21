import {
  formatThreadsAuthorName,
  getThreadsUrl,
  normalizeThreadsUsername,
  publicHttpUrl,
} from "../utils";

export type RawProfile = Record<string, unknown> & {username: string};
export type ProfileQuery = {
  queryName: "BarcelonaProfilePageDirectQuery" | "BarcelonaProfilePageFallbackQuery";
  queryID: string;
  variables: Record<string, unknown>;
};

export function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function matchingUser(value: unknown, username: string): RawProfile | undefined {
  const user = object(value);
  if (
    typeof user?.username === "string" &&
    normalizeThreadsUsername(user.username).toLowerCase() === username.toLowerCase()
  ) return user as RawProfile;
  return;
}

export function readProfileResponse(value: unknown, username: string): RawProfile | undefined {
  const data = object(object(value)?.data);
  // Both web queries currently alias their root field to "user".
  return matchingUser(data?.user, username) ||
    matchingUser(data?.xdt_text_app_user, username) ||
    matchingUser(data?.xdt_text_app_user_by_username, username);
}

export function readProfilePage(html: string, username: string) {
  const queries: Partial<Record<ProfileQuery["queryName"], ProfileQuery>> = {};
  let directUser: RawProfile | undefined;
  let fallbackUser: RawProfile | undefined;

  function visit(value: unknown, depth = 0) {
    if (depth > 50 || !value || typeof value !== "object") return;
    const node = object(value);
    if (node) {
      const name = node.queryName;
      const variables = object(node.variables);
      if (
        (name === "BarcelonaProfilePageDirectQuery" || name === "BarcelonaProfilePageFallbackQuery") &&
        typeof node.queryID === "string" && /^\d+$/.test(node.queryID) && variables &&
        (variables.username === undefined || variables.username === username)
      ) queries[name] = {queryName: name, queryID: node.queryID, variables};
    }

    // Only read profile query results, never a nested post author or viewer.
    if (Array.isArray(value) && value[0] === "RelayPrefetchedStreamCache") {
      const args = value[3];
      if (Array.isArray(args) && typeof args[0] === "string") {
        const result = object(object(args[1])?.__bbox)?.result;
        const user = readProfileResponse(result, username);
        if (args[0].startsWith("adp_BarcelonaProfilePageDirectQueryRelayPreloader_")) {
          directUser = user || directUser;
        } else if (args[0].startsWith("adp_BarcelonaProfilePageFallbackQueryRelayPreloader_")) {
          fallbackUser = user || fallbackUser;
        }
      }
    }
    for (const child of Object.values(value)) visit(child, depth + 1);
  }

  for (const match of html.matchAll(/<script\b[^>]*\btype\s*=\s*["']application\/json["'][^>]*>([\s\S]*?)<\/script\s*>/gi)) {
    try {
      visit(JSON.parse(match[1]));
    } catch {
      // One malformed unrelated script must not discard a valid profile.
    }
  }
  return {user: directUser || fallbackUser, queries};
}

export function profileUserId(user?: RawProfile): string | undefined {
  const id = user?.pk ?? user?.id;
  return typeof id === "string" && /^\d+$/.test(id) ? id : undefined;
}

export function hasCompleteProfile(user?: RawProfile): boolean {
  // Field completeness is separate from whether an authenticated viewer can
  // see a public count that is null in the anonymous response.
  return Boolean(user && [
    "full_name", "biography", "profile_pic_url", "follower_count", "bio_links",
    "text_post_app_public_views", "show_text_post_app_badge", "is_verified",
    "text_post_app_is_private", "text_post_app_has_fediverse_enabled",
  ]
    .every(key => Object.prototype.hasOwnProperty.call(user, key)));
}

function boolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function count(value: unknown): number | undefined {
  const number = typeof value === "number"
    ? value
    : typeof value === "string" && /^\d+$/.test(value) ? Number(value) : NaN;
  return Number.isSafeInteger(number) && number >= 0 ? number : undefined;
}

export function getPublicViewCount(user?: RawProfile): number | undefined {
  return count(object(user?.text_post_app_public_views)?.text_post_app_public_view_count);
}

function biography(user: RawProfile): string {
  if (typeof user.biography === "string") return user.biography;
  const fragments = object(object(user.text_app_biography)?.text_fragments)?.fragments;
  if (!Array.isArray(fragments)) return "";
  return fragments.map(fragment => {
    const value = object(fragment)?.plaintext;
    return typeof value === "string" ? value : "";
  }).join("");
}

export function profileContent(user: RawProfile, userAgent: string): ContentProps {
  const username = normalizeThreadsUsername(user.username);
  const displayName = typeof user.full_name === "string" ? user.full_name.trim() : "";
  const authorName = formatThreadsAuthorName(displayName, username);
  const followerCount = count(user.follower_count);
  const publicViewCount = getPublicViewCount(user);
  const instagramUrl = user.show_text_post_app_badge === true && /^[a-z0-9._]+$/i.test(username)
    ? `https://www.instagram.com/${username}/` : undefined;
  const versions = Array.isArray(user.hd_profile_pic_versions)
    ? user.hd_profile_pic_versions.map(object).filter(version => Boolean(version)) : [];
  versions.sort((a, b) => (count(b?.width) || 0) - (count(a?.width) || 0));
  const avatar = versions.map(version => publicHttpUrl(version?.url, 2048)).find(Boolean) ||
    publicHttpUrl(user.profile_pic_url, 2048) || "";
  const links = Array.isArray(user.bio_links)
    ? user.bio_links.flatMap(value => {
        const link = object(value);
        if (typeof link?.url !== "string") return [];
        return [{url: link.url, title: typeof link.title === "string" ? link.title : ""}];
      })
    : undefined;
  return {
    description: biography(user),
    title: `Threads 上的 ${authorName}`,
    images: avatar ? [{url: avatar}] : [],
    username,
    imageType: "single",
    oembedStat: followerCount === undefined ? "" : `👤 ${followerCount.toLocaleString("en-US")} 個追蹤者`,
    authorName,
    authorUrl: getThreadsUrl(username),
    authorIcon: avatar,
    footerName: "FzThreads",
    footerIcon: "/favicon.png",
    video: [],
    userAgent,
    profile: {
      displayName: displayName || username, followerCount, publicViewCount, links,
      instagramUrl,
      isVerified: boolean(user.is_verified),
      isPrivate: boolean(user.text_post_app_is_private),
      isFederated: boolean(user.text_post_app_has_fediverse_enabled),
    },
  };
}
