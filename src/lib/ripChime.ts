/**
 * CD 取り込みの完了 / 失敗を知らせる短い通知音。
 *
 * 音源ファイルは持たず Web Audio API でその場で合成する。
 * 音楽再生は Rust (rodio) 側なので、WebView の AudioContext とは独立しており干渉しない。
 */

export type RipChimeKind = "done" | "error";

let ctx: AudioContext | null = null;

function getContext(): AudioContext | null {
  if (ctx) return ctx;
  const Ctor =
    typeof window !== "undefined"
      ? (window.AudioContext ??
        (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext)
      : undefined;
  if (!Ctor) return null;
  try {
    ctx = new Ctor();
  } catch {
    ctx = null;
  }
  return ctx;
}

/**
 * ユーザー操作 (「Start Ripping」クリック等) の中で呼んで AudioContext を起こしておく。
 * 自動再生ポリシーで、操作なしに作った AudioContext が suspended のまま鳴らないのを防ぐ。
 */
export function primeRipChime(): void {
  const c = getContext();
  if (c && c.state === "suspended") void c.resume().catch(() => {});
}

/** ベル風の 1 音 (基音 + 控えめな倍音) を鳴らす。 */
function bell(
  c: AudioContext,
  dest: AudioNode,
  freq: number,
  start: number,
  dur: number,
  peak: number,
  type: OscillatorType = "sine",
): void {
  const env = c.createGain();
  env.gain.setValueAtTime(0.0001, start);
  env.gain.exponentialRampToValueAtTime(peak, start + 0.012);
  env.gain.exponentialRampToValueAtTime(0.0001, start + dur);
  env.connect(dest);

  const partials: Array<[number, number]> = [
    [1, 1],
    [2, 0.18], // オクターブ上をうっすら足してベルっぽく
  ];
  for (const [mul, amp] of partials) {
    const osc = c.createOscillator();
    osc.type = type;
    osc.frequency.setValueAtTime(freq * mul, start);
    const g = c.createGain();
    g.gain.value = amp;
    osc.connect(g);
    g.connect(env);
    osc.start(start);
    osc.stop(start + dur + 0.05);
  }
}

/**
 * 通知音を鳴らす。
 * - done: 明るい上行アルペジオ (G5 → B5 → D6)
 * - error: 低めでやわらかい下行 2 音 (E4 → C4)
 */
export function playRipChime(kind: RipChimeKind): void {
  const c = getContext();
  if (!c) return;
  const play = () => {
    const t0 = c.currentTime + 0.02;
    const master = c.createGain();
    // 角を丸めて耳に刺さらないようにする。
    const lp = c.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.value = kind === "done" ? 5000 : 1400;
    master.connect(lp);
    lp.connect(c.destination);

    if (kind === "done") {
      master.gain.value = 0.22;
      const notes = [783.99, 987.77, 1174.66];
      notes.forEach((f, i) => bell(c, master, f, t0 + i * 0.11, i === notes.length - 1 ? 1.1 : 0.7, 0.9));
    } else {
      master.gain.value = 0.16;
      bell(c, master, 329.63, t0, 0.45, 0.9, "triangle");
      bell(c, master, 261.63, t0 + 0.2, 0.7, 0.9, "triangle");
    }
  };
  if (c.state === "suspended") {
    c.resume().then(play, () => {});
  } else {
    play();
  }
}
