# デスクトップ TS のテストとミューテーションテスト

## テスト (`pnpm test`)

- ランナーは Vitest（`vitest.config.ts`、node 環境）。対象は `tests/desktop/**/*.test.ts`。
- `test` は `vitest` から、アサーションは `node:assert/strict` を使う。タイマーは `vi.useFakeTimers`、
  `console.error` の抑止などは `vi.spyOn` で行い、`afterEach` で元に戻す。
- CI（`.github/workflows/ci.yml` の Linux ジョブ）で毎回走る。

## ミューテーションテスト (`pnpm test:mutation`)

[@mizchi/mutator](https://www.npmjs.com/package/@mizchi/mutator) でコードを 1 か所ずつ書き換え（`>=` → `>`、
文字列 → `""`、呼び出しの削除など）、テストがそれを検出できるかを調べる。検出できなかった変異
（生き残り）は「テストが確かめていない振る舞い」の候補。Node 24 以上が要る。

```sh
pnpm test:mutation                       # 対象全体（初回は数分。結果は .mutator/ にキャッシュ）
pnpm test:mutation:diff                  # origin/main との差分にある変異だけ
pnpm test:mutation --include src/lib/genre.ts   # 1 ファイルだけ
pnpm test:mutation --reporter agent > .mutator/agent.json   # 生き残りの key・該当関数・カバーするテストを JSON で
pnpm exec mutator --only <key>           # 1 つの変異だけを再確認（数秒）
```

- 設定は `mutator.config.ts`。対象（`include`）は **tests/desktop にテストがある純粋ロジック**だけ。
  テストを足したモジュールはここにも足す。React コンポーネント・Tauri API の配線は対象外。
- `critical`（`src/lib/genre.ts`, `src/lib/relativeDate.ts`）は仕様の要点を守るモジュールで、生き残りが
  1 つでもあると exit 2 になる。
- `.mutator/` はキャッシュとレポートなので gitignore 済み。`mutator.accepted.json` はコミットする。
- CI の必須ゲートにはしていない。プロダクトコードを変えた PR では手元で `pnpm test:mutation:diff` を回す。

## 生き残りの扱い

1. **テストを足す**（基本）。`--reporter agent` の `gap` を見る:
   - `notReached`: どのテストも通らない → そのコードを通るケースを足す。
   - `notInfected`: 通るが、変異で値が変わる入力が無い → 境界値（`>=` なら等しい値）を足す。
   - `notDetected`: 値は変わるがアサーションが見ていない → 戻り値・状態・呼び出しを厳密に確かめる。
   テスト名は振る舞いを書く（変異の説明にしない）。実装の内部状態を覗くテストにしない。
2. **等価変異は理由付きで accept する**。どんな入力でも振る舞いが変わらない変異（例: 直後の
   `filter(Boolean)` で消える空文字列、`clearTimeout(null)`）は
   `pnpm exec mutator accept <key> --reason "equivalent: <なぜ観測できないか>"` で
   `mutator.accepted.json` に記録し、コードと同じようにレビューする。
   等価か自信が無いものは accept せず残す。
3. 変異で「仕様が曖昧」「バグっぽい」箇所が見つかったら、テストを合わせて直さず、まず仕様
   （`docs/ui-spec.md` など。CLAUDE.md 参照）を確認する。
4. 実行結果に出る `acceptance.killed`（accept したのに今は検出される）と `acceptance.stale`（変異が
   もう無い）は `mutator.accepted.json` から消す。

## 既知の生き残り（accept していないもの）

`src/lib/windowedList.ts` に 3 件。いずれも観測できる差が小さく、等価とは言い切れないので残している。

- `isMissing` の `!isFresh(page) && !inflight.has(page)` を `true` / `||` にする変異（2 件）:
  `request()` が新しい・取得中のページを除くので取得するページは変わらない。差は `schedule` が早期 return
  せずに `eager`（次の取得を待たずに始める）を消費するかどうかだけ。
- `cancelRetry` の `clearTimeout` を消す変異: 残った再試行タイマーは発火時に新しい・取得中のページを
  取らないので、差が出るのは `sync` のあと `schedule` を呼ばない間に発火したときだけ。
