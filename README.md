# FzThreads - Consistent Embedding of Metadata for Threads

Fixes Meta's Threads metadata for sites like Discord, Telegram, etc.

Forked from [milanmdev/fixthreads](https://github.com/milanmdev/fixthreads), with additional features for FzThreads.

## Features

- Improved metadata rendering for Threads links
- Discord Components v2 post previews with author/avatar, verification badge, topic tag, engagement counts, replies, quotes, text attachments, polls, and mixed image/video galleries in their original order
- Native Discord text and media spoilers, including spoilers in quoted posts
- Automatically upload Threads inline stickers/GIFs as Discord application emojis, with a persistent cache and background uploads
- Legacy Mastodon-compatible previews on `l.fzthreads.com`; this host never includes a Components v2 payload (including profiles)
- Better video preview/player metadata
- Poll previews with options, vote counts, percentages, and ended status in Open Graph and Mastodon-compatible responses
- Custom FzThreads favicon and provider icon metadata
- Discord Components v2 profile previews with biography, follower/public view counts, and Markdown profile links; standard Open Graph/oEmbed previews remain available
- Profile cards link biography @mentions, include Instagram when the profile shows its badge, and display confirmed verified/private/fediverse status

## Usage

When you send a `threads.com` or `threads.net` link, replace the domain with `fzthreads.com` and then send it. (im broke)

Use `l.fzthreads.com` instead for the previous Mastodon preview. Other hosts serve Components v2 with Open Graph/oEmbed fallbacks; only the legacy host advertises the Activity JSON alternate or negotiates it on a post URL. Explicit `/activity` and status API endpoints remain available.

Post component previews follow Discord's 3,000-byte payload and 10-gallery-item limits. Long text is shortened with `…`, and media that cannot fit is omitted from the preview; the original Threads link still contains the full post.

## Discord emoji uploads

Set `DISCORD_BOT_TOKEN` in the runtime environment (or your existing local dotenv configuration) to enable uploads to that bot's **application emojis**. A guild ID is not needed. The application ID is discovered from the bot token. Keep the token private; it is never stored in the emoji cache or returned in previews.

| Environment variable | Default | Purpose |
| --- | --- | --- |
| `DISCORD_BOT_TOKEN` | unset | Bot token; uploads are disabled without it |
| `DISCORD_APPLICATION_ID` | auto-detected | Optional application ID for the bot |
| `DISCORD_EMOJI_CACHE_FILE` | `generated/discord-emojis.json` | Persistent emoji IDs and last-use times |
| `DISCORD_EMOJI_CACHE_LIMIT` | `2000` | Application emoji capacity to use (maximum 2000, including existing emojis) |
| `DISCORD_EMOJI_CLEANUP_BATCH_SIZE` | `50` | Number of old managed emojis to remove when capacity is reached |

An ordinary post/share request returns immediately after fetching the post, whether its emojis are fully, partially, or not yet cached. Cached emojis appear in CV2; missing emojis and their placeholders are omitted while they upload in the background. Later requests use the uploaded emojis. Concurrent requests share uploads. Captions, quoted captions, text attachments, and their spoiler positions are supported; ordinary Unicode emoji remain unchanged.

Append `/preload` to wait for missing emoji uploads, then receive the same preview HTML. A full cache hit returns immediately, including while background cache revalidation is pending:

```text
/@power3067830678/post/DeP23AyE-3V/preload
/t/DeP23AyE-3V/preload
/share/SHARE_CODE/preload
```

Preload requests return a 502/503 error if an emoji cannot be uploaded (including missing bot configuration), so a successful response means its emojis are ready. Posts without custom emojis need no bot token. Discord rate limits are respected, so preloading can take longer than an ordinary preview request. Upload errors never delay ordinary previews.

Images are resized to fit Discord's 256 KiB limit, retaining GIF animation. At capacity, the least recently used managed emojis are deleted in batches (50 by default, or the available eligible entries if fewer). Emojis needed by pending requests are protected. Only names matching the reserved `ft_<24-character hash>` namespace are managed; other application emojis are retained. Deleting an old emoji can affect previews that previously referenced its ID.

Keep `generated/` writable and persistent. On startup and periodically, the cache is reconciled with Discord, recovering managed emojis after a missing/corrupt cache and dropping deleted IDs. Run one uploader process per bot/cache file; the upload queue and file writes are coordinated within that process. The upload API and limits follow the [Discord emoji documentation](https://docs.discord.com/developers/resources/emoji).

## Docker

Build the image:

```bash
docker build -t fzthreads .
```

Create your runtime folders, then put your private credentials in `config/users.json`:

```bash
mkdir -p config generated
cp config/users.example.json config/users.json
```

Run the container:

```bash
docker run -d --name fzthreads \
  -p 20061:20061 \
  -e PORT=20061 \
  -v "$(pwd)/config:/build/config:ro" \
  -v "$(pwd)/generated:/build/generated" \
  fzthreads
```

`config/` is mounted read-only because the app only reads `config/users.json`.
`generated/` is mounted writable so login/session tokens can persist across container restarts.
For emoji uploads, also pass `-e DISCORD_BOT_TOKEN` to `docker run` after setting it in the host environment. The same `generated/` mount persists the emoji cache.

## Getting `config/users.json`

`config/users.json` is private. It can contain Threads/Instagram login cookies, a bearer token, or username/password credentials. Do not commit it or paste it into issues/logs.

The recommended format is cookie-based:

```json
[
  {
    "username": "your_threads_username",
    "cookies": {
      "sessionid": "YOUR_SESSION_ID",
      "csrftoken": "YOUR_CSRF_TOKEN",
      "ds_user_id": "YOUR_USER_ID",
      "mid": "YOUR_MID",
      "ig_did": "YOUR_IG_DID"
    }
  }
]
```

Quick DevTools Console method:

1. Log in at `https://www.threads.com/`.
2. Open DevTools, then open the Console tab.
3. Paste this script. It copies a `config/users.json` template to your clipboard.

```js
(() => {
  const wanted = new Set(["sessionid", "csrftoken", "ds_user_id", "mid", "ig_did"]);
  const cookies = Object.fromEntries(
    document.cookie
      .split(";")
      .map(part => part.trim())
      .filter(Boolean)
      .map(part => {
        const index = part.indexOf("=");
        return [part.slice(0, index), decodeURIComponent(part.slice(index + 1))];
      })
      .filter(([key, value]) => wanted.has(key) && value)
  );

  const config = [
    {
      username: "your_threads_username",
      cookies,
    },
  ];

  copy(JSON.stringify(config, null, 2));
  console.log("Copied config/users.json JSON to clipboard. Keep it private.");
})();
```

If `sessionid` is missing, use the Network tab instead:

1. Open DevTools, then open the Network tab.
2. Refresh `https://www.threads.com/`.
3. Click a request to `www.threads.com`.
4. In Request Headers, copy the `Cookie` header. You can also right-click the request, choose Copy, then Copy as cURL, and copy the value from the `cookie:` header in that command.
5. Convert the `Cookie` header into the `cookies` object above. Keep at least `sessionid`; `csrftoken`, `ds_user_id`, `mid`, and `ig_did` are also useful.

Cookie header converter:

```js
const cookieHeader = "PASTE_COOKIE_HEADER_HERE";
const wanted = new Set(["sessionid", "csrftoken", "ds_user_id", "mid", "ig_did"]);
const cookies = Object.fromEntries(
  cookieHeader
    .split(";")
    .map(part => part.trim())
    .filter(Boolean)
    .map(part => {
      const index = part.indexOf("=");
      return [part.slice(0, index), decodeURIComponent(part.slice(index + 1))];
    })
    .filter(([key, value]) => wanted.has(key) && value)
);

copy(
  JSON.stringify(
    [
      {
        username: "your_threads_username",
        cookies,
      },
    ],
    null,
    2
  )
);
```

You can also use a bearer token instead:

```json
[
  {
    "username": "your_threads_username",
    "token": "Bearer IGT:2:YOUR_TOKEN"
  }
]
```

## Support

If you need support, feel free to join the [Discord server](https://discord.gg/xNFpR9PgSP).
