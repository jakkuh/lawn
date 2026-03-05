"use node";

import {
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  UploadPartCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { v } from "convex/values";
import { action, internalAction, ActionCtx } from "./_generated/server";
import { api, internal } from "./_generated/api";
import { Id } from "./_generated/dataModel";
import {
  buildMuxPlaybackUrl,
  buildMuxThumbnailUrl,
  createMuxAssetFromInputUrl,
  createPublicPlaybackId,
  getMuxAsset,
} from "./mux";
import { BUCKET_NAME, buildPublicContentUrl, getS3Client, getS3SigningClient } from "./s3";

const GIBIBYTE = 1024 ** 3;
const MAX_PRESIGNED_PUT_FILE_SIZE_BYTES = 5 * GIBIBYTE;
const MAX_MULTIPART_FILE_SIZE_BYTES = 50 * GIBIBYTE;
const MULTIPART_PART_SIZE = 50 * 1024 * 1024; // 50 MB
const ALLOWED_UPLOAD_CONTENT_TYPES = new Set([
  "video/mp4",
  "video/quicktime",
  "video/webm",
  "video/x-matroska",
]);

function getExtensionFromKey(key: string, fallback = "mp4") {
  let source = key;
  if (key.startsWith("http://") || key.startsWith("https://")) {
    try {
      source = new URL(key).pathname;
    } catch {
      source = key;
    }
  }

  const ext = source.split(".").pop();
  if (!ext) return fallback;
  if (ext.length > 8 || /[^a-zA-Z0-9]/.test(ext)) return fallback;
  return ext.toLowerCase();
}

function sanitizeFilename(input: string) {
  const trimmed = input.trim();
  const base = trimmed.length > 0 ? trimmed : "video";
  const sanitized = base
    .replace(/["']/g, "")
    .replace(/[^a-zA-Z0-9._-]+/g, "_")
    .replace(/_+/g, "_");
  return sanitized.slice(0, 120);
}

function buildDownloadFilename(title: string | undefined, key: string) {
  const ext = getExtensionFromKey(key);
  const safeTitle = sanitizeFilename(title ?? "video");
  return safeTitle.endsWith(`.${ext}`) ? safeTitle : `${safeTitle}.${ext}`;
}

function normalizeBucketKey(key: string): string {
  if (key.startsWith("http://") || key.startsWith("https://")) {
    try {
      const pathname = new URL(key).pathname.replace(/^\/+/, "");
      const bucketPrefix = `${BUCKET_NAME}/`;
      return pathname.startsWith(bucketPrefix)
        ? pathname.slice(bucketPrefix.length)
        : pathname;
    } catch {
      return key;
    }
  }
  return key;
}

async function buildSignedBucketObjectUrl(
  key: string,
  options?: {
    expiresIn?: number;
    filename?: string;
    contentType?: string;
    forBrowser?: boolean;
  },
): Promise<string> {
  const normalizedKey = normalizeBucketKey(key);
  const s3 = options?.forBrowser ? getS3SigningClient() : getS3Client();
  const filename = options?.filename;
  const command = new GetObjectCommand({
    Bucket: BUCKET_NAME,
    Key: normalizedKey,
    ResponseContentDisposition: filename
      ? `attachment; filename="${filename}"`
      : undefined,
    ResponseContentType: options?.contentType,
  });
  return await getSignedUrl(s3, command, { expiresIn: options?.expiresIn ?? 600 });
}

function getValueString(value: unknown, field: string): string | null {
  const raw = (value as Record<string, unknown>)[field];
  return typeof raw === "string" && raw.length > 0 ? raw : null;
}

function normalizeContentType(contentType: string | null | undefined): string {
  if (!contentType) return "";
  return contentType
    .split(";")[0]
    .trim()
    .toLowerCase();
}

function isAllowedUploadContentType(contentType: string): boolean {
  return ALLOWED_UPLOAD_CONTENT_TYPES.has(contentType);
}

function validateUploadRequestOrThrow(args: { fileSize: number; contentType: string }) {
  if (!Number.isFinite(args.fileSize) || args.fileSize <= 0) {
    throw new Error("Video file size must be greater than zero.");
  }

  if (args.fileSize > MAX_PRESIGNED_PUT_FILE_SIZE_BYTES) {
    throw new Error("Video file is too large for direct upload.");
  }

  const normalizedContentType = normalizeContentType(args.contentType);
  if (!isAllowedUploadContentType(normalizedContentType)) {
    throw new Error("Unsupported video format. Allowed: mp4, mov, webm, mkv.");
  }

  return normalizedContentType;
}

function shouldDeleteUploadedObjectOnFailure(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  return (
    error.message.includes("Unsupported video format") ||
    error.message.includes("Video file is too large") ||
    error.message.includes("Uploaded video file not found") ||
    error.message.includes("Storage limit reached")
  );
}

async function requireVideoMemberAccess(
  ctx: ActionCtx,
  videoId: Id<"videos">
) {
  const video = (await ctx.runQuery(api.videos.get, { videoId })) as
    | { role?: string }
    | null;
  if (!video || video.role === "viewer") {
    throw new Error("Requires member role or higher");
  }
}

function useTranscoder(): boolean {
  return Boolean(
    process.env.SELF_HOSTED_TRANSCODER || process.env.TRANSCODER_URL,
  );
}

function buildPublicPlaybackSession(
  playbackId: string,
): { url: string; posterUrl: string } {
  return {
    url: buildMuxPlaybackUrl(playbackId),
    posterUrl: buildMuxThumbnailUrl(playbackId),
  };
}

function buildHlsPlaybackSession(
  hlsKey: string,
  thumbnailKey?: string | null,
  thumbnailUrl?: string | null,
  spriteVttKey?: string | null,
): { url: string; posterUrl: string; spriteVttUrl?: string } {
  return {
    url: buildPublicContentUrl(hlsKey),
    posterUrl: thumbnailKey
      ? buildPublicContentUrl(thumbnailKey)
      : (thumbnailUrl ?? ""),
    spriteVttUrl: spriteVttKey ? buildPublicContentUrl(spriteVttKey) : undefined,
  };
}


async function ensurePublicPlaybackId(
  ctx: ActionCtx,
  params: {
    videoId?: Id<"videos">;
    muxAssetId?: string | null;
    muxPlaybackId: string;
  },
): Promise<string> {
  const { videoId, muxAssetId, muxPlaybackId } = params;
  if (!muxAssetId) return muxPlaybackId;

  const asset = await getMuxAsset(muxAssetId);
  const playbackIds = (asset.playback_ids ?? []) as Array<{
    id?: string;
    policy?: string;
  }>;

  let publicPlaybackId = playbackIds.find((entry) => entry.policy === "public" && entry.id)?.id;
  if (!publicPlaybackId) {
    const created = await createPublicPlaybackId(muxAssetId);
    publicPlaybackId = created.id;
  }

  const resolvedPlaybackId = publicPlaybackId ?? muxPlaybackId;
  if (videoId && resolvedPlaybackId !== muxPlaybackId) {
    await ctx.runMutation(internal.videos.setMuxPlaybackId, {
      videoId,
      muxPlaybackId: resolvedPlaybackId,
      thumbnailUrl: buildMuxThumbnailUrl(resolvedPlaybackId),
    });
  }

  return resolvedPlaybackId;
}

export const getUploadUrl = action({
  args: {
    videoId: v.id("videos"),
    filename: v.string(),
    fileSize: v.number(),
    contentType: v.string(),
  },
  returns: v.object({
    url: v.string(),
    uploadId: v.string(),
  }),
  handler: async (ctx, args) => {
    await requireVideoMemberAccess(ctx, args.videoId);
    const normalizedContentType = validateUploadRequestOrThrow({
      fileSize: args.fileSize,
      contentType: args.contentType,
    });

    const s3 = getS3SigningClient();
    const ext = getExtensionFromKey(args.filename);
    const key = `videos/${args.videoId}/${Date.now()}.${ext}`;
    const command = new PutObjectCommand({
      Bucket: BUCKET_NAME,
      Key: key,
      ContentType: normalizedContentType,
    });
    const url = await getSignedUrl(s3, command, { expiresIn: 3600 });

    await ctx.runMutation(internal.videos.setUploadInfo, {
      videoId: args.videoId,
      s3Key: key,
      fileSize: args.fileSize,
      contentType: normalizedContentType,
    });

    return { url, uploadId: key };
  },
});

export const initiateMultipartUpload = action({
  args: {
    videoId: v.id("videos"),
    filename: v.string(),
    fileSize: v.number(),
    contentType: v.string(),
  },
  returns: v.object({
    key: v.string(),
    s3UploadId: v.string(),
    partUrls: v.array(v.string()),
    partSize: v.number(),
  }),
  handler: async (ctx, args) => {
    await requireVideoMemberAccess(ctx, args.videoId);

    const normalizedContentType = normalizeContentType(args.contentType);
    if (!isAllowedUploadContentType(normalizedContentType)) {
      throw new Error("Unsupported video format. Allowed: mp4, mov, webm, mkv.");
    }
    if (!Number.isFinite(args.fileSize) || args.fileSize <= 0) {
      throw new Error("Video file size must be greater than zero.");
    }
    if (args.fileSize > MAX_MULTIPART_FILE_SIZE_BYTES) {
      throw new Error("Video file exceeds the 50 GB maximum.");
    }

    const s3 = getS3SigningClient();
    const ext = getExtensionFromKey(args.filename);
    const key = `videos/${args.videoId}/${Date.now()}.${ext}`;

    const { UploadId } = await s3.send(
      new CreateMultipartUploadCommand({
        Bucket: BUCKET_NAME,
        Key: key,
        ContentType: normalizedContentType,
      }),
    );

    if (!UploadId) throw new Error("Failed to initiate multipart upload.");

    const totalParts = Math.ceil(args.fileSize / MULTIPART_PART_SIZE);
    const partUrls: string[] = [];
    for (let partNumber = 1; partNumber <= totalParts; partNumber++) {
      const command = new UploadPartCommand({
        Bucket: BUCKET_NAME,
        Key: key,
        UploadId,
        PartNumber: partNumber,
      });
      const url = await getSignedUrl(s3, command, { expiresIn: 86400 });
      partUrls.push(url);
    }

    await ctx.runMutation(internal.videos.setUploadInfo, {
      videoId: args.videoId,
      s3Key: key,
      fileSize: args.fileSize,
      contentType: normalizedContentType,
    });

    return { key, s3UploadId: UploadId, partUrls, partSize: MULTIPART_PART_SIZE };
  },
});

export const completeMultipartUpload = action({
  args: {
    videoId: v.id("videos"),
    key: v.string(),
    s3UploadId: v.string(),
    parts: v.array(v.object({ PartNumber: v.number(), ETag: v.string() })),
  },
  returns: v.object({ success: v.boolean() }),
  handler: async (ctx, args) => {
    await requireVideoMemberAccess(ctx, args.videoId);

    const s3 = getS3Client();
    await s3.send(
      new CompleteMultipartUploadCommand({
        Bucket: BUCKET_NAME,
        Key: args.key,
        UploadId: args.s3UploadId,
        MultipartUpload: { Parts: args.parts },
      }),
    );

    return { success: true };
  },
});

export const markUploadComplete = action({
  args: {
    videoId: v.id("videos"),
  },
  returns: v.object({
    success: v.boolean(),
  }),
  handler: async (ctx, args) => {
    await requireVideoMemberAccess(ctx, args.videoId);

    const video = await ctx.runQuery(api.videos.getVideoForPlayback, {
      videoId: args.videoId,
    });

    if (!video || !video.s3Key) {
      throw new Error("Original bucket file not found for this video");
    }

    try {
      const s3 = getS3Client();
      const head = await s3.send(
        new HeadObjectCommand({
          Bucket: BUCKET_NAME,
          Key: video.s3Key,
        }),
      );
      const contentLengthRaw = head.ContentLength;
      if (
        typeof contentLengthRaw !== "number" ||
        !Number.isFinite(contentLengthRaw) ||
        contentLengthRaw <= 0
      ) {
        throw new Error("Uploaded video file not found or empty.");
      }
      const contentLength = contentLengthRaw;

      const normalizedContentType = normalizeContentType(
        head.ContentType ?? video.contentType,
      );
      if (!isAllowedUploadContentType(normalizedContentType)) {
        throw new Error("Unsupported video format. Allowed: mp4, mov, webm, mkv.");
      }

      await ctx.runMutation(internal.videos.reconcileUploadedObjectMetadata, {
        videoId: args.videoId,
        fileSize: contentLength,
        contentType: normalizedContentType,
      });

      await ctx.runMutation(internal.videos.markAsProcessing, {
        videoId: args.videoId,
      });

      if (useTranscoder()) {
        await ctx.runMutation(internal.transcodeQueue.enqueue, {
          videoId: args.videoId,
          s3Key: video.s3Key,
          bucket: BUCKET_NAME,
        });
      } else {
        const ingestUrl = await buildSignedBucketObjectUrl(video.s3Key, {
          expiresIn: 60 * 60 * 24,
        });
        const asset = await createMuxAssetFromInputUrl(args.videoId, ingestUrl);
        if (asset.id) {
          await ctx.runMutation(internal.videos.setMuxAssetReference, {
            videoId: args.videoId,
            muxAssetId: asset.id,
          });
        }
      }
    } catch (error) {
      const shouldDeleteObject = shouldDeleteUploadedObjectOnFailure(error);
      if (shouldDeleteObject) {
        const s3 = getS3Client();
        try {
          await s3.send(
            new DeleteObjectCommand({
              Bucket: BUCKET_NAME,
              Key: video.s3Key,
            }),
          );
        } catch {
          // No-op: preserve original processing failure.
        }
      }

      const uploadError =
        shouldDeleteObject && error instanceof Error
          ? error.message
          : "Video processing failed after upload.";
      await ctx.runMutation(internal.videos.markAsFailed, {
        videoId: args.videoId,
        uploadError,
      });
      throw error;
    }

    return { success: true };
  },
});

export const retryTranscode = action({
  args: {
    videoId: v.id("videos"),
    tiers: v.optional(v.array(v.string())),
    force: v.optional(v.boolean()),
  },
  returns: v.object({ success: v.boolean() }),
  handler: async (ctx, args) => {
    await requireVideoMemberAccess(ctx, args.videoId);

    const video = await ctx.runQuery(api.videos.getVideoForPlayback, {
      videoId: args.videoId,
    });

    if (!video || !video.s3Key) {
      throw new Error("Video not found or has no source file");
    }

    await ctx.runMutation(internal.videos.markAsProcessing, {
      videoId: args.videoId,
    });

    if (useTranscoder()) {
      await ctx.runMutation(internal.transcodeQueue.enqueue, {
        videoId: args.videoId,
        s3Key: video.s3Key,
        bucket: BUCKET_NAME,
        requestedTiers: args.tiers,
        force: args.force,
      });
    } else {
      const ingestUrl = await buildSignedBucketObjectUrl(video.s3Key, {
        expiresIn: 60 * 60 * 24,
      });
      const asset = await createMuxAssetFromInputUrl(args.videoId, ingestUrl);
      if (asset.id) {
        await ctx.runMutation(internal.videos.setMuxAssetReference, {
          videoId: args.videoId,
          muxAssetId: asset.id,
        });
      }
    }

    return { success: true };
  },
});

export const markUploadFailed = action({
  args: {
    videoId: v.id("videos"),
  },
  returns: v.object({
    success: v.boolean(),
  }),
  handler: async (ctx, args) => {
    await requireVideoMemberAccess(ctx, args.videoId);

    await ctx.runMutation(internal.videos.markAsFailed, {
      videoId: args.videoId,
      uploadError: "Upload failed before video could be processed.",
    });

    return { success: true };
  },
});

export const getPlaybackSession = action({
  args: { videoId: v.id("videos") },
  returns: v.object({
    url: v.string(),
    posterUrl: v.string(),
    spriteVttUrl: v.optional(v.string()),
  }),
  handler: async (
    ctx,
    args,
  ): Promise<{ url: string; posterUrl: string; spriteVttUrl?: string }> => {
    const video = await ctx.runQuery(api.videos.getVideoForPlayback, {
      videoId: args.videoId,
    });

    if (!video || video.status !== "ready") {
      throw new Error("Video not found or not ready");
    }

    if (video.hlsKey) {
      return buildHlsPlaybackSession(video.hlsKey, video.thumbnailKey, video.thumbnailUrl, video.spriteVttKey);
    }

    if (!video.muxPlaybackId) {
      throw new Error("Video not found or not ready");
    }

    const playbackId = await ensurePublicPlaybackId(ctx, {
      videoId: args.videoId,
      muxAssetId: video.muxAssetId,
      muxPlaybackId: video.muxPlaybackId,
    });
    return buildPublicPlaybackSession(playbackId);
  },
});

export const getPlaybackUrl = action({
  args: { videoId: v.id("videos") },
  returns: v.object({
    url: v.string(),
  }),
  handler: async (ctx, args): Promise<{ url: string }> => {
    const video = await ctx.runQuery(api.videos.getVideoForPlayback, {
      videoId: args.videoId,
    });

    if (!video || video.status !== "ready") {
      throw new Error("Video not found or not ready");
    }

    if (video.hlsKey) {
      return { url: buildPublicContentUrl(video.hlsKey) };
    }

    if (!video.muxPlaybackId) {
      throw new Error("Video not found or not ready");
    }

    const playbackId = await ensurePublicPlaybackId(ctx, {
      videoId: args.videoId,
      muxAssetId: video.muxAssetId,
      muxPlaybackId: video.muxPlaybackId,
    });
    const session = buildPublicPlaybackSession(playbackId);
    return { url: session.url };
  },
});

export const getOriginalPlaybackUrl = action({
  args: { videoId: v.id("videos") },
  returns: v.object({
    url: v.string(),
    contentType: v.string(),
  }),
  handler: async (ctx, args): Promise<{ url: string; contentType: string }> => {
    const video = await ctx.runQuery(api.videos.getVideoForPlayback, {
      videoId: args.videoId,
    });

    if (!video || !video.s3Key) {
      throw new Error("Original bucket file not found for this video");
    }

    const contentType = video.contentType ?? "video/mp4";
    return {
      url: await buildSignedBucketObjectUrl(video.s3Key, {
        expiresIn: 600,
        contentType,
        forBrowser: true,
      }),
      contentType,
    };
  },
});

export const getPublicPlaybackSession = action({
  args: { publicId: v.string() },
  returns: v.object({
    url: v.string(),
    posterUrl: v.string(),
    spriteVttUrl: v.optional(v.string()),
  }),
  handler: async (
    ctx,
    args,
  ): Promise<{ url: string; posterUrl: string; spriteVttUrl?: string }> => {
    const result = await ctx.runQuery(api.videos.getByPublicId, {
      publicId: args.publicId,
    });

    if (!result?.video) {
      throw new Error("Video not found or not ready");
    }

    if (result.video.hlsKey) {
      return buildHlsPlaybackSession(result.video.hlsKey, result.video.thumbnailKey, result.video.thumbnailUrl, result.video.spriteVttKey);
    }

    if (!result.video.muxPlaybackId) {
      throw new Error("Video not found or not ready");
    }

    const playbackId = await ensurePublicPlaybackId(ctx, {
      videoId: result.video._id,
      muxAssetId: result.video.muxAssetId,
      muxPlaybackId: result.video.muxPlaybackId,
    });
    return buildPublicPlaybackSession(playbackId);
  },
});

export const getSharedPlaybackSession = action({
  args: { grantToken: v.string() },
  returns: v.object({
    url: v.string(),
    posterUrl: v.string(),
    spriteVttUrl: v.optional(v.string()),
  }),
  handler: async (
    ctx,
    args,
  ): Promise<{ url: string; posterUrl: string; spriteVttUrl?: string }> => {
    const result = await ctx.runQuery(api.videos.getByShareGrant, {
      grantToken: args.grantToken,
    });

    if (!result?.video) {
      throw new Error("Video not found or not ready");
    }

    if (result.video.hlsKey) {
      return buildHlsPlaybackSession(result.video.hlsKey, result.video.thumbnailKey, result.video.thumbnailUrl, result.video.spriteVttKey);
    }

    if (!result.video.muxPlaybackId) {
      throw new Error("Video not found or not ready");
    }

    const playbackId = await ensurePublicPlaybackId(ctx, {
      videoId: result.video._id,
      muxAssetId: result.video.muxAssetId,
      muxPlaybackId: result.video.muxPlaybackId,
    });
    return buildPublicPlaybackSession(playbackId);
  },
});

export const getDownloadUrl = action({
  args: { videoId: v.id("videos") },
  returns: v.object({
    url: v.string(),
    filename: v.string(),
  }),
  handler: async (ctx, args): Promise<{ url: string; filename: string }> => {
    const video = await ctx.runQuery(api.videos.getVideoForPlayback, {
      videoId: args.videoId,
    });

    if (!video) {
      throw new Error("Video not found");
    }

    if (video.status !== "ready") {
      throw new Error("Video not found or not ready");
    }

    const key = getValueString(video, "s3Key");
    if (!key) {
      throw new Error("Original bucket file not found for this video");
    }

    const filename = buildDownloadFilename(video.title, key);

    return {
      url: await buildSignedBucketObjectUrl(key, {
        expiresIn: 600,
        filename,
        contentType: video.contentType ?? "video/mp4",
        forBrowser: true,
      }),
      filename,
    };
  },
});

async function deleteAllObjectsWithPrefix(prefix: string) {
  const s3 = getS3Client();
  let continuationToken: string | undefined;
  do {
    const list = await s3.send(
      new ListObjectsV2Command({
        Bucket: BUCKET_NAME,
        Prefix: prefix,
        MaxKeys: 1000,
        ContinuationToken: continuationToken,
      }),
    );
    const objects = list.Contents;
    if (objects && objects.length > 0) {
      await s3.send(
        new DeleteObjectsCommand({
          Bucket: BUCKET_NAME,
          Delete: {
            Objects: objects.map((o) => ({ Key: o.Key! })),
            Quiet: true,
          },
        }),
      );
    }
    continuationToken = list.IsTruncated ? list.NextContinuationToken : undefined;
  } while (continuationToken);
}

export const purgeVideoFiles = internalAction({
  args: { videoId: v.string() },
  returns: v.null(),
  handler: async (_ctx, args) => {
    const prefix = `videos/${args.videoId}/`;
    await deleteAllObjectsWithPrefix(prefix);
    return null;
  },
});
