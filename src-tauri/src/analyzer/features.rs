//! モノラル PCM から DJ 向け特徴量を抽出する純 Rust DSP。
//!
//! - BPM: スペクトルフラックスのオンセット包絡を自己相関してテンポ推定
//! - Key: クロマ + Krumhansl-Schmuckler 鍵プロファイル相関 → Camelot
//! - Energy: RMS / スペクトル重心 / オンセット密度の合成 (0..1)
//! - Loudness: EBU R128 統合ラウドネス (LUFS) → ReplayGain 相当ゲイン
//! - vector: 上記を正規化して並べた類似度用ベクトル

use rustfft::{num_complex::Complex, FftPlanner};

/// スペクトル解析の作業サンプリングレート (ネイティブからダウンサンプルする)。
const ANALYSIS_RATE: u32 = 22_050;
const FFT_SIZE: usize = 2_048;
const HOP: usize = 512;

pub struct Features {
    pub bpm: Option<f64>,
    pub key_camelot: Option<String>,
    pub key_name: Option<String>,
    pub energy: Option<f64>,
    pub loudness_lufs: Option<f64>,
    pub replaygain_db: Option<f64>,
    pub vector: Vec<f64>,
    /// 波形オーバービュー (0..1 に正規化した max-abs 包絡、固定本数)。
    pub peaks: Vec<f32>,
}

/// 波形表示用のピーク本数。
const PEAK_BARS: usize = 160;

/// ネイティブレートのモノラルサンプルから全特徴量を抽出する。
pub fn extract(native_mono: &[f32], native_rate: u32) -> Features {
    // ラウドネスはネイティブレートのまま計測する (R128 はレート依存)。
    let (lufs, replaygain) = loudness(native_mono, native_rate);
    // 波形オーバービューはフル解像度の max-abs 包絡から作る。
    let peaks = compute_peaks(native_mono, PEAK_BARS);

    // スペクトル系は解析レートへ落としてから。
    let mono = downsample(native_mono, native_rate, ANALYSIS_RATE);

    if mono.len() < FFT_SIZE * 2 {
        return Features {
            bpm: None,
            key_camelot: None,
            key_name: None,
            energy: None,
            loudness_lufs: lufs,
            replaygain_db: replaygain,
            vector: Vec::new(),
            peaks,
        };
    }

    let frames = stft_magnitudes(&mono);
    let onset = onset_envelope(&frames);
    let bpm = estimate_bpm(&onset, ANALYSIS_RATE);

    let chroma = chromagram(&frames, ANALYSIS_RATE);
    let (camelot, key_name, _strength) = estimate_key(&chroma);

    let centroid = spectral_centroid(&frames, ANALYSIS_RATE);
    let onset_rate = if onset.is_empty() {
        0.0
    } else {
        onset.iter().filter(|&&x| x > 0.0).count() as f64 / onset.len() as f64
    };
    let energy = compute_energy(rms(&mono), centroid, onset_rate);

    let vector = build_vector(bpm, energy, &chroma, centroid, lufs, onset_rate);

    Features {
        bpm,
        key_camelot: camelot,
        key_name,
        energy: Some(energy),
        loudness_lufs: lufs,
        replaygain_db: replaygain,
        vector,
        peaks,
    }
}

/// フル解像度サンプルを `n` 個のバケットに分け、各 max-abs を取って 0..1 に正規化。
fn compute_peaks(samples: &[f32], n: usize) -> Vec<f32> {
    if samples.is_empty() || n == 0 {
        return Vec::new();
    }
    let bucket = (samples.len() as f64 / n as f64).ceil().max(1.0) as usize;
    let mut peaks = Vec::with_capacity(n);
    let mut i = 0;
    while i < samples.len() && peaks.len() < n {
        let end = (i + bucket).min(samples.len());
        let mut m = 0.0f32;
        for &s in &samples[i..end] {
            let a = s.abs();
            if a > m {
                m = a;
            }
        }
        peaks.push(m);
        i = end;
    }
    let max = peaks.iter().copied().fold(0.0f32, f32::max);
    if max > 0.0 {
        for p in peaks.iter_mut() {
            *p /= max;
        }
    }
    peaks
}

