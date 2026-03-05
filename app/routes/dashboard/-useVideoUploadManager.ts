import { useAction, useMutation } from "convex/react";
import { useCallback, useState } from "react";
import { api } from "@convex/_generated/api";
import { Id } from "@convex/_generated/dataModel";
import type { UploadStatus } from "@/components/upload/UploadProgress";

export interface ManagedUploadItem {
  id: string;
  projectId: Id<"projects">;
  file: File;
  videoId?: Id<"videos">;
  progress: number;
  status: UploadStatus;
  error?: string;
  bytesPerSecond?: number;
  estimatedSecondsRemaining?: number | null;
  abortController?: AbortController;
}

function createUploadId() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return Math.random().toString(36).slice(2);
}

const MULTIPART_THRESHOLD = 25 * 1024 * 1024; // 25 MB — always prefer multipart
const CONCURRENT_PARTS = 6;

function uploadPartXhr(
  url: string,
  blob: Blob,
  signal: AbortSignal,
  onProgress: (loaded: number) => void,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.upload.addEventListener("progress", (e) => {
      if (e.lengthComputable) onProgress(e.loaded);
    });
    xhr.addEventListener("load", () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        const etag = xhr.getResponseHeader("ETag");
        if (!etag) return reject(new Error("Missing ETag in part response"));
        resolve(etag);
      } else {
        reject(new Error(`Part upload failed: ${xhr.status}`));
      }
    });
    xhr.addEventListener("error", () => reject(new Error("Part upload network error")));
    xhr.addEventListener("abort", () => reject(new Error("Upload cancelled")));
    signal.addEventListener("abort", () => xhr.abort());
    xhr.open("PUT", url);
    xhr.send(blob);
  });
}

