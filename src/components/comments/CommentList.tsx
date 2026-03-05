"use client";

import { useState, useMemo, useEffect, useRef } from "react";
import { useQuery } from "convex/react";
import { api } from "../../../convex/_generated/api";
import { Id } from "../../../convex/_generated/dataModel";
import { FunctionReturnType } from "convex/server";
import { CommentItem } from "./CommentItem";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Search, X } from "lucide-react";
import { cn } from "@/lib/utils";

type ThreadedComments = FunctionReturnType<typeof api.comments.getThreaded>;
type ResolvedFilter = "all" | "open" | "resolved";

interface CommentListProps {
  videoId: Id<"videos">;
  comments?: ThreadedComments;
  currentUserClerkId?: string;
  onTimestampClick: (seconds: number) => void;
  onEditTimestamp?: (commentId: Id<"comments">, timestampSeconds: number) => void;
  highlightedCommentId?: Id<"comments">;
  canResolve?: boolean;
  onVisibleIdsChange?: (ids: Set<string>) => void;
}

export function CommentList({
  videoId,
  comments: providedComments,
  currentUserClerkId,
  onTimestampClick,
  onEditTimestamp,
  highlightedCommentId,
  canResolve = false,
  onVisibleIdsChange,
}: CommentListProps) {
  const queriedComments = useQuery(api.comments.getThreaded, { videoId });
  const comments = providedComments ?? queriedComments;
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<ResolvedFilter>("all");

  const resolvedCount = useMemo(
    () => comments?.filter((c) => c.resolved).length ?? 0,
    [comments],
  );
  const openCount = useMemo(
    () => comments?.filter((c) => !c.resolved).length ?? 0,
    [comments],
  );

  const filtered = useMemo(() => {
    if (!comments) return undefined;
    const q = search.toLowerCase().trim();
    return comments.filter((c) => {
      if (filter === "open" && c.resolved) return false;
      if (filter === "resolved" && !c.resolved) return false;
      if (!q) return true;
      if (c.text.toLowerCase().includes(q)) return true;
      if (c.userName.toLowerCase().includes(q)) return true;
      if (c.replies.some((r) => r.text.toLowerCase().includes(q) || r.userName.toLowerCase().includes(q))) return true;
      return false;
    });
  }, [comments, search, filter]);

  const prevIdsRef = useRef<string>("");
  useEffect(() => {
    if (!onVisibleIdsChange || !filtered) return;
    const isFiltering = filter !== "all" || search.trim() !== "";
    if (!isFiltering) {
      const key = "__all__";
      if (prevIdsRef.current !== key) {
        prevIdsRef.current = key;
        onVisibleIdsChange(new Set());
      }
      return;
    }
    const ids = new Set(filtered.map((c) => c._id as string));
    const key = [...ids].sort().join(",");
    if (prevIdsRef.current !== key) {
      prevIdsRef.current = key;
      onVisibleIdsChange(ids);
    }
  }, [filtered, filter, search, onVisibleIdsChange]);

  if (comments === undefined) {
    return (
      <div className="p-4 text-center text-[#888]">Loading...</div>
    );
  }

  if (comments.length === 0) {
    return (
      <div className="h-full flex items-center justify-center p-6">
        <p className="text-[#888] text-sm text-center">
          No comments yet.<br />
          Click on the timeline to add one.
        </p>
      </div>
    );
  }

  const FILTERS: { key: ResolvedFilter; label: string; count: number }[] = [
    { key: "all", label: "All", count: comments.length },
    { key: "open", label: "Open", count: openCount },
    { key: "resolved", label: "Resolved", count: resolvedCount },
  ];

  return (
    <div className="flex h-full flex-col">
      <div className="shrink-0 border-b border-[#1a1a1a]/10 dark:border-white/10 px-3 pt-3 pb-2 space-y-2">
        <div className="relative">
          <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[#888]" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search comments..."
            className="w-full border-2 border-[#1a1a1a] bg-[#f0f0e8] py-1.5 pl-7 pr-7 text-xs text-[#1a1a1a] placeholder:text-[#888] focus:outline-none"
          />
          {search && (
            <button
              type="button"
              onClick={() => setSearch("")}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-[#888] hover:text-[#1a1a1a]"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
        <div className="flex gap-1">
          {FILTERS.map((f) => (
            <button
              key={f.key}
              type="button"
              onClick={() => setFilter(f.key)}
              className={cn(
                "px-2 py-0.5 text-[11px] font-bold uppercase tracking-wide transition-colors",
                filter === f.key
                  ? "bg-[#1a1a1a] text-[#f0f0e8]"
                  : "text-[#888] hover:text-[#1a1a1a]",
              )}
            >
              {f.label}
              <span className="ml-1 font-mono font-normal">{f.count}</span>
            </button>
          ))}
        </div>
      </div>

      <ScrollArea className="flex-1 min-h-0">
        {filtered && filtered.length === 0 ? (
          <div className="p-6 text-center text-[#888] text-sm">
            {search ? "No matching comments." : "No comments in this view."}
          </div>
        ) : (
          <div className="flex flex-col divide-y divide-[#1a1a1a]/10 dark:divide-white/10">
            {filtered?.map((comment) => (
              <div key={comment._id} className="relative">
                <CommentItem
                  comment={comment}
                  currentUserClerkId={currentUserClerkId}
                  onTimestampClick={onTimestampClick}
                  onEditTimestamp={onEditTimestamp}
                  isHighlighted={highlightedCommentId === comment._id}
                  canResolve={canResolve}
                />
                {comment.replies.length > 0 && (
                  <div className="pl-14 pr-4 pb-4 space-y-4 relative">
                    <div className="absolute left-[1.35rem] top-0 bottom-6 w-px bg-[#1a1a1a]/10 dark:bg-white/10" />
                    {comment.replies.map((reply) => (
                      <CommentItem
                        key={reply._id}
                        comment={reply}
                        currentUserClerkId={currentUserClerkId}
                        onTimestampClick={onTimestampClick}
                        onEditTimestamp={onEditTimestamp}
                        isHighlighted={highlightedCommentId === reply._id}
                        isReply
                        canResolve={canResolve}
                      />
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </ScrollArea>
    </div>
  );
}
