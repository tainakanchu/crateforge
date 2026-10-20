mod analyzer;
mod api;
mod artwork;
mod audio;
mod cast;
mod cd_ripper;
mod commands;
mod converter;
mod db;
mod devices;
mod ffmpeg;
mod fonts;
mod importer;
mod itunes_xml;
mod logging;
mod mdns;
mod metadata;
mod models;
mod organizer;
mod pairing;
mod playback_target;
mod playlist_rules;
mod proc;
mod rbx_cli;
mod smart;
mod smtc;
mod sync;
mod text_fold;
mod traktor_nml;
mod updater;
mod usb_export;

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
    // 有効トークン集合 (legacy 共有トークン + デバイス別トークン)。axum ハンドラと
    // Tauri コマンドで Arc を共有する。中身は setup で DB から初期化する。
    let valid_tokens = devices::ValidTokens::default();

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        // ウィンドウのサイズ・位置・最大化状態を次回起動時に復元する。
        .plugin(tauri_plugin_window_state::Builder::default().build())
        // 埋め込みジャケットを `artwork://localhost/<percent-encoded path>` で配信。
        // <img> から遅延ロードされ、WebView がレスポンスをキャッシュする。
        // `?s=<px>` を付けると段階 (64/128/256/512/1024) に丸めた縮小版を返し、
        // `<app_cache_dir>/artwork-thumbs` にディスクキャッシュする (artwork::thumb)。
        // s 無しは従来どおり原本。Windows では `http://artwork.localhost/...` になるが
        // path / query の形は同じ。
        .register_asynchronous_uri_scheme_protocol("artwork", |ctx, request, responder| {
            // convertFileSrc は `/<encodeURIComponent(path)>` を作る。先頭スラッシュは
            // 1 個だけ剥がす (絶対パスの先頭 `/` を誤って消さないため)。
            let raw = request.uri().path();
            let path_enc = raw.strip_prefix('/').unwrap_or(raw).to_string();
            let bucket = artwork::thumb::parse_size_query(request.uri().query());
            let cache_dir = bucket.and_then(|_| {
                ctx.app_handle()
                    .path()
                    .app_cache_dir()
                    .ok()
                    .map(|d| d.join(artwork::thumb::CACHE_DIR_NAME))
            });
            // スレッドを 1 リクエストごとに立てず、tokio の blocking プールに載せる。
            // 重い処理 (抽出・縮小) の同時実行数は artwork::thumb 側のセマフォで絞る。
            tauri::async_runtime::spawn(async move {
                let path = percent_encoding::percent_decode_str(&path_enc)
                    .decode_utf8_lossy()
                    .into_owned();
                let resp = match artwork::thumb::load(path, bucket, cache_dir).await {
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
        .manage(valid_tokens)
        // Cast Receiver 用の Media Ticket。API サーバー (起動のたびに取り直す) と共有する。
        .manage(cast::media_ticket::MediaTickets::default())
        .manage(commands::sync::SyncRuntime::default())
        .manage(commands::playback::PreviewMode::default())
        .manage(commands::playback_persist::PlaybackPersister::default())
        .manage(commands::output_device::OutputDeviceNotices::default())
        // USB 書き出し (rbx-cli) の単一実行ガード。
        .manage(usb_export::UsbExportRuntime::default())
        .setup(|app| {
            // クラッシュ痕跡を残すためのファイルロガー + panic フックを最初に仕込む
            // (GUI 起動で stderr が残らない。panic=abort でも abort 前にフックが走る)。
            if let Ok(dir) = app.path().app_data_dir() {
                logging::install(&dir);
            }

            // バックグラウンド音声解析ワーカを起動して managed state に載せる。
            app.manage(analyzer::Analyzer::new(app.handle().clone()));

            // 再生先 (Local / Google Cast) の振り分け窓口。再生系のコマンド・ワーカー・
            // Remote API はすべてこれを経由するので、ワーカー起動より前に manage する。
            // 起動時は常に Local (Cast へ自動接続しない)。
            app.manage(playback_target::PlaybackCoordinator::new(
                std::sync::Arc::new(playback_target::TauriEnv::new(app.handle().clone())),
            ));
            // Cast 端末の探索 (最初に一覧を開いたときに browse を始める)。
            let discovery_handle = app.handle().clone();
            app.manage(cast::discovery::CastDiscovery::new(move |devices| {
                use tauri::Emitter;
                let _ = discovery_handle.emit("cast-devices-changed", devices);
            }));

            // 曲の自動送りを駆動するワーカースレッド。AudioPlayer の manage 後に起動する
            // (ワーカーが app.state::<Mutex<AudioPlayer>> を参照するため)。
            // フロントのポーリングではなく Rust 側で送るので、WebView がスロットルされても
            // 再生が継続する。
            let advance_handle = app.handle().clone();
            std::thread::spawn(move || {
                commands::playback::advance_worker(advance_handle);
            });

            // 前回終了時の再生キュー / 再生状態を復元する (#159)。曲は一時停止状態で
            // 保存位置に読み込むだけで自動再生はしない。永続化ワーカーは復元の後に起動する
            // (先に動くと空のキューで保存済みの状態を上書きしてしまうため)。
            // 保存済みの出力デバイス (#170) を先に開き、復元した曲がそのデバイスに載るようにする。
            commands::output_device::apply_saved(app.handle());
            commands::playback_persist::restore(app.handle());
            // 出力デバイスの抜去監視 / システム既定への追従。
            let output_handle = app.handle().clone();
            std::thread::spawn(move || {
                commands::output_device::watch_worker(output_handle);
            });
            let persist_handle = app.handle().clone();
            std::thread::spawn(move || {
                commands::playback_persist::persist_worker(persist_handle);
            });

            // SMTC is best-effort: failure here shouldn't block app launch.
            let handle = app.handle().clone();
            if let Err(e) = smtc::init(&handle) {
                eprintln!("SMTC init failed (non-fatal): {}", e);
                logging::write_line("warn", &format!("SMTC init failed (non-fatal): {}", e));
            }

            // 有効トークン集合を DB から初期化する (legacy 共有トークン + 全デバイス
            // トークン)。サーバー自動起動より前に済ませておくことで、起動直後から
            // 既存デバイスが認証できる。DB を開けない場合は空集合のまま続行する。
            {
                let valid = app.state::<devices::ValidTokens>();
                if let Ok(dir) = app.path().app_data_dir() {
                    if let Ok(db) = db::Database::open(&dir) {
                        devices::reload_valid_tokens(&db, &valid);
                    }
                }
            }

            // 前回 enabled だった場合のみ内蔵 API サーバーを自動起動する。
            // bind 失敗 (ポート使用中など) は非致命: 警告だけ出して起動はブロックしない。
            {
                let server_state = app.state::<Mutex<Option<api::ServerControl>>>();
                let pairing_reg = app.state::<pairing::PairingRegistry>();
                let valid = app.state::<devices::ValidTokens>();
                if let Err(e) = commands::api::start_if_enabled(
                    app.handle(),
                    &server_state,
                    &pairing_reg,
                    &valid,
                ) {
                    eprintln!("API server auto-start failed (non-fatal): {}", e);
                    logging::write_line(
                        "warn",
                        &format!("API server auto-start failed (non-fatal): {}", e),
                    );
                }
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            // library
            commands::library::import_library,
            commands::library::export_library,
            commands::library::import_files,
            commands::library::import_folders,
            commands::library::refresh_tech_metadata,
            commands::library::rescan_file_existence,
            commands::library::relocate_track_file,
            commands::library::get_tracks,
            commands::library::get_tracks_by_ids,
            commands::library::search_tracks,
            commands::library::get_library_stats,
            commands::library::update_track,
            commands::library::set_track_rating,
            commands::library::add_genre_tag,
            commands::library::remove_genre_tag,
            commands::library::get_all_genre_tags,
            commands::library::get_all_tags,
            commands::library::get_track_tags,
            commands::library::add_track_tags,
            commands::library::remove_track_tags,
            commands::library::get_library_root,
            commands::library::set_library_root,
            commands::library::detect_library_root,
            commands::library::get_search_fold_level,
            commands::library::set_search_fold_level,
            commands::library::get_albums,
            commands::library::get_album_tracks,
            commands::library::get_artists,
            commands::library::get_artist_albums,
            // バックアップ / 復元 / 整合性チェック / VACUUM (#167)
            commands::backup::backup_library,
            commands::backup::restore_library,
            commands::backup::check_library_integrity,
            commands::backup::vacuum_library,
            commands::library::delete_tracks,
            commands::library::reveal_in_file_manager,
            // artwork
            commands::artwork::set_artwork_from_data,
            commands::artwork::set_artwork_from_file,
            commands::artwork::remove_artwork,
            // playlists
            commands::playlists::get_playlists,
            commands::playlists::get_playlist_tracks,
            commands::playlists::create_playlist,
            commands::playlists::rename_playlist,
            commands::playlists::delete_playlist,
            commands::playlists::add_tracks_to_playlist,
            commands::playlists::remove_track_from_playlist,
            commands::playlists::remove_tracks_from_playlist,
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
            commands::playback::set_preview_mode,
            commands::playback::get_preview_mode,
            commands::playback_persist::get_playback_restored,
            commands::output_device::list_output_devices,
            commands::output_device::set_output_device,
            commands::output_device::take_output_device_notices,
            // 再生先 (Google Cast)
            commands::cast::list_cast_devices,
            commands::cast::refresh_cast_devices,
            commands::cast::get_cast_status,
            commands::cast::set_playback_target,
            commands::cast::disconnect_cast,
            // ripping
            commands::ripping::detect_disc,
            commands::ripping::list_cd_drives,
            commands::ripping::disc_present,
            commands::ripping::lookup_release_by_disc_id,
            commands::ripping::lookup_release_by_toc,
            commands::ripping::compute_disc_id,
            commands::ripping::rip_cd,
            commands::ripping::organize_active,
            // conversion
            commands::convert::convert_tracks,
            // ffmpeg (resolution / on-demand download)
            commands::ffmpeg::get_ffmpeg_status,
            commands::ffmpeg::download_ffmpeg,
            // USB 書き出し (rekordbox 互換 / CDJ 向け、外部 rbx-cli)
            commands::usb_export::get_rbx_cli_status,
            commands::usb_export::download_rbx_cli,
            commands::usb_export::set_rbx_cli_path,
            commands::usb_export::get_traktor_nml_status,
            commands::usb_export::set_traktor_nml_path,
            commands::usb_export::usb_list_devices,
            commands::usb_export::usb_eject,
            commands::usb_export::usb_export_plan,
            commands::usb_export::usb_export_start,
            commands::usb_export::usb_export_cancel,
            commands::usb_export::usb_export_status,
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
            commands::pairing::list_paired_devices,
            commands::pairing::revoke_device,
            // federation slave sync
            commands::sync::sync_pair_start,
            commands::sync::sync_pair_poll,
            commands::sync::sync_list_sources,
            commands::sync::sync_list_selections,
            commands::sync::sync_set_selection_policy,
            commands::sync::sync_remove_selection,
            commands::sync::sync_list_remote_playlists,
            commands::sync::sync_playlist_size_estimate,
            commands::sync::sync_provision,
            commands::sync::sync_provision_status,
            commands::sync::sync_resync,
            commands::sync::sync_eviction_candidates,
            commands::sync::sync_evict,
            commands::sync::sync_storage_usage,
            commands::sync::sync_writeback_plan,
            commands::sync::sync_writeback_apply,
            commands::sync::sync_list_pushable,
            commands::sync::sync_push_tracks,
            commands::sync::sync_push_analyses,
            // フォント
            commands::fonts::list_system_fonts,
            commands::fonts::get_ui_font,
            commands::fonts::set_ui_font,
            commands::fonts::cjk_font_status,
            commands::fonts::download_cjk_font,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            // 終了時に再生キュー / 再生位置を即時保存する (#159)。
            if let tauri::RunEvent::Exit = event {
                commands::playback_persist::flush(app);
                // Cast のチケットを失効させ、Receiver との接続を閉じる。
                if let Some(coord) = app.try_state::<playback_target::PlaybackCoordinator>() {
                    let coord = coord.inner().clone();
                    tauri::async_runtime::block_on(coord.shutdown());
                }
                if let Some(d) = app.try_state::<cast::discovery::CastDiscovery>() {
                    d.stop();
                }
                // 実行中の rbx-cli (USB 書き出し) を孤児にしない。
                commands::usb_export::shutdown(app);
            }
        });
}