export function useVideoUploadManager() {
  const createVideo = useMutation(api.videos.create);
  const getUploadUrl = useAction(api.videoActions.getUploadUrl);
  const initiateMultipart = useAction(api.videoActions.initiateMultipartUpload);
  const completeMultipart = useAction(api.videoActions.completeMultipartUpload);
  const markUploadComplete = useAction(api.videoActions.markUploadComplete);
  const markUploadFailed = useAction(api.videoActions.markUploadFailed);
  const [uploads, setUploads] = useState<ManagedUploadItem[]>([]);

  const updateUpload = (uploadId: string, patch: Partial<ManagedUploadItem>) => {
    setUploads((prev) =>
      prev.map((u) => (u.id === uploadId ? { ...u, ...patch } : u)),
    );
  };

  const uploadSinglePut = async (
    uploadId: string,
    videoId: Id<"videos">,
    file: File,
    abortController: AbortController,
  ) => {
    const { url } = await getUploadUrl({
      videoId,
      filename: file.name,
      fileSize: file.size,
      contentType: file.type || "video/mp4",
    });

    await new Promise<void>((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      let lastTime = Date.now();
      let lastLoaded = 0;
      const recentSpeeds: number[] = [];

      xhr.upload.addEventListener("progress", (event) => {
        if (!event.lengthComputable) return;
        const percentage = Math.round((event.loaded / event.total) * 100);
        const now = Date.now();
        const timeDelta = (now - lastTime) / 1000;
        const bytesDelta = event.loaded - lastLoaded;
        if (timeDelta > 0.1) {
          recentSpeeds.push(bytesDelta / timeDelta);
          if (recentSpeeds.length > 5) recentSpeeds.shift();
          lastTime = now;
          lastLoaded = event.loaded;
        }
        const avgSpeed = recentSpeeds.length > 0
          ? recentSpeeds.reduce((a, b) => a + b, 0) / recentSpeeds.length
          : 0;
        const remaining = event.total - event.loaded;
        updateUpload(uploadId, {
          progress: percentage,
          bytesPerSecond: avgSpeed,
          estimatedSecondsRemaining: avgSpeed > 0 ? Math.ceil(remaining / avgSpeed) : null,
        });
      });
      xhr.addEventListener("load", () => {
        if (xhr.status >= 200 && xhr.status < 300) resolve();
        else reject(new Error(`Upload failed: ${xhr.status} ${xhr.statusText}`));
      });
      xhr.addEventListener("error", () => reject(new Error("Upload failed: Network error")));
      xhr.addEventListener("abort", () => reject(new Error("Upload cancelled")));
      abortController.signal.addEventListener("abort", () => xhr.abort());
      xhr.open("PUT", url);
      xhr.setRequestHeader("Content-Type", file.type || "video/mp4");
      xhr.send(file);
    });
  };

  const uploadMultipart = async (
    uploadId: string,
    videoId: Id<"videos">,
    file: File,
    abortController: AbortController,
  ) => {
    const { key, s3UploadId, partUrls, partSize } = await initiateMultipart({
      videoId,
      filename: file.name,
      fileSize: file.size,
      contentType: file.type || "video/mp4",
    });

    const totalParts = partUrls.length;
    const partLoaded = new Array<number>(totalParts).fill(0);
    const completedParts: { PartNumber: number; ETag: string }[] = [];
    let lastCalcTime = Date.now();
    let lastTotalLoaded = 0;
    const recentSpeeds: number[] = [];

    const recalcProgress = () => {
      const totalLoaded = partLoaded.reduce((a, b) => a + b, 0);
      const percentage = Math.round((totalLoaded / file.size) * 100);
      const now = Date.now();
      const timeDelta = (now - lastCalcTime) / 1000;
      if (timeDelta > 0.3) {
        const speed = (totalLoaded - lastTotalLoaded) / timeDelta;
        recentSpeeds.push(speed);
        if (recentSpeeds.length > 5) recentSpeeds.shift();
        lastCalcTime = now;
        lastTotalLoaded = totalLoaded;
      }
      const avgSpeed = recentSpeeds.length > 0
        ? recentSpeeds.reduce((a, b) => a + b, 0) / recentSpeeds.length
        : 0;
      const remaining = file.size - totalLoaded;
      updateUpload(uploadId, {
        progress: percentage,
        bytesPerSecond: avgSpeed,
        estimatedSecondsRemaining: avgSpeed > 0 ? Math.ceil(remaining / avgSpeed) : null,
      });
    };

    let nextPartIndex = 0;
    const uploadNext = async (): Promise<void> => {
      while (nextPartIndex < totalParts) {
        if (abortController.signal.aborted) throw new Error("Upload cancelled");
        const idx = nextPartIndex++;
        const start = idx * partSize;
        const end = Math.min(start + partSize, file.size);
        const blob = file.slice(start, end);
        const etag = await uploadPartXhr(
          partUrls[idx],
          blob,
          abortController.signal,
          (loaded) => { partLoaded[idx] = loaded; recalcProgress(); },
        );
        partLoaded[idx] = end - start;
        recalcProgress();
        completedParts.push({ PartNumber: idx + 1, ETag: etag });
      }
    };

    const workers = Array.from(
      { length: Math.min(CONCURRENT_PARTS, totalParts) },
      () => uploadNext(),
    );
    await Promise.all(workers);

    completedParts.sort((a, b) => a.PartNumber - b.PartNumber);
    await completeMultipart({ videoId, key, s3UploadId, parts: completedParts });
  };

  const uploadFilesToProject = useCallback(
    async (projectId: Id<"projects">, files: File[]) => {
      for (const file of files) {
        const uploadId = createUploadId();
        const title = file.name.replace(/\.[^/.]+$/, "");
        const abortController = new AbortController();

        setUploads((prev) => [
          ...prev,
          { id: uploadId, projectId, file, progress: 0, status: "pending", abortController },
        ]);

        let createdVideoId: Id<"videos"> | undefined;

        try {
          createdVideoId = await createVideo({
            projectId,
            title,
            fileSize: file.size,
            contentType: file.type || "video/mp4",
          });

          updateUpload(uploadId, { videoId: createdVideoId, status: "uploading" });

          if (file.size > MULTIPART_THRESHOLD) {
            await uploadMultipart(uploadId, createdVideoId, file, abortController);
          } else {
            await uploadSinglePut(uploadId, createdVideoId, file, abortController);
          }

          await markUploadComplete({ videoId: createdVideoId });
          updateUpload(uploadId, { status: "complete", progress: 100 });
          setTimeout(() => {
            setUploads((prev) => prev.filter((u) => u.id !== uploadId));
          }, 3000);
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : "Upload failed";
          updateUpload(uploadId, { status: "error", error: errorMessage });
          if (createdVideoId) {
            markUploadFailed({ videoId: createdVideoId }).catch(console.error);
          }
        }
      }
    },
    [createVideo, getUploadUrl, initiateMultipart, completeMultipart, markUploadComplete, markUploadFailed],
  );

  const cancelUpload = useCallback(
    (uploadId: string) => {
      const upload = uploads.find((item) => item.id === uploadId);
      if (upload?.abortController) {
        upload.abortController.abort();
      }
      if (upload?.videoId) {
        markUploadFailed({ videoId: upload.videoId }).catch(console.error);
      }
      setUploads((prev) => prev.filter((item) => item.id !== uploadId));
    },
    [uploads, markUploadFailed],
  );

  return {
    uploads,
    uploadFilesToProject,
    cancelUpload,
  };
}
