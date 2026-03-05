import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function formatDuration(seconds: number): string {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);

  if (hours > 0) {
    return `${hours}:${minutes.toString().padStart(2, "0")}:${secs.toString().padStart(2, "0")}`;
  }
  return `${minutes}:${secs.toString().padStart(2, "0")}`;
}

export function formatTimestamp(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  const wholeSecs = Math.floor(seconds % 60);
  const frac = seconds - Math.floor(seconds);
  if (frac < 0.005) {
    return `${minutes}:${wholeSecs.toString().padStart(2, "0")}`;
  }
  const centis = Math.round(frac * 100)
    .toString()
    .padStart(2, "0");
  return `${minutes}:${wholeSecs.toString().padStart(2, "0")}.${centis}`;
}

export function formatTimestampInput(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const wholeSec = Math.floor(seconds % 60);
  const frac = seconds - Math.floor(seconds);
  const base = `${String(m).padStart(2, "0")}:${String(wholeSec).padStart(2, "0")}`;
  if (frac < 0.005) return base;
  return `${base}.${Math.round(frac * 100).toString().padStart(2, "0")}`;
}

export function parseTimestampInput(value: string): number | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const match = trimmed.match(
    /^(?:(\d+):)?(\d{1,2}):(\d{1,2})(?:\.(\d+))?$|^(\d+(?:\.\d+)?)$/,
  );
  if (!match) return null;
  if (match[5] !== undefined) return parseFloat(match[5]);
  const h = match[1] ? parseInt(match[1], 10) : 0;
  const m = parseInt(match[2], 10);
  const s = parseInt(match[3], 10);
  const frac = match[4] ? parseFloat(`0.${match[4]}`) : 0;
  return h * 3600 + m * 60 + s + frac;
}

export function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
}

export function formatRelativeTime(date: Date | number): string {
  const now = new Date();
  const d = typeof date === "number" ? new Date(date) : date;
  const diff = now.getTime() - d.getTime();

  const seconds = Math.floor(diff / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 30) {
    return d.toLocaleDateString();
  }
  if (days > 0) {
    return `${days}d ago`;
  }
  if (hours > 0) {
    return `${hours}h ago`;
  }
  if (minutes > 0) {
    return `${minutes}m ago`;
  }
  return "Just now";
}

export function getInitials(name: string): string {
  return name
    .split(" ")
    .map((n) => n[0])
    .join("")
    .toUpperCase()
    .substring(0, 2);
}
