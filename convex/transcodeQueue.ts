import { v } from "convex/values";
import { internalMutation, query } from "./_generated/server";
import { requireVideoAccess } from "./auth";
import { buildPublicContentUrl } from "./s3";

const HEARTBEAT_TIMEOUT_MS = 45_000;
const MAX_ATTEMPTS = 3;

const tierStatusValidator = v.union(
  v.literal("pending"),
  v.literal("processing"),
  v.literal("completed"),
  v.literal("failed"),
);

export const enqueue = internalMutation({
  args: {
    videoId: v.id("videos"),
    s3Key: v.string(),
    bucket: v.string(),
    requestedTiers: v.optional(v.array(v.string())),
    force: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("transcodeJobs")
      .withIndex("by_video", (q) => q.eq("videoId", args.videoId))
      .collect();

    for (const job of existing) {
      if (job.status === "queued" || job.status === "processing") {
        await ctx.db.patch(job._id, {
          status: "failed" as const,
          error: "Superseded by new job",
          completedAt: Date.now(),
        });
      }
    }

    return await ctx.db.insert("transcodeJobs", {
      videoId: args.videoId,
      status: "queued",
      s3Key: args.s3Key,
      bucket: args.bucket,
      requestedTiers: args.requestedTiers,
      force: args.force,
      attempts: 0,
      maxAttempts: MAX_ATTEMPTS,
      createdAt: Date.now(),
    });
  },
});

export const claimNext = internalMutation({
  args: { workerId: v.string() },
  handler: async (ctx, args) => {
    const job = await ctx.db
      .query("transcodeJobs")
      .withIndex("by_status_created", (q) => q.eq("status", "queued"))
      .first();

    if (!job) return null;

    const now = Date.now();
    await ctx.db.patch(job._id, {
      status: "processing",
      workerId: args.workerId,
      lastHeartbeat: now,
      startedAt: now,
      attempts: job.attempts + 1,
    });

    return {
      id: job._id,
      videoId: job.videoId,
      s3Key: job.s3Key,
      bucket: job.bucket,
      requestedTiers: job.requestedTiers,
      force: job.force,
    };
  },
});

export const heartbeat = internalMutation({
  args: {
    jobId: v.id("transcodeJobs"),
    workerId: v.string(),
    tiers: v.optional(
      v.array(
        v.object({
          tag: v.string(),
          status: tierStatusValidator,
          error: v.optional(v.string()),
        }),
      ),
    ),
    sourceWidth: v.optional(v.number()),
    sourceHeight: v.optional(v.number()),
    sourceDuration: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const job = await ctx.db.get(args.jobId);
    if (!job || job.status !== "processing" || job.workerId !== args.workerId)
      return;

    const patch: Record<string, unknown> = { lastHeartbeat: Date.now() };
    if (args.tiers) patch.tiers = args.tiers;
    if (args.sourceWidth !== undefined) patch.sourceWidth = args.sourceWidth;
    if (args.sourceHeight !== undefined) patch.sourceHeight = args.sourceHeight;
    if (args.sourceDuration !== undefined)
      patch.sourceDuration = args.sourceDuration;

    await ctx.db.patch(args.jobId, patch);
  },
});

export const updateTier = internalMutation({
  args: {
    jobId: v.id("transcodeJobs"),
    tier: v.string(),
    status: tierStatusValidator,
    error: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const job = await ctx.db.get(args.jobId);
    if (!job || job.status !== "processing" || !job.tiers) return;

    const updatedTiers = job.tiers.map((t) =>
      t.tag === args.tier
        ? {
            ...t,
            status: args.status as (typeof t)["status"],
            error: args.error,
          }
        : t,
    );

    await ctx.db.patch(args.jobId, {
      tiers: updatedTiers,
      lastHeartbeat: Date.now(),
    });
  },
});

