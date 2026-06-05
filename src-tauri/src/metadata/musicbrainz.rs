use crate::models::{ReleaseCandidate, ReleaseTrack};

const USER_AGENT: &str = concat!(
    "Crateforge/",
    env!("CARGO_PKG_VERSION"),
    " ( https://github.com/tainakanchu/itunes-playlist-viewer )"
);

const MB_BASE: &str = "https://musicbrainz.org/ws/2";

fn client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .user_agent(USER_AGENT)
        .timeout(std::time::Duration::from_secs(20))
        .build()
        .map_err(|e| format!("Failed to build HTTP client: {}", e))
}

/// MusicBrainz disc ID で検索する。見つからなければ空ベクタ。
pub async fn lookup_by_disc_id(mb_id: &str) -> Result<Vec<ReleaseCandidate>, String> {
    let url = format!(
        "{}/discid/{}?inc=artist-credits+recordings&fmt=json",
        MB_BASE, mb_id
    );
    fetch_and_parse(&url).await
}

/// TOC で検索する (disc id が登録されていない CD のフォールバック)。
pub async fn lookup_by_toc(
    track_count: usize,
    leadout: u32,
    offsets: &[u32],
) -> Result<Vec<ReleaseCandidate>, String> {
    let mut toc_param = format!("{}+{}", track_count, leadout);
    for o in offsets {
        toc_param.push_str(&format!("+{}", o));
    }
    let url = format!(
        "{}/discid/-?toc={}&inc=artist-credits+recordings&fmt=json",
        MB_BASE, toc_param
    );
    fetch_and_parse(&url).await
}

async fn fetch_and_parse(url: &str) -> Result<Vec<ReleaseCandidate>, String> {
    let resp = client()?
        .get(url)
        .send()
        .await
        .map_err(|e| format!("MusicBrainz request failed: {}", e))?;

    let status = resp.status();
    if status == reqwest::StatusCode::NOT_FOUND {
        return Ok(vec![]);
    }
    if !status.is_success() {
        let body = resp.text().await.unwrap_or_default();
        return Err(format!("MusicBrainz returned {}: {}", status, body));
    }

    let json: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| format!("Invalid MusicBrainz JSON: {}", e))?;

    Ok(parse_releases(&json))
}

fn parse_releases(json: &serde_json::Value) -> Vec<ReleaseCandidate> {
    let mut results = Vec::new();
    let releases = json.get("releases").and_then(|v| v.as_array());
    let Some(releases) = releases else {
        return results;
    };

    for r in releases {
        let release_id = r
            .get("id")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        let title = r
            .get("title")
            .and_then(|v| v.as_str())
            .unwrap_or("(Unknown)")
            .to_string();
        let date = r
            .get("date")
            .and_then(|v| v.as_str())
            .map(String::from);
        let country = r
            .get("country")
            .and_then(|v| v.as_str())
            .map(String::from);
        let barcode = r
            .get("barcode")
            .and_then(|v| v.as_str())
            .map(String::from);
        let artist = artist_credit_string(r.get("artist-credit"));

        let tracks = extract_tracks(r);

        let cover_art_url = if !release_id.is_empty() {
            Some(crate::metadata::cover_art::front_url(&release_id))
        } else {
            None
        };

        results.push(ReleaseCandidate {
            release_id,
            title,
            artist,
            date,
            country,
            barcode,
            track_count: tracks.len(),
            tracks,
            cover_art_url,
        });
    }
    results
}

fn artist_credit_string(value: Option<&serde_json::Value>) -> String {
    let Some(arr) = value.and_then(|v| v.as_array()) else {
        return "(Unknown Artist)".to_string();
    };
    let mut out = String::new();
    for entry in arr {
        if let Some(name) = entry.get("name").and_then(|v| v.as_str()) {
            out.push_str(name);
        } else if let Some(name) = entry
            .get("artist")
            .and_then(|v| v.get("name"))
            .and_then(|v| v.as_str())
        {
            out.push_str(name);
        }
        if let Some(joinphrase) = entry.get("joinphrase").and_then(|v| v.as_str()) {
            out.push_str(joinphrase);
        }
    }
    if out.is_empty() {
        "(Unknown Artist)".to_string()
    } else {
        out
    }
}

fn extract_tracks(release: &serde_json::Value) -> Vec<ReleaseTrack> {
    let mut tracks = Vec::new();
    let media = release.get("media").and_then(|v| v.as_array());
    let Some(media) = media else { return tracks };

    // Take the first medium (most CDs are single-disc; MB lookup-by-disc returns the matching medium).
    for medium in media {
        if let Some(track_list) = medium.get("tracks").and_then(|v| v.as_array()) {
            for t in track_list {
                let position = t
                    .get("position")
                    .and_then(|v| v.as_u64())
                    .unwrap_or(0) as usize;
                let title = t
                    .get("title")
                    .and_then(|v| v.as_str())
                    .unwrap_or("(Untitled)")
                    .to_string();
                let artist = artist_credit_string(t.get("artist-credit"));
                let length_ms = t.get("length").and_then(|v| v.as_u64());
                tracks.push(ReleaseTrack {
                    position,
                    title,
                    artist,
                    length_ms,
                });
            }
            // First medium with tracks wins.
            if !tracks.is_empty() {
                return tracks;
            }
        }
    }
    tracks
}
