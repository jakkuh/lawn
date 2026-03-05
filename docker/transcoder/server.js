import http from "node:http";
import crypto from "node:crypto";
import { join } from "node:path";
import { mkdir, rm, stat, writeFile, readdir } from "node:fs/promises";
import {
  createS3Client,
  downloadSource,
  probeSource,
  selectTiers,
  transcodeTier,
  generateThumbnail,
  generateSpriteSheet,
  uploadFile,
  uploadDir,
  tierExistsInS3,
  listExistingTiers,
  buildMasterPlaylist,
} from "./transcode.js";

const PORT = parseInt(process.env.PORT || "3300", 10);
const CONVEX_URL = process.env.CONVEX_URL;
const SECRET = process.env.TRANSCODER_SECRET || "";
const HW_ACCEL = process.env.HW_ACCEL || "cpu";

const POLL_INTERVAL_MS = 5000;
const POLL_MAX_BACKOFF_MS = 30000;
const HEARTBEAT_INTERVAL_MS = 15000;
const WORKER_ID = `worker-${crypto.randomUUID().slice(0, 8)}`;

let currentJob = null;
const recentLogs = [];

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  recentLogs.push(line);
  if (recentLogs.length > 200) recentLogs.shift();
  console.log(msg);
}

// ---------------------------------------------------------------------------
// Convex queue API helpers
// ---------------------------------------------------------------------------

