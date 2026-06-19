// Crateforge ランディングページ — 言語切替・スクロール演出
// 依存ゼロのバニラ JS。

/* ============================================================
   多言語辞書 (日本語 / English / 繁體中文)
   ============================================================ */
const I18N = {
  ja: {
    "nav.features": "特徴",
    "nav.analysis": "DJ 解析",
    "nav.ai": "AI 選曲",
    "nav.download": "ダウンロード",
    "nav.downloadBtn": "ダウンロード",
    "hero.badge": "Tauri 2 + React 19 + Rust 製デスクトップアプリ",
    "hero.subtitle":
      "爆速 iTunes 風 音楽管理デスクトップアプリ。DJ のための解析・類似度選曲・iTunes XML 互換・CD リッピング・ローカル再生まで、この 1 本で完結。",
    "hero.download": "ダウンロード",
    "hero.github": "GitHub で見る",
    "hero.platforms": "Windows · macOS · Linux 対応",
    "shot.coming": "スクリーンショットは近日公開",
    "features.title": "必要な機能を、ぜんぶ 1 本に",
    "features.subtitle":
      "ライブラリ管理から DJ 解析、AI 選曲まで。外部アプリに頼らず完結します。",
    "features.fast.title": "爆速",
    "features.fast.desc":
      "SQLite (WAL) + 索引で 10,000+ トラックでも快適。React 側は行を仮想化。",
    "features.xml.title": "iTunes Library.xml 互換",
    "features.xml.desc":
      "入出力とも Apple plist 形式。rekordbox / Serato / Traktor が読める出力。",
    "features.cd.title": "CD リッピング",
    "features.cd.desc":
      "cdparanoia + flac/lame/ffmpeg。MusicBrainz で曲情報、Cover Art Archive でジャケット自動取得。",
    "features.files.title": "ファイル取り込み",
    "features.files.desc":
      "FLAC / MP3 / M4A / WAV / Ogg / Opus / AIFF のタグを読み取り。",
    "features.playlist.title": "プレイリスト編集",
    "features.playlist.desc":
      "作成・リネーム・削除・フォルダ階層・複数選択追加・並び替え・スマートプレイリスト。",
    "features.playback.title": "ローカル再生",
    "features.playback.desc":
      "rodio (symphonia) で各種フォーマットを直接デコード。",
    "features.ai.title": "AI 選曲",
    "features.ai.desc":
      "ローカル HTTP API 内蔵。Claude Code プラグイン dj-curator から選曲の叩き台を生成。",
    "features.nix.title": "Nix 完結",
    "features.nix.desc":
      "flake.nix で Rust / Node / GTK / WebKit / CD ツール / エンコーダを宣言。",
    "analysis.tag": "DJ ANALYSIS",
    "analysis.title": "DJ のための解析",
    "analysis.subtitle":
      "BPM・Key・Energy を解析し、似た曲をすばやく手繰り寄せる。純 Rust の DSP で高速に。",
    "analysis.bpm.title": "BPM",
    "analysis.bpm.desc": "テンポを自動検出。つなぎやすい曲を把握。",
    "analysis.key.title": "Key (Camelot)",
    "analysis.key.desc": "ハーモニックミックス向けに Camelot 表記で調を表示。",
    "analysis.energy.title": "Energy",
    "analysis.energy.desc": "曲の勢いを数値化。セットの流れを設計。",
    "analysis.similar.title": "類似度選曲",
    "analysis.similar.desc": "解析値をもとに似た雰囲気の曲を提案。",
    "gallery.title": "スクリーンショット",
    "gallery.subtitle": "アートワーク主導の UI で、ライブラリを心地よく。",
    "gallery.library": "ライブラリ表示",
    "gallery.playlists": "プレイリスト",
    "gallery.ripping": "CD リッピング",
    "gallery.analysis": "DJ 解析",
    "ai.tag": "AI CURATION",
    "ai.title": "AI と組む DJ 選曲",
    "ai.desc":
      "ローカル HTTP API サーバーを内蔵。Claude Code プラグイン dj-curator から「インプット → コンセプト → DJ 選曲の叩き台」を生成します。AI は候補プールの選定に集中し、曲順は GUI で人間が詰める方針です。",
    "ai.step1": "プラグインマーケットプレイスを追加",
    "ai.step2": "dj-curator プラグインを導入",
    "ai.step3": "コンセプトから選曲の叩き台を生成",
    "ai.readme": "dj-curator の詳細を見る",
    "download.title": "ダウンロード",
    "download.subtitle":
      "Windows / macOS / Linux に対応。最新リリースから入手できます。",
    "download.win.desc": ".exe / portable .zip / .msi / setup .exe",
    "download.mac.desc": ".dmg (Apple Silicon)",
    "download.linux.desc": ".AppImage / .deb",
    "download.cta": "最新リリースをダウンロード",
    "download.note": "ビルドは Nix (flake.nix) で完結します。",
    "footer.tagline": "爆速 iTunes 風 音楽管理デスクトップアプリ",
    "footer.license": "MIT License © 2026 tainakanchu",
    "footer.built": "Tauri 2 + React 19 + Vite 6 + Rust 製",
  },
  en: {
    "nav.features": "Features",
    "nav.analysis": "DJ Analysis",
    "nav.ai": "AI Curation",
    "nav.download": "Download",
    "nav.downloadBtn": "Download",
    "hero.badge": "A desktop app built with Tauri 2 + React 19 + Rust",
    "hero.subtitle":
      "A blazing-fast, iTunes-style music manager for desktop. DJ analysis, similarity-based selection, iTunes XML compatibility, CD ripping, and local playback — all in one app.",
    "hero.download": "Download",
    "hero.github": "View on GitHub",
    "hero.platforms": "Available for Windows · macOS · Linux",
    "shot.coming": "Screenshot coming soon",
    "features.title": "Everything you need, in one app",
    "features.subtitle":
      "From library management to DJ analysis and AI curation — no external apps required.",
    "features.fast.title": "Blazing Fast",
    "features.fast.desc":
      "SQLite (WAL) + indexes stay smooth past 10,000+ tracks. The React side virtualizes rows.",
    "features.xml.title": "iTunes Library.xml Compatible",
    "features.xml.desc":
      "Apple plist format for both import and export — output that rekordbox / Serato / Traktor can read.",
    "features.cd.title": "CD Ripping",
    "features.cd.desc":
      "cdparanoia + flac/lame/ffmpeg. Track info from MusicBrainz, cover art from the Cover Art Archive.",
    "features.files.title": "File Import",
    "features.files.desc":
      "Reads tags from FLAC / MP3 / M4A / WAV / Ogg / Opus / AIFF.",
    "features.playlist.title": "Playlist Editing",
    "features.playlist.desc":
      "Create, rename, delete, folder hierarchy, multi-select add, reorder, and smart playlists.",
    "features.playback.title": "Local Playback",
    "features.playback.desc":
      "Decodes a wide range of formats directly via rodio (symphonia).",
    "features.ai.title": "AI Curation",
    "features.ai.desc":
      "Built-in local HTTP API. Generate a starting set from the dj-curator Claude Code plugin.",
    "features.nix.title": "Powered by Nix",
    "features.nix.desc":
      "flake.nix declares Rust / Node / GTK / WebKit / CD tools / encoders.",
    "analysis.tag": "DJ ANALYSIS",
    "analysis.title": "Analysis built for DJs",
    "analysis.subtitle":
      "Analyze BPM, Key, and Energy, then pull up similar tracks fast — powered by pure-Rust DSP.",
    "analysis.bpm.title": "BPM",
    "analysis.bpm.desc": "Auto-detect tempo to find tracks that mix well.",
    "analysis.key.title": "Key (Camelot)",
    "analysis.key.desc": "Camelot notation for smooth harmonic mixing.",
    "analysis.energy.title": "Energy",
    "analysis.energy.desc": "Quantify momentum to design your set's flow.",
    "analysis.similar.title": "Similarity Selection",
    "analysis.similar.desc":
      "Suggest tracks with a similar vibe based on analysis values.",
    "gallery.title": "Screenshots",
    "gallery.subtitle": "An artwork-driven UI that makes your library a joy.",
    "gallery.library": "Library View",
    "gallery.playlists": "Playlists",
    "gallery.ripping": "CD Ripping",
    "gallery.analysis": "DJ Analysis",
    "ai.tag": "AI CURATION",
    "ai.title": "DJ curation, paired with AI",
    "ai.desc":
      "A built-in local HTTP API server lets the dj-curator Claude Code plugin turn an input into a concept and then a DJ starting set. The AI focuses on selecting the candidate pool, while you refine the track order in the GUI.",
    "ai.step1": "Add the plugin marketplace",
    "ai.step2": "Install the dj-curator plugin",
    "ai.step3": "Generate a starting set from a concept",
    "ai.readme": "Learn more about dj-curator",
    "download.title": "Download",
    "download.subtitle":
      "Available for Windows / macOS / Linux. Grab it from the latest release.",
    "download.win.desc": ".exe / portable .zip / .msi / setup .exe",
    "download.mac.desc": ".dmg (Apple Silicon)",
    "download.linux.desc": ".AppImage / .deb",
    "download.cta": "Download Latest Release",
    "download.note": "Builds are fully handled by Nix (flake.nix).",
    "footer.tagline": "A blazing-fast, iTunes-style music manager for desktop",
    "footer.license": "MIT License © 2026 tainakanchu",
    "footer.built": "Built with Tauri 2 + React 19 + Vite 6 + Rust",
  },
  "zh-Hant": {
    "nav.features": "特色",
    "nav.analysis": "DJ 分析",
    "nav.ai": "AI 選曲",
    "nav.download": "下載",
    "nav.downloadBtn": "下載",
    "hero.badge": "以 Tauri 2 + React 19 + Rust 打造的桌面應用程式",
    "hero.subtitle":
      "極速的 iTunes 風格音樂管理桌面應用程式。DJ 分析、相似度選曲、iTunes XML 相容、CD 擷取到本機播放，一套全包。",
    "hero.download": "下載",
    "hero.github": "在 GitHub 上檢視",
    "hero.platforms": "支援 Windows · macOS · Linux",
    "shot.coming": "螢幕截圖即將推出",
    "features.title": "所有需要的功能，盡在一套",
    "features.subtitle":
      "從音樂庫管理到 DJ 分析與 AI 選曲，無需仰賴外部應用程式。",
    "features.fast.title": "極速",
    "features.fast.desc":
      "SQLite (WAL) + 索引，即使超過 10,000 首曲目也順暢。React 端將列表虛擬化。",
    "features.xml.title": "iTunes Library.xml 相容",
    "features.xml.desc":
      "匯入匯出皆採 Apple plist 格式，輸出可供 rekordbox / Serato / Traktor 讀取。",
    "features.cd.title": "CD 擷取",
    "features.cd.desc":
      "cdparanoia + flac/lame/ffmpeg。透過 MusicBrainz 取得曲目資訊，Cover Art Archive 自動取得封面。",
    "features.files.title": "檔案匯入",
    "features.files.desc":
      "讀取 FLAC / MP3 / M4A / WAV / Ogg / Opus / AIFF 的標籤。",
    "features.playlist.title": "播放清單編輯",
    "features.playlist.desc":
      "建立、重新命名、刪除、資料夾階層、多選加入、重新排序與智慧型播放清單。",
    "features.playback.title": "本機播放",
    "features.playback.desc": "以 rodio (symphonia) 直接解碼多種格式。",
    "features.ai.title": "AI 選曲",
    "features.ai.desc":
      "內建本機 HTTP API。可從 Claude Code 外掛 dj-curator 產生選曲草稿。",
    "features.nix.title": "Nix 完整封裝",
    "features.nix.desc":
      "flake.nix 宣告 Rust / Node / GTK / WebKit / CD 工具 / 編碼器。",
    "analysis.tag": "DJ ANALYSIS",
    "analysis.title": "為 DJ 打造的分析",
    "analysis.subtitle":
      "分析 BPM、Key 與 Energy，並快速找出相似曲目——由純 Rust DSP 驅動。",
    "analysis.bpm.title": "BPM",
    "analysis.bpm.desc": "自動偵測節奏，掌握易於銜接的曲目。",
    "analysis.key.title": "Key (Camelot)",
    "analysis.key.desc": "以 Camelot 記號顯示調性，利於和聲混音。",
    "analysis.energy.title": "Energy",
    "analysis.energy.desc": "將曲目氣勢量化，設計整套的流動。",
    "analysis.similar.title": "相似度選曲",
    "analysis.similar.desc": "依據分析數值推薦氛圍相近的曲目。",
    "gallery.title": "螢幕截圖",
    "gallery.subtitle": "以藝術封面為主軸的介面，讓音樂庫賞心悅目。",
    "gallery.library": "音樂庫檢視",
    "gallery.playlists": "播放清單",
    "gallery.ripping": "CD 擷取",
    "gallery.analysis": "DJ 分析",
    "ai.tag": "AI CURATION",
    "ai.title": "與 AI 協作的 DJ 選曲",
    "ai.desc":
      "內建本機 HTTP API 伺服器，讓 Claude Code 外掛 dj-curator 將輸入轉化為概念，再產生 DJ 選曲草稿。AI 專注於挑選候選曲庫，而曲目順序則由你在 GUI 中細修。",
    "ai.step1": "新增外掛市集",
    "ai.step2": "安裝 dj-curator 外掛",
    "ai.step3": "從概念產生選曲草稿",
    "ai.readme": "深入了解 dj-curator",
    "download.title": "下載",
    "download.subtitle": "支援 Windows / macOS / Linux，可從最新版本取得。",
    "download.win.desc": ".exe / 可攜式 .zip / .msi / setup .exe",
    "download.mac.desc": ".dmg (Apple Silicon)",
    "download.linux.desc": ".AppImage / .deb",
    "download.cta": "下載最新版本",
    "download.note": "建置完全由 Nix (flake.nix) 處理。",
    "footer.tagline": "極速的 iTunes 風格音樂管理桌面應用程式",
    "footer.license": "MIT License © 2026 tainakanchu",
    "footer.built": "以 Tauri 2 + React 19 + Vite 6 + Rust 打造",
  },
};

