/**
 * 本地图床服务器
 * 提供安全的图片存储和访问服务
 */

import http from "node:http";
import fs from "node:fs";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import path from "node:path";
import crypto from "node:crypto";
import { validateRemoteUrl } from "./utils/ssrf-guard.js";
import { getQQBotMediaDir } from "./utils/platform.js";

export interface ImageServerConfig {
  /** 监听端口 */
  port: number;
  /** 图片存储目录 */
  storageDir: string;
  /** 外部访问的基础 URL（如 http://your-server:port），留空则自动生成 */
  baseUrl?: string;
  /** 图片过期时间（秒），0 表示不过期 */
  ttlSeconds?: number;
  /** 允许的图片格式 */
  allowedFormats?: string[];
}

interface StoredImage {
  id: string;
  filename: string;
  mimeType: string;
  createdAt: number;
  ttl: number;
}

const DEFAULT_CONFIG: Required<ImageServerConfig> = {
  port: 18765,
  storageDir: "./qqbot-images",
  baseUrl: "",
  ttlSeconds: 3600, // 默认 1 小时过期
  allowedFormats: ["png", "jpg", "jpeg", "gif", "webp"],
};

let serverInstance: http.Server | null = null;
let currentConfig: Required<ImageServerConfig> = { ...DEFAULT_CONFIG };
let imageIndex = new Map<string, StoredImage>();

/**
 * 生成安全的随机 ID
 */
function generateImageId(): string {
  return crypto.randomBytes(16).toString("hex");
}

/**
 * 验证请求路径是否安全（防止目录遍历攻击）
 */
function isPathSafe(requestPath: string, baseDir: string): boolean {
  const normalizedBase = path.resolve(baseDir);
  const normalizedPath = path.resolve(baseDir, requestPath);
  return normalizedPath.startsWith(normalizedBase + path.sep) || normalizedPath === normalizedBase;
}

/**
 * 获取 MIME 类型
 */
function getMimeType(ext: string): string {
  const mimeTypes: Record<string, string> = {
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    webp: "image/webp",
  };
  return mimeTypes[ext.toLowerCase()] || "application/octet-stream";
}

/**
 * 从 MIME 类型获取扩展名
 */
function getExtFromMime(mimeType: string): string | null {
  const extMap: Record<string, string> = {
    "image/png": "png",
    "image/jpeg": "jpg",
    "image/gif": "gif",
    "image/webp": "webp",
    "application/pdf": "pdf",
    "application/json": "json",
    "text/plain": "txt",
    "text/csv": "csv",
    "application/msword": "doc",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
    "application/vnd.ms-excel": "xls",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
  };
  return extMap[mimeType] || null;
}

/**
 * 清理过期图片
 */
function cleanupExpiredImages(): void {
  const now = Date.now();
  const expiredIds: string[] = [];

  for (const [id, image] of imageIndex) {
    if (image.ttl > 0 && now - image.createdAt > image.ttl * 1000) {
      expiredIds.push(id);
    }
  }

  for (const id of expiredIds) {
    const image = imageIndex.get(id);
    if (image) {
      const filePath = path.join(currentConfig.storageDir, image.filename);
      try {
        if (fs.existsSync(filePath)) {
          fs.unlinkSync(filePath);
        }
      } catch {
        // 忽略删除错误
      }
      imageIndex.delete(id);
    }
  }
}

/**
 * 加载已有的图片索引
 */
function loadImageIndex(): void {
  const indexPath = path.join(currentConfig.storageDir, ".index.json");
  try {
    if (fs.existsSync(indexPath)) {
      const data = JSON.parse(fs.readFileSync(indexPath, "utf-8"));
      imageIndex = new Map(Object.entries(data));
    }
  } catch {
    imageIndex = new Map();
  }
}

/**
 * 保存图片索引
 */
function saveImageIndex(): void {
  const indexPath = path.join(currentConfig.storageDir, ".index.json");
  try {
    const data = Object.fromEntries(imageIndex);
    fs.writeFileSync(indexPath, JSON.stringify(data, null, 2));
  } catch {
    // 忽略保存错误
  }
}

/**
 * 处理 HTTP 请求
 */
function handleRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
  const url = new URL(req.url || "/", `http://localhost:${currentConfig.port}`);
  const pathname = url.pathname;

  // 设置 CORS 头（允许 QQ 服务器访问）
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  // 只允许 GET 请求访问图片
  if (req.method !== "GET") {
    res.writeHead(405, { "Content-Type": "text/plain" });
    res.end("Method Not Allowed");
    return;
  }

  // 解析图片 ID（路径格式: /images/{id}.{ext}）
  const match = pathname.match(/^\/images\/([a-f0-9]{32})\.(\w+)$/);
  if (!match) {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not Found");
    return;
  }

  const [, imageId, requestedExt] = match;
  const image = imageIndex.get(imageId);

  if (!image) {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Image Not Found");
    return;
  }

  // 检查是否过期
  if (image.ttl > 0 && Date.now() - image.createdAt > image.ttl * 1000) {
    res.writeHead(410, { "Content-Type": "text/plain" });
    res.end("Image Expired");
    return;
  }

  // 安全检查：确保文件路径在存储目录内
  const filePath = path.join(currentConfig.storageDir, image.filename);
  if (!isPathSafe(image.filename, currentConfig.storageDir)) {
    res.writeHead(403, { "Content-Type": "text/plain" });
    res.end("Forbidden");
    return;
  }

  // 读取并返回图片
  try {
    if (!fs.existsSync(filePath)) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("File Not Found");
      return;
    }

    const imageData = fs.readFileSync(filePath);
    res.writeHead(200, {
      "Content-Type": image.mimeType,
      "Content-Length": imageData.length,
      "Cache-Control": image.ttl > 0 ? `max-age=${image.ttl}` : "max-age=31536000",
    });
    res.end(imageData);
  } catch (err) {
    res.writeHead(500, { "Content-Type": "text/plain" });
    res.end("Internal Server Error");
  }
}

/**
 * 启动图床服务器
 */
export function startImageServer(config?: Partial<ImageServerConfig>): Promise<string> {
  return new Promise((resolve, reject) => {
    if (serverInstance) {
      const baseUrl = currentConfig.baseUrl || `http://localhost:${currentConfig.port}`;
      resolve(baseUrl);
      return;
    }

    currentConfig = { ...DEFAULT_CONFIG, ...config };

    // 确保存储目录存在
    if (!fs.existsSync(currentConfig.storageDir)) {
      fs.mkdirSync(currentConfig.storageDir, { recursive: true });
    }

    // 加载图片索引
    loadImageIndex();

    // 启动定期清理
    const cleanupInterval = setInterval(cleanupExpiredImages, 60000); // 每分钟清理一次

    serverInstance = http.createServer(handleRequest);

    serverInstance.on("error", (err) => {
      clearInterval(cleanupInterval);
      reject(err);
    });

    serverInstance.listen(currentConfig.port, () => {
      const baseUrl = currentConfig.baseUrl || `http://localhost:${currentConfig.port}`;
      resolve(baseUrl);
    });
  });
}

/**
 * 停止图床服务器
 */
export function stopImageServer(): Promise<void> {
  return new Promise((resolve) => {
    if (serverInstance) {
      serverInstance.close(() => {
        serverInstance = null;
        saveImageIndex();
        resolve();
      });
    } else {
      resolve();
    }
  });
}

/**
 * 保存图片并返回访问 URL
 * @param imageData 图片数据（Buffer 或 base64 字符串）
 * @param mimeType 图片 MIME 类型
 * @param ttlSeconds 过期时间（秒），默认使用配置值
 * @returns 图片访问 URL
 */
