"use client";

import { useRef, useEffect, useState, useCallback, forwardRef, useImperativeHandle } from "react";

export type DrawingTool = "pen" | "arrow" | "rect" | "circle";

export interface DrawingStroke {
  tool: DrawingTool;
  color: string;
  lineWidth: number;
  points: { x: number; y: number }[];
}

export interface DrawingCanvasHandle {
  undo: () => void;
  clear: () => void;
  toDataURL: () => string;
  getStrokes: () => DrawingStroke[];
  loadStrokes: (strokes: DrawingStroke[]) => void;
}

interface DrawingCanvasProps {
  tool: DrawingTool;
  color: string;
  lineWidth: number;
  active: boolean;
  className?: string;
}

export const DrawingCanvas = forwardRef<DrawingCanvasHandle, DrawingCanvasProps>(
  function DrawingCanvas({ tool, color, lineWidth, active, className }, ref) {
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const [strokes, setStrokes] = useState<DrawingStroke[]>([]);
    const currentStrokeRef = useRef<DrawingStroke | null>(null);
    const isDrawingRef = useRef(false);

    const getRelativePos = useCallback((e: PointerEvent | React.PointerEvent) => {
      const canvas = canvasRef.current;
      if (!canvas) return { x: 0, y: 0 };
      const rect = canvas.getBoundingClientRect();
      return {
        x: (e.clientX - rect.left) / rect.width,
        y: (e.clientY - rect.top) / rect.height,
      };
    }, []);

    const redraw = useCallback((allStrokes: DrawingStroke[], pending?: DrawingStroke | null) => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;

      const dpr = window.devicePixelRatio || 1;
      const rect = canvas.getBoundingClientRect();
      canvas.width = rect.width * dpr;
      canvas.height = rect.height * dpr;
      ctx.scale(dpr, dpr);
      ctx.clearRect(0, 0, rect.width, rect.height);

      const draw = (stroke: DrawingStroke) => {
        if (stroke.points.length < 1) return;
        const w = rect.width;
        const h = rect.height;
        ctx.strokeStyle = stroke.color;
        ctx.fillStyle = stroke.color;
        ctx.lineWidth = stroke.lineWidth;
        ctx.lineCap = "round";
        ctx.lineJoin = "round";

        const pts = stroke.points.map((p) => ({ x: p.x * w, y: p.y * h }));

        if (stroke.tool === "pen") {
          ctx.beginPath();
          ctx.moveTo(pts[0].x, pts[0].y);
          for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
          ctx.stroke();
        } else if (stroke.tool === "arrow") {
          if (pts.length < 2) return;
          const start = pts[0];
          const end = pts[pts.length - 1];
          ctx.beginPath();
          ctx.moveTo(start.x, start.y);
          ctx.lineTo(end.x, end.y);
          ctx.stroke();
          const angle = Math.atan2(end.y - start.y, end.x - start.x);
          const headLen = Math.max(12, stroke.lineWidth * 4);
          ctx.beginPath();
          ctx.moveTo(end.x, end.y);
          ctx.lineTo(end.x - headLen * Math.cos(angle - Math.PI / 6), end.y - headLen * Math.sin(angle - Math.PI / 6));
          ctx.lineTo(end.x - headLen * Math.cos(angle + Math.PI / 6), end.y - headLen * Math.sin(angle + Math.PI / 6));
          ctx.closePath();
          ctx.fill();
        } else if (stroke.tool === "rect") {
          if (pts.length < 2) return;
          const start = pts[0];
          const end = pts[pts.length - 1];
          ctx.beginPath();
          ctx.rect(start.x, start.y, end.x - start.x, end.y - start.y);
          ctx.stroke();
        } else if (stroke.tool === "circle") {
          if (pts.length < 2) return;
          const start = pts[0];
          const end = pts[pts.length - 1];
          const cx = (start.x + end.x) / 2;
          const cy = (start.y + end.y) / 2;
          const rx = Math.abs(end.x - start.x) / 2;
          const ry = Math.abs(end.y - start.y) / 2;
          ctx.beginPath();
          ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
          ctx.stroke();
        }
      };

      for (const s of allStrokes) draw(s);
      if (pending) draw(pending);
    }, []);

    useEffect(() => {
      redraw(strokes);
    }, [strokes, redraw]);

    useEffect(() => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const ro = new ResizeObserver(() => redraw(strokes));
      ro.observe(canvas);
      return () => ro.disconnect();
    }, [strokes, redraw]);

    useImperativeHandle(ref, () => ({
      undo: () => setStrokes((prev) => prev.slice(0, -1)),
      clear: () => setStrokes([]),
      toDataURL: () => canvasRef.current?.toDataURL("image/png") ?? "",
      getStrokes: () => strokes,
      loadStrokes: (s) => setStrokes(s),
    }), [strokes]);

    const handlePointerDown = useCallback((e: React.PointerEvent) => {
      if (!active) return;
      e.preventDefault();
      e.stopPropagation();
      isDrawingRef.current = true;
      const pos = getRelativePos(e);
      currentStrokeRef.current = { tool, color, lineWidth, points: [pos] };
      (e.target as HTMLElement).setPointerCapture(e.pointerId);
    }, [active, tool, color, lineWidth, getRelativePos]);

    const handlePointerMove = useCallback((e: React.PointerEvent) => {
      if (!isDrawingRef.current || !currentStrokeRef.current) return;
      e.preventDefault();
      const pos = getRelativePos(e);
      currentStrokeRef.current.points.push(pos);
      redraw(strokes, currentStrokeRef.current);
    }, [getRelativePos, redraw, strokes]);

    const handlePointerUp = useCallback((e: React.PointerEvent) => {
      if (!isDrawingRef.current || !currentStrokeRef.current) return;
      e.preventDefault();
      isDrawingRef.current = false;
      if (currentStrokeRef.current.points.length > 0) {
        setStrokes((prev) => [...prev, currentStrokeRef.current!]);
      }
      currentStrokeRef.current = null;
    }, []);

    return (
      <canvas
        ref={canvasRef}
        className={className}
        style={{
          position: "absolute",
          inset: 0,
          width: "100%",
          height: "100%",
          cursor: active ? "crosshair" : "default",
          pointerEvents: active ? "auto" : "none",
          touchAction: "none",
        }}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
      />
    );
  }
);

DrawingCanvas.displayName = "DrawingCanvas";
