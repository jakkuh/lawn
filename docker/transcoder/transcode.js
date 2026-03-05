import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createWriteStream, createReadStream } from "node:fs";
import { mkdir, readdir, rm, stat, open, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import {
  S3Client,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
} from "@aws-sdk/client-s3";

const execFileAsync = promisify(execFile);

const AUDIO_BITRATE = "256k";
const MAX_TIERS = parseInt(process.env.MAX_TIERS || "2", 10);

export const TIERS = [
  { tag: "2160p", height: 2160, bitrate: "12000k", maxrate: "14000k", bufsize: "24000k" },
  { tag: "1080p", height: 1080, bitrate: "5000k",  maxrate: "6000k",  bufsize: "10000k" },
  { tag: "720p",  height: 720,  bitrate: "2800k",  maxrate: "3500k",  bufsize: "5600k"  },
];

const DL_PARALLEL_THRESHOLD = 50 * 1024 * 1024;
const DL_CHUNK_SIZE = 64 * 1024 * 1024;
const DL_MAX_STREAMS = 6;
const UL_CONCURRENCY = 8;

async function pMap(items, fn, concurrency = 8) {
  let idx = 0;
  const worker = async () => {
    while (idx < items.length) {
      const i = idx++;
      await fn(items[i], i);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, () => worker()),
  );
}

function contentTypeForFile(name) {
  if (name.endsWith(".m3u8")) return "application/vnd.apple.mpegurl";
  if (name.endsWith(".ts")) return "video/MP2T";
  if (name.endsWith(".jpg")) return "image/jpeg";
  return "application/octet-stream";
}

async function collectFiles(localDir, prefix) {
  const entries = await readdir(localDir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const localPath = join(localDir, entry.name);
    const s3Key = `${prefix}/${entry.name}`;
    if (entry.isDirectory()) {
      files.push(...(await collectFiles(localPath, s3Key)));
    } else {
      files.push({ localPath, s3Key, contentType: contentTypeForFile(entry.name) });
    }
  }
  return files;
}

// ---------------------------------------------------------------------------
// S3
// ---------------------------------------------------------------------------

export function createS3Client() {
  return new S3Client({
    region: process.env.S3_REGION || "auto",
    endpoint: process.env.S3_ENDPOINT,
    credentials: {
      accessKeyId: process.env.S3_ACCESS_KEY_ID,
      secretAccessKey: process.env.S3_SECRET_ACCESS_KEY,
    },
    forcePathStyle: true,
  });
}

export async function downloadSource(s3, bucket, key, dest, log) {
  let totalSize;
  try {
    const head = await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
    totalSize = head.ContentLength;
  } catch {
    totalSize = null;
  }

  if (!totalSize || totalSize < DL_PARALLEL_THRESHOLD) {
    const { Body } = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    await pipeline(Body, createWriteStream(dest));
    return;
  }

  const numChunks = Math.min(DL_MAX_STREAMS, Math.ceil(totalSize / DL_CHUNK_SIZE));
  const chunkSize = Math.ceil(totalSize / numChunks);
  if (log) log(`Parallel download: ${numChunks} streams, ${(chunkSize / 1024 / 1024).toFixed(0)} MB each`);

  const fh = await open(dest, "w");
  try {
    await fh.truncate(totalSize);
    const ranges = Array.from({ length: numChunks }, (_, i) => ({
      start: i * chunkSize,
      end: Math.min((i + 1) * chunkSize - 1, totalSize - 1),
    }));
    await pMap(ranges, async (range) => {
      const { Body } = await s3.send(new GetObjectCommand({
        Bucket: bucket,
        Key: key,
        Range: `bytes=${range.start}-${range.end}`,
      }));
      const chunks = [];
      for await (const chunk of Body) chunks.push(chunk);
      const buf = Buffer.concat(chunks);
      await fh.write(buf, 0, buf.length, range.start);
    }, DL_MAX_STREAMS);
  } finally {
    await fh.close();
  }
}

export async function uploadFile(s3, bucket, key, filePath, contentType) {
  const body = createReadStream(filePath);
  await s3.send(
    new PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentType: contentType }),
  );
}

export async function uploadDir(s3, bucket, prefix, localDir) {
  const files = await collectFiles(localDir, prefix);
  await pMap(files, (f) => uploadFile(s3, bucket, f.s3Key, f.localPath, f.contentType), UL_CONCURRENCY);
}

export async function tierExistsInS3(s3, bucket, videoId, tierTag) {
  try {
    await s3.send(new HeadObjectCommand({
      Bucket: bucket,
      Key: `videos/${videoId}/hls/${tierTag}/playlist.m3u8`,
    }));
    return true;
  } catch {
    return false;
  }
}