/// ボックス平均による簡易ダウンサンプル (アンチエイリアス兼用)。`to >= from` なら無加工。
fn downsample(input: &[f32], from: u32, to: u32) -> Vec<f32> {
    if input.is_empty() || to >= from {
        return input.to_vec();
    }
    let ratio = from as f64 / to as f64;
    let out_len = (input.len() as f64 / ratio).floor() as usize;
    let mut out = Vec::with_capacity(out_len);
    for i in 0..out_len {
        let start = (i as f64 * ratio) as usize;
        let end = (((i + 1) as f64) * ratio) as usize;
        let end = end.min(input.len()).max(start + 1);
        let slice = &input[start..end];
        out.push(slice.iter().copied().sum::<f32>() / slice.len() as f32);
    }
    out
}

fn hann(n: usize) -> Vec<f32> {
    if n <= 1 {
        return vec![1.0; n];
    }
    (0..n)
        .map(|i| 0.5 - 0.5 * (2.0 * std::f32::consts::PI * i as f32 / (n as f32 - 1.0)).cos())
        .collect()
}

/// STFT の各フレームの振幅スペクトル (片側、FFT_SIZE/2+1 ビン)。
fn stft_magnitudes(mono: &[f32]) -> Vec<Vec<f32>> {
    let mut planner = FftPlanner::<f32>::new();
    let fft = planner.plan_fft_forward(FFT_SIZE);
    let window = hann(FFT_SIZE);
    let bins = FFT_SIZE / 2 + 1;

    let mut frames = Vec::new();
    let mut buf = vec![Complex::new(0.0f32, 0.0); FFT_SIZE];
    let mut i = 0;
    while i + FFT_SIZE <= mono.len() {
        for j in 0..FFT_SIZE {
            buf[j] = Complex::new(mono[i + j] * window[j], 0.0);
        }
        fft.process(&mut buf);
        frames.push(buf[..bins].iter().map(|c| c.norm()).collect());
        i += HOP;
    }
    frames
}

/// スペクトルフラックス (正の差分の総和) によるオンセット包絡。平均を引いて整流する。
fn onset_envelope(frames: &[Vec<f32>]) -> Vec<f32> {
    if frames.len() < 2 {
        return Vec::new();
    }
    let mut env = Vec::with_capacity(frames.len());
    env.push(0.0);
    for k in 1..frames.len() {
        let mut flux = 0.0f32;
        let (cur, prev) = (&frames[k], &frames[k - 1]);
        for b in 0..cur.len().min(prev.len()) {
            let d = cur[b] - prev[b];
            if d > 0.0 {
                flux += d;
            }
        }
        env.push(flux);
    }
    let mean = env.iter().sum::<f32>() / env.len() as f32;
    for v in env.iter_mut() {
        *v = (*v - mean).max(0.0);
    }
    env
}

/// オンセット包絡の自己相関でテンポ (BPM) を推定。典型的な DJ レンジへ折り返す。
fn estimate_bpm(onset: &[f32], rate: u32) -> Option<f64> {
    if onset.len() < 16 {
        return None;
    }
    let fps = rate as f64 / HOP as f64;
    let min_lag = ((60.0 * fps / 200.0).floor() as usize).max(1);
    let max_lag = ((60.0 * fps / 60.0).ceil() as usize).min(onset.len() - 1);
    if max_lag <= min_lag {
        return None;
    }

    let mut best_lag = 0usize;
    let mut best = f64::MIN;
    for lag in min_lag..=max_lag {
        let mut sum = 0.0f64;
        for i in lag..onset.len() {
            sum += onset[i] as f64 * onset[i - lag] as f64;
        }
        // 短いラグへの偏りを抑えるため重なり数で正規化。
        let norm = sum / (onset.len() - lag) as f64;
        if norm > best {
            best = norm;
            best_lag = lag;
        }
    }
    if best_lag == 0 || best <= 0.0 {
        return None;
    }
    let mut bpm = 60.0 * fps / best_lag as f64;
    while bpm < 70.0 {
        bpm *= 2.0;
    }
    while bpm > 180.0 {
        bpm /= 2.0;
    }
    Some((bpm * 10.0).round() / 10.0)
}

/// 全フレームを集計した 12 音クロマ (合計 1 に正規化)。
fn chromagram(frames: &[Vec<f32>], rate: u32) -> [f64; 12] {
    let mut chroma = [0.0f64; 12];
    let bins = frames.first().map(|f| f.len()).unwrap_or(0);

    // ビン → ピッチクラス を事前計算 (A0=27.5Hz 〜 5kHz の楽音域に限定)。
    let mut pc_of_bin = vec![None; bins];
    for (b, slot) in pc_of_bin.iter_mut().enumerate().skip(1) {
        let f = b as f64 * rate as f64 / FFT_SIZE as f64;
        if !(27.5..=5000.0).contains(&f) {
            continue;
        }
        let midi = 69.0 + 12.0 * (f / 440.0).log2();
        *slot = Some((midi.round() as i64).rem_euclid(12) as usize);
    }

    for frame in frames {
        for (b, &m) in frame.iter().enumerate() {
            if let Some(Some(pc)) = pc_of_bin.get(b) {
                chroma[*pc] += m as f64;
            }
        }
    }

    let sum: f64 = chroma.iter().sum();
    if sum > 0.0 {
        for c in chroma.iter_mut() {
            *c /= sum;
        }
    }
    chroma
}

