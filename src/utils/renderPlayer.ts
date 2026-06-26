import escape from "escape-html";

function getVideoSourceUrl(content: ContentProps): string {
  const primaryVideo = content.video[0];
  return primaryVideo?.url || "";
}

export default function renderPlayer(content: ContentProps) {
  const title = escape(content.title || `@${content.username}`);
  const videoUrl = escape(getVideoSourceUrl(content));
  const posterUrl = escape(
    content.video[0]?.previewUrl || content.images?.[0]?.url || ""
  );

  return `<!DOCTYPE html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${title}</title>
    <style>
      html, body {
        margin: 0;
        width: 100%;
        height: 100%;
        background: #000;
      }

      body {
        display: flex;
        align-items: center;
        justify-content: center;
      }

      video {
        width: 100%;
        height: 100%;
        object-fit: contain;
        background: #000;
      }
    </style>
  </head>
  <body>
    <video controls playsinline autoplay muted${
      posterUrl ? ` poster="${posterUrl}"` : ""
    }>
      <source src="${videoUrl}" type="video/mp4" />
    </video>
  </body>
</html>`;
}
