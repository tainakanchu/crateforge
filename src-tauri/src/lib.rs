mod artwork;
mod audio;
mod cd_ripper;
mod commands;
mod db;
mod importer;
mod itunes_xml;
mod metadata;
mod models;
mod organizer;
mod playlist_rules;
mod smtc;
mod updater;

use std::sync::Mutex;

/// アートワークが無い / 読めない場合の 404 レスポンス。
fn not_found() -> tauri::http::Response<Vec<u8>> {
    tauri::http::Response::builder()
        .status(404)
        .body(Vec::new())
        .expect("static 404 response")
}

pub fn run() {
    let audio_player = Mutex::new(audio::AudioPlayer::new());
    let smtc_state = Mutex::new(smtc::SmtcState::new());

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_shell::init())
        // 埋め込みジャケットを `artwork://localhost/<percent-encoded path>` で配信。
        // <img> から遅延ロードされ、WebView がレスポンスをキャッシュする。
        .register_asynchronous_uri_scheme_protocol("artwork", |_ctx, request, responder| {
            // convertFileSrc は `/<encodeURIComponent(path)>` を作る。先頭スラッシュは
            // 1 個だけ剥がす (絶対パスの先頭 `/` を誤って消さないため)。
            let raw = request.uri().path();
            let path_enc = raw.strip_prefix('/').unwrap_or(raw).to_string();
            std::thread::spawn(move || {
                let path = percent_encoding::percent_decode_str(&path_enc)
                    .decode_utf8_lossy()
                    .into_owned();
                let resp = match artwork::extract_picture(&path) {
                    Some((data, mime)) => tauri::http::Response::builder()
                        .status(200)
                        .header(tauri::http::header::CONTENT_TYPE, mime)
                        .header(tauri::http::header::CACHE_CONTROL, "max-age=86400")
                        .body(data)
                        .unwrap_or_else(|_| not_found()),
                    None => not_found(),
                };
                responder.respond(resp);
            });
        })
        .manage(audio_player)
        .manage(smtc_state)
        .setup(|app| {
            // SMTC is best-effort: failure here shouldn't block app launch.
            let handle = app.handle().clone();
            if let Err(e) = smtc::init(&handle) {
                eprintln!("SMTC init failed (non-fatal): {}", e);
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            // library
            commands::library::import_library,
            commands::library::export_library,
            commands::library::import_files,
            commands::library::get_tracks,
            commands::library::search_tracks,
            commands::library::get_library_stats,
            commands::library::update_track,
            commands::library::set_track_rating,
            commands::library::add_genre_tag,
            commands::library::remove_genre_tag,
            commands::library::get_all_genre_tags,
            commands::library::get_library_root,
            commands::library::set_library_root,
            // playlists
            commands::playlists::get_playlists,
            commands::playlists::get_playlist_tracks,
            commands::playlists::create_playlist,
            commands::playlists::rename_playlist,
            commands::playlists::delete_playlist,
            commands::playlists::add_tracks_to_playlist,
            commands::playlists::remove_track_from_playlist,
            commands::playlists::reorder_playlist_tracks,
            // playback
            commands::playback::play_track,
            commands::playback::pause,
            commands::playback::resume,
            commands::playback::stop,
            commands::playback::seek,
            commands::playback::get_playback_state,
            commands::playback::get_recent_tracks,
            commands::playback::set_queue,
            commands::playback::enqueue_track,
            commands::playback::clear_queue,
            commands::playback::get_queue,
            commands::playback::play_queue_at,
            commands::playback::play_next,
            commands::playback::play_prev,
            commands::playback::set_shuffle,
            commands::playback::set_repeat,
            commands::playback::set_volume,
            commands::playback::check_advance,
            // ripping
            commands::ripping::detect_disc,
            commands::ripping::lookup_release_by_disc_id,
            commands::ripping::lookup_release_by_toc,
            commands::ripping::compute_disc_id,
            commands::ripping::rip_cd,
            // declarative playlist rules
            commands::rules::validate_rules,
            commands::rules::preview_rules,
            commands::rules::apply_rules,
            commands::rules::read_text_file,
            commands::rules::write_text_file,
            // updater
            commands::updater::check_for_update,
            // smtc
            commands::smtc::update_smtc,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