/* ============================================================
   言語の決定・適用
   ============================================================ */
const SUPPORTED = ["ja", "en", "zh-Hant"];
const STORAGE_KEY = "crateforge-lang";

function detectLang() {
  const saved = localStorage.getItem(STORAGE_KEY);
  if (saved && SUPPORTED.includes(saved)) return saved;
  const nav = (navigator.language || "en").toLowerCase();
  if (nav.startsWith("ja")) return "ja";
  if (nav.startsWith("zh")) return "zh-Hant";
  return "en";
}

function applyLang(lang) {
  if (!SUPPORTED.includes(lang)) lang = "en";
  const dict = I18N[lang];
  document.documentElement.lang = lang === "zh-Hant" ? "zh-Hant" : lang;
  document.querySelectorAll("[data-i18n]").forEach((el) => {
    const key = el.getAttribute("data-i18n");
    const val = dict[key];
    if (val !== undefined) el.textContent = val;
  });
  document.querySelectorAll("[data-lang]").forEach((btn) => {
    const active = btn.getAttribute("data-lang") === lang;
    btn.classList.toggle("is-active", active);
    btn.setAttribute("aria-pressed", active ? "true" : "false");
  });
  localStorage.setItem(STORAGE_KEY, lang);
}

/* ============================================================
   初期化
   ============================================================ */
