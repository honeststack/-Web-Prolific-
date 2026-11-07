/**
 * Local stand-in for the Netlify function. With --serve-dist it also serves the
 * production build, so the whole site runs from one port without a Netlify account.
 */
import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { handleApi } from "../server/api";
import { buildContext } from "../server/app-context";
import { FileStore } from "../server/store";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const dataDir = process.env.DATA_DIR ?? join(ROOT, ".data");
const port = Number(process.env.PORT ?? 8787);
const serveDist = process.argv.includes("--serve-dist");
const dist = join(ROOT, "dist");

const { ctx, config } = buildContext(new FileStore(dataDir), process.env);
const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".png": "image/png",
  ".json": "application/json",
  ".svg": "image/svg+xml",
};

createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://localhost:${port}`);
  if (url.pathname.startsWith("/api/")) {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const headers = new Headers();
    for (const [key, value] of Object.entries(req.headers)) if (typeof value === "string") headers.set(key, value);
    const hasBody = req.method !== "GET" && req.method !== "HEAD";
    const response = await handleApi(new Request(url, { method: req.method, headers, body: hasBody ? Buffer.concat(chunks) : undefined }), ctx, config);
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(Buffer.from(await response.arrayBuffer()));
    return;
  }
  if (!serveDist) {
    res.writeHead(404).end();
    return;
  }
  const relative = normalize(decodeURIComponent(url.pathname)).replace(/^[/\\]+/, "");
  let file = resolve(dist, relative);
  if (!file.startsWith(resolve(dist)) || !existsSync(file) || statSync(file).isDirectory()) {
    // Same rule as netlify.toml: missing images stay 404, other paths get the app.
    if (extname(url.pathname) === ".png") {
      res.writeHead(404).end();
      return;
    }
    file = join(dist, "index.html");
  }
  res.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream" });
  createReadStream(file).pipe(res);
}).listen(port, () => console.log(`API ready on http://localhost:${port}${serveDist ? " (serving dist)" : ""}`));