export async function listExistingTiers(s3, bucket, videoId) {
  const existing = [];
  for (const tier of TIERS) {
    if (await tierExistsInS3(s3, bucket, videoId, tier.tag)) {
      existing.push(tier);
    }
  }
  return existing;
}

// ---------------------------------------------------------------------------
// FFmpeg
// ---------------------------------------------------------------------------

export async function probeSource(inputPath) {
  const { stdout } = await execFileAsync("ffprobe", [
    "-v", "quiet",
    "-print_format", "json",
    "-show_streams",
    "-show_format",
    inputPath,
  ]);
  const info = JSON.parse(stdout);
  const video = info.streams?.find((s) => s.codec_type === "video");
  if (!video) throw new Error("No video stream found");
  return {
    width: video.width,
    height: video.height,
    duration: parseFloat(info.format?.duration ?? video.duration ?? "0"),
    codec: video.codec_name,
  };
}

export function selectTiers(sourceHeight, requestedTiers) {
  let eligible = TIERS.filter((t) => t.height <= sourceHeight);
  if (eligible.length === 0) eligible = [TIERS[TIERS.length - 1]];

  if (requestedTiers && requestedTiers.length > 0) {
    eligible = eligible.filter((t) => requestedTiers.includes(t.tag));
  } else {
    eligible = eligible.slice(0, MAX_TIERS);
  }
  return eligible;
}

function buildFfmpegArgs(inputPath, tier, outputDir, hwAccel) {
  const segmentFilename = join(outputDir, "segment_%04d.ts");
  const playlistPath = join(outputDir, "playlist.m3u8");

  const scaleFilter =
    hwAccel === "nvidia"
      ? `scale_cuda=-2:${tier.height}`
      : `scale=-2:${tier.height}`;

  const threads = process.env.FFMPEG_THREADS || "0";
  const args = ["-y"];

  if (hwAccel === "nvidia") {
    args.push("-hwaccel", "cuda", "-hwaccel_output_format", "cuda");
  }

  args.push("-i", inputPath, "-threads", threads);

  if (hwAccel === "nvidia") {
    args.push(
      "-vf", scaleFilter,
      "-c:v", "h264_nvenc",
      "-preset", "p6",
      "-tune", "hq",
      "-profile:v", "high",
      "-rc", "vbr",
      "-multipass", "fullres",
      "-rc-lookahead", "32",
      "-spatial_aq", "1",
      "-temporal_aq", "1",
      "-bf", "4",
      "-b_ref_mode", "middle",
      "-b:v", tier.bitrate,
      "-maxrate", tier.maxrate,
      "-bufsize", tier.bufsize,
    );
  } else {
    const cpuPreset = process.env.X264_PRESET || "medium";
    args.push(
      "-vf", scaleFilter,
      "-c:v", "libx264",
      "-preset", cpuPreset,
      "-profile:v", "high",
      "-b:v", tier.bitrate,
      "-maxrate", tier.maxrate,
      "-bufsize", tier.bufsize,
    );
  }

  args.push(
    "-c:a", "aac",
    "-b:a", AUDIO_BITRATE,
    "-ar", "48000",
    "-f", "hls",
    "-hls_time", "6",
    "-hls_list_size", "0",
    "-hls_segment_filename", segmentFilename,
    playlistPath,
  );

  return { args, playlistPath };
}

export async function transcodeTier(inputPath, tier, outputDir, hwAccel) {
  await mkdir(outputDir, { recursive: true });
  const { args } = buildFfmpegArgs(inputPath, tier, outputDir, hwAccel);
  await execFileAsync("ffmpeg", args, { maxBuffer: 50 * 1024 * 1024, timeout: 0 });
}

export async function generateThumbnail(inputPath, outputPath, hwAccel) {
  const args = ["-y"];
  if (hwAccel === "nvidia") {
    args.push("-hwaccel", "cuda");
  }
  args.push(
    "-i", inputPath,
    "-ss", "00:00:01",
    "-vframes", "1",
    "-vf", "scale=640:-2",
    "-q:v", "2",
    outputPath,
  );
  await execFileAsync("ffmpeg", args);
}

export function buildMasterPlaylist(tiers, probeInfo) {
  let m3u8 = "#EXTM3U\n#EXT-X-VERSION:3\n";
  for (const tier of tiers) {
    const width = Math.round((probeInfo.width / probeInfo.height) * tier.height);
    const evenWidth = width % 2 === 0 ? width : width + 1;
    const bw = parseInt(tier.bitrate) * 1000;
    m3u8 += `#EXT-X-STREAM-INF:BANDWIDTH=${bw},RESOLUTION=${evenWidth}x${tier.height}\n`;
    m3u8 += `${tier.tag}/playlist.m3u8\n`;
  }
  return m3u8;
}
