# FzThreads - Consistent Embedding of Metadata for Threads

Fixes Meta's Threads metadata for sites like Discord, Telegram, etc.

Forked from [milanmdev/fixthreads](https://github.com/milanmdev/fixthreads), with additional features for FzThreads.

## Features

- Improved metadata rendering for Threads links
- Discord Components v2 post previews with author/avatar, verification badge, topic tag, engagement counts, replies, quotes, text attachments, polls, and mixed image/video galleries in their original order
- Native Discord text and media spoilers, including spoilers in quoted posts
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
