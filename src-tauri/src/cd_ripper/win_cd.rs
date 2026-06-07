//! Windows 専用: CD ドライブから TOC と CDDA 生データを直接読み取る低レベル I/O。
//!
//! 追加の crate 依存（windows / windows-sys）を入れず、`kernel32` を生 FFI で呼ぶ。
//! これは Windows ターゲットをこの開発機でコンパイル検証できないため、crate の
//! バージョン差異で壊れるリスクを避ける狙い。CDROM の IOCTL/構造体 ABI は安定。

use std::ffi::c_void;
use std::path::Path;

#[link(name = "kernel32")]
extern "system" {
    fn CreateFileW(
        lp_file_name: *const u16,
        dw_desired_access: u32,
        dw_share_mode: u32,
        lp_security_attributes: *mut c_void,
        dw_creation_disposition: u32,
        dw_flags_and_attributes: u32,
        h_template_file: *mut c_void,
    ) -> *mut c_void;
    fn DeviceIoControl(
        h_device: *mut c_void,
        dw_io_control_code: u32,
        lp_in_buffer: *const c_void,
        n_in_buffer_size: u32,
        lp_out_buffer: *mut c_void,
        n_out_buffer_size: u32,
        lp_bytes_returned: *mut u32,
        lp_overlapped: *mut c_void,
    ) -> i32;
    fn CloseHandle(h_object: *mut c_void) -> i32;
    fn GetLastError() -> u32;
}

const GENERIC_READ: u32 = 0x8000_0000;
const FILE_SHARE_READ: u32 = 0x0000_0001;
const FILE_SHARE_WRITE: u32 = 0x0000_0002;
const OPEN_EXISTING: u32 = 3;
const INVALID_HANDLE_VALUE: isize = -1;

// CTL_CODE(FILE_DEVICE_CD_ROM=0x2, function, method, FILE_READ_ACCESS=1)
//   = (0x2 << 16) | (1 << 14) | (function << 2) | method
const IOCTL_CDROM_READ_TOC: u32 = 0x0002_4000; // function 0x0000, METHOD_BUFFERED
const IOCTL_CDROM_RAW_READ: u32 = 0x0002_403E; // function 0x000F, METHOD_OUT_DIRECT

const TRACK_MODE_CDDA: i32 = 2; // TRACK_MODE_TYPE::CDDA
const RAW_SECTOR_SIZE: usize = 2352; // CDDA raw サンプル長
const COOKED_SECTOR_SIZE: i64 = 2048; // RAW_READ_INFO.DiskOffset の単位換算
const LEAD_IN_FRAMES: u32 = 150; // 2 秒のリードイン (LBA = frames - 150)

// 以下 3 つは DeviceIoControl が生メモリへ読み書きする ABI 構造体。
// 一部フィールドは OS が参照するだけで Rust からは読まないため dead_code を許可。
#[repr(C)]
#[derive(Clone, Copy)]
#[allow(dead_code)]
struct TrackData {
    reserved: u8,
    control_adr: u8, // Control:4 / Adr:4 のビットフィールドを 1 バイトで保持
    track_number: u8,
    reserved1: u8,
    address: [u8; 4], // IOCTL_CDROM_READ_TOC は MSF: [reserved, M, S, F]
}

#[repr(C)]
#[allow(dead_code)]
struct CdromToc {
    length: [u8; 2],
    first_track: u8,
    last_track: u8,
    track_data: [TrackData; 100],
}

#[repr(C)]
#[allow(dead_code)]
struct RawReadInfo {
    disk_offset: i64, // バイト換算 = LBA * 2048
    sector_count: u32,
    track_mode: i32,
}

pub struct WinToc {
    pub first_track: u8,
    pub last_track: u8,
    /// 各トラックの絶対フレームオフセット (MSF→frames, リードイン 150 込み)。index 0 = first_track。
    pub offsets: Vec<u32>,
    /// リードアウトの絶対フレームオフセット。
    pub leadout: u32,
}

pub struct Drive {
    handle: *mut c_void,
}

impl Drive {
    /// TOC を読み取り、MSF アドレスを絶対フレームに変換して返す。
    pub fn read_toc(&self) -> Result<WinToc, String> {
        let mut toc: CdromToc = unsafe { std::mem::zeroed() };
        let mut returned: u32 = 0;
        let ok = unsafe {
            DeviceIoControl(
                self.handle,
                IOCTL_CDROM_READ_TOC,
                std::ptr::null(),
                0,
                &mut toc as *mut _ as *mut c_void,
                std::mem::size_of::<CdromToc>() as u32,
                &mut returned,
                std::ptr::null_mut(),
            )
        };
        if ok == 0 {
            return Err(format!(
                "TOC の読み取りに失敗しました (GetLastError={}). オーディオ CD が入っているか確認してください。",
                unsafe { GetLastError() }
            ));
        }
        let first = toc.first_track;
        let last = toc.last_track;
        if last < first {
            return Err("不正な TOC です（トラックが見つかりません）。".into());
        }
        // leadout は index == count の位置に入るので、配列長を超えないことを保証する。
        if (last - first + 1) as usize >= toc.track_data.len() {
            return Err("不正な TOC です（トラック数が異常）。".into());
        }
        let msf =
            |a: [u8; 4]| -> u32 { (a[1] as u32) * 60 * 75 + (a[2] as u32) * 75 + (a[3] as u32) };
        let count = (last - first + 1) as usize;
        let mut offsets = Vec::with_capacity(count);
        for i in 0..count {
            offsets.push(msf(toc.track_data[i].address));
        }
        // リードアウトは index == count の位置 (TrackNumber == 0xAA)。
        let leadout = msf(toc.track_data[count].address);
        Ok(WinToc {
            first_track: first,
            last_track: last,
            offsets,
            leadout,
        })
    }

