/**
 * 分片上传 PUT 测试脚本
 * 
 * 用途：你已经通过 API 拿到了 upload_prepare 返回的预签名 URL，
 *       现在想验证"读文件 → 分片 → PUT 到 COS"这段逻辑是否正确。
 * 
 * 用法：
 *   npx tsx scripts/test-chunked-put.ts \
 *     --file /path/to/test-video.mp4 \
 *     --block-size 5242880 \
 *     --urls "https://cos-url-1" "https://cos-url-2" "https://cos-url-3"
 * 
 * 参数：
 *   --file        要上传的本地文件路径
 *   --block-size  分片大小（字节），upload_prepare 返回的 block_size
 *   --urls        预签名 URL 列表，按分片顺序依次传入（part1 part2 part3...）
 *   --dry-run     仅读取分片并计算 MD5，不真正 PUT（验证分片逻辑）
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";

// ============ 参数解析 ============

const args = process.argv.slice(2);

function getArg(name: string): string | undefined {
  const idx = args.indexOf(name);
  if (idx === -1) return undefined;
  return args[idx + 1];
}

function getArgList(name: string): string[] {
  const idx = args.indexOf(name);
  if (idx === -1) return [];
  const result: string[] = [];
  for (let i = idx + 1; i < args.length; i++) {
    if (args[i].startsWith("--")) break;
    result.push(args[i]);
  }
  return result;
}

const filePath = getArg("--file");
const blockSizeStr = getArg("--block-size");
const presignedUrls = getArgList("--urls");
const dryRun = args.includes("--dry-run");

if (!filePath) {
  console.error("❌ 缺少 --file 参数");
  console.error("\n用法:");
  console.error("  npx tsx scripts/test-chunked-put.ts \\");
  console.error('    --file /path/to/video.mp4 \\');
  console.error("    --block-size 5242880 \\");
  console.error('    --urls "https://cos-url-1" "https://cos-url-2" "https://cos-url-3"');
  console.error("\n  加 --dry-run 仅计算分片信息不实际上传");
  process.exit(1);
}

// ============ 工具函数（和 chunked-upload.ts 一致） ============

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)}GB`;
}

async function readFileChunk(fp: string, offset: number, length: number): Promise<Buffer> {
  const fd = await fs.promises.open(fp, "r");
  try {
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await fd.read(buffer, 0, length, offset);
    if (bytesRead < length) {
      return buffer.subarray(0, bytesRead);
    }
    return buffer;
  } finally {
    await fd.close();
  }
}

const PART_UPLOAD_TIMEOUT = 120_000;
const PART_UPLOAD_MAX_RETRIES = 2;

async function putToPresignedUrl(
  presignedUrl: string,
  data: Buffer,
  partIndex: number,
  totalParts: number,
): Promise<void> {
  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= PART_UPLOAD_MAX_RETRIES; attempt++) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), PART_UPLOAD_TIMEOUT);

      try {
        const ab = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;

        const attemptLabel = attempt > 0 ? ` (retry ${attempt})` : "";
        console.log(`    >>> PUT Part ${partIndex}/${totalParts}${attemptLabel}: url=${presignedUrl}, size=${data.length}`);
        const startTime = Date.now();

        const response = await fetch(presignedUrl, {
          method: "PUT",
          body: new Blob([ab]),
          headers: { "Content-Length": String(data.length) },
          signal: controller.signal,
        });

        const elapsed = Date.now() - startTime;
        const etag = response.headers.get("ETag") ?? "-";
        const requestId = response.headers.get("x-cos-request-id") ?? "-";

        if (!response.ok) {
          const body = await response.text().catch(() => "");
          console.error(`    <<< PUT Part ${partIndex}/${totalParts}: FAILED ${response.status} ${response.statusText} (${elapsed}ms, requestId=${requestId}) body=${body}`);
          throw new Error(`COS PUT failed: ${response.status} ${response.statusText} - ${body}`);
        }

        console.log(`    <<< PUT Part ${partIndex}/${totalParts}: ${response.status} OK (${elapsed}ms, ETag=${etag}, requestId=${requestId})`);
        return;
      } finally {
        clearTimeout(timeoutId);
      }
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      if (lastError.name === "AbortError") {
        lastError = new Error(`Part ${partIndex}/${totalParts} upload timeout after ${PART_UPLOAD_TIMEOUT}ms`);
      }
      if (attempt < PART_UPLOAD_MAX_RETRIES) {
        const delay = 1000 * Math.pow(2, attempt);
        console.warn(`    ⚠️  Part ${partIndex}: attempt ${attempt + 1} failed (${lastError.message}), retrying in ${delay}ms...`);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
  }
  throw lastError!;
}

// ============ 主流程 ============

async function main() {
  // 1. 读取文件信息
  const stat = await fs.promises.stat(filePath!);
  const fileSize = stat.size;
  const fileName = filePath!.split(/[/\\]/).pop() ?? "file";

  console.log(`\n📄 文件: ${fileName}`);
  console.log(`   大小: ${formatFileSize(fileSize)} (${fileSize} bytes)`);

  // 2. 确定分片参数
  const blockSize = blockSizeStr ? parseInt(blockSizeStr, 10) : 0;
  const totalParts = presignedUrls.length;

  if (totalParts === 0 && !dryRun) {
    // 没有传 URL，自动切换到 dry-run 模式
    console.log("\n⚠️  没有传入 --urls，自动进入 dry-run 模式\n");
  }

  const effectiveDryRun = dryRun || totalParts === 0;

  if (blockSize > 0) {
    const expectedParts = Math.ceil(fileSize / blockSize);
    console.log(`   分片大小: ${formatFileSize(blockSize)} (${blockSize} bytes)`);
    console.log(`   预期分片数: ${expectedParts}`);

    if (!effectiveDryRun && totalParts !== expectedParts) {
      console.error(`\n❌ URL 数量 (${totalParts}) 与预期分片数 (${expectedParts}) 不匹配！`);
      process.exit(1);
    }
  }

  if (!effectiveDryRun) {
    console.log(`   预签名 URL 数量: ${totalParts}`);
  }

  // 3. 逐个分片处理
  const effectiveBlockSize = blockSize > 0 ? blockSize : (totalParts > 0 ? Math.ceil(fileSize / totalParts) : fileSize);
  const effectiveTotalParts = blockSize > 0 ? Math.ceil(fileSize / effectiveBlockSize) : (totalParts > 0 ? totalParts : 1);

  console.log(`\n${"=".repeat(60)}`);
  console.log(effectiveDryRun ? "🔍 Dry-run 模式：只读取分片 + 计算 MD5" : "🚀 开始上传分片");
  console.log(`${"=".repeat(60)}\n`);

  let totalUploadedBytes = 0;
  const partResults: { index: number; offset: number; length: number; md5: string; status: string }[] = [];

  for (let i = 0; i < effectiveTotalParts; i++) {
    const partIndex = i + 1;
    const offset = i * effectiveBlockSize;
    const length = Math.min(effectiveBlockSize, fileSize - offset);

    // 读取分片
    const partBuffer = await readFileChunk(filePath!, offset, length);
    const md5Hex = crypto.createHash("md5").update(partBuffer).digest("hex");

    console.log(`  Part ${partIndex}/${effectiveTotalParts}: offset=${offset}, length=${formatFileSize(length)}, md5=${md5Hex}`);

    if (!effectiveDryRun) {
      const url = presignedUrls[i];
      const start = Date.now();
      try {
        await putToPresignedUrl(url, partBuffer, partIndex, effectiveTotalParts);
        const elapsed = Date.now() - start;
        const speed = length / (elapsed / 1000);
        console.log(`    ✅ PUT 成功 (${elapsed}ms, ${formatFileSize(speed)}/s)`);
        partResults.push({ index: partIndex, offset, length, md5: md5Hex, status: "ok" });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`    ❌ PUT 失败: ${msg}`);
        partResults.push({ index: partIndex, offset, length, md5: md5Hex, status: `failed: ${msg}` });
      }
    } else {
      partResults.push({ index: partIndex, offset, length, md5: md5Hex, status: "dry-run" });
    }

    totalUploadedBytes += length;
  }

  // 4. 汇总
  console.log(`\n${"=".repeat(60)}`);
  console.log("📊 汇总");
  console.log(`${"=".repeat(60)}\n`);

  console.log(`  文件大小:       ${formatFileSize(fileSize)} (${fileSize} bytes)`);
  console.log(`  分片数:         ${effectiveTotalParts}`);
  console.log(`  分片大小:       ${formatFileSize(effectiveBlockSize)}`);
  console.log(`  读取总字节数:   ${formatFileSize(totalUploadedBytes)} (${totalUploadedBytes} bytes)`);
  console.log(`  字节数匹配:     ${totalUploadedBytes === fileSize ? "✅ 一致" : "❌ 不一致！"}`);

  console.log(`\n  分片 MD5 列表（用于调用 upload_part_finish）：`);
  for (const p of partResults) {
    console.log(`    Part ${p.index}: md5=${p.md5}  size=${p.length}  ${p.status}`);
  }

  if (!effectiveDryRun) {
    const failed = partResults.filter(p => p.status.startsWith("failed"));
    if (failed.length === 0) {
      console.log(`\n  🎉 所有分片 PUT 成功！可以调用 complete_upload 了。`);
    } else {
      console.log(`\n  ❌ ${failed.length} 个分片失败：`);
      for (const f of failed) {
        console.log(`    Part ${f.index}: ${f.status}`);
      }
    }
  }

  console.log("");
}

main().catch((err) => {
  console.error("❌ 执行失败:", err);
  process.exit(1);
});
