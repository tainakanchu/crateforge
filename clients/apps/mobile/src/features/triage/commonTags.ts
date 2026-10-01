// トリアージ用の定番 first-class Tags（チップ表示）。
// RN Alert.prompt は iOS のみなので、MVP は固定チップ + フリー入力は後回し。

export const REVIEW_LATER_TAG = "review:later";

/** 長押しメニュー / プレイヤーですぐ付けられる定番タグ。 */
export const COMMON_TRIAGE_TAGS: { tag: string; label: string }[] = [
  { tag: REVIEW_LATER_TAG, label: "あとで聴く" },
  { tag: "mood:energy", label: "mood:energy" },
  { tag: "mood:chill", label: "mood:chill" },
  { tag: "mood:dark", label: "mood:dark" },
  { tag: "crate:candidates", label: "候補" },
  { tag: "crate:keep", label: "keep" },
];
