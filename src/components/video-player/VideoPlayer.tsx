"use client";

import { useRef, useEffect, useState, useCallback, useMemo, forwardRef, useImperativeHandle } from "react";
import type Hls from "hls.js";
import {
  Play,
  Pause,
  Volume2,
  VolumeX,
  Maximize2,
  Minimize2,
  Download,
  RotateCcw,
  RotateCw,
  Timer,
  Settings2,
  Check,
  ChevronDown,
} from "lucide-react";
import { cn, formatDuration, formatTimestamp } from "@/lib/utils";
import { triggerDownload } from "@/lib/download";

interface Comment {
  _id: string;
  timestampSeconds: number;
  endTimestampSeconds?: number;
  resolved: boolean;
}

interface DownloadResult {
  url: string;
  filename?: string;
}

interface SpriteEntry {
  start: number;
  end: number;
  url: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

interface VideoPlayerProps {
  src: string;
  poster?: string;
  comments?: Comment[];
  onTimeUpdate?: (currentTime: number) => void;
  onMarkerClick?: (comment: Comment) => void;
  initialTime?: number;
  className?: string;
  allowDownload?: boolean;
  downloadUrl?: string;
  downloadFilename?: string;
  onRequestDownload?: () => Promise<DownloadResult | null | undefined> | DownloadResult | null | undefined;
  qualityOptionsConfig?: Array<{
    id: string;
    label: string;
    disabled?: boolean;
  }>;
  selectedQualityId?: string;
  onSelectQuality?: (id: string) => void;
  /** Render controls below the video frame instead of overlaid. Ideal for mobile. */
  controlsBelow?: boolean;
  /** URL to a WebVTT file mapping timestamps to sprite sheet thumbnails. */
  spriteVttUrl?: string;
  /** When set, renders a draggable editing marker on the timeline. */
  editingMarker?: { timestampSeconds: number };
  /** Called continuously while the editing marker is dragged. */
  onEditingMarkerDrag?: (time: number) => void;
  /** Range editing: in/out handles */
  rangeMarker?: { inTime: number; outTime: number };
  onRangeMarkerDrag?: (handle: "in" | "out", time: number) => void;
}

export interface VideoPlayerHandle {
  seekTo: (time: number, options?: { play?: boolean }) => void;
}

const PLAYBACK_RATES = [0.5, 0.75, 1, 1.25, 1.5, 2] as const;
const AUTO_QUALITY_LEVEL = -1 as const;
const DEFAULT_FPS = 30;

type QualityLevelOption = {
  level: number;
  label: string;
};

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

function isHlsSource(src: string) {
  return src.includes(".m3u8");
}

export const VideoPlayer = forwardRef<VideoPlayerHandle, VideoPlayerProps>(function VideoPlayer(
  {
    src,
    poster,
    comments = [],
    onTimeUpdate,
    onMarkerClick,
    initialTime,
    className,
    allowDownload = false,
    downloadUrl,
    downloadFilename,
    onRequestDownload,
    qualityOptionsConfig,
    selectedQualityId,
    onSelectQuality,
    controlsBelow = false,
    spriteVttUrl,
    editingMarker,
    onEditingMarkerDrag,
    rangeMarker,
    onRangeMarkerDrag,
  },
  ref
) {
  const wrapperRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const hlsRef = useRef<Hls | null>(null);
  const trackRef = useRef<HTMLDivElement>(null);

  const [duration, setDuration] = useState(0);
  const [currentTime, setCurrentTime] = useState(0);
  const [bufferedPercent, setBufferedPercent] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [isMediaReady, setIsMediaReady] = useState(false);
  const [isBuffering, setIsBuffering] = useState(false);
  const [controlsVisible, setControlsVisible] = useState(true);
  const [volume, setVolume] = useState(1);
  const [isMuted, setIsMuted] = useState(false);
  const [playbackRate, setPlaybackRate] = useState(1);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [isScrubbing, setIsScrubbing] = useState(false);
  const [scrubTime, setScrubTime] = useState(0);
  const [isDownloading, setIsDownloading] = useState(false);
  const [loopEnabled, setLoopEnabled] = useState(false);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);
  const [qualityMenuOpen, setQualityMenuOpen] = useState(false);
  const [qualityOptions, setQualityOptions] = useState<QualityLevelOption[]>([]);
  const [selectedQualityLevel, setSelectedQualityLevel] = useState<number>(AUTO_QUALITY_LEVEL);
  const [frameStepIndicator, setFrameStepIndicator] = useState<string | null>(null);
  const [detectedFps, setDetectedFps] = useState<number | null>(null);
  const [hoverTime, setHoverTime] = useState<number | null>(null);
  const [hoverX, setHoverX] = useState(0);
  const [sprites, setSprites] = useState<SpriteEntry[]>([]);

  const hideControlsTimeoutRef = useRef<number | null>(null);
  const frameStepTimerRef = useRef<number | null>(null);
  const wasPlayingBeforeScrubRef = useRef(false);
  const scrubTimeRef = useRef(0);
  const volumeBeforeMuteRef = useRef(1);
  const isPlayingRef = useRef(false);
  const isScrubbingRef = useRef(false);
  const resumeTimeOnSourceChangeRef = useRef<number | null>(null);
  const fpsDetectedRef = useRef(false);

  const groupedMarkers = useMemo(() => {
    if (!duration || comments.length === 0) return [] as { position: number; comment: Comment }[];

    const markers: { position: number; comment: Comment }[] = [];
    for (const comment of comments) {
      const position = (comment.timestampSeconds / duration) * 100;
      const existing = markers.find((m) => Math.abs(m.position - position) < 1);
      if (!existing) {
        markers.push({ position, comment });
      }
    }
    return markers;
  }, [comments, duration]);

  const showControls = useCallback(() => {
    setControlsVisible(true);
    if (hideControlsTimeoutRef.current !== null) {
      window.clearTimeout(hideControlsTimeoutRef.current);
      hideControlsTimeoutRef.current = null;
    }
    if (isPlayingRef.current) {
      hideControlsTimeoutRef.current = window.setTimeout(() => {
        setControlsVisible(false);
      }, 2500);
    }
  }, []);

  const updateBuffered = useCallback(() => {
    const video = videoRef.current;
    if (!video || !video.duration || video.buffered.length === 0) return;
    const end = video.buffered.end(video.buffered.length - 1);
    setBufferedPercent(clamp(end / video.duration, 0, 1));
  }, []);

  const applyTime = useCallback(
    (time: number) => {
      const video = videoRef.current;
      if (!video) return;
      const actualDuration = duration || video.duration || 0;
      const next = actualDuration > 0 ? clamp(time, 0, actualDuration) : Math.max(time, 0);
      video.currentTime = next;
      setCurrentTime(next);
      onTimeUpdate?.(next);
    },
    [duration, onTimeUpdate]
  );

  const seekTo = useCallback(
    (time: number, options?: { play?: boolean }) => {
      applyTime(time);
      if (options?.play) {
        const video = videoRef.current;
        if (video) {
          const playPromise = video.play();
          if (playPromise) {
            playPromise.catch(() => {
              // Ignore autoplay rejections.
            });
          }
        }
      }
      showControls();
    },
    [applyTime, showControls]
  );

  useImperativeHandle(ref, () => ({ seekTo }), [seekTo]);

  const handleSeekBy = useCallback(
    (delta: number) => {
      applyTime((videoRef.current?.currentTime ?? 0) + delta);
      showControls();
    },
    [applyTime, showControls]
  );

  const handleFrameStep = useCallback(
    (direction: 1 | -1) => {
      const video = videoRef.current;
      if (!video) return;
      if (!video.paused) video.pause();
      const fps = detectedFps ?? DEFAULT_FPS;
      const frameDuration = 1 / fps;
      const next = clamp(video.currentTime + direction * frameDuration, 0, duration || video.duration || 0);
      video.currentTime = next;
      setCurrentTime(next);
      onTimeUpdate?.(next);
      showControls();
      const fpsLabel = detectedFps ? `${detectedFps}fps` : "";
      const label = direction > 0 ? `Frame +1 ${fpsLabel}` : `Frame \u20131 ${fpsLabel}`;
      setFrameStepIndicator(label);
      if (frameStepTimerRef.current !== null) window.clearTimeout(frameStepTimerRef.current);
      frameStepTimerRef.current = window.setTimeout(() => setFrameStepIndicator(null), 600);
    },
    [detectedFps, duration, onTimeUpdate, showControls],
  );

  const togglePlay = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;

    showControls();

    if (video.paused) {
      const playPromise = video.play();
      if (playPromise) {
        playPromise.catch(() => {
          // Ignore play errors caused by browser autoplay policies.
        });
      }
    } else {
      video.pause();
    }
  }, [showControls]);

  const setVideoVolume = useCallback((nextVolume: number) => {
    const video = videoRef.current;
    if (!video) return;
    const clamped = clamp(nextVolume, 0, 1);
    video.volume = clamped;
    video.muted = clamped === 0;
    setVolume(clamped);
    setIsMuted(video.muted);
  }, []);

  const toggleMute = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;

    showControls();

    if (video.muted || video.volume === 0) {
      const restored = volumeBeforeMuteRef.current > 0 ? volumeBeforeMuteRef.current : 1;
      setVideoVolume(restored);
      video.muted = false;
      setIsMuted(false);
    } else {
      volumeBeforeMuteRef.current = video.volume;
      video.muted = true;
      setIsMuted(true);
    }
  }, [setVideoVolume, showControls]);

  const cyclePlaybackRate = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;

    showControls();

    const currentIndex = PLAYBACK_RATES.findIndex((rate) => rate === video.playbackRate);
    const nextIndex = currentIndex === -1 ? 2 : (currentIndex + 1) % PLAYBACK_RATES.length;
    const nextRate = PLAYBACK_RATES[nextIndex];
    video.playbackRate = nextRate;
    setPlaybackRate(nextRate);
  }, [showControls]);

  const toggleFullscreen = useCallback(async () => {
    const target = controlsBelow ? wrapperRef.current : containerRef.current;
    if (!target) return;

    showControls();

    try {
      if (document.fullscreenElement) {
        await document.exitFullscreen();
      } else {
        await target.requestFullscreen();
      }
    } catch {
      // Fullscreen can fail in some embedded contexts; ignore gracefully.
    }
  }, [controlsBelow, showControls]);

  const handleDownload = useCallback(async () => {
    if (!allowDownload || isDownloading) return;

    showControls();
    setIsDownloading(true);

    try {
      if (onRequestDownload) {
        const result = await onRequestDownload();
        if (result?.url) {
          triggerDownload(result.url, result.filename ?? downloadFilename);
          return;
        }
      }

      if (downloadUrl) {
        triggerDownload(downloadUrl, downloadFilename);
      }
    } finally {
      setContextMenu(null);
      setIsDownloading(false);
    }
  }, [allowDownload, isDownloading, onRequestDownload, downloadUrl, downloadFilename, showControls]);

  const copyTimestamp = useCallback(async () => {
    const timeToCopy = isScrubbing ? scrubTimeRef.current : currentTime;
    const label = formatTimestamp(timeToCopy);
    try {
      await navigator.clipboard.writeText(label);
    } catch {
      // Clipboard access may fail on some browsers; ignore silently.
    }
    setContextMenu(null);
    showControls();
  }, [currentTime, isScrubbing, showControls]);

  const toggleLoop = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    const next = !loopEnabled;
    video.loop = next;
    setLoopEnabled(next);
    setContextMenu(null);
    showControls();
  }, [loopEnabled, showControls]);

  const applyQualityLevel = useCallback(
    (level: number) => {
      const hls = hlsRef.current;
      if (!hls) return;
      hls.currentLevel = level;
      setSelectedQualityLevel(level);
      setQualityMenuOpen(false);
      showControls();
    },
    [showControls]
  );

  const getTimeFromClientX = useCallback(
    (clientX: number) => {
      const track = trackRef.current;
      if (!track || !duration) return 0;
      const rect = track.getBoundingClientRect();
      if (rect.width <= 0) return 0;
      const percent = clamp((clientX - rect.left) / rect.width, 0, 1);
      return percent * duration;
    },
    [duration]
  );

  const startScrub = useCallback(
    (clientX: number) => {
      const video = videoRef.current;
      if (!video || !duration) return;

      wasPlayingBeforeScrubRef.current = !video.paused;
      video.pause();
      setIsScrubbing(true);

      const nextTime = getTimeFromClientX(clientX);
      video.currentTime = nextTime;
      scrubTimeRef.current = nextTime;
      setScrubTime(nextTime);
      setCurrentTime(nextTime);
      onTimeUpdate?.(nextTime);
    },
    [duration, getTimeFromClientX, onTimeUpdate]
  );

  const updateScrub = useCallback(
    (clientX: number) => {
      if (!isScrubbingRef.current) return;
      const video = videoRef.current;
      const nextTime = getTimeFromClientX(clientX);
      if (video) video.currentTime = nextTime;
      scrubTimeRef.current = nextTime;
      setScrubTime(nextTime);
      setCurrentTime(nextTime);
      onTimeUpdate?.(nextTime);
    },
    [getTimeFromClientX, onTimeUpdate]
  );

  const endScrub = useCallback(() => {
    const video = videoRef.current;
    if (!video || !duration) return;

    const finalTime = clamp(scrubTimeRef.current, 0, duration);
    video.currentTime = finalTime;
    setCurrentTime(finalTime);
    setIsScrubbing(false);

    if (wasPlayingBeforeScrubRef.current) {
      const playPromise = video.play();
      if (playPromise) {
        playPromise.catch(() => {
          // Ignore autoplay rejections after scrubbing.
        });
      }
    }
  }, [duration]);

  useEffect(() => {
    isPlayingRef.current = isPlaying;
  }, [isPlaying]);

  useEffect(() => {
    isScrubbingRef.current = isScrubbing;
  }, [isScrubbing]);

  useEffect(() => {
    if (!spriteVttUrl) { setSprites([]); return; }
    let cancelled = false;
    fetch(spriteVttUrl)
      .then((r) => r.text())
      .then((text) => {
        if (cancelled) return;
        const baseUrl = spriteVttUrl.substring(0, spriteVttUrl.lastIndexOf("/") + 1);
        const entries: SpriteEntry[] = [];
        const blocks = text.split(/\n\n+/);
        for (const block of blocks) {
          const lines = block.trim().split("\n");
          const timeLine = lines.find((l) => l.includes("-->"));
          const urlLine = lines.find((l) => l.includes("#xywh="));
          if (!timeLine || !urlLine) continue;
          const [startStr, endStr] = timeLine.split("-->").map((s) => s.trim());
          const parseVttTime = (t: string) => {
            const p = t.split(":");
            return parseFloat(p[0]) * 3600 + parseFloat(p[1]) * 60 + parseFloat(p[2]);
          };
          const [file, frag] = urlLine.split("#xywh=");
          const [x, y, w, h] = frag.split(",").map(Number);
          entries.push({
            start: parseVttTime(startStr),
            end: parseVttTime(endStr),
            url: file.startsWith("http") ? file : `${baseUrl}${file}`,
            x, y, w, h,
          });
        }
        setSprites(entries);
      })
      .catch(() => { if (!cancelled) setSprites([]); });
    return () => { cancelled = true; };
  }, [spriteVttUrl]);

  const spriteForTime = useCallback(
    (time: number): SpriteEntry | null => {
      for (const s of sprites) {
        if (time >= s.start && time < s.end) return s;
      }
      return sprites.length > 0 ? sprites[sprites.length - 1] : null;
    },
    [sprites],
  );

  useEffect(() => {
    return () => {
      if (hideControlsTimeoutRef.current !== null) {
        window.clearTimeout(hideControlsTimeoutRef.current);
        hideControlsTimeoutRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    let cancelled = false;

    const handleLoadedMetadata = () => {
      if (cancelled) return;
      setDuration(video.duration || 0);
      updateBuffered();
      const resumeTime = initialTime ?? resumeTimeOnSourceChangeRef.current ?? undefined;
      if (resumeTime && resumeTime > 0) {
        video.currentTime = clamp(resumeTime, 0, video.duration || resumeTime);
      }
      resumeTimeOnSourceChangeRef.current = null;
    };

    const handleLoadedData = () => {
      if (cancelled) return;
      setIsMediaReady(true);
      setIsBuffering(false);
    };

    const handleDurationChange = () => {
      if (cancelled) return;
      setDuration(video.duration || 0);
    };

    const handleTimeUpdate = () => {
      if (cancelled || isScrubbingRef.current) return;
      const time = video.currentTime || 0;
      setCurrentTime(time);
      onTimeUpdate?.(time);
    };

    const handlePlay = () => {
      if (cancelled) return;
      setIsPlaying(true);
      setIsBuffering(false);
      showControls();
    };

    const handlePause = () => {
      if (cancelled) return;
      setIsPlaying(false);
      setIsBuffering(false);
      setControlsVisible(true);
    };

    const handleWaiting = () => {
      if (cancelled) return;
      setIsBuffering(true);
    };

    const handlePlaying = () => {
      if (cancelled) return;
      setIsMediaReady(true);
      setIsBuffering(false);

      if (!fpsDetectedRef.current && "requestVideoFrameCallback" in video) {
        fpsDetectedRef.current = true;
        let prevMedia: number | null = null;
        const deltas: number[] = [];
        const onFrame = (_now: DOMHighResTimeStamp, meta: { mediaTime: number }) => {
          if (cancelled) return;
          if (prevMedia !== null) {
            const d = meta.mediaTime - prevMedia;
            if (d > 0.001 && d < 0.2) deltas.push(d);
          }
          prevMedia = meta.mediaTime;
          if (deltas.length >= 4) {
            const avg = deltas.reduce((a, b) => a + b, 0) / deltas.length;
            const fps = Math.round(1 / avg);
            if (fps >= 10 && fps <= 120) setDetectedFps(fps);
          } else {
            (video as any).requestVideoFrameCallback(onFrame);
          }
        };
        (video as any).requestVideoFrameCallback(onFrame);
      }
    };

    const handleCanPlay = () => {
      if (cancelled) return;
      setIsMediaReady(true);
    };

    const handleError = () => {
      if (cancelled) return;
      setIsMediaReady(true);
      setIsBuffering(false);
    };

    const handleVolumeChange = () => {
      if (cancelled) return;
      setVolume(video.volume);
      setIsMuted(video.muted || video.volume === 0);
    };

    const handleRateChange = () => {
      if (cancelled) return;
      setPlaybackRate(video.playbackRate || 1);
    };

    const handleProgress = () => {
      if (cancelled) return;
      updateBuffered();
    };

    const handleEnded = () => {
      if (cancelled) return;
      setIsPlaying(false);
      setControlsVisible(true);
    };

    const attachSource = async () => {
      const currentSourceTime = video.currentTime;
      resumeTimeOnSourceChangeRef.current =
        currentSourceTime > 0 ? currentSourceTime : resumeTimeOnSourceChangeRef.current;

      // Clean up any previous HLS instance.
      if (hlsRef.current) {
        hlsRef.current.destroy();
        hlsRef.current = null;
      }

      setDuration(0);
      setCurrentTime(0);
      setBufferedPercent(0);
      setIsMediaReady(false);
      setIsBuffering(false);
      setQualityMenuOpen(false);
      setQualityOptions([]);
      setSelectedQualityLevel(AUTO_QUALITY_LEVEL);
      setDetectedFps(null);
      fpsDetectedRef.current = false;

      // Reset the element source before attaching a new one.
      video.removeAttribute("src");
      video.load();

      if (isHlsSource(src)) {
        const { default: Hls } = await import("hls.js");
        if (cancelled) return;

        if (Hls.isSupported()) {
          const hls = new Hls({ enableWorker: true });
          hlsRef.current = hls;
          hls.loadSource(src);
          hls.attachMedia(video);
          hls.on(Hls.Events.MANIFEST_PARSED, () => {
            // Populate available manual quality levels and default to auto.
            const dedupedByHeight = new Map<number, { level: number; bitrate: number }>();
            hls.levels.forEach((levelInfo, levelIndex) => {
              const height = levelInfo.height;
              if (!height) return;
              const bitrate = levelInfo.bitrate ?? 0;
              const existing = dedupedByHeight.get(height);
              if (!existing || bitrate >= existing.bitrate) {
                dedupedByHeight.set(height, { level: levelIndex, bitrate });
              }
            });

            const nextOptions = Array.from(dedupedByHeight.entries())
              .sort((a, b) => b[0] - a[0])
              .map(([height, data]) => ({
                level: data.level,
                label: `${height}p`,
              }));
            setQualityOptions(nextOptions);
            setSelectedQualityLevel(AUTO_QUALITY_LEVEL);
          });
          hls.on(Hls.Events.LEVEL_SWITCHED, () => {
            if (hls.autoLevelEnabled) {
              setSelectedQualityLevel(AUTO_QUALITY_LEVEL);
            }
          });
        } else {
          video.src = src;
        }
      } else {
        video.src = src;
      }
    };

    video.addEventListener("loadedmetadata", handleLoadedMetadata);
    video.addEventListener("loadeddata", handleLoadedData);
    video.addEventListener("durationchange", handleDurationChange);
    video.addEventListener("timeupdate", handleTimeUpdate);
    video.addEventListener("play", handlePlay);
    video.addEventListener("pause", handlePause);
    video.addEventListener("waiting", handleWaiting);
    video.addEventListener("playing", handlePlaying);
    video.addEventListener("canplay", handleCanPlay);
    video.addEventListener("error", handleError);
    video.addEventListener("volumechange", handleVolumeChange);
    video.addEventListener("ratechange", handleRateChange);
    video.addEventListener("progress", handleProgress);
    video.addEventListener("ended", handleEnded);

    attachSource().catch(() => {
      // If HLS import fails, fall back to setting the src directly.
      video.src = src;
    });

    return () => {
      cancelled = true;

      // Save current time before teardown so a source change can resume.
      const ct = video.currentTime;
      if (ct > 0) {
        resumeTimeOnSourceChangeRef.current = ct;
      }

      video.removeEventListener("loadedmetadata", handleLoadedMetadata);
      video.removeEventListener("loadeddata", handleLoadedData);
      video.removeEventListener("durationchange", handleDurationChange);
      video.removeEventListener("timeupdate", handleTimeUpdate);
      video.removeEventListener("play", handlePlay);
      video.removeEventListener("pause", handlePause);
      video.removeEventListener("waiting", handleWaiting);
      video.removeEventListener("playing", handlePlaying);
      video.removeEventListener("canplay", handleCanPlay);
      video.removeEventListener("error", handleError);
      video.removeEventListener("volumechange", handleVolumeChange);
      video.removeEventListener("ratechange", handleRateChange);
      video.removeEventListener("progress", handleProgress);
      video.removeEventListener("ended", handleEnded);

      if (hlsRef.current) {
        hlsRef.current.destroy();
        hlsRef.current = null;
      }

      video.removeAttribute("src");
      video.load();
    };
  }, [src, initialTime, onTimeUpdate, showControls, updateBuffered]);

  useEffect(() => {
    const handleFullscreenChange = () => {
      setIsFullscreen(Boolean(document.fullscreenElement));
    };
    document.addEventListener("fullscreenchange", handleFullscreenChange);
    return () => {
      document.removeEventListener("fullscreenchange", handleFullscreenChange);
    };
  }, []);

  useEffect(() => {
    if (!isScrubbing) return;

    const handleMove = (e: PointerEvent) => updateScrub(e.clientX);
    const handleUp = () => endScrub();

    window.addEventListener("pointermove", handleMove);
    window.addEventListener("pointerup", handleUp, { once: true });

    return () => {
      window.removeEventListener("pointermove", handleMove);
      window.removeEventListener("pointerup", handleUp);
    };
  }, [endScrub, isScrubbing, updateScrub]);

  useEffect(() => {
    if (!contextMenu) return;

    const handleClose = () => setContextMenu(null);
    window.addEventListener("click", handleClose);
    window.addEventListener("blur", handleClose);
    window.addEventListener("contextmenu", handleClose);

    return () => {
      window.removeEventListener("click", handleClose);
      window.removeEventListener("blur", handleClose);
      window.removeEventListener("contextmenu", handleClose);
    };
  }, [contextMenu]);

  useEffect(() => {
    if (!qualityMenuOpen) return;

    const handleClose = () => setQualityMenuOpen(false);
    window.addEventListener("click", handleClose);
    window.addEventListener("blur", handleClose);

    return () => {
      window.removeEventListener("click", handleClose);
      window.removeEventListener("blur", handleClose);
    };
  }, [qualityMenuOpen]);

  const displayTime = isScrubbing ? scrubTime : currentTime;
  const playedPercent = duration > 0 ? clamp(displayTime / duration, 0, 1) : 0;
  const canDownload = allowDownload && (Boolean(downloadUrl) || Boolean(onRequestDownload));
  const isHls = isHlsSource(src);
  const hasExternalQualityOptions = Boolean(qualityOptionsConfig && qualityOptionsConfig.length > 0);
  const hasManualQualityOptions = isHls && qualityOptions.length > 0;
  const qualityLabel = useMemo(() => {
    if (hasManualQualityOptions) {
      if (selectedQualityLevel === AUTO_QUALITY_LEVEL) return "Auto";
      return qualityOptions.find((option) => option.level === selectedQualityLevel)?.label ?? "Auto";
    }
    if (hasExternalQualityOptions) {
      return qualityOptionsConfig?.find((option) => option.id === selectedQualityId)?.label ?? "Quality";
    }
    if (!isHls) return "Original";
    return "Auto";
  }, [hasManualQualityOptions, hasExternalQualityOptions, isHls, qualityOptions, qualityOptionsConfig, selectedQualityId, selectedQualityLevel]);
  const isExternalControls = controlsBelow && !isFullscreen;

  // ── Controls content (timeline + buttons) ─────────────────────────
  // Rendered either as an overlay inside the video frame or below it.
  const controlsContent = (
    <>
      {/* Timeline */}
      <div
        ref={trackRef}
        className="relative mb-1 h-3 w-full cursor-pointer rounded-full border border-white/10 bg-white/10"
        onPointerDown={(e) => {
          e.preventDefault();
          showControls();
          startScrub(e.clientX);
        }}
        onPointerMove={(e) => {
          if (isScrubbing) return;
          const track = trackRef.current;
          if (!track || !duration) return;
          const rect = track.getBoundingClientRect();
          const pct = clamp((e.clientX - rect.left) / rect.width, 0, 1);
          setHoverTime(pct * duration);
          setHoverX(clamp(e.clientX - rect.left, 0, rect.width));
        }}
        onPointerLeave={() => { setHoverTime(null); }}
      >
        <div
          className="absolute inset-y-0 left-0 rounded-full bg-white/20"
          style={{ width: `${bufferedPercent * 100}%` }}
        />
        <div
          className="absolute inset-y-0 left-0 rounded-full bg-[color:var(--accent)]"
          style={{ width: `${playedPercent * 100}%` }}
        />

        {/* Sprite thumbnail tooltip on hover or scrub */}
        {(() => {
          const previewTime = isScrubbing ? scrubTime : hoverTime;
          if (previewTime === null) return null;
          const sprite = spriteForTime(previewTime);
          const thumbW = sprite?.w ?? 160;
          const thumbH = sprite?.h ?? 90;
          const trackW = trackRef.current?.clientWidth ?? 9999;
          const previewX = isScrubbing
            ? (duration > 0 ? (previewTime / duration) * trackW : 0)
            : hoverX;
          const tooltipLeft = clamp(previewX, thumbW / 2, trackW - thumbW / 2);
          return (
            <div
              className="pointer-events-none absolute z-30"
              style={{ left: tooltipLeft, bottom: 20, transform: "translateX(-50%)" }}
            >
              {sprite ? (
                <div
                  className="overflow-hidden rounded border border-white/20 shadow-lg"
                  style={{
                    width: thumbW,
                    height: thumbH,
                    backgroundImage: `url(${sprite.url})`,
                    backgroundPosition: `-${sprite.x}px -${sprite.y}px`,
                    backgroundSize: `${thumbW * 10}px auto`,
                  }}
                />
              ) : null}
              <div className="mt-1 text-center text-[10px] font-mono text-white/80">
                {formatTimestamp(previewTime)}
              </div>
            </div>
          );
        })()}

        {/* Range comment fills on scrub bar */}
        {duration > 0 && comments
          .filter((c) => c.endTimestampSeconds !== undefined && c.endTimestampSeconds > c.timestampSeconds)
          .map((c) => (
            <div
              key={`fill-${c._id}`}
              className={cn(
                "absolute inset-y-0 z-[5]",
                c.resolved ? "bg-green-400/15" : "bg-orange-400/15",
              )}
              style={{
                left: `${(c.timestampSeconds / duration) * 100}%`,
                width: `${((c.endTimestampSeconds! - c.timestampSeconds) / duration) * 100}%`,
              }}
            />
          ))}

        {/* Comment ticks on scrub bar */}
        {groupedMarkers.map((marker) => {
          const isActive = Math.abs(displayTime - marker.comment.timestampSeconds) < 1.5;
          return (
            <button
              key={marker.comment._id}
              type="button"
              className={cn(
                "absolute top-0 bottom-0 z-10 w-0.5 -translate-x-1/2",
                marker.comment.resolved ? "bg-green-400/60" : "bg-orange-400/80",
                isActive && "w-1 bg-orange-300"
              )}
              style={{ left: `${marker.position}%` }}
              onPointerDown={(e) => { e.stopPropagation(); }}
              onClick={(e) => {
                e.stopPropagation();
                applyTime(marker.comment.timestampSeconds);
                onMarkerClick?.(marker.comment);
                showControls();
              }}
              aria-label={`Jump to comment at ${formatTimestamp(marker.comment.timestampSeconds)}`}
              title={`Comment at ${formatTimestamp(marker.comment.timestampSeconds)}`}
            />
          );
        })}
        {/* End-point ticks for range comments */}
        {comments
          .filter((c) => c.endTimestampSeconds !== undefined && c.endTimestampSeconds > c.timestampSeconds && duration > 0)
          .map((c) => (
            <div
              key={`end-${c._id}`}
              className={cn(
                "absolute top-0 bottom-0 z-10 w-0.5 -translate-x-1/2",
                c.resolved ? "bg-green-400/60" : "bg-orange-400/80",
              )}
              style={{ left: `${(c.endTimestampSeconds! / duration) * 100}%` }}
            />
          ))}

        {/* Range bar for in/out comments */}
        {rangeMarker && duration > 0 && (
          <>
            <div
              className="absolute inset-y-0 z-[8] bg-[#2d5a2d]/30 rounded-full"
              style={{
                left: `${(rangeMarker.inTime / duration) * 100}%`,
                width: `${((rangeMarker.outTime - rangeMarker.inTime) / duration) * 100}%`,
              }}
            />
            <div
              className="absolute top-1/2 z-[15] h-5 w-2 -translate-x-1/2 -translate-y-1/2 cursor-ew-resize rounded-sm border border-[#2d5a2d] bg-[#7cb87c] shadow"
              style={{ left: `${(rangeMarker.inTime / duration) * 100}%` }}
              onPointerDown={(e) => {
                e.stopPropagation();
                e.preventDefault();
                const video = videoRef.current;
                if (video && !video.paused) video.pause();
                const startX = e.clientX;
                const startTime = rangeMarker.inTime;
                const onMove = (ev: PointerEvent) => {
                  const track = trackRef.current;
                  if (!track) return;
                  const dx = ev.clientX - startX;
                  const scale = ev.shiftKey ? 0.1 : 1;
                  const dt = (dx * scale / track.getBoundingClientRect().width) * duration;
                  const t = clamp(startTime + dt, 0, duration);
                  if (video) video.currentTime = t;
                  onRangeMarkerDrag?.("in", t);
                };
                const onUp = () => {
                  window.removeEventListener("pointermove", onMove);
                  window.removeEventListener("pointerup", onUp);
                };
                window.addEventListener("pointermove", onMove);
                window.addEventListener("pointerup", onUp, { once: true });
              }}
            />
            <div
              className="absolute top-1/2 z-[15] h-5 w-2 -translate-x-1/2 -translate-y-1/2 cursor-ew-resize rounded-sm border border-[#2d5a2d] bg-[#7cb87c] shadow"
              style={{ left: `${(rangeMarker.outTime / duration) * 100}%` }}
              onPointerDown={(e) => {
                e.stopPropagation();
                e.preventDefault();
                const video = videoRef.current;
                if (video && !video.paused) video.pause();
                const startX = e.clientX;
                const startTime = rangeMarker.outTime;
                const onMove = (ev: PointerEvent) => {
                  const track = trackRef.current;
                  if (!track) return;
                  const dx = ev.clientX - startX;
                  const scale = ev.shiftKey ? 0.1 : 1;
                  const dt = (dx * scale / track.getBoundingClientRect().width) * duration;
                  const t = clamp(startTime + dt, 0, duration);
                  if (video) video.currentTime = t;
                  onRangeMarkerDrag?.("out", t);
                };
                const onUp = () => {
                  window.removeEventListener("pointermove", onMove);
                  window.removeEventListener("pointerup", onUp);
                };
                window.addEventListener("pointermove", onMove);
                window.addEventListener("pointerup", onUp, { once: true });
              }}
            />
          </>
        )}

        {/* Editing marker (draggable diamond) */}
        {editingMarker && duration > 0 && (
          <div
            className="absolute top-1/2 z-[15] h-4 w-4 -translate-x-1/2 -translate-y-1/2 rotate-45 cursor-ew-resize border-2 border-[#2d5a2d] bg-[#7cb87c] shadow"
            style={{ left: `${(editingMarker.timestampSeconds / duration) * 100}%` }}
            onPointerDown={(e) => {
              e.stopPropagation();
              e.preventDefault();
              const video = videoRef.current;
              if (video && !video.paused) video.pause();
              const startX = e.clientX;
              const startTime = editingMarker.timestampSeconds;
              const onMove = (ev: PointerEvent) => {
                const track = trackRef.current;
                if (!track) return;
                const dx = ev.clientX - startX;
                const scale = ev.shiftKey ? 0.1 : 1;
                const dt = (dx * scale / track.getBoundingClientRect().width) * duration;
                const t = clamp(startTime + dt, 0, duration);
                if (video) video.currentTime = t;
                onEditingMarkerDrag?.(t);
              };
              const onUp = () => {
                window.removeEventListener("pointermove", onMove);
                window.removeEventListener("pointerup", onUp);
              };
              window.addEventListener("pointermove", onMove);
              window.addEventListener("pointerup", onUp, { once: true });
            }}
            title={`Edit timestamp: ${formatTimestamp(editingMarker.timestampSeconds)} — hold Shift for fine control`}
          />
        )}

        {/* Scrubber */}
        <div
          className="absolute top-1/2 z-20 h-4 w-4 -translate-x-1/2 -translate-y-1/2 rounded-full border border-white/30 bg-white shadow"
          style={{ left: `${playedPercent * 100}%` }}
        />
      </div>

      {/* Comment markers lane */}
      {duration > 0 && comments.length > 0 && (
        <div className="relative mb-2 h-3 w-full">
          {comments.map((c) => {
            const isRange = c.endTimestampSeconds !== undefined && c.endTimestampSeconds > c.timestampSeconds;
            const isActive = Math.abs(displayTime - c.timestampSeconds) < 1.5;
            const left = (c.timestampSeconds / duration) * 100;

            if (isRange) {
              const endLeft = (c.endTimestampSeconds! / duration) * 100;
              const width = endLeft - left;
              return (
                <button
                  key={c._id}
                  type="button"
                  className="absolute top-1/2 -translate-y-1/2 group"
                  style={{ left: `${left}%`, width: `${width}%` }}
                  onPointerDown={(e) => e.stopPropagation()}
                  onClick={(e) => {
                    e.stopPropagation();
                    applyTime(c.timestampSeconds);
                    onMarkerClick?.(c);
                    showControls();
                  }}
                  title={`${formatTimestamp(c.timestampSeconds)}–${formatTimestamp(c.endTimestampSeconds!)}`}
                >
                  {/* Bar */}
                  <div className={cn(
                    "absolute inset-x-0 top-1/2 -translate-y-1/2 h-1",
                    c.resolved ? "bg-green-400/50" : "bg-orange-400/60",
                    isActive && "h-1.5"
                  )} />
                  {/* In triangle ▶ */}
                  <div
                    className={cn(
                      "absolute left-0 top-1/2 -translate-y-1/2 -translate-x-1/2",
                      c.resolved ? "text-green-400" : "text-orange-400",
                    )}
                    style={{ fontSize: 8, lineHeight: 1 }}
                  >▶</div>
                  {/* Out triangle ◀ */}
                  <div
                    className={cn(
                      "absolute right-0 top-1/2 -translate-y-1/2 translate-x-1/2",
                      c.resolved ? "text-green-400" : "text-orange-400",
                    )}
                    style={{ fontSize: 8, lineHeight: 1 }}
                  >◀</div>
                </button>
              );
            }

            return (
              <button
                key={c._id}
                type="button"
                className={cn(
                  "absolute top-1/2 z-10 h-2 w-2 -translate-x-1/2 -translate-y-1/2 rounded-full",
                  c.resolved ? "bg-green-400/70" : "bg-orange-400",
                  isActive && "ring-1 ring-white/60 h-2.5 w-2.5"
                )}
                style={{ left: `${left}%` }}
                onPointerDown={(e) => e.stopPropagation()}
                onClick={(e) => {
                  e.stopPropagation();
                  applyTime(c.timestampSeconds);
                  onMarkerClick?.(c);
                  showControls();
                }}
                title={`Comment at ${formatTimestamp(c.timestampSeconds)}`}
              />
            );
          })}
        </div>
      )}

      {/* Control row */}
      <div className="flex flex-wrap items-center gap-2 text-white">
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); togglePlay(); }}
          className="inline-flex h-9 w-9 items-center justify-center rounded-full border border-white/15 bg-white/10 transition hover:border-white/25 hover:bg-white/20"
          aria-label={isPlaying ? "Pause" : "Play"}
        >
          {isPlaying ? <Pause className="h-4 w-4" /> : <Play className="ml-0.5 h-4 w-4" />}
        </button>

        <div className="hidden sm:flex items-center gap-1.5 rounded-full border border-white/10 bg-white/5 px-2 py-1">
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); toggleMute(); }}
            className="inline-flex h-7 w-7 items-center justify-center rounded-full text-white/90 transition hover:bg-white/10"
            aria-label={isMuted ? "Unmute" : "Mute"}
          >
            {isMuted || volume === 0 ? <VolumeX className="h-4 w-4" /> : <Volume2 className="h-4 w-4" />}
          </button>
          <input
            aria-label="Volume"
            type="range"
            min={0}
            max={1}
            step={0.01}
            value={isMuted ? 0 : volume}
            onChange={(e) => { e.stopPropagation(); setVideoVolume(Number(e.target.value)); }}
            className="h-1 w-24 cursor-pointer accent-[color:var(--accent)]"
          />
        </div>

        <div className="rounded-full border border-white/10 bg-white/5 px-3 py-1 text-xs text-white/90">
          <span className="font-mono">
            {formatDuration(displayTime)} / {formatDuration(duration || 0)}
          </span>
        </div>

        <div className="ml-auto flex items-center gap-2">
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); handleSeekBy(-10); }}
            className="hidden sm:inline-flex h-9 w-9 items-center justify-center rounded-full border border-white/10 bg-white/5 transition hover:border-white/25 hover:bg-white/15"
            aria-label="Rewind 10 seconds"
            title="Rewind 10 seconds"
          >
            <RotateCcw className="h-4 w-4" />
          </button>

          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); handleSeekBy(10); }}
            className="hidden sm:inline-flex h-9 w-9 items-center justify-center rounded-full border border-white/10 bg-white/5 transition hover:border-white/25 hover:bg-white/15"
            aria-label="Forward 10 seconds"
            title="Forward 10 seconds"
          >
            <RotateCw className="h-4 w-4" />
          </button>

          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); cyclePlaybackRate(); }}
            className="inline-flex h-9 min-w-[56px] items-center justify-center rounded-full border border-white/10 bg-white/5 px-3 text-xs font-medium text-white/95 transition hover:border-white/25 hover:bg-white/15"
            aria-label={`Playback speed ${playbackRate}x`}
            title="Change playback speed"
          >
            {playbackRate}x
          </button>

          <div className="relative">
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); showControls(); setQualityMenuOpen((c) => !c); }}
              className="inline-flex h-9 min-w-[108px] items-center justify-center gap-1.5 rounded-full border border-white/10 bg-white/5 px-3 text-xs font-medium text-white/95 transition hover:border-white/25 hover:bg-white/15"
              aria-label={`Quality ${qualityLabel}`}
              title="Quality settings"
            >
              <Settings2 className="h-3.5 w-3.5" />
              {qualityLabel}
              <ChevronDown className="h-3.5 w-3.5" />
            </button>

            {qualityMenuOpen && (
              <div
                className="absolute right-0 bottom-11 z-30 min-w-[170px] rounded-lg border border-white/10 bg-black/90 p-1.5 text-sm text-white shadow-2xl backdrop-blur"
                onClick={(e) => e.stopPropagation()}
              >
                {hasManualQualityOptions && (
                  <>
                    <button
                      type="button"
                      onClick={() => applyQualityLevel(AUTO_QUALITY_LEVEL)}
                      className="flex w-full items-center justify-between gap-2 rounded-md px-2.5 py-2 text-left text-white/95 transition hover:bg-white/10"
                    >
                      <span>Auto</span>
                      {selectedQualityLevel === AUTO_QUALITY_LEVEL && <Check className="h-4 w-4" />}
                    </button>
                    {qualityOptions.map((option) => (
                      <button
                        key={option.level}
                        type="button"
                        onClick={() => applyQualityLevel(option.level)}
                        className="flex w-full items-center justify-between gap-2 rounded-md px-2.5 py-2 text-left text-white/95 transition hover:bg-white/10"
                      >
                        <span>{option.label}</span>
                        {selectedQualityLevel === option.level && <Check className="h-4 w-4" />}
                      </button>
                    ))}
                  </>
                )}

                {hasManualQualityOptions && hasExternalQualityOptions && (
                  <div className="my-1 border-t border-white/10" />
                )}

                {hasExternalQualityOptions && (
                  <>
                    {qualityOptionsConfig?.map((option) => (
                      <button
                        key={option.id}
                        type="button"
                        onClick={() => { if (option.disabled) return; onSelectQuality?.(option.id); setQualityMenuOpen(false); showControls(); }}
                        disabled={option.disabled}
                        className="flex w-full items-center justify-between gap-2 rounded-md px-2.5 py-2 text-left text-white/95 transition hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        <span>{option.label}</span>
                        {selectedQualityId === option.id && !hasManualQualityOptions && <Check className="h-4 w-4" />}
                      </button>
                    ))}
                  </>
                )}

                {!hasManualQualityOptions && !hasExternalQualityOptions && (
                  <div className="flex w-full items-center justify-between gap-2 rounded-md px-2.5 py-2 text-left text-white/85">
                    <span>{isHls ? "Auto (browser)" : "Original source"}</span>
                    <Check className="h-4 w-4" />
                  </div>
                )}
              </div>
            )}
          </div>

          {canDownload && (
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); void handleDownload(); }}
              disabled={isDownloading}
              className="inline-flex h-9 items-center justify-center gap-1.5 rounded-full border border-white/15 bg-white/10 px-3 sm:px-3 text-xs font-medium text-white transition hover:border-white/25 hover:bg-white/20 disabled:opacity-60"
              aria-label="Download video"
              title="Download video"
            >
              <Download className="h-3.5 w-3.5 flex-shrink-0" />
              <span className="hidden sm:inline">{isDownloading ? "Preparing..." : "Download"}</span>
            </button>
          )}

          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); toggleFullscreen(); }}
            className="inline-flex h-9 w-9 items-center justify-center rounded-full border border-white/15 bg-white/10 transition hover:border-white/25 hover:bg-white/20"
            aria-label={isFullscreen ? "Exit fullscreen" : "Enter fullscreen"}
            title={isFullscreen ? "Exit fullscreen" : "Fullscreen"}
          >
            {isFullscreen ? <Minimize2 className="h-4 w-4" /> : <Maximize2 className="h-4 w-4" />}
          </button>
        </div>
      </div>
    </>
  );

  return (
    <div
      ref={wrapperRef}
      className={cn(
        "relative",
        controlsBelow ? "flex flex-col h-full bg-black" : "",
        className,
      )}
    >
      <div
        ref={containerRef}
        className={cn(
          "relative w-full overflow-hidden bg-black",
          controlsBelow
            ? "flex-1 min-h-0"
            : cn(
                "aspect-video rounded-xl border border-zinc-800/80 shadow-[0_10px_40px_rgba(0,0,0,0.45)]",
                isFullscreen && "rounded-none border-none shadow-none"
              ),
        )}
        tabIndex={0}
        onMouseMove={showControls}
        onMouseEnter={showControls}
        onMouseLeave={() => {
          if (isPlaying) {
            setControlsVisible(false);
          }
        }}
        onKeyDown={(e) => {
          if (e.key === " " || e.key.toLowerCase() === "k") {
            e.preventDefault();
            togglePlay();
            return;
          }
          if (e.shiftKey && e.key === "ArrowLeft") {
            e.preventDefault();
            handleFrameStep(-1);
            return;
          }
          if (e.shiftKey && e.key === "ArrowRight") {
            e.preventDefault();
            handleFrameStep(1);
            return;
          }
          if (e.key === "ArrowLeft") {
            e.preventDefault();
            handleSeekBy(-5);
            return;
          }
          if (e.key === "ArrowRight") {
            e.preventDefault();
            handleSeekBy(5);
            return;
          }
          if (e.key.toLowerCase() === "f") {
            e.preventDefault();
            toggleFullscreen();
            return;
          }
          if (e.key.toLowerCase() === "m") {
            e.preventDefault();
            toggleMute();
          }
        }}
        onContextMenu={(e) => {
          e.preventDefault();
          showControls();
          setQualityMenuOpen(false);
          const rect = e.currentTarget.getBoundingClientRect();
          const menuWidth = 180;
          const menuHeight = 120;
          const x = clamp(e.clientX - rect.left, 8, rect.width - menuWidth - 8);
          const y = clamp(e.clientY - rect.top, 8, rect.height - menuHeight - 8);
          setContextMenu({ x, y });
        }}
      >
        <video
          ref={videoRef}
          poster={poster}
          className={cn(
            "h-full w-full object-contain transition-opacity duration-200",
            isMediaReady ? "opacity-100" : "opacity-0"
          )}
          playsInline
          preload="auto"
          onClick={(e) => {
            e.stopPropagation();
            togglePlay();
          }}
        />

        {!isMediaReady && (
          <div className="pointer-events-none absolute inset-0 z-[5]">
            {poster ? (
              <img
                src={poster}
                alt=""
                className="h-full w-full object-cover blur-[4px]"
              />
            ) : (
              <div className="h-full w-full bg-zinc-900" />
            )}
            <div className="absolute inset-0 bg-black/40" />
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 text-white">
              <div className="h-8 w-8 animate-spin rounded-full border-2 border-white/20 border-t-white/80" />
              <p className="text-sm font-medium text-white/85">Loading stream...</p>
            </div>
          </div>
        )}

        {/* Big play button */}
        {!isPlaying && (
          <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center">
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                togglePlay();
              }}
              className="pointer-events-auto inline-flex h-20 w-20 items-center justify-center rounded-full border border-white/15 bg-black/60 text-white shadow-lg transition hover:scale-[1.03] hover:border-white/30 hover:bg-black/75"
              aria-label="Play video"
            >
              <Play className="ml-1 h-9 w-9" />
            </button>
          </div>
        )}

        {/* Buffering indicator */}
        {isBuffering && isPlaying && (
          <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center">
            <div className="h-9 w-9 animate-spin rounded-full border-2 border-white/20 border-t-white/80" />
          </div>
        )}

        {/* Frame step indicator */}
        {frameStepIndicator && (
          <div className="pointer-events-none absolute top-4 left-1/2 z-10 -translate-x-1/2 rounded-full bg-black/70 px-3 py-1.5 text-xs font-mono font-medium text-white/90 backdrop-blur">
            {frameStepIndicator}
          </div>
        )}

        {/* Overlay controls — inside video frame (default or fullscreen) */}
        {!isExternalControls && (
          <div
            className={cn(
              "absolute inset-x-0 bottom-0 z-20 transition-opacity",
              controlsVisible ? "opacity-100" : "opacity-0"
            )}
          >
            <div className="pointer-events-auto bg-gradient-to-t from-black/90 via-black/70 to-transparent px-4 pb-4 pt-10">
              {controlsContent}
            </div>
          </div>
        )}

        {/* Custom context menu */}
        {contextMenu && (
          <div
            className="absolute z-30 w-44 rounded-lg border border-white/10 bg-black/90 p-1.5 text-sm text-white shadow-2xl backdrop-blur"
            style={{ left: contextMenu.x, top: contextMenu.y }}
          >
            {canDownload && (
              <button
                type="button"
                onClick={() => void handleDownload()}
                disabled={isDownloading}
                className="flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left text-white/95 transition hover:bg-white/10 disabled:opacity-60"
              >
                <Download className="h-4 w-4" />
                {isDownloading ? "Preparing download..." : "Download video"}
              </button>
            )}
            <button
              type="button"
              onClick={() => void copyTimestamp()}
              className="flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left text-white/95 transition hover:bg-white/10"
            >
              <Timer className="h-4 w-4" />
              Copy timestamp ({formatTimestamp(displayTime)})
            </button>
            <button
              type="button"
              onClick={toggleLoop}
              className="flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left text-white/95 transition hover:bg-white/10"
            >
              {loopEnabled ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}
              {loopEnabled ? "Disable loop" : "Loop video"}
            </button>
          </div>
        )}
      </div>

      {/* External controls — pinned to bottom */}
      {isExternalControls && (
        <div
          className="flex-shrink-0 bg-black px-4 pb-3 pt-2"
          onMouseMove={showControls}
          onMouseEnter={showControls}
        >
          {controlsContent}
        </div>
      )}
    </div>
  );
});

VideoPlayer.displayName = "VideoPlayer";
