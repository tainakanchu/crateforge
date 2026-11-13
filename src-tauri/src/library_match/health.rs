//! 既存曲のファイル状態の判定 (なし / 破損の疑い / 正常)。
//!
//! 実例: OneDrive の同期失敗で、サイズはそのままに途中 (数百 KB 〜 約 8 MiB 以降)
//! から末尾までがゼロで埋まったファイルが残ることがある。圧縮形式の音声データが
//! 64 KiB 連続でゼロになることはまず無いので、データ領域をまばらに標本化して
//! 「全部ゼロの窓」があれば破損の疑いとする。
//!
//! WAV / AIFF は無音区間が本当にゼロ連続になりうるので対象外 (常に Ok)。
//! 読み取りは窓単位 (64 KiB を 256 KiB おき) に限られ、ファイル全体は読まない。

use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::Path;

use serde::{Deserialize, Serialize};

/// 一致した既存曲のファイル状態。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum FileHealth {
    Ok,
    /// ファイルが無い (file_exists = 0 / パスが見つからない)。
    Missing,
    /// ゼロ埋めによる破損の疑い。
    Broken,
}

const WINDOW: u64 = 64 * 1024;
const STRIDE: u64 = 256 * 1024;
/// 末尾の ID3v1 (128 B) はゼロを含みうるので見ない。
const TAIL_SKIP: u64 = 128;
/// これより小さいデータ領域は判定しない (短すぎて誤判定しやすい)。
const MIN_REGION: u64 = 4 * 1024;

/// DB の `location_path` / `file_exists` からファイル状態を判定する。
pub fn probe(location_path: Option<&str>, file_exists: bool) -> FileHealth {
    let Some(p) = location_path.map(str::trim).filter(|p| !p.is_empty()) else {
        return FileHealth::Missing;
    };
    let path = Path::new(p);
    if !file_exists || !path.is_file() {
        return FileHealth::Missing;
    }
    match looks_zero_filled(path) {
        Ok(true) => FileHealth::Broken,
        // 読めない (権限など) ときは断定しない。
        _ => FileHealth::Ok,
    }
}

/// 拡張子からデータ領域の始まりを決める形式。
enum Kind {
    Mp3,
    Mp4,
    Flac,
    Plain,
}

fn kind_of(path: &Path) -> Option<Kind> {
    let ext = path.extension()?.to_str()?.to_ascii_lowercase();
    Some(match ext.as_str() {
        "mp3" => Kind::Mp3,
        "m4a" | "aac" | "mp4" | "alac" => Kind::Mp4,
        "flac" => Kind::Flac,
        "ogg" | "opus" | "oga" => Kind::Plain,
        // wav / aiff など非圧縮 (無音 = ゼロが正当) とその他は判定しない。
        _ => return None,
    })
}

/// ゼロ埋め破損の疑いがあるか。対象外の形式は常に false。
pub fn looks_zero_filled(path: &Path) -> std::io::Result<bool> {
    let Some(kind) = kind_of(path) else {
        return Ok(false);
    };
    let mut f = File::open(path)?;
    let len = f.metadata()?.len();
    // 調べる音声データの範囲 [start, end)。タグ・パディング等 (ゼロが正当) は除く。
    let regions: Vec<(u64, u64)> = match kind {
        Kind::Mp3 => {
            let start = id3v2_end(&mut f, 0)?;
            vec![(start, mp3_audio_end(&mut f, len)?)]
        }
        Kind::Flac => vec![(flac_audio_start(&mut f)?, len.saturating_sub(TAIL_SKIP))],
        Kind::Mp4 => mp4_mdat_ranges(&mut f, len)?,
        Kind::Plain => vec![(0, len.saturating_sub(TAIL_SKIP))],
    };
    let mut buf = vec![0u8; WINDOW as usize];
    for (start, end) in regions {
        let end = end.min(len);
        if scan_region(&mut f, &mut buf, start, end)? {
            return Ok(true);
        }
    }
    Ok(false)
}

