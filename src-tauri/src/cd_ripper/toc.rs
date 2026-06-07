use crate::models::DiscToc;

/// 指定デバイスの TOC を libdiscid 経由で読み取り、MusicBrainz disc id を計算する。
///
/// Windows は libdiscid の入手が面倒なため未対応 (エラーを返す)。
#[cfg(unix)]
pub fn detect_disc(device: &str) -> Result<DiscToc, String> {
    use discid::DiscId;

    let device_opt = if device.is_empty() {
        None
    } else {
        Some(device)
    };

    let disc = DiscId::read(device_opt).map_err(|e| {
        format!(
            "Failed to read disc from {}: {}. Insert an audio CD and check the drive path.",
            device, e
        )
    })?;

    let first = disc.first_track_num();
    let last = disc.last_track_num();
    let total_sectors = disc.sectors();

    let mut track_lengths_sec = Vec::with_capacity((last - first + 1) as usize);
    for t in disc.tracks() {
        track_lengths_sec.push((t.sectors as u32) / 75);
    }

    Ok(DiscToc {
        freedb_id: disc.freedb_id().to_string(),
        musicbrainz_id: Some(disc.id().to_string()),
        device: device.to_string(),
        track_count: (last - first + 1) as usize,
        track_lengths_sec,
        total_sectors: total_sectors as u32,
    })
}

/// Windows: libdiscid 無しで TOC を IOCTL から直接読み、MusicBrainz / freedb の
/// disc id を自前計算する。
#[cfg(windows)]
pub fn detect_disc(device: &str) -> Result<DiscToc, String> {
    use crate::cd_ripper::win_cd;
    use crate::metadata::disc_id::calculate_musicbrainz_id;

    let drive = win_cd::open_drive(device)?;
    let toc = drive.read_toc()?;

    let count = (toc.last_track - toc.first_track + 1) as usize;
    let mut track_lengths_sec = Vec::with_capacity(count);
    for i in 0..toc.offsets.len() {
        let start = toc.offsets[i];
        let end = if i + 1 < toc.offsets.len() {
            toc.offsets[i + 1]
        } else {
            toc.leadout
        };
        track_lengths_sec.push(end.saturating_sub(start) / 75);
    }

    let musicbrainz_id =
        calculate_musicbrainz_id(toc.first_track, toc.last_track, toc.leadout, &toc.offsets);
    let freedb_id = freedb_disc_id(&toc.offsets, toc.leadout, count as u32);

    Ok(DiscToc {
        freedb_id,
        musicbrainz_id: Some(musicbrainz_id),
        device: device.to_string(),
        track_count: count,
        track_lengths_sec,
        total_sectors: toc.leadout,
    })
}

/// freedb/CDDB の disc id を TOC から計算する (8 桁 16 進)。
/// 仕様: <https://en.wikipedia.org/wiki/CDDB#Computing_disc_IDs>
#[cfg(windows)]
fn freedb_disc_id(offsets: &[u32], leadout: u32, track_count: u32) -> String {
    fn digit_sum(mut n: u32) -> u32 {
        let mut s = 0;
        while n > 0 {
            s += n % 10;
            n /= 10;
        }
        s
    }
    // 各トラックの開始秒の桁和を合計。
    let n: u32 = offsets.iter().map(|&o| digit_sum(o / 75)).sum();
    let first_start_sec = offsets.first().copied().unwrap_or(0) / 75;
    let total_sec = leadout / 75 - first_start_sec;
    let id = ((n % 0xff) << 24) | (total_sec << 8) | track_count;
    format!("{:08x}", id)
}

#[cfg(not(any(unix, windows)))]
pub fn detect_disc(_device: &str) -> Result<DiscToc, String> {
    Err("CD detection is not supported on this platform yet. \
         Use the Linux/macOS/Windows build for physical CD ripping, \
         or paste a TOC manually and use `compute_disc_id` to look it up on MusicBrainz."
        .to_string())
}
