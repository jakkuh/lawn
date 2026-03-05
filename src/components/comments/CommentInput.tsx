"use client";

import { useState, useRef, useEffect } from "react";
import { useMutation } from "convex/react";
import { api } from "../../../convex/_generated/api";
import { Id } from "../../../convex/_generated/dataModel";
import { Button } from "@/components/ui/button";
import { formatTimestamp } from "@/lib/utils";
import { Send, X, Scissors, Pencil } from "lucide-react";

function formatTimestampInput(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function parseTimestampInput(value: string): number | null {
  const parts = value.split(":").map(Number);
  if (parts.some(isNaN)) return null;
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  return null;
}

interface CommentInputProps {
  videoId: Id<"videos">;
  timestampSeconds: number;
  parentId?: Id<"comments">;
  onSubmit?: () => void;
  onCancel?: () => void;
  autoFocus?: boolean;
  placeholder?: string;
  showTimestamp?: boolean;
  variant?: "default" | "seamless";
  onRangeChange?: (range: { inTime: number; outTime: number } | null) => void;
  onDrawingRequest?: () => void;
  drawingData?: string | null;
}

export function CommentInput({
  videoId,
  timestampSeconds,
  parentId,
  onSubmit,
  onCancel,
  autoFocus = false,
  placeholder,
  showTimestamp = false,
  variant = "default",
  onRangeChange,
  onDrawingRequest,
  drawingData,
}: CommentInputProps) {
  const [text, setText] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [rangeMode, setRangeMode] = useState(false);
  const [inTime, setInTime] = useState("");
  const [outTime, setOutTime] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const createComment = useMutation(api.comments.create);

  const defaultPlaceholder = showTimestamp 
    ? `Comment at ${formatTimestamp(timestampSeconds)}...` 
    : "Add a comment...";
  const finalPlaceholder = placeholder || defaultPlaceholder;

  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
      textareaRef.current.style.height = `${textareaRef.current.scrollHeight}px`;
    }
  }, [text]);

  const toggleRangeMode = () => {
    const next = !rangeMode;
    setRangeMode(next);
    if (next) {
      const inSec = timestampSeconds;
      const outSec = timestampSeconds + 5;
      setInTime(formatTimestampInput(inSec));
      setOutTime(formatTimestampInput(outSec));
      onRangeChange?.({ inTime: inSec, outTime: outSec });
    } else {
      setInTime("");
      setOutTime("");
      onRangeChange?.(null);
    }
  };

  const handleInTimeChange = (val: string) => {
    setInTime(val);
    const parsed = parseTimestampInput(val);
    const parsedOut = parseTimestampInput(outTime);
    if (parsed !== null && parsedOut !== null) {
      onRangeChange?.({ inTime: parsed, outTime: parsedOut });
    }
  };

  const handleOutTimeChange = (val: string) => {
    setOutTime(val);
    const parsedIn = parseTimestampInput(inTime);
    const parsed = parseTimestampInput(val);
    if (parsedIn !== null && parsed !== null) {
      onRangeChange?.({ inTime: parsedIn, outTime: parsed });
    }
  };

  const submitComment = async () => {
    if (!text.trim()) return;

    setIsLoading(true);
    try {
      const parsedIn = rangeMode ? parseTimestampInput(inTime) : null;
      const parsedOut = rangeMode ? parseTimestampInput(outTime) : null;
      await createComment({
        videoId,
        text: text.trim(),
        timestampSeconds: parsedIn ?? timestampSeconds,
        ...(parsedOut !== null ? { endTimestampSeconds: parsedOut } : {}),
        ...(drawingData ? { drawingData } : {}),
        parentId,
      });
      setText("");
      setRangeMode(false);
      setInTime("");
      setOutTime("");
      onRangeChange?.(null);
      onSubmit?.();
    } catch (error) {
      console.error("Failed to create comment:", error);
    } finally {
      setIsLoading(false);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    await submitComment();
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (
      e.key === "Enter" &&
      !e.shiftKey &&
      !e.metaKey &&
      !e.ctrlKey &&
      !e.altKey
    ) {
      e.preventDefault();
      void submitComment();
    }
    if (e.key === "Escape") {
      onCancel?.();
    }
  };

  return (
    <form 
      onSubmit={handleSubmit} 
      className={
        variant === "seamless" 
          ? "relative w-full bg-[#f0f0e8]"
          : "relative w-full pb-1 pr-1"
      }
    >
      <textarea
        ref={textareaRef}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder={finalPlaceholder}
        autoFocus={autoFocus}
        className={
          variant === "seamless"
            ? "block w-full max-h-64 min-h-[100px] bg-transparent border-0 focus:ring-0 resize-none px-4 pt-4 pb-12 text-sm leading-relaxed text-[#1a1a1a] placeholder:text-[#888] font-sans outline-none transition-all"
            : "block w-full max-h-64 min-h-[100px] bg-[#f0f0e8] border-2 border-[#1a1a1a] focus:ring-0 resize-none px-3 pt-3 pb-12 text-sm leading-relaxed text-[#1a1a1a] placeholder:text-[#888] font-sans outline-none shadow-[4px_4px_0px_0px_var(--shadow-color)] focus:translate-y-[2px] focus:translate-x-[2px] focus:shadow-[2px_2px_0px_0px_var(--shadow-color)] transition-all"
        }
        rows={3}
      />
      {rangeMode && (
        <div className={
          variant === "seamless"
            ? "flex items-center gap-2 px-4 pb-1 text-xs"
            : "flex items-center gap-2 px-3 pb-1 text-xs"
        }>
          <label className="font-mono text-[#888]">In</label>
          <input
            type="text"
            value={inTime}
            onChange={(e) => handleInTimeChange(e.target.value)}
            className="w-16 border-2 border-[#1a1a1a] bg-[#f0f0e8] px-1.5 py-0.5 font-mono text-xs text-[#1a1a1a] focus:outline-none"
            placeholder="mm:ss"
          />
          <label className="font-mono text-[#888]">Out</label>
          <input
            type="text"
            value={outTime}
            onChange={(e) => handleOutTimeChange(e.target.value)}
            className="w-16 border-2 border-[#1a1a1a] bg-[#f0f0e8] px-1.5 py-0.5 font-mono text-xs text-[#1a1a1a] focus:outline-none"
            placeholder="mm:ss"
          />
        </div>
      )}

      <div
        className={
          variant === "seamless"
            ? "absolute bottom-3 right-3 flex items-center gap-1.5"
            : "absolute bottom-3 right-3 flex items-center gap-1.5"
        }
      >
        {!parentId && (
          <>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className={`h-8 w-8 shrink-0 ${rangeMode ? "bg-[#2d5a2d]/10 text-[#2d5a2d]" : ""}`}
              onClick={toggleRangeMode}
              title={rangeMode ? "Disable range mode" : "Mark in/out range"}
            >
              <Scissors className="h-4 w-4" />
            </Button>
            {onDrawingRequest && (
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className={`h-8 w-8 shrink-0 ${drawingData ? "bg-[#2d5a2d]/10 text-[#2d5a2d]" : ""}`}
                onClick={onDrawingRequest}
                title="Draw annotation"
              >
                <Pencil className="h-4 w-4" />
              </Button>
            )}
          </>
        )}
        {onCancel && (
          <Button
            type="button"
            variant={variant === "seamless" ? "ghost" : "outline"}
            size="icon"
            className="h-8 w-8 shrink-0"
            onClick={onCancel}
          >
            <X className="h-4 w-4" />
          </Button>
        )}
        <Button
          type="submit"
          variant={variant === "seamless" ? "ghost" : "primary"}
          size="icon"
          className="h-8 w-8 shrink-0 disabled:opacity-50"
          disabled={!text.trim() || isLoading}
        >
          <Send className="h-4 w-4" />
        </Button>
      </div>
    </form>
  );
}