/// `[start, end)` を 64 KiB 窓で 256 KiB おきに (+ 末尾直前の窓) 調べ、全ゼロの窓があれば true。
fn scan_region(f: &mut File, buf: &mut [u8], start: u64, end: u64) -> std::io::Result<bool> {
    if end <= start || end - start < MIN_REGION {
        return Ok(false);
    }
    let mut check = |from: u64, size: u64| -> std::io::Result<bool> {
        let b = &mut buf[..size as usize];
        f.seek(SeekFrom::Start(from))?;
        f.read_exact(b)?;
        Ok(b.iter().all(|&x| x == 0))
    };
    if end - start <= WINDOW {
        return check(start, end - start);
    }
    let mut pos = start;
    while pos + WINDOW <= end {
        if check(pos, WINDOW)? {
            return Ok(true);
        }
        pos += STRIDE;
    }
    // 末尾直前の窓 (ゼロ埋めが終盤だけのケース)。
    check(end - WINDOW, WINDOW)
}

/// MP3 の音声データの終わり: 末尾の ID3v1 (128 B) と、その前の APEv2 / Lyrics3v2 タグ
/// (ゼロを含みうる) を除いた位置。
fn mp3_audio_end(f: &mut File, len: u64) -> std::io::Result<u64> {
    let read_at = |f: &mut File, pos: u64, n: usize| -> std::io::Result<Option<Vec<u8>>> {
        let mut v = vec![0u8; n];
        f.seek(SeekFrom::Start(pos))?;
        Ok(f.read_exact(&mut v).ok().map(|_| v))
    };
    let mut end = len;
    if len >= 128 {
        if let Some(t) = read_at(f, len - 128, 3)? {
            if &t == b"TAG" {
                end = len - 128;
            }
        }
    }
    // APEv2 / Lyrics3v2 は順不同で重なりうるので、見つからなくなるまで剥がす。
    for _ in 0..4 {
        let mut stripped = false;
        if end >= 32 {
            if let Some(footer) = read_at(f, end - 32, 32)? {
                if &footer[..8] == b"APETAGEX" {
                    // size はフッタを含みヘッダを含まない。flags bit31 = ヘッダあり。
                    let size =
                        u32::from_le_bytes([footer[12], footer[13], footer[14], footer[15]]) as u64;
                    let flags =
                        u32::from_le_bytes([footer[20], footer[21], footer[22], footer[23]]);
                    let total = size + if flags & 0x8000_0000 != 0 { 32 } else { 0 };
                    if total >= 32 && total <= end {
                        end -= total;
                        stripped = true;
                    }
                }
            }
        }
        if !stripped && end >= 15 {
            if let Some(tail) = read_at(f, end - 15, 15)? {
                if &tail[6..] == b"LYRICS200" {
                    let size = std::str::from_utf8(&tail[..6])
                        .ok()
                        .and_then(|s| s.parse::<u64>().ok());
                    if let Some(size) = size.filter(|&n| n + 15 <= end) {
                        end -= size + 15;
                        stripped = true;
                    }
                }
            }
        }
        if !stripped {
            break;
        }
    }
    Ok(end)
}

/// `offset` に ID3v2 ヘッダがあればその直後の位置、無ければ `offset` を返す。
fn id3v2_end(f: &mut File, offset: u64) -> std::io::Result<u64> {
    let mut h = [0u8; 10];
    f.seek(SeekFrom::Start(offset))?;
    if f.read_exact(&mut h).is_err() || &h[..3] != b"ID3" {
        return Ok(offset);
    }
    // サイズは syncsafe (各バイト下位 7 bit)。フッタ付きなら +10。
    let size = h[6..10]
        .iter()
        .fold(0u64, |acc, &b| (acc << 7) | (b & 0x7f) as u64);
    let footer = if h[5] & 0x10 != 0 { 10 } else { 0 };
    Ok(offset + 10 + size + footer)
}

/// FLAC: (先頭の ID3v2 を飛ばし) `fLaC` のあとメタデータブロック (PADDING はゼロ) を
/// 最後まで飛ばした位置。構造が読めなければ 0。
fn flac_audio_start(f: &mut File) -> std::io::Result<u64> {
    let mut pos = id3v2_end(f, 0)?;
    let mut magic = [0u8; 4];
    f.seek(SeekFrom::Start(pos))?;
    if f.read_exact(&mut magic).is_err() || &magic != b"fLaC" {
        return Ok(0);
    }
    pos += 4;
    for _ in 0..1024 {
        let mut h = [0u8; 4];
        f.seek(SeekFrom::Start(pos))?;
        if f.read_exact(&mut h).is_err() {
            return Ok(pos);
        }
        let last = h[0] & 0x80 != 0;
        let size = ((h[1] as u64) << 16) | ((h[2] as u64) << 8) | h[3] as u64;
        pos += 4 + size;
        if last {
            return Ok(pos);
        }
    }
    Ok(pos)
}

