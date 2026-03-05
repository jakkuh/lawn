"use client";

import { Pencil, MoveUpRight, Square, Circle, Undo2, Trash2, Check } from "lucide-react";
import type { DrawingTool } from "./DrawingCanvas";
import { cn } from "@/lib/utils";

const COLORS = ["#ef4444", "#f97316", "#eab308", "#22c55e", "#3b82f6", "#a855f7", "#ffffff"];

interface DrawingToolbarProps {
  tool: DrawingTool;
  color: string;
  onToolChange: (tool: DrawingTool) => void;
  onColorChange: (color: string) => void;
  onUndo: () => void;
  onClear: () => void;
  onDone: () => void;
}

const tools: { id: DrawingTool; icon: typeof Pencil; label: string }[] = [
  { id: "pen", icon: Pencil, label: "Pen" },
  { id: "arrow", icon: MoveUpRight, label: "Arrow" },
  { id: "rect", icon: Square, label: "Rectangle" },
  { id: "circle", icon: Circle, label: "Circle" },
];

export function DrawingToolbar({
  tool,
  color,
  onToolChange,
  onColorChange,
  onUndo,
  onClear,
  onDone,
}: DrawingToolbarProps) {
  return (
    <div className="absolute top-3 left-1/2 z-40 -translate-x-1/2 flex items-center gap-1 rounded-lg border border-white/20 bg-black/80 px-2 py-1.5 text-white shadow-2xl backdrop-blur">
      {tools.map(({ id, icon: Icon, label }) => (
        <button
          key={id}
          type="button"
          onClick={() => onToolChange(id)}
          className={cn(
            "inline-flex h-8 w-8 items-center justify-center rounded-md transition",
            tool === id ? "bg-white/20" : "hover:bg-white/10"
          )}
          title={label}
        >
          <Icon className="h-4 w-4" />
        </button>
      ))}

      <div className="mx-1 h-5 w-px bg-white/20" />

      {COLORS.map((c) => (
        <button
          key={c}
          type="button"
          onClick={() => onColorChange(c)}
          className={cn(
            "h-5 w-5 rounded-full border-2 transition",
            color === c ? "border-white scale-110" : "border-white/30 hover:border-white/60"
          )}
          style={{ backgroundColor: c }}
          title={c}
        />
      ))}

      <div className="mx-1 h-5 w-px bg-white/20" />

      <button
        type="button"
        onClick={onUndo}
        className="inline-flex h-8 w-8 items-center justify-center rounded-md transition hover:bg-white/10"
        title="Undo"
      >
        <Undo2 className="h-4 w-4" />
      </button>
      <button
        type="button"
        onClick={onClear}
        className="inline-flex h-8 w-8 items-center justify-center rounded-md transition hover:bg-white/10"
        title="Clear"
      >
        <Trash2 className="h-4 w-4" />
      </button>

      <div className="mx-1 h-5 w-px bg-white/20" />

      <button
        type="button"
        onClick={onDone}
        className="inline-flex h-8 items-center justify-center gap-1 rounded-md bg-[#2d5a2d] px-3 text-xs font-medium transition hover:bg-[#3a6a3a]"
        title="Done drawing"
      >
        <Check className="h-3.5 w-3.5" />
        Done
      </button>
    </div>
  );
}
