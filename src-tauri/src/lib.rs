mod analyzer;
mod api;
mod artwork;
mod audio;
mod cd_ripper;
mod commands;
mod converter;
mod db;
mod ffmpeg;
mod fonts;
mod importer;
mod itunes_xml;
mod logging;
mod metadata;
mod models;
mod organizer;
mod pairing;
mod playlist_rules;
mod smart;
mod smtc;
mod text_fold;
mod updater;

use std::sync::Mutex;

use tauri::Manager;

/// アートワークが無い / 読めない場合の 404 レスポンス。
fn not_found() -> tauri::http::Response<Vec<u8>> {
    tauri::http::Response::builder()
        .status(404)
        .body(Vec::new())
        .expect("static 404 response")
}

pub fn run() {
    // 前回のポータブル自己アップデートで残った旧 exe を掃除する。
    updater::cleanup_stale();

    let audio_player = Mutex::new(audio::AudioPlayer::new());
    let smtc_state = Mutex::new(smtc::SmtcState::new());
    // 内蔵 API サーバーの稼働ハンドル。setup / コマンドから差し替える。
    let api_server: Mutex<Option<api::ServerControl>> = Mutex::new(None);
    // デバイスペアリング レジストリ。axum ハンドラと Tauri コマンドで共有する。
    let pairing_registry = pairing::PairingRegistry::default();

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_clipboard_manager::init())
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
        // キャッシュ済み CJK フォントを `font://localhost/<filename>` で配信。
        // フロントエンドは CSS の @font-face src に convertFileSrc で生成した URL を渡す。
        .register_asynchronous_uri_scheme_protocol("font", |ctx, request, responder| {
            // AppHandle をクローンして spawn に移動する。
            let app = ctx.app_handle().clone();
            let raw = request.uri().path();
            let filename_enc = raw.strip_prefix('/').unwrap_or(raw).to_string();
            std::thread::spawn(move || {
                let filename = percent_encoding::percent_decode_str(&filename_enc)
                    .decode_utf8_lossy()
                    .into_owned();
                // セキュリティ: パス区切りを含むリクエストは拒否する。
                if filename.contains('/') || filename.contains('\\') {
                    responder.respond(not_found());
                    return;
                }
                let resp = match fonts::cache_path(&app) {
                    Some(dir) => {
                        let font_path = dir.parent().unwrap_or(&dir).join(&filename);
                        match std::fs::read(&font_path) {
                            Ok(data) => tauri::http::Response::builder()
                                .status(200)
                                .header(tauri::http::header::CONTENT_TYPE, "font/otf")
                                .header(tauri::http::header::CACHE_CONTROL, "max-age=86400")
                                .body(data)
                                .unwrap_or_else(|_| not_found()),
                            Err(_) => not_found(),
                        }
                    }
                    None => not_found(),
                };
                responder.respond(resp);
            });
        })
        .manage(audio_player)
        .manage(smtc_state)
        .manage(api_server)
        .manage(pairing_registry)
        .setup(|app| {
            // クラッシュ痕跡を残すためのファイルロガー + panic フックを最初に仕込む
            // (GUI 起動で stderr が残らない。panic=abort でも abort 前にフックが走る)。
            if let Ok(dir) = app.path().app_data_dir() {
                logging::install(&dir);
            }

            // バックグラウンド音声解析ワーカを起動して managed state に載せる。
            app.manage(analyzer::Analyzer::new(app.handle().clone()));

            // 曲の自動送りを駆動するワーカースレッド。AudioPlayer の manage 後に起動する
            // (ワーカーが app.state::<Mutex<AudioPlayer>> を参照するため)。
            // フロントのポーリングではなく Rust 側で送るので、WebView がスロットルされても
            // 再生が継続する。
            let advance_handle = app.handle().clone();
            std::thread::spawn(move || {
                commands::playback::advance_worker(advance_handle);
            });

            // SMTC is best-effort: failure here shouldn't block app launch.
            let handle = app.handle().clone();
            if let Err(e) = smtc::init(&handle) {
                eprintln!("SMTC init failed (non-fatal): {}", e);
                logging::write_line("warn", &format!("SMTC init failed (non-fatal): {}", e));
            }

            // 前回 enabled だった場合のみ内蔵 API サーバーを自動起動する。
            // bind 失敗 (ポート使用中など) は非致命: 警告だけ出して起動はブロックしない。
            {
                let server_state = app.state::<Mutex<Option<api::ServerControl>>>();
                let pairing_reg = app.state::<pairing::PairingRegistry>();
                if let Err(e) = commands::api::start_if_enabled(app.handle(), &server_state, &pairing_reg) {
                    eprintln!("API server auto-start failed (non-fatal): {}", e);
                    logging::write_line("warn", &format!("API server auto-start failed (non-fatal): {}", e));
                }
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            // library
            commands::library::import_library,
            commands::library::export_library,
            commands::library::import_files,
            commands::library::get_tracks,
            commands::library::get_tracks_by_ids,
            commands::library::search_tracks,
            commands::library::get_library_stats,
            commands::library::update_track,
            commands::library::set_track_rating,
            commands::library::add_genre_tag,
            commands::library::remove_genre_tag,
            commands::library::get_all_genre_tags,
            commands::library::get_library_root,
            commands::library::set_library_root,
            commands::library::detect_library_root,
            commands::library::get_search_fold_level,
            commands::library::set_search_fold_level,
            // artwork
            commands::artwork::set_artwork_from_data,
            commands::artwork::set_artwork_from_file,
            // playlists
            commands::playlists::get_playlists,
            commands::playlists::get_playlist_tracks,
            commands::playlists::create_playlist,
            commands::playlists::rename_playlist,
            commands::playlists::delete_playlist,
            commands::playlists::add_tracks_to_playlist,
            commands::playlists::remove_track_from_playlist,
            commands::playlists::reorder_playlist_tracks,
            commands::playlists::create_smart_playlist,
            commands::playlists::update_smart_criteria,
            commands::playlists::get_smart_criteria,
            commands::playlists::get_smart_playlist_tracks,
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
            commands::playback::enqueue_track_next,
            commands::playback::remove_queue_at,
            commands::playback::move_queue_item,
            commands::playback::clear_queue,
            commands::playback::get_queue,
            commands::playback::play_queue_at,
            commands::playback::play_next,
            commands::playback::play_prev,
            commands::playback::set_shuffle,
            commands::playback::set_repeat,
            commands::playback::set_volume,
            commands::playback::set_replaygain,
            // ripping
            commands::ripping::detect_disc,
            commands::ripping::lookup_release_by_disc_id,
            commands::ripping::lookup_release_by_toc,
            commands::ripping::compute_disc_id,
            commands::ripping::rip_cd,
            // conversion
            commands::convert::convert_tracks,
            // ffmpeg (resolution / on-demand download)
            commands::ffmpeg::get_ffmpeg_status,
            commands::ffmpeg::download_ffmpeg,
            // audio analysis
            commands::analysis::analyze_tracks,
            commands::analysis::get_analysis,
            commands::analysis::get_analysis_status,
            commands::analysis::get_all_analyses,
            commands::analysis::get_similar,
            commands::analysis::build_smooth_order,
            // declarative playlist rules
            commands::rules::validate_rules,
            commands::rules::preview_rules,
            commands::rules::apply_rules,
            commands::rules::read_text_file,
            commands::rules::write_text_file,
            // updater
            commands::updater::check_for_update,
            commands::updater::download_and_run_update,
            // smtc
            commands::smtc::update_smtc,
            // 内蔵 API サーバー
            commands::api::get_api_server_status,
            commands::api::set_api_server_config,
            commands::api::set_api_lan_enabled,
            commands::api::regenerate_api_token,
            commands::api::lan_qr_svg,
            // デバイスペアリング
            commands::pairing::approve_pairing,
            commands::pairing::list_pending_pairings,
            // フォント
            commands::fonts::list_system_fonts,
            commands::fonts::get_ui_font,
            commands::fonts::set_ui_font,
            commands::fonts::cjk_font_status,
            commands::fonts::download_cjk_font,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
