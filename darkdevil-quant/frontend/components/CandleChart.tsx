"use client";

import { useMemo } from "react";
import { fmtNum } from "@/lib/api";

export type Kline = {
  open_time_ms: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  close_time_ms: number;
};

/**
 * Renders real candles supplied by the backend. It performs no simulation: when
 * there is no data it says so instead of drawing a plausible-looking series.
 */
export default function CandleChart({
  candles,
  height = 260,
  width = 900,
}: {
  candles: Kline[];
  height?: number;
  width?: number;
}) {
  const geom = useMemo(() => {
    if (candles.length === 0) return null;
    const highs = candles.map((c) => c.high);
    const lows = candles.map((c) => c.low);
    const max = Math.max(...highs);
    const min = Math.min(...lows);
    const span = max - min || Math.max(max * 0.001, 1e-8);
    const pad = span * 0.06;
    const top = max + pad;
    const bottom = min - pad;
    const plotH = height - 24;

    const y = (v: number) => 12 + ((top - v) / (top - bottom)) * plotH;
    const slot = width / candles.length;
    const bodyW = Math.max(1, Math.min(slot * 0.62, 14));

    return {
      top,
      bottom,
      y,
      slot,
      bodyW,
      points: candles.map((c, i) => ({
        x: slot * i + slot / 2,
        up: c.close >= c.open,
        c,
      })),
    };
  }, [candles, height, width]);

  if (candles.length === 0 || !geom) {
    return (
      <div className="panel px-4 py-6 text-xs opacity-60" role="status">
        No candles returned for this market/interval. Nothing is drawn rather than
        showing an invented series.
      </div>
    );
  }

  const { y, bodyW, points, top, bottom } = geom;
  const gridLines = 4;

  return (
    <div className="w-full overflow-hidden">
      <svg
        viewBox={`0 0 ${width} ${height}`}
        className="h-auto w-full"
        role="img"
        aria-label={`Candlestick chart of ${candles.length} candles`}
        preserveAspectRatio="none"
      >
        {Array.from({ length: gridLines + 1 }).map((_, i) => {
          const yy = 12 + (i / gridLines) * (height - 24);
          const value = top - (i / gridLines) * (top - bottom);
          return (
            <g key={i}>
              <line
                x1={0}
                x2={width}
                y1={yy}
                y2={yy}
                stroke="var(--border)"
                strokeWidth={1}
                vectorEffect="non-scaling-stroke"
              />
              <text x={4} y={yy - 3} fontSize={9} fill="var(--muted)">
                {fmtNum(value, value >= 1000 ? 0 : 2)}
              </text>
            </g>
          );
        })}

        {points.map(({ x, up, c }, i) => {
          const color = up ? "var(--up)" : "var(--down)";
          const yHigh = y(c.high);
          const yLow = y(c.low);
          const yOpen = y(c.open);
          const yClose = y(c.close);
          const bodyTop = Math.min(yOpen, yClose);
          const bodyH = Math.max(1, Math.abs(yClose - yOpen));
          return (
            <g key={i}>
              <line
                x1={x}
                x2={x}
                y1={yHigh}
                y2={yLow}
                stroke={color}
                strokeWidth={1}
                vectorEffect="non-scaling-stroke"
              />
              <rect
                x={x - bodyW / 2}
                y={bodyTop}
                width={bodyW}
                height={bodyH}
                fill={color}
                opacity={up ? 0.9 : 0.85}
              />
            </g>
          );
        })}
      </svg>
    </div>
  );
}
