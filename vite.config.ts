import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import fs from "node:fs";
import path from "node:path";

const OUT_DIR = path.resolve(process.cwd(), "out");

function ensureOutDir() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
}

function getMimeType(filePath: string) {
  const extension = path.extname(filePath).toLowerCase();
  switch (extension) {
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".webp":
      return "image/webp";
    case ".gif":
      return "image/gif";
    default:
      return "application/octet-stream";
  }
}

function createAssetStorageMiddleware(): Plugin {
  const handler = (
    req: import("http").IncomingMessage,
    res: import("http").ServerResponse,
    next: () => void
  ) => {
    const url = req.url ?? "";
    const [pathname] = url.split("?");

    if (req.method === "GET" && pathname?.startsWith("/assets/")) {
      const relativeEncoded = pathname.slice("/assets/".length);
      const relative = decodeURIComponent(relativeEncoded);
      if (
        !relative ||
        relative.includes("..") ||
        relative.includes("\\") ||
        path.isAbsolute(relative)
      ) {
        res.statusCode = 400;
        res.end("Invalid asset path");
        return;
      }
      ensureOutDir();
      const targetPath = path.join(OUT_DIR, relative);
      if (!fs.existsSync(targetPath) || !fs.statSync(targetPath).isFile()) {
        res.statusCode = 404;
        res.end("Not found");
        return;
      }
      res.statusCode = 200;
      res.setHeader("Content-Type", getMimeType(targetPath));
      fs.createReadStream(targetPath).pipe(res);
      return;
    }

    if (req.method === "POST" && pathname?.startsWith("/api/assets")) {
      const chunks: Uint8Array[] = [];
      req.on("data", (chunk) => chunks.push(chunk));

      req.on("end", () => {
        try {
          const raw = Buffer.concat(chunks).toString("utf8");
          const payload = JSON.parse(raw) as { name?: string; data?: string };
          if (!payload?.name || !payload?.data) {
            res.statusCode = 400;
            res.end("Invalid payload");
            return;
          }
          if (
            payload.name.includes("..") ||
            payload.name.includes("/") ||
            payload.name.includes("\\")
          ) {
            res.statusCode = 400;
            res.end("Invalid filename");
            return;
          }
          ensureOutDir();
          const targetPath = path.join(OUT_DIR, payload.name);
          const buffer = Buffer.from(payload.data, "base64");
          fs.writeFileSync(targetPath, buffer);
          res.statusCode = 200;
          res.end("ok");
        } catch (error) {
          res.statusCode = 500;
          res.end(
            error instanceof Error ? error.message : "Failed to store asset."
          );
        }
      });

      req.on("error", (error) => {
        res.statusCode = 500;
        res.end(error instanceof Error ? error.message : "Asset upload error.");
      });
      return;
    }

    next();
  };

  return {
    name: "asset-storage-middleware",
    configureServer(server) {
      server.middlewares.use(handler);
    },
    configurePreviewServer(server) {
      server.middlewares.use(handler);
    },
  };
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), createAssetStorageMiddleware()],
});
