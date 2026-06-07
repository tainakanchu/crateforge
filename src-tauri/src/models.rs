use serde::{Deserialize, Serialize};

// === Library models ===

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Track {
    pub id: i64,
    pub track_id: i64,
    pub persistent_id: Option<String>,
    pub name: Option<String>,
    pub artist: Option<String>,
    pub album_artist: Option<String>,
    pub composer: Option<String>,
    pub album: Option<String>,
    pub genre: Option<String>,
    pub year: Option<i64>,
    pub rating: Option<i64>,
    pub play_count: Option<i64>,
    pub skip_count: Option<i64>,
    pub total_time_ms: Option<i64>,
    pub date_added: Option<String>,
    pub date_modified: Option<String>,
    pub bpm: Option<i64>,
    pub comments: Option<String>,
    pub location_raw: Option<String>,
    pub location_path: Option<String>,
    pub track_type: Option<String>,
    pub disabled: bool,
    pub compilation: bool,
    pub disc_number: Option<i64>,
    pub disc_count: Option<i64>,
    pub track_number: Option<i64>,
    pub track_count: Option<i64>,
    pub file_exists: bool,
    /// アプリ内で最後に再生した時刻 (ISO8601 UTC)。未再生なら None。
    pub last_played: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Playlist {
    pub id: i64,
    pub playlist_id: i64,
    pub persistent_id: Option<String>,
    pub parent_persistent_id: Option<String>,
    pub name: String,
    pub is_folder: bool,
    pub is_smart: bool,
    pub is_user_created: bool,
    pub track_count: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlaybackState {
    pub is_playing: bool,
    pub current_track_id: Option<i64>,
    pub position_ms: u64,
    pub duration_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportResult {
    pub track_count: usize,
    pub playlist_count: usize,
    pub missing_files: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportResult {
    pub output_path: String,
    pub track_count: usize,
    pub playlist_count: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LibraryStats {
    pub track_count: i64,
    pub playlist_count: i64,
    pub total_time_ms: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QueueState {
    pub track_ids: Vec<i64>,
    pub current_index: Option<i64>,
    pub shuffle: bool,
    pub repeat: String,
    pub volume: f32,
}

/// トラックの編集可能フィールドのパッチ。
/// - `String` 系: `Some("")` で空文字に、`None` で変更なし
/// - 数値系の Option<Option<T>>: `Some(Some(v))` で設定、`Some(None)` で NULL に、`None` で変更なし
#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct TrackEdit {
    pub name: Option<String>,
    pub artist: Option<String>,
    pub album_artist: Option<String>,
    pub composer: Option<String>,
    pub album: Option<String>,
    pub genre: Option<String>,
    pub comments: Option<String>,
    #[serde(default, deserialize_with = "double_option")]
    pub year: Option<Option<i64>>,
    #[serde(default, deserialize_with = "double_option")]
    pub bpm: Option<Option<i64>>,
    pub rating: Option<i64>,
    #[serde(default, deserialize_with = "double_option")]
    pub track_number: Option<Option<i64>>,
    #[serde(default, deserialize_with = "double_option")]
    pub track_count: Option<Option<i64>>,
    #[serde(default, deserialize_with = "double_option")]
    pub disc_number: Option<Option<i64>>,
    #[serde(default, deserialize_with = "double_option")]
    pub disc_count: Option<Option<i64>>,
    /// コンピレーション・フラグ。`Some(true/false)` で設定、`None` で変更なし。
    pub compilation: Option<bool>,
}

/// `null` を「明示的にクリア」と扱うために、二重 Option を必要とする。
fn double_option<'de, T, D>(deserializer: D) -> Result<Option<Option<T>>, D::Error>
where
    T: Deserialize<'de>,
    D: serde::Deserializer<'de>,
{
    Option::<T>::deserialize(deserializer).map(Some)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GenreTagCount {
    pub tag: String,
    pub count: i64,
}

// === Audio analysis (DJ 向け: BPM / key / energy / loudness / similarity) ===

/// 1 曲の解析結果。`track_analysis` テーブルに 1:1 で保存される。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrackAnalysis {
    pub track_id: i64,
    /// 解析器のバージョン。アルゴリズム更新時に再解析判定へ使う。
    pub version: i64,
    pub analyzed_at: String,
    /// 解析で推定した BPM。
    pub bpm: Option<f64>,
    /// Camelot 表記 (例 "8A")。ハーモニックミキシング用。
    pub key_camelot: Option<String>,
    /// 人間可読のキー名 (例 "A minor")。
    pub key_name: Option<String>,
    /// エネルギー (0..1)。体感の激しさ・推進力の近似。
    pub energy: Option<f64>,
    /// EBU R128 統合ラウドネス (LUFS)。
    pub loudness_lufs: Option<f64>,
    /// ReplayGain 相当のゲイン (dB)。再生時の音量正規化に使う。
    pub replaygain_db: Option<f64>,
    /// 類似度計算用の特徴ベクトル (正規化済み)。
    pub vector: Vec<f64>,
    /// 波形オーバービュー (0..1 のピーク列)。一覧取得では空 (get_analysis でのみ充填)。
    #[serde(default)]
    pub peaks: Vec<f32>,
}

/// 解析進捗イベント (`analysis-progress`)。RipProgress と同じノリのタグ付き enum。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum AnalysisProgress {
    Start {
        total: usize,
    },
    Item {
        track_id: i64,
        done: usize,
        total: usize,
        ok: bool,
    },
    Finished {
        analyzed: usize,
        failed: usize,
    },
}

/// 解析状況のサマリ (バッジ表示用)。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AnalysisStatus {
    /// 現行バージョンで解析済みの曲数。
    pub analyzed: i64,
    /// ファイルが存在する曲の総数 (解析対象母数)。
    pub total: i64,
}

/// 類似度検索の 1 ヒット (曲 + 距離。距離が小さいほど似ている)。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SimilarHit {
    pub track: Track,
    pub distance: f64,
}

// === CD / ripping models ===

/// 物理 CD ドライブから読み取った TOC + disc id。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiscToc {
    /// `cd-discid` が返した freedb 形式の disc id (16 進)。
    pub freedb_id: String,
    /// MusicBrainz 形式の disc id (Base64-like)。
    pub musicbrainz_id: Option<String>,
    /// CD ドライブパス (例: /dev/sr0)。
    pub device: String,
    pub track_count: usize,
    /// 各トラックのフレーム単位の長さ (75 frames/sec)。
    pub track_lengths_sec: Vec<u32>,
    /// CD 全体のセクタ長 (info 用)。
    pub total_sectors: u32,
}

/// MusicBrainz から取得したリリース候補。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReleaseCandidate {
    pub release_id: String,
    pub title: String,
    pub artist: String,
    pub date: Option<String>,
    pub country: Option<String>,
    pub barcode: Option<String>,
    pub track_count: usize,
    pub tracks: Vec<ReleaseTrack>,
    pub cover_art_url: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReleaseTrack {
    pub position: usize,
    pub title: String,
    pub artist: String,
    pub length_ms: Option<u64>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum EncodeFormat {
    Flac,
    Mp3,
    Alac,
    Wav,
}

impl EncodeFormat {
    pub fn extension(&self) -> &'static str {
        match self {
            EncodeFormat::Flac => "flac",
            EncodeFormat::Mp3 => "mp3",
            EncodeFormat::Alac => "m4a",
            EncodeFormat::Wav => "wav",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RipRequest {
    pub device: String,
    pub output_dir: String,
    pub format: EncodeFormat,
    /// 1-based トラック番号 (空なら全件)。
    pub tracks: Vec<usize>,
    /// 適用するメタデータ (見つからなければ None — その場合はトラック番号で命名)。
    pub release: Option<ReleaseCandidate>,
    /// 取り込み完了後にライブラリに追加するか。
    pub add_to_library: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum RipProgress {
    Start {
        total: usize,
    },
    TrackStart {
        index: usize,
        total: usize,
        label: String,
    },
    TrackProgress {
        index: usize,
        percent: u8,
    },
    TrackDone {
        index: usize,
        output_path: String,
    },
    Done {
        written_files: Vec<String>,
        added_tracks: usize,
    },
    Error {
        message: String,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportFileResult {
    pub added_tracks: usize,
    pub skipped: usize,
}

// === Smart playlists ===

/// スマートプレイリストの条件 (フラットなルール列 + 全/いずれか一致)。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SmartCriteria {
    /// true = すべての条件に一致 (AND)、false = いずれか (OR)。
    pub match_all: bool,
    pub rules: Vec<SmartRule>,
    /// 上限曲数 (None で無制限)。
    pub limit: Option<usize>,
    /// 並び替えフィールド (UI 側 SortField 名)。
    pub sort_by: Option<String>,
    #[serde(default)]
    pub sort_desc: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SmartRule {
    pub field: String,
    pub op: SmartOp,
    pub value: String,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum SmartOp {
    Is,
    IsNot,
    Contains,
    NotContains,
    Gt,
    Lt,
    Gte,
    Lte,
    Exists,
    NotExists,
}

// === Audio file conversion ===

/// 変換先の音声フォーマット (ffmpeg ベース)。
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ConvertFormat {
    Mp3,
    Flac,
    Alac,
    Aac,
    Opus,
    Wav,
}

impl ConvertFormat {
    pub fn extension(&self) -> &'static str {
        match self {
            ConvertFormat::Mp3 => "mp3",
            ConvertFormat::Flac => "flac",
            ConvertFormat::Alac | ConvertFormat::Aac => "m4a",
            ConvertFormat::Opus => "opus",
            ConvertFormat::Wav => "wav",
        }
    }

    /// 埋め込みカバーアートを保持できるコンテナか。
    pub fn supports_cover(&self) -> bool {
        matches!(
            self,
            ConvertFormat::Mp3 | ConvertFormat::Flac | ConvertFormat::Alac | ConvertFormat::Aac
        )
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConvertRequest {
    pub track_ids: Vec<i64>,
    pub format: ConvertFormat,
    /// 非可逆フォーマットのビットレート (kbps)。None なら既定値。
    pub bitrate_kbps: Option<u32>,
    pub output_dir: String,
    /// 変換後のファイルをライブラリへ追加するか。
    pub add_to_library: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum ConvertProgress {
    Start {
        total: usize,
    },
    Item {
        index: usize,
        total: usize,
        name: String,
        ok: bool,
    },
    Done {
        converted: usize,
        failed: usize,
        added: usize,
    },
}