/// Krumhansl-Schmuckler。12 主音 × {major, minor} の相関最大を選び Camelot へ。
fn estimate_key(chroma: &[f64; 12]) -> (Option<String>, Option<String>, f64) {
    if chroma.iter().sum::<f64>() <= 0.0 {
        return (None, None, 0.0);
    }
    const MAJOR: [f64; 12] = [
        6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88,
    ];
    const MINOR: [f64; 12] = [
        6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17,
    ];

    let mut best = (f64::MIN, 0usize, false);
    for tonic in 0..12 {
        let rotated: Vec<f64> = (0..12).map(|i| chroma[(tonic + i) % 12]).collect();
        let cmaj = pearson(&rotated, &MAJOR);
        let cmin = pearson(&rotated, &MINOR);
        if cmaj > best.0 {
            best = (cmaj, tonic, false);
        }
        if cmin > best.0 {
            best = (cmin, tonic, true);
        }
    }
    let (strength, tonic, is_minor) = best;
    (
        Some(camelot_code(tonic, is_minor)),
        Some(key_name(tonic, is_minor)),
        strength,
    )
}

fn pearson(a: &[f64], b: &[f64]) -> f64 {
    let n = a.len().min(b.len()) as f64;
    if n == 0.0 {
        return 0.0;
    }
    let ma = a.iter().sum::<f64>() / n;
    let mb = b.iter().sum::<f64>() / n;
    let mut num = 0.0;
    let mut da = 0.0;
    let mut db = 0.0;
    for i in 0..a.len().min(b.len()) {
        let xa = a[i] - ma;
        let xb = b[i] - mb;
        num += xa * xb;
        da += xa * xa;
        db += xb * xb;
    }
    let den = (da * db).sqrt();
    if den > 0.0 {
        num / den
    } else {
        0.0
    }
}

/// ピッチクラス (0=C..11=B) と長短から Camelot コード ("8A" 等) を作る。
fn camelot_code(pc: usize, is_minor: bool) -> String {
    const MAJ: [u8; 12] = [8, 3, 10, 5, 12, 7, 2, 9, 4, 11, 6, 1];
    const MIN: [u8; 12] = [5, 12, 7, 2, 9, 4, 11, 6, 1, 8, 3, 10];
    let num = if is_minor { MIN[pc] } else { MAJ[pc] };
    let letter = if is_minor { 'A' } else { 'B' };
    format!("{num}{letter}")
}

fn key_name(pc: usize, is_minor: bool) -> String {
    const NAMES: [&str; 12] = [
        "C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B",
    ];
    format!("{} {}", NAMES[pc], if is_minor { "minor" } else { "major" })
}

fn spectral_centroid(frames: &[Vec<f32>], rate: u32) -> f64 {
    if frames.is_empty() {
        return 0.0;
    }
    let mut total = 0.0f64;
    let mut count = 0usize;
    for frame in frames {
        let mut num = 0.0f64;
        let mut den = 0.0f64;
        for (b, &m) in frame.iter().enumerate() {
            let f = b as f64 * rate as f64 / FFT_SIZE as f64;
            num += f * m as f64;
            den += m as f64;
        }
        if den > 0.0 {
            total += num / den;
            count += 1;
        }
    }
    if count == 0 {
        0.0
    } else {
        total / count as f64
    }
}

fn rms(x: &[f32]) -> f64 {
    if x.is_empty() {
        return 0.0;
    }
    let s: f64 = x.iter().map(|&v| (v as f64) * (v as f64)).sum();
    (s / x.len() as f64).sqrt()
}

fn compute_energy(rms: f64, centroid: f64, onset_rate: f64) -> f64 {
    let rms_db = if rms > 1e-9 {
        20.0 * rms.log10()
    } else {
        -80.0
    };
    let loud = ((rms_db + 40.0) / 40.0).clamp(0.0, 1.0);
    let bright = (centroid / 4000.0).clamp(0.0, 1.0);
    let drive = onset_rate.clamp(0.0, 1.0);
    (0.5 * loud + 0.25 * bright + 0.25 * drive).clamp(0.0, 1.0)
}