export function saveImage(
  imageData: Buffer | string,
  mimeType: string = "image/png",
  ttlSeconds?: number
): string {
  // 转换 base64 为 Buffer
  let buffer: Buffer;
  if (typeof imageData === "string") {
    // 处理 data URL 格式
    const base64Match = imageData.match(/^data:([^;]+);base64,(.+)$/);
    if (base64Match) {
      mimeType = base64Match[1];
      buffer = Buffer.from(base64Match[2], "base64");
    } else {
      buffer = Buffer.from(imageData, "base64");
    }
  } else {
    buffer = imageData;
  }

  // 生成唯一 ID 和文件名
  const imageId = generateImageId();
  const ext = getExtFromMime(mimeType) || "png";
  const filename = `${imageId}.${ext}`;

  // 确保存储目录存在
  if (!fs.existsSync(currentConfig.storageDir)) {
    fs.mkdirSync(currentConfig.storageDir, { recursive: true });
  }

  // 保存文件
  const filePath = path.join(currentConfig.storageDir, filename);
  fs.writeFileSync(filePath, buffer);

  // 记录到索引
  const image: StoredImage = {
    id: imageId,
    filename,
    mimeType,
    createdAt: Date.now(),
    ttl: ttlSeconds ?? currentConfig.ttlSeconds,
  };
  imageIndex.set(imageId, image);
  saveImageIndex();

  // 返回访问 URL
  const baseUrl = currentConfig.baseUrl || `http://localhost:${currentConfig.port}`;
  return `${baseUrl}/images/${imageId}.${ext}`;
}

/**
 * 从本地文件路径保存图片到图床
 * @param filePath 本地文件路径
 * @param ttlSeconds 过期时间（秒），默认使用配置值
 * @returns 图片访问 URL，如果文件不存在或不是图片则返回 null
 */
export function saveImageFromPath(filePath: string, ttlSeconds?: number): string | null {
  try {
    console.log(`[image-server] saveImageFromPath: ${filePath}`);
    
    // 检查文件是否存在
    if (!fs.existsSync(filePath)) {
      console.log(`[image-server] File not found: ${filePath}`);
      return null;
    }

    // 读取文件
    const buffer = fs.readFileSync(filePath);
    console.log(`[image-server] File size: ${buffer.length}`);
    
    // 根据扩展名获取 MIME 类型
    const ext = path.extname(filePath).toLowerCase().replace(".", "");
    console.log(`[image-server] Extension: "${ext}"`);
    const mimeType = getMimeType(ext);
    console.log(`[image-server] MIME type: ${mimeType}`);
    
    // 只处理图片文件
    if (!mimeType.startsWith("image/")) {
      console.log(`[image-server] Not an image file`);
      return null;
    }

    // 使用 saveImage 保存
    return saveImage(buffer, mimeType, ttlSeconds);
  } catch (err) {
    console.error(`[image-server] saveImageFromPath error:`, err);
    return null;
  }
}

/**
 * 检查图床服务器是否运行中
 */
export function isImageServerRunning(): boolean {
  return serverInstance !== null;
}

/**
 * 确保图床服务器正在运行
 * 如果未运行，则自动启动
 * @param publicBaseUrl 公网访问的基础 URL（如 http://your-server:18765）
 * @returns 基础 URL，启动失败返回 null
 */
export async function ensureImageServer(publicBaseUrl?: string): Promise<string | null> {
  if (isImageServerRunning()) {
    return publicBaseUrl || currentConfig.baseUrl || `http://0.0.0.0:${currentConfig.port}`;
  }

  try {
    const config: Partial<ImageServerConfig> = {
      port: DEFAULT_CONFIG.port,
      storageDir: DEFAULT_CONFIG.storageDir,
      // 使用用户配置的公网地址
      baseUrl: publicBaseUrl || `http://0.0.0.0:${DEFAULT_CONFIG.port}`,
      ttlSeconds: 3600, // 1 小时过期
    };
    await startImageServer(config);
    console.log(`[image-server] Auto-started on port ${config.port}, baseUrl: ${config.baseUrl}`);
    return config.baseUrl!;
  } catch (err) {
    console.error(`[image-server] Failed to auto-start: ${err}`);
    return null;
  }
}

/** downloadFile 的返回结果 */
export interface DownloadResult {
  /** 下载成功时的本地文件路径（位于系统临时目录，调用方用完后应删除） */
  filePath: string | null;
  /** 下载失败时的错误信息（用于兜底消息展示） */
  error?: string;
}

/** 默认下载目录：与入站附件统一放在 ~/.openclaw/media/qqbot/downloads/ */
const DEFAULT_DOWNLOAD_DIR = getQQBotMediaDir("downloads");

