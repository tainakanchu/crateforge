// @ts-check
import { defineConfig } from "astro/config";
import starlight from "@astrojs/starlight";

// GitHub Pages serves the LP (site/) at the repo root
// (https://tainakanchu.github.io/crateforge/) and these docs live under
// /crateforge/docs/. So site = the user/org origin and base = /crateforge/docs.
export default defineConfig({
  site: "https://tainakanchu.github.io",
  base: "/crateforge/docs",
  integrations: [
    starlight({
      title: "Crateforge Docs",
      defaultLocale: "root",
      locales: {
        root: { label: "日本語", lang: "ja" },
        en: { label: "English", lang: "en" },
        "zh-tw": { label: "繁體中文", lang: "zh-TW" },
      },
      social: [
        {
          icon: "github",
          label: "GitHub",
          href: "https://github.com/tainakanchu/crateforge",
        },
      ],
      editLink: {
        baseUrl:
          "https://github.com/tainakanchu/crateforge/edit/main/website/",
      },
      // Dark theme is Starlight's default; pin it so the LP and docs match.
      // (Local full-text search via pagefind is enabled by default.)
      sidebar: [
        {
          // Link back to the LP at the site root. Use an absolute URL so
          // Starlight treats it as external and does NOT prepend the docs
          // base (/crateforge/docs) or the locale segment.
          label: "← Crateforge",
          link: "https://tainakanchu.github.io/crateforge/",
          attrs: { target: "_self" },
          translations: {
            en: "← Crateforge",
            "zh-TW": "← Crateforge",
          },
        },
        {
          label: "ガイド",
          translations: {
            en: "Guide",
            "zh-TW": "指南",
          },
          items: [
            {
              slug: "index",
              label: "はじめに",
              translations: { en: "Introduction", "zh-TW": "開始使用" },
            },
            {
              slug: "guide/install",
              label: "インストール",
              translations: { en: "Install", "zh-TW": "安裝" },
            },
            {
              slug: "guide/import",
              label: "ライブラリ取り込み",
              translations: { en: "Import library", "zh-TW": "匯入音樂庫" },
            },
            {
              slug: "guide/playback",
              label: "再生・キュー・Crate",
              translations: {
                en: "Playback, queue & crate",
                "zh-TW": "播放・佇列・Crate",
              },
            },
            {
              slug: "guide/smart-playlists",
              label: "スマートプレイリスト",
              translations: {
                en: "Smart playlists",
                "zh-TW": "智慧播放清單",
              },
            },
            {
              slug: "guide/customize",
              label: "表示のカスタマイズ",
              translations: {
                en: "Customize the view",
                "zh-TW": "自訂顯示",
              },
            },
            {
              slug: "guide/dj-analysis",
              label: "DJ 解析",
              translations: { en: "DJ analysis", "zh-TW": "DJ 解析" },
            },
            {
              slug: "guide/api-server",
              label: "内蔵 API サーバー",
              translations: {
                en: "Built-in API server",
                "zh-TW": "內建 API 伺服器",
              },
            },
            {
              slug: "guide/mobile",
              label: "モバイル",
              translations: { en: "Mobile", "zh-TW": "行動裝置" },
            },
            {
              slug: "guide/convert",
              label: "フォーマット変換",
              translations: {
                en: "Format conversion",
                "zh-TW": "格式轉換",
              },
            },
            {
              slug: "guide/usb-export",
              label: "USB 書き出し（CDJ）",
              translations: {
                en: "USB export (CDJ)",
                "zh-TW": "USB 匯出（CDJ）",
              },
            },
          ],
        },
      ],
    }),
  ],
});