/// EBU R128 統合ラウドネス (LUFS) と ReplayGain 相当ゲイン (dB)。
fn loudness(mono: &[f32], rate: u32) -> (Option<f64>, Option<f64>) {
    use ebur128::{EbuR128, Mode};
    if mono.is_empty() || rate == 0 {
        return (None, None);
    }
    let mut meter = match EbuR128::new(1, rate, Mode::I) {
        Ok(m) => m,
        Err(_) => return (None, None),
    };
    if meter.add_frames_f32(mono).is_err() {
        return (None, None);
    }
    match meter.loudness_global() {
        Ok(l) if l.is_finite() => {
            // ReplayGain 2.0 の基準は -18 LUFS。
            let rg = (-18.0 - l).clamp(-15.0, 15.0);
            (
                Some((l * 10.0).round() / 10.0),
                Some((rg * 10.0).round() / 10.0),
            )
        }
        _ => (None, None),
    }
}

/// 類似度用ベクトル: 各特徴を 0..1 へ正規化して連結 (先頭 5 次元 + クロマ 12 次元)。
fn build_vector(
    bpm: Option<f64>,
    energy: f64,
    chroma: &[f64; 12],
    centroid: f64,
    lufs: Option<f64>,
    onset_rate: f64,
) -> Vec<f64> {
    let bpm_n = bpm
        .map(|b| ((b - 70.0) / 110.0).clamp(0.0, 1.0))
        .unwrap_or(0.5);
    let centroid_n = (centroid / 8000.0).clamp(0.0, 1.0);
    let lufs_n = lufs
        .map(|l| ((l + 30.0) / 30.0).clamp(0.0, 1.0))
        .unwrap_or(0.5);

    let mut v = Vec::with_capacity(5 + 12);
    v.push(bpm_n);
    v.push(energy.clamp(0.0, 1.0));
    v.push(centroid_n);
    v.push(lufs_n);
    v.push(onset_rate.clamp(0.0, 1.0));
    v.extend_from_slice(chroma);
    v
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::f32::consts::PI;

    /// 440Hz (A4) の正弦波はクロマのピークが A (pc=9) になるはず。
    #[test]
    fn sine_440_detects_a() {
        let rate = ANALYSIS_RATE;
        let n = (rate as usize) * 2; // 2 秒
        let sig: Vec<f32> = (0..n)
            .map(|i| (2.0 * PI * 440.0 * i as f32 / rate as f32).sin() * 0.8)
            .collect();
        let frames = stft_magnitudes(&sig);
        let chroma = chromagram(&frames, rate);
        let argmax = (0..12)
            .max_by(|&a, &b| chroma[a].total_cmp(&chroma[b]))
            .unwrap();
        assert_eq!(argmax, 9, "expected pitch class A, chroma={chroma:?}");
    }

    /// 120 BPM のクリック列はテンポ推定が ~120 に乗るはず。
    #[test]
    fn click_train_detects_120_bpm() {
        let rate = ANALYSIS_RATE;
        let interval = (rate as f64 * 60.0 / 120.0) as usize; // 120 BPM のサンプル間隔
        let n = interval * 32;
        let mut sig = vec![0.0f32; n];
        let mut t = 0;
        while t < n {
            // 短いバースト (広帯域オンセット)。
            for k in 0..64 {
                if t + k < n {
                    sig[t + k] = if k % 2 == 0 { 0.9 } else { -0.9 };
                }
            }
            t += interval;
        }
        let bpm = extract(&sig, rate).bpm.expect("bpm");
        assert!((bpm - 120.0).abs() < 6.0, "expected ~120 BPM, got {bpm}");
    }

    /// 無音 / 極短は panic せず None を返す。
    #[test]
    fn silence_is_safe() {
        let f = extract(&[0.0f32; 1000], ANALYSIS_RATE);
        assert!(f.bpm.is_none());
        assert!(f.key_camelot.is_none());
    }

    #[test]
    fn camelot_mapping_spot_checks() {
        assert_eq!(camelot_code(9, true), "8A"); // A minor
        assert_eq!(camelot_code(0, false), "8B"); // C major
        assert_eq!(camelot_code(7, false), "9B"); // G major
        assert_eq!(camelot_code(8, true), "1A"); // G# minor
    }
}
