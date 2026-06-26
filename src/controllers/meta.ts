import express from "express";
import { HttpError, GlobalVars } from "../utils/utils";
import packageFile from "../../package.json";
const router: express.Router = express.Router();

router.get("/oembed", async (req, res, next) => {
  try {
    if (!req.query.url)
      return next(new HttpError(400, "Not enough query parameters provided"));

    if (typeof req.query.url !== "string")
      return next(new HttpError(400, "Invalid query parameters provided"));

    const url = req.query.url as string;
    const title =
      typeof req.query.title === "string" ? req.query.title : "Threads";
    const authorName =
      typeof req.query.authorName === "string"
        ? req.query.authorName
        : typeof req.query.text === "string"
          ? req.query.text
          : GlobalVars.name;
    const authorUrl =
      typeof req.query.authorUrl === "string" ? req.query.authorUrl : url;
    const providerName =
      typeof req.query.providerName === "string"
        ? req.query.providerName
        : GlobalVars.name;
    const providerUrl =
      typeof req.query.providerUrl === "string"
        ? req.query.providerUrl
        : "https://www.threads.com";
    const thumbnailUrl =
      typeof req.query.thumbnailUrl === "string" ? req.query.thumbnailUrl : "";
    const authorIcon =
      typeof req.query.authorIcon === "string" ? req.query.authorIcon : "";
    const providerIcon =
      typeof req.query.providerIcon === "string" ? req.query.providerIcon : "";

    let embed: OembedPostProps = {
      author_name: authorName,
      author_url: authorUrl,
      provider_name: providerName,
      provider_url: providerUrl,
      title,
      type: "rich",
      version: "1.0",
    };

    if (thumbnailUrl) {
      embed.thumbnail_url = thumbnailUrl;
      embed.thumbnail_width = 150;
      embed.thumbnail_height = 150;
    }

    if (authorIcon) {
      embed.author_icon = authorIcon;
    }

    if (providerIcon) {
      embed.provider_icon = providerIcon;
    }

    return res.json(embed);
  } catch (e: any) {
    res.status(500).json({
      error: true,
      message: e.message,
    });
  }
});

router.get("/health", async (_req, res, _next) => {
  try {
    return res.json({
      status: "ok",
      version: packageFile.version,
    });
  } catch (e: any) {
    return res.status(500).json({
      error: true,
      message: e.message,
    });
  }
});

export default router;