async function convexApi(path, body) {
  const res = await fetch(`${CONVEX_URL}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(SECRET ? { "x-transcoder-secret": SECRET } : {}),
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`API ${path}: ${res.status} ${text}`);
  }
  return res.json();
}

async function claimJob() {
  const data = await convexApi("/api/transcode/claim", { workerId: WORKER_ID });
  return data.job || null;
}

async function sendHeartbeat(jobId, extras = {}) {
  await convexApi("/api/transcode/heartbeat", {
    jobId,
    workerId: WORKER_ID,
    ...extras,
  }).catch((e) => log(`Heartbeat error: ${e.message}`));
}

async function updateTierStatus(jobId, tier, status, error) {
  await convexApi("/api/transcode/tier-update", {
    jobId,
    tier,
    status,
    ...(error ? { error } : {}),
  }).catch((e) => log(`Tier update error: ${e.message}`));
}

async function reportComplete(jobId, result) {
  await convexApi("/api/transcode/complete", { jobId, ...result });
}

async function reportFail(jobId, error) {
  await convexApi("/api/transcode/fail", { jobId, error });
}

// ---------------------------------------------------------------------------
// Job processing
// ---------------------------------------------------------------------------

async function processJob(job) {
  const s3 = createS3Client();
  const workDir = join("/tmp", `transcode-${job.videoId}-${Date.now()}`);
  const hlsDir = join(workDir, "hls");
  const inputPath = join(workDir, "input");
  const thumbPath = join(workDir, "thumbnail.jpg");

  let heartbeatTimer = null;

  try {
    await mkdir(hlsDir, { recursive: true });

    heartbeatTimer = setInterval(() => {
      sendHeartbeat(job.id);
    }, HEARTBEAT_INTERVAL_MS);

    log(`[${job.videoId}] Downloading s3://${job.bucket}/${job.s3Key}`);
    await downloadSource(s3, job.bucket, job.s3Key, inputPath, (m) =>
      log(`[${job.videoId}] ${m}`),
    );
    const inputStat = await stat(inputPath);
    log(
      `[${job.videoId}] Downloaded ${(inputStat.size / 1024 / 1024).toFixed(1)} MB`,
    );

    log(`[${job.videoId}] Probing input...`);
    const probeInfo = await probeSource(inputPath);
    log(
      `[${job.videoId}] Source: ${probeInfo.width}x${probeInfo.height}, ${probeInfo.duration.toFixed(1)}s, codec=${probeInfo.codec}`,
    );

    const tiers = selectTiers(probeInfo.height, job.requestedTiers);
    log(`[${job.videoId}] Selected tiers: ${tiers.map((t) => t.tag).join(", ")}`);

    await sendHeartbeat(job.id, {
      tiers: tiers.map((t) => ({ tag: t.tag, status: "pending" })),
      sourceWidth: probeInfo.width,
      sourceHeight: probeInfo.height,
      sourceDuration: probeInfo.duration,
    });

    const hlsPrefix = `videos/${job.videoId}/hls`;
    const thumbKey = `videos/${job.videoId}/thumbnail.jpg`;
    const spritesPrefix = `videos/${job.videoId}/sprites`;
    const spriteDir = join(workDir, "sprites");

    log(`[${job.videoId}] Generating thumbnail...`);
    await generateThumbnail(inputPath, thumbPath, HW_ACCEL);
    await uploadFile(s3, job.bucket, thumbKey, thumbPath, "image/jpeg");
    log(`[${job.videoId}] Thumbnail uploaded.`);

    log(`[${job.videoId}] Generating sprite sheets...`);
    await generateSpriteSheet(inputPath, spriteDir, probeInfo.duration, HW_ACCEL, probeInfo.width, probeInfo.height);
    await uploadDir(s3, job.bucket, spritesPrefix, spriteDir);
    log(`[${job.videoId}] Sprite sheets uploaded.`);

    let pendingUpload = null;
    for (const tier of tiers) {
      if (
        !job.force &&
        (await tierExistsInS3(s3, job.bucket, job.videoId, tier.tag))
      ) {
        log(`[${job.videoId}] ${tier.tag} already exists, skipping.`);
        await updateTierStatus(job.id, tier.tag, "completed");
        continue;
      }

      await updateTierStatus(job.id, tier.tag, "processing");

      const tierDir = join(hlsDir, tier.tag);
      log(`[${job.videoId}] Transcoding ${tier.tag} (${HW_ACCEL})...`);
      await transcodeTier(inputPath, tier, tierDir, HW_ACCEL);

      if (pendingUpload) await pendingUpload;

      log(`[${job.videoId}] Uploading ${tier.tag} segments...`);
      pendingUpload = uploadDir(
        s3,
        job.bucket,
        `${hlsPrefix}/${tier.tag}`,
        tierDir,
      ).then(() => {
        log(`[${job.videoId}] ${tier.tag} uploaded.`);
        return updateTierStatus(job.id, tier.tag, "completed");
      });
    }
    if (pendingUpload) await pendingUpload;

    const allExisting = await listExistingTiers(s3, job.bucket, job.videoId);
    const masterContent = buildMasterPlaylist(allExisting, probeInfo);
    const masterPath = join(hlsDir, "master.m3u8");
    await writeFile(masterPath, masterContent);
    await uploadFile(
      s3,
      job.bucket,
      `${hlsPrefix}/master.m3u8`,
      masterPath,
      "application/vnd.apple.mpegurl",
    );

    log(`[${job.videoId}] Transcode complete.`);
    await reportComplete(job.id, {
      hlsKey: `${hlsPrefix}/master.m3u8`,
      thumbnailKey: thumbKey,
      spriteVttKey: `${spritesPrefix}/sprites.vtt`,
      duration: probeInfo.duration,
      width: probeInfo.width,
      height: probeInfo.height,
    });
  } catch (err) {
    log(`[${job.videoId}] ERROR: ${err.message}`);
    await reportFail(job.id, err.message).catch(() => {});
  } finally {
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    currentJob = null;
    await rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Poll loop
// ---------------------------------------------------------------------------

async function pollLoop() {
  let backoff = POLL_INTERVAL_MS;

  while (true) {
    if (!CONVEX_URL) {
      log("CONVEX_URL not set, waiting...");
      await new Promise((r) => setTimeout(r, 10000));
      continue;
    }

    try {
      const job = await claimJob();
      if (job) {
        backoff = POLL_INTERVAL_MS;
        currentJob = job;
        log(`[${job.videoId}] Claimed job ${job.id}`);
        await processJob(job);
      } else {
        await new Promise((r) => setTimeout(r, backoff));
        backoff = Math.min(backoff * 1.5, POLL_MAX_BACKOFF_MS);
      }
    } catch (e) {
      log(`Poll error: ${e.message}`);
      await new Promise((r) => setTimeout(r, POLL_MAX_BACKOFF_MS));
    }
  }
}

// ---------------------------------------------------------------------------
// Health check HTTP server
// ---------------------------------------------------------------------------

function jsonRes(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

const server = http.createServer((req, res) => {
  if (req.method === "GET" && req.url === "/health") {
    return jsonRes(res, 200, {
      ok: true,
      workerId: WORKER_ID,
      currentJob: currentJob?.videoId || null,
      hwAccel: HW_ACCEL,
    });
  }
  if (req.method === "GET" && req.url === "/logs") {
    return jsonRes(res, 200, { logs: recentLogs.slice(-50) });
  }
  jsonRes(res, 404, { error: "not found" });
});

async function resetOrphanedJobs() {
  if (!CONVEX_URL) return;
  try {
    const data = await convexApi("/api/transcode/reset", { workerId: WORKER_ID });
    if (data.requeued > 0) {
      log(`Re-queued ${data.requeued} orphaned job(s) from previous worker`);
    }
  } catch (e) {
    log(`Reset orphaned jobs failed (non-fatal): ${e.message}`);
  }
}

async function cleanStaleTmpDirs() {
  try {
    const entries = await readdir("/tmp");
    for (const name of entries) {
      if (name.startsWith("transcode-")) {
        await rm(join("/tmp", name), { recursive: true, force: true });
      }
    }
    const cleaned = entries.filter((n) => n.startsWith("transcode-")).length;
    if (cleaned > 0) log(`Cleaned ${cleaned} stale temp dir(s) from previous run`);
  } catch {
    // /tmp might not have any — that's fine
  }
}

server.listen(PORT, async () => {
  log(`Transcoder worker ${WORKER_ID} started (hw_accel=${HW_ACCEL})`);
  await cleanStaleTmpDirs();
  await resetOrphanedJobs();
  pollLoop();
});