export const completeJob = internalMutation({
  args: {
    jobId: v.id("transcodeJobs"),
    hlsKey: v.string(),
    thumbnailKey: v.optional(v.string()),
    spriteVttKey: v.optional(v.string()),
    duration: v.optional(v.number()),
    width: v.optional(v.number()),
    height: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const job = await ctx.db.get(args.jobId);
    if (!job || job.status !== "processing") return;

    await ctx.db.patch(args.jobId, {
      status: "completed",
      completedAt: Date.now(),
    });

    const thumbnailUrl = args.thumbnailKey
      ? buildPublicContentUrl(args.thumbnailKey)
      : undefined;

    const patch: Record<string, unknown> = {
      hlsKey: args.hlsKey,
      status: "ready",
      muxAssetStatus: "ready",
      uploadError: undefined,
    };
    if (args.thumbnailKey) patch.thumbnailKey = args.thumbnailKey;
    if (thumbnailUrl) patch.thumbnailUrl = thumbnailUrl;
    if (args.spriteVttKey) patch.spriteVttKey = args.spriteVttKey;
    if (args.duration !== undefined) patch.duration = args.duration;

    await ctx.db.patch(job.videoId, patch);
  },
});

export const failJob = internalMutation({
  args: {
    jobId: v.id("transcodeJobs"),
    error: v.string(),
  },
  handler: async (ctx, args) => {
    const job = await ctx.db.get(args.jobId);
    if (!job) return;

    if (job.attempts < job.maxAttempts) {
      await ctx.db.patch(args.jobId, {
        status: "queued",
        error: args.error,
        workerId: undefined,
        lastHeartbeat: undefined,
        startedAt: undefined,
      });
    } else {
      await ctx.db.patch(args.jobId, {
        status: "failed",
        error: args.error,
        completedAt: Date.now(),
      });
      const video = await ctx.db.get(job.videoId);
      if (video) {
        await ctx.db.patch(job.videoId, {
          muxAssetStatus: "errored",
          uploadError: `Transcoding failed after ${job.maxAttempts} attempts: ${args.error}`,
          status: "failed",
        });
      }
    }
  },
});

export const requeueOrphaned = internalMutation({
  args: { workerId: v.string() },
  handler: async (ctx, args) => {
    const processingJobs = await ctx.db
      .query("transcodeJobs")
      .withIndex("by_status", (q) => q.eq("status", "processing"))
      .collect();

    let count = 0;
    for (const job of processingJobs) {
      if (job.workerId === args.workerId) continue;
      if (job.attempts < job.maxAttempts) {
        await ctx.db.patch(job._id, {
          status: "queued",
          error: "Worker restarted — re-queued",
          workerId: undefined,
          lastHeartbeat: undefined,
          startedAt: undefined,
        });
      } else {
        await ctx.db.patch(job._id, {
          status: "failed",
          error: `Orphaned after ${job.maxAttempts} attempts`,
          completedAt: Date.now(),
        });
        const video = await ctx.db.get(job.videoId);
        if (video) {
          await ctx.db.patch(job.videoId, {
            muxAssetStatus: "errored",
            uploadError: "Transcoding failed — worker lost",
            status: "failed",
          });
        }
      }
      count++;
    }
    return { requeued: count };
  },
});

export const requeueStaleJobs = internalMutation({
  handler: async (ctx) => {
    const staleThreshold = Date.now() - HEARTBEAT_TIMEOUT_MS;

    const processingJobs = await ctx.db
      .query("transcodeJobs")
      .withIndex("by_status", (q) => q.eq("status", "processing"))
      .collect();

    for (const job of processingJobs) {
      if (!job.lastHeartbeat || job.lastHeartbeat >= staleThreshold) continue;

      if (job.attempts < job.maxAttempts) {
        await ctx.db.patch(job._id, {
          status: "queued",
          error: "Worker heartbeat timed out",
          workerId: undefined,
          lastHeartbeat: undefined,
          startedAt: undefined,
        });
      } else {
        await ctx.db.patch(job._id, {
          status: "failed",
          error: `Heartbeat timed out after ${job.maxAttempts} attempts`,
          completedAt: Date.now(),
        });
        const video = await ctx.db.get(job.videoId);
        if (video) {
          await ctx.db.patch(job.videoId, {
            muxAssetStatus: "errored",
            uploadError: "Transcoding timed out",
            status: "failed",
          });
        }
      }
    }
  },
});

export const getForVideo = query({
  args: { videoId: v.id("videos") },
  handler: async (ctx, args) => {
    await requireVideoAccess(ctx, args.videoId, "viewer");

    const jobs = await ctx.db
      .query("transcodeJobs")
      .withIndex("by_video", (q) => q.eq("videoId", args.videoId))
      .order("desc")
      .take(1);

    return jobs[0] ?? null;
  },
});
