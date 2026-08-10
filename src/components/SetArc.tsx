import { useMemo } from "react";
import type { Track, TrackAnalysis } from "../types";

interface SetArcProps {
  crate: Track[];
  analysisByTrack: Map<number, TrackAnalysis> | ReadonlyMap<number, TrackAnalysis>;
  /** 再生中 / ハイライトする crate index */
  highlightIndex?: number | null;
  height?: number;
}

function polylinePoints(
  values: Array<number | null>,
  width: number,
  height: number,
  padY: number,
): string | null {
  const usable = values
    .map((v, i) => ({ v, i }))
    .filter((x): x is { v: number; i: number } => x.v != null && Number.isFinite(x.v));
  if (usable.length < 2) return null;

  const nums = usable.map((x) => x.v);
  let min = Math.min(...nums);
  let max = Math.max(...nums);
  if (max - min < 1e-6) {
    min -= 1;
    max += 1;
  }

  const n = values.length;
  const innerH = height - padY * 2;
  const pts: string[] = [];
  for (const { v, i } of usable) {
    const x = n <= 1 ? width / 2 : (i / (n - 1)) * width;
    const t = (v - min) / (max - min);
    const y = padY + innerH * (1 - t);
    pts.push(`${x.toFixed(1)},${y.toFixed(1)}`);
  }
  return pts.join(" ");
}

/**
 * Set Arc — crate 順の BPM / Energy を簡易折れ線で可視化。
 */
export function SetArc({
  crate,
  analysisByTrack,
  highlightIndex = null,
  height = 64,
}: SetArcProps) {
  const width = 280; // viewBox; scales via CSS width 100%

  const { bpmPts, energyPts, n } = useMemo(() => {
    const bpms: Array<number | null> = [];
    const energies: Array<number | null> = [];
    for (const t of crate) {
      const a = analysisByTrack.get(t.trackId);
      const bpm = a?.bpm ?? t.bpm;
      bpms.push(bpm != null && bpm > 0 ? bpm : null);
      energies.push(a?.energy != null ? a.energy : null);
    }
    return {
      bpmPts: polylinePoints(bpms, width, height, 6),
      energyPts: polylinePoints(energies, width, height, 6),
      n: crate.length,
    };
  }, [crate, analysisByTrack, height]);

  if (n < 2) {
    return (
      <div className="cb-set-arc cb-set-arc-empty">
        Arc 表示には 2 曲以上必要です
      </div>
    );
  }

  const hiX =
    highlightIndex != null && highlightIndex >= 0 && highlightIndex < n
      ? n <= 1
        ? width / 2
        : (highlightIndex / (n - 1)) * width
      : null;

  return (
    <div className="cb-set-arc" title="BPM (実線) / Energy (破線)">
      <svg
        viewBox={`0 0 ${width} ${height}`}
        width="100%"
        height={height}
        preserveAspectRatio="none"
        className="cb-set-arc-svg"
        aria-label="Set arc: BPM and Energy"
      >
        {/* baseline grid */}
        <line
          x1={0}
          y1={height / 2}
          x2={width}
          y2={height / 2}
          className="cb-set-arc-grid"
        />
        {bpmPts && (
          <polyline
            points={bpmPts}
            fill="none"
            className="cb-set-arc-bpm"
            vectorEffect="non-scaling-stroke"
          />
        )}
        {energyPts && (
          <polyline
            points={energyPts}
            fill="none"
            className="cb-set-arc-energy"
            vectorEffect="non-scaling-stroke"
          />
        )}
        {hiX != null && (
          <line
            x1={hiX}
            y1={2}
            x2={hiX}
            y2={height - 2}
            className="cb-set-arc-hi"
            vectorEffect="non-scaling-stroke"
          />
        )}
      </svg>
      <div className="cb-set-arc-legend">
        <span className="cb-set-arc-leg-bpm">BPM</span>
        <span className="cb-set-arc-leg-energy">Energy</span>
      </div>
    </div>
  );
}