document.addEventListener("DOMContentLoaded", () => {
  applyLang(detectLang());

  document.querySelectorAll("[data-lang]").forEach((btn) => {
    btn.addEventListener("click", () => {
      applyLang(btn.getAttribute("data-lang"));
    });
  });

  const navToggle = document.querySelector(".nav-toggle");
  const navLinks = document.querySelector(".nav-links");
  if (navToggle && navLinks) {
    navToggle.addEventListener("click", () => {
      const open = navLinks.classList.toggle("is-open");
      navToggle.setAttribute("aria-expanded", open ? "true" : "false");
    });
    navLinks.querySelectorAll("a").forEach((a) => {
      a.addEventListener("click", () => {
        navLinks.classList.remove("is-open");
        navToggle.setAttribute("aria-expanded", "false");
      });
    });
  }

  const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const revealables = document.querySelectorAll(".reveal");
  if (reduce || !("IntersectionObserver" in window)) {
    revealables.forEach((el) => el.classList.add("is-visible"));
  } else {
    const io = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            entry.target.classList.add("is-visible");
            io.unobserve(entry.target);
          }
        });
      },
      { threshold: 0.12 },
    );
    revealables.forEach((el) => io.observe(el));
  }

  const nav = document.querySelector(".nav");
  if (nav) {
    const onScroll = () => {
      nav.classList.toggle("is-scrolled", window.scrollY > 8);
    };
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
  }
});