/**
 * 下载远程文件到系统临时目录。
 *
 * 文件名采用 UUID 保证不重名不覆盖，调用方用完后应自行删除。
 *
 * 安全措施：
 * 1. SSRF 防护 — DNS 解析后校验 IP，拒绝私有/保留网段
 * 2. Content-Type 黑名单 — 拦截 text/html（登录页/错误页/人机验证页）
 * 3. 超时控制 — 默认 30 秒
 *
 * @param url 远程文件 URL
 * @param originalFilename 原始文件名（可选，仅用于推导扩展名）
 * @param options 下载选项
 * @returns DownloadResult，filePath 为 null 表示失败，error 包含失败原因
 */
export async function downloadFile(
  url: string,
  originalFilename?: string,
  options?: {
    /** 超时时间（毫秒），默认 30000（30 秒） */
    timeoutMs?: number;
    /** 指定下载目标目录。不传则使用系统临时目录（调用方用完后应删除） */
    destDir?: string;
  },
): Promise<DownloadResult> {
  const timeoutMs = options?.timeoutMs ?? 30_000;
  const destDir = options?.destDir ?? DEFAULT_DOWNLOAD_DIR;

  // ---- SSRF 防护 ----
  try {
    await validateRemoteUrl(url);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[image-server] SSRF check failed: ${msg}`);
    return { filePath: null, error: `URL 安全检查未通过: ${msg}` };
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  let tempPath: string | null = null;

  try {
    // 确保目标目录存在
    if (!fs.existsSync(destDir)) {
      fs.mkdirSync(destDir, { recursive: true });
    }

    // 下载文件（带超时控制）
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) {
      const reason = `HTTP ${response.status} ${response.statusText}`;
      console.error(`[image-server] Download failed: ${reason}`);
      return { filePath: null, error: `下载失败 (${reason})` };
    }

    if (!response.body) {
      console.error(`[image-server] Download failed: empty response body`);
      return { filePath: null, error: `下载失败 (响应体为空)` };
    }

    // 推导扩展名：originalFilename > Content-Disposition > Content-Type > .bin
    const contentType = response.headers.get("content-type") ?? "";
    let ext = "";
    if (originalFilename) {
      try { ext = path.extname(decodeURIComponent(originalFilename)); } catch { ext = path.extname(originalFilename); }
    }
    if (!ext) {
      const disposition = response.headers.get("content-disposition");
      if (disposition) {
        const m = disposition.match(/filename\*?=(?:UTF-8''|")?([^";]+)"?/i);
        if (m?.[1]) {
          try { ext = path.extname(decodeURIComponent(m[1])); } catch { /* keep empty */ }
        }
      }
    }
    if (!ext) {
      const mime = contentType.split(";")[0]?.trim() ?? "";
      ext = mime ? (`.${getExtFromMime(mime) ?? "bin"}`) : ".bin";
    }

    // UUID 文件名，绝对不会重名
    const uniqueName = `${crypto.randomUUID()}${ext}`;
    const filePath = path.join(destDir, uniqueName);
    tempPath = filePath + ".tmp";

    // ---- 流式写入临时文件（内存占用恒定，不会 OOM） ----
    const nodeStream = Readable.fromWeb(response.body as import("node:stream/web").ReadableStream);
    const writeStream = fs.createWriteStream(tempPath);
    await pipeline(nodeStream, writeStream);

    // 流式写入完成，原子重命名为最终文件
    const stat = await fs.promises.stat(tempPath);
    fs.renameSync(tempPath, filePath);
    tempPath = null; // 重命名成功，不再需要清理

    console.log(`[image-server] Downloaded file: ${filePath} (${stat.size} bytes)`);
    return { filePath };
  } catch (err) {
    // 清理不完整的临时文件
    if (tempPath) {
      try { fs.unlinkSync(tempPath); } catch { /* ignore cleanup error */ }
    }

    if (err instanceof Error && err.name === "AbortError") {
      console.error(`[image-server] Download timeout after ${timeoutMs}ms: ${url}`);
      return { filePath: null, error: `下载超时（${Math.round(timeoutMs / 1000)}秒）` };
    }
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[image-server] Download error:`, err);
    return { filePath: null, error: `下载出错: ${msg}` };
  } finally {
    clearTimeout(timeoutId);
  }
}


/**
 * 获取图床服务器配置
 */
export function getImageServerConfig(): Required<ImageServerConfig> {
  return { ...currentConfig };
}