    /// 1 トラック分の CDDA を読み、生 PCM (16bit LE / stereo / 44100Hz) を返す。
    pub fn read_track_pcm(&self, toc: &WinToc, track_num: usize) -> Result<Vec<u8>, String> {
        let first = toc.first_track as usize;
        if track_num < first || track_num > toc.last_track as usize {
            return Err(format!("トラック番号 {} は範囲外です。", track_num));
        }
        let idx = track_num - first;
        let start_frame = toc.offsets[idx];
        let end_frame = if idx + 1 < toc.offsets.len() {
            toc.offsets[idx + 1]
        } else {
            toc.leadout
        };
        if end_frame <= start_frame {
            return Err(format!("トラック {} の長さが 0 です。", track_num));
        }
        let start_lba = (start_frame - LEAD_IN_FRAMES) as i64;
        let total_sectors = end_frame - start_frame;

        let mut pcm = Vec::with_capacity(total_sectors as usize * RAW_SECTOR_SIZE);
        const CHUNK: u32 = 26; // 64KB 未満に収める (26 * 2352 = 61,152 bytes)
        let mut buf = vec![0u8; CHUNK as usize * RAW_SECTOR_SIZE];
        let mut done = 0u32;
        while done < total_sectors {
            let n = (total_sectors - done).min(CHUNK);
            let info = RawReadInfo {
                disk_offset: (start_lba + done as i64) * COOKED_SECTOR_SIZE,
                sector_count: n,
                track_mode: TRACK_MODE_CDDA,
            };
            let mut returned: u32 = 0;
            let ok = unsafe {
                DeviceIoControl(
                    self.handle,
                    IOCTL_CDROM_RAW_READ,
                    &info as *const _ as *const c_void,
                    std::mem::size_of::<RawReadInfo>() as u32,
                    buf.as_mut_ptr() as *mut c_void,
                    n * RAW_SECTOR_SIZE as u32,
                    &mut returned,
                    std::ptr::null_mut(),
                )
            };
            if ok == 0 {
                return Err(format!(
                    "オーディオの読み取りに失敗しました (track {}, GetLastError={}).",
                    track_num,
                    unsafe { GetLastError() }
                ));
            }
            pcm.extend_from_slice(&buf[..returned as usize]);
            done += n;
        }
        Ok(pcm)
    }
}

impl Drop for Drive {
    fn drop(&mut self) {
        unsafe {
            CloseHandle(self.handle);
        }
    }
}

/// "D:" や "D" のようなデバイス指定からドライブを開く。
pub fn open_drive(device: &str) -> Result<Drive, String> {
    let letter = device
        .chars()
        .find(|c| c.is_ascii_alphabetic())
        .ok_or_else(|| format!("ドライブ文字を特定できません: {:?}", device))?;
    let path = format!(r"\\.\{}:", letter.to_ascii_uppercase());
    let wide: Vec<u16> = path.encode_utf16().chain(std::iter::once(0)).collect();
    let handle = unsafe {
        CreateFileW(
            wide.as_ptr(),
            GENERIC_READ,
            FILE_SHARE_READ | FILE_SHARE_WRITE,
            std::ptr::null_mut(),
            OPEN_EXISTING,
            0,
            std::ptr::null_mut(),
        )
    };
    if handle as isize == INVALID_HANDLE_VALUE {
        return Err(format!(
            "ドライブ {}: を開けませんでした (GetLastError={}). 管理者権限や別アプリの占有を確認してください。",
            letter,
            unsafe { GetLastError() }
        ));
    }
    Ok(Drive { handle })
}

/// 16bit LE / stereo / 44100Hz の生 PCM を WAV ファイルとして書き出す。
pub fn write_wav(path: &Path, pcm: &[u8]) -> Result<(), String> {
    use std::io::Write;
    let data_len = pcm.len() as u32;
    let sample_rate: u32 = 44100;
    let channels: u16 = 2;
    let bits: u16 = 16;
    let byte_rate = sample_rate * channels as u32 * (bits as u32 / 8);
    let block_align = channels * (bits / 8);

    let mut h: Vec<u8> = Vec::with_capacity(44);
    h.extend_from_slice(b"RIFF");
    h.extend_from_slice(&(36 + data_len).to_le_bytes());
    h.extend_from_slice(b"WAVE");
    h.extend_from_slice(b"fmt ");
    h.extend_from_slice(&16u32.to_le_bytes());
    h.extend_from_slice(&1u16.to_le_bytes()); // PCM
    h.extend_from_slice(&channels.to_le_bytes());
    h.extend_from_slice(&sample_rate.to_le_bytes());
    h.extend_from_slice(&byte_rate.to_le_bytes());
    h.extend_from_slice(&block_align.to_le_bytes());
    h.extend_from_slice(&bits.to_le_bytes());
    h.extend_from_slice(b"data");
    h.extend_from_slice(&data_len.to_le_bytes());

    let mut f = std::fs::File::create(path).map_err(|e| format!("WAV 作成失敗: {e}"))?;
    f.write_all(&h)
        .map_err(|e| format!("WAV ヘッダ書込失敗: {e}"))?;
    f.write_all(pcm)
        .map_err(|e| format!("WAV データ書込失敗: {e}"))?;
    Ok(())
}
