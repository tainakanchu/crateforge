# ジャンル 設計メモ

- 位置づけ: ジャンルの **データモデル・編集・検索** の仕様。`docs/ui-spec.md`・ユーザーガイド・
  `plugins/dj-curator/skills/build-set/reference.md` はこのメモと矛盾してはならない。
- 経緯: v0.18.0 で区切りを `; , /` のみに変えて仕様と食い違い、v0.19.1 で空白区切りに戻した。
  そのとき「複数語のジャンルは空白なしで書く」規約がユーザーガイドにしか書かれず、
  仕様書と API リファレンスから抜けていた。検索 (`genre:` / `?genre=`) は文字列項目共通の
  部分一致 (`text_like_clause`) を流用しており、タグ集合のモデルと噛み合っていなかった。

## 1. データモデル

- ジャンルは **空白区切りのタグ集合**。`;` `,` も区切りとして受け付ける。`/` は区切らない
  (`R&B/Soul` は 1 タグ)。
- **複数語のジャンルは空白を入れずに書く** (`DeepHouse`, `TechHouse`, `DrumAndBass`)。
  `Deep House` と書くと `Deep` と `House` の 2 タグになる。
- 1 タグは分解できない 1 つのジャンル名。`DeepHouse` は `House` の修飾ではなく別ジャンル。
  名前の文字列としての重なり (`House` ⊂ `DeepHouse`) はジャンルの関係を表さない。
- 親ジャンルのタグを併記する運用 (`DeepHouse House`) は前提にしない。
- 保存はタグを半角空白 1 つでつないだ文字列。

実装: Rust `split_genre_tags` (`src-tauri/src/db/tracks.rs`)、TS `splitGenre` / `joinGenre`
(`src/lib/genre.ts`)。挙動は `tests/desktop/genre.test.ts` と Rust 側テストで固定する。

## 2. 編集

- GUI のタグ追加/削除 (右クリック → Genre tags)、Get Info の Genre、API の
  `POST /api/tracks/genre-tags/{add,remove}` と `PATCH /api/tracks*` は **いずれも DB と
  実ファイルのタグの両方を更新する**。経路によって書き戻しの有無を変えない。
- ファイル書き込みはベストエフォート (ファイルが無ければスキップ、失敗は件数で返す)。

## 3. 検索

| 書き方 | 意味 |
|---|---|
| `genre:House` (検索構文) / `?genre=House` (API) | その曲が `House` タグを **持つ** (タグ単位の完全一致)。`DeepHouse` だけの曲は一致しない |
| `house` (フィールド指定なし) | 従来どおり name / artist / album / albumArtist / genre / comments への部分一致 |

- 大文字小文字・全角半角などの揺れは、他の検索と同じ fold レベルで無視する。
- 値に空白を含めた場合 (`genre:"Deep House"`) は、値も同じ規則でタグに分け、
  **すべてのタグを持つ** 曲に一致させる (`genre:"House Techno"` = House かつ Techno)。
- `/` を含むタグ (`Electronic/Dance`) は 1 タグなので、`genre:Electronic` では一致しない。
- 判定は SQL の `LIKE` 近似ではなく、`split_genre_tags` と fold を使う 1 つの関数
  (SQLite 関数として登録) に寄せ、区切り規則の実装を 1 か所に保つ。

### 今回入れないもの (必要になったら追加)

- ワイルドカード (`genre:*House`)、ジャンル限定の部分一致 (`genre~house`)、
  同一フィールド内 OR (`genre:House,DeepHouse`)。
- ジャンルの系統 (親子) 定義。

### 対象外 (変えない)

- スマートプレイリストの `Is` / `Contains` 等: iTunes 互換の判定で、genre 文字列全体に対して行う。
- YAML ルールの `field: genre` + `equals` / `contains`: genre 文字列全体に対して行う。
  タグ単位で判定したくなったら別の演算子 (例 `hasTag`) を追加する。