/// MP4/M4A: トップレベルの atom をたどり、`mdat` の中身の範囲をすべて返す。
/// moov / udta / free など (パディングでゼロが正当) は調べない。
/// atom ヘッダが壊れていたら (ゼロ埋めでヘッダが消えた等)、そこから末尾までを範囲にする。
fn mp4_mdat_ranges(f: &mut File, len: u64) -> std::io::Result<Vec<(u64, u64)>> {
    let mut out = Vec::new();
    let mut pos = 0u64;
    for _ in 0..1024 {
        if pos + 8 > len {
            break;
        }
        let mut h = [0u8; 8];
        f.seek(SeekFrom::Start(pos))?;
        f.read_exact(&mut h)?;
        let size32 = u32::from_be_bytes([h[0], h[1], h[2], h[3]]) as u64;
        let typ = &h[4..8];
        let (size, header) = match size32 {
            1 => {
                let mut ext = [0u8; 8];
                if f.read_exact(&mut ext).is_err() {
                    out.push((pos, len));
                    break;
                }
                (u64::from_be_bytes(ext), 16)
            }
            0 => (len - pos, 8),
            s => (s, 8),
        };
        let printable = typ.iter().all(|&b| (0x20..=0x7e).contains(&b));
        let is_mdat = typ == b"mdat";
        // 壊れたヘッダ: 型が文字でない / サイズがヘッダ未満 / mdat 以外が末尾を越える。
        if !printable || size < header || (!is_mdat && pos + size > len) {
            out.push((pos, len));
            break;
        }
        if is_mdat {
            out.push((pos + header, (pos + size).min(len)));
        }
        pos += size;
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use tempfile::TempDir;

    /// ゼロを含まない擬似圧縮データ。
    fn noise(n: usize) -> Vec<u8> {
        (0..n).map(|i| ((i * 7 + 13) % 251 + 1) as u8).collect()
    }

    fn write(dir: &Path, name: &str, data: &[u8]) -> std::path::PathBuf {
        let p = dir.join(name);
        std::fs::File::create(&p).unwrap().write_all(data).unwrap();
        p
    }

    fn id3_header(size: u32, padding_zeros: usize) -> Vec<u8> {
        let mut v = b"ID3\x04\x00\x00".to_vec();
        let s = size;
        v.extend_from_slice(&[
            ((s >> 21) & 0x7f) as u8,
            ((s >> 14) & 0x7f) as u8,
            ((s >> 7) & 0x7f) as u8,
            (s & 0x7f) as u8,
        ]);
        v.extend(std::iter::repeat_n(0u8, padding_zeros));
        v
    }

    #[test]
    fn healthy_mp3_with_large_zero_padded_tag_is_ok() {
        let tmp = TempDir::new().unwrap();
        // 200 KiB のゼロ padding 付き ID3 (カバー画像の領域など) は対象外。
        let mut data = id3_header(200 * 1024, 200 * 1024);
        data.extend(noise(3 * 1024 * 1024));
        data.extend(std::iter::repeat_n(0u8, 128)); // ID3v1 相当の末尾
        let p = write(tmp.path(), "ok.mp3", &data);
        assert!(!looks_zero_filled(&p).unwrap());
        assert_eq!(probe(p.to_str(), true), FileHealth::Ok);
    }

    #[test]
    fn mp3_zero_filled_tail_is_broken() {
        let tmp = TempDir::new().unwrap();
        let mut data = id3_header(1024, 1024);
        data.extend(noise(300 * 1024));
        data.extend(std::iter::repeat_n(0u8, 2 * 1024 * 1024));
        let p = write(tmp.path(), "bad.mp3", &data);
        assert!(looks_zero_filled(&p).unwrap());
        assert_eq!(probe(p.to_str(), true), FileHealth::Broken);
    }

    #[test]
    fn zero_fill_only_near_end_is_caught_by_final_window() {
        let tmp = TempDir::new().unwrap();
        // 窓の刻みに乗らない位置からのゼロ埋め (最後の窓だけが拾う)。
        let mut data = noise(1024 * 1024 + 300 * 1024);
        data.extend(std::iter::repeat_n(0u8, 70 * 1024));
        let p = write(tmp.path(), "tail.flac", &data);
        assert!(looks_zero_filled(&p).unwrap());
    }

    #[test]
    fn wav_silence_is_not_flagged() {
        let tmp = TempDir::new().unwrap();
        let mut data = b"RIFF\0\0\0\0WAVE".to_vec();
        data.extend(std::iter::repeat_n(0u8, 2 * 1024 * 1024));
        let p = write(tmp.path(), "silence.wav", &data);
        assert!(!looks_zero_filled(&p).unwrap());
        assert_eq!(probe(p.to_str(), true), FileHealth::Ok);
    }

    #[test]
    fn missing_file_or_flag() {
        let tmp = TempDir::new().unwrap();
        let p = tmp.path().join("nope.mp3");
        assert_eq!(probe(p.to_str(), true), FileHealth::Missing);
        assert_eq!(probe(None, true), FileHealth::Missing);
        assert_eq!(probe(Some("  "), true), FileHealth::Missing);
        let q = write(tmp.path(), "x.mp3", &noise(100_000));
        assert_eq!(probe(q.to_str(), false), FileHealth::Missing);
        assert_eq!(probe(q.to_str(), true), FileHealth::Ok);
    }

    #[test]
    fn flac_padding_block_is_skipped() {
        let tmp = TempDir::new().unwrap();
        let mut data = b"fLaC".to_vec();
        // STREAMINFO (34 B)
        data.extend_from_slice(&[0x00, 0x00, 0x00, 34]);
        data.extend(noise(34));
        // PADDING (last, 128 KiB のゼロ)
        let pad = 128 * 1024u32;
        data.extend_from_slice(&[0x81, (pad >> 16) as u8, (pad >> 8) as u8, pad as u8]);
        data.extend(std::iter::repeat_n(0u8, pad as usize));
        data.extend(noise(1024 * 1024));
        let p = write(tmp.path(), "pad.flac", &data);
        assert!(!looks_zero_filled(&p).unwrap());
    }

    fn atom(typ: &[u8; 4], body: &[u8]) -> Vec<u8> {
        let mut v = ((body.len() + 8) as u32).to_be_bytes().to_vec();
        v.extend_from_slice(typ);
        v.extend_from_slice(body);
        v
    }

    fn ftyp() -> Vec<u8> {
        atom(b"ftyp", b"M4A \0\0\0\0M4A mp42")
    }

    /// ffmpeg 既定の mdat → moov 順で、moov 内の free (udta 等) にゼロが続いても正常。
    #[test]
    fn m4a_mdat_then_moov_with_zero_free_is_ok() {
        let tmp = TempDir::new().unwrap();
        let mut data = ftyp();
        data.extend(atom(b"mdat", &noise(1024 * 1024)));
        let free = atom(b"free", &vec![0u8; 200 * 1024]);
        let mut moov_body = atom(b"mvhd", &noise(100));
        moov_body.extend(atom(b"udta", &free));
        data.extend(atom(b"moov", &moov_body));
        data.extend(atom(b"free", &vec![0u8; 100 * 1024]));
        let p = write(tmp.path(), "ok.m4a", &data);
        assert!(!looks_zero_filled(&p).unwrap());
    }

    #[test]
    fn m4a_moov_then_mdat_zero_tail_is_broken() {
        let tmp = TempDir::new().unwrap();
        let mut data = ftyp();
        data.extend(atom(b"moov", &atom(b"mvhd", &noise(100))));
        let mut body = noise(512 * 1024);
        body.extend(vec![0u8; 512 * 1024]);
        data.extend(atom(b"mdat", &body));
        let p = write(tmp.path(), "bad.m4a", &data);
        assert!(looks_zero_filled(&p).unwrap());
    }

    /// 複数の mdat はそれぞれ調べる。
    #[test]
    fn m4a_checks_every_mdat() {
        let tmp = TempDir::new().unwrap();
        let mut data = ftyp();
        data.extend(atom(b"mdat", &noise(300 * 1024)));
        data.extend(atom(b"free", &vec![0u8; 100 * 1024]));
        let mut body = noise(64 * 1024);
        body.extend(vec![0u8; 300 * 1024]);
        data.extend(atom(b"mdat", &body));
        let p = write(tmp.path(), "multi.m4a", &data);
        assert!(looks_zero_filled(&p).unwrap());
    }

    /// 末尾の APEv2 タグ (ゼロを含む) + ID3v1 は音声データとみなさない。
    #[test]
    fn mp3_trailing_ape_tag_with_zeros_is_ok() {
        let tmp = TempDir::new().unwrap();
        let mut data = id3_header(0, 0);
        data.extend(noise(1024 * 1024));
        // APEv2: ヘッダ (32) + 項目 (ゼロ 100 KiB) + フッタ (32)。size = 項目 + フッタ。
        let items = vec![0u8; 100 * 1024];
        let size = (items.len() + 32) as u32;
        let mk = |flags: u32| {
            let mut v = b"APETAGEX".to_vec();
            v.extend_from_slice(&2000u32.to_le_bytes());
            v.extend_from_slice(&size.to_le_bytes());
            v.extend_from_slice(&1u32.to_le_bytes());
            v.extend_from_slice(&flags.to_le_bytes());
            v.extend_from_slice(&[0u8; 8]);
            v
        };
        data.extend(mk(0xA000_0000));
        data.extend(&items);
        data.extend(mk(0x8000_0000));
        let mut v1 = b"TAG".to_vec();
        v1.extend(vec![0u8; 125]);
        data.extend(v1);
        let p = write(tmp.path(), "ape.mp3", &data);
        assert!(!looks_zero_filled(&p).unwrap());
    }

    #[test]
    fn m4a_skips_atoms_before_mdat() {
        let tmp = TempDir::new().unwrap();
        let mut data = Vec::new();
        data.extend_from_slice(&24u32.to_be_bytes());
        data.extend_from_slice(b"ftypM4A \0\0\0\0M4A mp42");
        // ゼロだらけの free atom (100 KiB)
        let free = 100 * 1024u32;
        data.extend_from_slice(&free.to_be_bytes());
        data.extend_from_slice(b"free");
        data.extend(std::iter::repeat_n(0u8, free as usize - 8));
        let body = noise(1024 * 1024);
        data.extend_from_slice(&((body.len() + 8) as u32).to_be_bytes());
        data.extend_from_slice(b"mdat");
        data.extend(&body);
        let p = write(tmp.path(), "ok.m4a", &data);
        assert!(!looks_zero_filled(&p).unwrap());

        // mdat の途中からゼロ埋め → 破損
        let mut bad = data.clone();
        let cut = bad.len() / 2;
        for b in &mut bad[cut..] {
            *b = 0;
        }
        let q = write(tmp.path(), "bad.m4a", &bad);
        assert!(looks_zero_filled(&q).unwrap());
    }

    /// 実データでの確認用 (手動実行・読み取りのみ)。
    /// `CRATEFORGE_HEALTH_SCAN_DIR=<dir> cargo test --lib scan_health_dir -- --ignored --nocapture`
    /// で、ディレクトリ配下の音声ファイルのうち「破損の疑い」と判定したものを列挙する。
    #[test]
    #[ignore]
    fn scan_health_dir() {
        let Ok(dir) = std::env::var("CRATEFORGE_HEALTH_SCAN_DIR") else {
            eprintln!("CRATEFORGE_HEALTH_SCAN_DIR is not set");
            return;
        };
        let files = crate::importer::collect_audio_files(&[std::path::PathBuf::from(dir)]);
        let started = std::time::Instant::now();
        let (mut checked, mut broken, mut errors) = (0usize, 0usize, 0usize);
        for f in &files {
            checked += 1;
            match looks_zero_filled(f) {
                Ok(true) => {
                    broken += 1;
                    println!("BROKEN\t{}", f.display());
                }
                Ok(false) => {}
                Err(e) => {
                    errors += 1;
                    println!("ERROR\t{}\t{}", f.display(), e);
                }
            }
        }
        println!(
            "SUMMARY\tchecked={checked}\tbroken={broken}\terrors={errors}\telapsed={:?}",
            started.elapsed()
        );
    }
}
