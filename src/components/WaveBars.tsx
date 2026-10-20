import { memo, useEffect, useRef } from "react";

// 波形シークバーの描画。
// 以前はバーごとに <i> を 160 個並べ、再生位置の tick / ドラッグ移動のたびに全要素の
// className を付け替えていた。ここでは bars を canvas に 1 度だけ描き、
// 進捗は「アクティブ色レイヤーを clip-path で切り出す」ことだけで表現する。

// CSS 側 (.cb-wave / .cb-wave-canvas) の値を canvas から読む。色・寸法の定義元は CSS のみ。
//   color        : バーの色 (非アクティブ = var(--bd) / アクティブ = var(--ac))
//   --wave-gap   : バー間隔 (px)
//   --wave-radius: バーの角丸 (px)
//   --wave-min-h : バーの最小高さ (px)
function readStyle(canvas: HTMLCanvasElement) {
  const cs = getComputedStyle(canvas);
  const num = (name: string, fallback: number) => {
    const v = parseFloat(cs.getPropertyValue(name));
    return Number.isFinite(v) ? v : fallback;
  };
  return {
    color: cs.color,
    gap: num("--wave-gap", 2),
    radius: num("--wave-radius", 2),
    minH: num("--wave-min-h", 0),
  };
}

function drawBars(canvas: HTMLCanvasElement, bars: number[]) {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const dpr = window.devicePixelRatio || 1;
  const cssW = canvas.clientWidth;
  const cssH = canvas.clientHeight;
  const pxW = Math.max(1, Math.round(cssW * dpr));
  const pxH = Math.max(1, Math.round(cssH * dpr));
  // サイズが変わらないときは width/height を触らない (触るとバッファが再確保されるため)。
  if (canvas.width !== pxW) canvas.width = pxW;
  if (canvas.height !== pxH) canvas.height = pxH;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssW, cssH);
  const n = bars.length;
  if (n === 0 || cssW <= 0 || cssH <= 0) return;

  const { color, gap, radius, minH } = readStyle(canvas);
  // flex: 1 で n 本を gap 間隔で等分していた旧レイアウトと同じ寸法。
  const barW = Math.max(0, (cssW - gap * (n - 1)) / n);
  ctx.fillStyle = color;
  ctx.beginPath();
  for (let i = 0; i < n; i++) {
    const h = Math.min(cssH, Math.max(minH, bars[i]));
    const x = i * (barW + gap);
    const y = (cssH - h) / 2;
    // roundRect 未対応の古い WebView では角丸なしの矩形にフォールバック。
    if (typeof ctx.roundRect === "function") {
      ctx.roundRect(x, y, barW, h, Math.min(radius, barW / 2, h / 2));
    } else {
      ctx.rect(x, y, barW, h);
    }
  }
  ctx.fill();
}

interface LayerProps {
  bars: number[];
  // audition の切替で CSS (高さ/gap/角丸) が変わるので再描画のトリガにする。
  audition: boolean;
}

// bars / audition / 要素サイズ / devicePixelRatio / テーマが変わったときだけ描き直す。
// 再生位置は props に含めないので、tick では再レンダー・再描画されない。
const WaveLayer = memo(function WaveLayer({ bars, audition }: LayerProps) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const redraw = () => drawBars(canvas, bars);
    redraw();

    // 要素サイズ (ウィンドウ幅・audition の高さ変更)。
    const ro = new ResizeObserver(redraw);
    ro.observe(canvas);

    // devicePixelRatio (ズーム / モニタ移動)。変わるたびに現在の値で張り直す。
    let dprMq: MediaQueryList | null = null;
    const onDprChange = () => {
      redraw();
      watchDpr();
    };
    const watchDpr = () => {
      dprMq?.removeEventListener("change", onDprChange);
      dprMq = window.matchMedia(`(resolution: ${window.devicePixelRatio || 1}dppx)`);
      dprMq.addEventListener("change", onDprChange);
    };
    watchDpr();

    // テーマ (OS の配色 / <html> の class・data-theme・style 変更) で色が変わる場合。
    const schemeMq = window.matchMedia("(prefers-color-scheme: dark)");
    schemeMq.addEventListener("change", redraw);
    const mo = new MutationObserver(redraw);
    mo.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class", "data-theme", "style"],
    });

    return () => {
      ro.disconnect();
      dprMq?.removeEventListener("change", onDprChange);
      schemeMq.removeEventListener("change", redraw);
      mo.disconnect();
    };
  }, [bars, audition]);

  return <canvas ref={ref} className="cb-wave-canvas" aria-hidden="true" />;
});

interface WaveBarsProps extends LayerProps {
  // 0〜1。再生位置 or ドラッグ中のプレビュー位置。
  ratio: number;
}

// 非アクティブ層 (下) + アクティブ層 (上, ratio 分だけ clip-path で見せる)。
// ratio の更新は style のみで、canvas 側の memo は崩れない。
export function WaveBars({ bars, audition, ratio }: WaveBarsProps) {
  const r = Math.min(1, Math.max(0, ratio));
  return (
    <>
      <WaveLayer bars={bars} audition={audition} />
      <div className="cb-wave-on" style={{ clipPath: `inset(0 ${(1 - r) * 100}% 0 0)` }}>
        <WaveLayer bars={bars} audition={audition} />
      </div>
    </>
  );
}
