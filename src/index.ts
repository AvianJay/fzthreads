import express from "express";
import { Request, Response } from "express";
import cors from "cors";
import {appendFileSync} from "node:fs";
import path from "node:path";
import "dotenv/config";
const cloudflare = require("cloudflare-express");

import { HttpError } from "./utils/utils";
import routes from "./controllers/index";
const app: express.Express = express();
const RUNTIME_DEBUG_FILE = "./runtime-debug.log";
const STATIC_ASSET_DIR = path.resolve(process.cwd(), "public");
const LOCAL_ICON_FILE = path.join(STATIC_ASSET_DIR, "favicon.png");

function writeServerDebug(
  step: string,
  details?: Record<string, string | number | boolean | undefined | null>
) {
  try {
    appendFileSync(
      RUNTIME_DEBUG_FILE,
      `${JSON.stringify({
        time: new Date().toISOString(),
        step,
        ...details,
      })}\n`
    );
  } catch (e) {
    // Ignore runtime debug logging errors.
  }
}

writeServerDebug("server:moduleLoaded", {
  argv: process.argv.join(" "),
});

function getPort(): number {
  const portArgIndex = process.argv.indexOf("--port");
  if (portArgIndex !== -1) {
    const portArg = Number(process.argv[portArgIndex + 1]);
    if (Number.isFinite(portArg) && portArg > 0) return portArg;
  }

  const trailingPortArg = Number(process.argv[process.argv.length - 1]);
  if (Number.isFinite(trailingPortArg) && trailingPortArg > 0) {
    return trailingPortArg;
  }

  const envPort = Number(process.env.PORT || process.env.npm_config_port);
  if (Number.isFinite(envPort) && envPort > 0) return envPort;

  return 20061;
}

const port = getPort();

/* Launch */
writeServerDebug("server:listen:start", {port});
app.listen(port, "0.0.0.0", () => {
  writeServerDebug("server:listen:ready", {port});
  console.log(`[LAUNCHED] Webserver launched at http://0.0.0.0:${port}`);
});

/* Middlewares */
app.set("trust proxy", "192.168.86.0/24, 192.168.86.42");
app.use(cloudflare.restore());
app.use((req, _res, next) => {
  writeServerDebug("server:request", {
    method: req.method,
    path: req.path,
  });
  next();
});
app.use(express.json());
app.use(cors());
app.use(express.static(STATIC_ASSET_DIR, {index: false}));
app.get(["/favicon.ico", "/favicon.webp", "/touch-icon.webp"], (_req, res) => {
  res.type("png").sendFile(LOCAL_ICON_FILE);
});
app.use(routes);

process.on("uncaughtException", error => {
  writeServerDebug("server:uncaughtException", {
    message: error.message,
  });
});

process.on("unhandledRejection", reason => {
  writeServerDebug("server:unhandledRejection", {
    message: reason instanceof Error ? reason.message : String(reason),
  });
});

app.use((err: any, _req: Request, res: Response, _next: Function) => {
  if (err instanceof HttpError) {
    res.status(err.statusCode).json({
      error: true,
      message: err.errMessage,
      code: err.statusCode,
    });
  } else {
    res.status(500).json({
      error: true,
      message: err.message || "5xx server error",
      code: 500,
    });
  }
});

app.get("/", async (_req: Request, res: Response, _next: Function) => {
  try {
    res.status(301).redirect("https://youtu.be/xvFZjo5PgG0");
  } catch (e: any) {
    res.status(500).json({
      error: true,
      message: e.message,
      code: 500,
    });
  }
});

app.get("/about", async (_req: Request, res: Response, _next: Function) => {
  try {
    res.status(301).redirect("https://github.com/milanmdev/fixthreads");
  } catch (e: any) {
    res.status(500).json({
      error: true,
      message: e.message,
      code: 500,
    });
  }
});

// 404
app.use(async (_req: Request, res: Response, _next: Function) => {
  try {
    res.status(404).json({
      error: true,
      message: "Not Found",
      code: 404,
    });
  } catch (e: any) {
    res.status(500).json({
      error: true,
      message: e.message,
      code: 500,
    });
  }
});

export default app;
