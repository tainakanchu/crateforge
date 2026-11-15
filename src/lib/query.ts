/**
 * 検索ボックスの文字列と絞り込みチップ (`genre:House` など) を、バックエンドへ渡す
 * 1 本のクエリにまとめる (空白区切りの AND)。
 */
export function combineQuery(search: string, tags: readonly string[]): string {
  return [search.trim(), ...tags].filter(Boolean).join(" ");
}
