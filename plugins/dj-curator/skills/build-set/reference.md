# Crateforge ローカル API リファレンス

ベース URL: `http://127.0.0.1:8787`（既定。`CRATEFORGE_API` で上書き可）。
すべて JSON。エラーは `4xx/5xx` + `{ "error": "..." }`。
呼び出しは `${CLAUDE_SKILL_DIR}/scripts/crate-api.sh <METHOD> <path> [json-body]` を使う。
GET/DELETE では `<path>` の後ろに `key=value` を並べると `curl -G --data-urlencode` で安全にクエリ化される。
**非 ASCII（日本語・中国語など）・空白・`&`・`#` を含む検索は、必ずこの `key=value` 形式で渡すこと**（`?...` に直書きするとエンコードされず壊れる）。

レーティングは **0–100 スケール**（★1=20, ★3=60, ★4=80, ★5=100）。

## 認証・アクセス制御
- **ループバック（`127.0.0.1` / `::1`）からのリクエストはトークン不要で全エンドポイント利用可**。このスキルの既定（`http://127.0.0.1:8787`）はこれに当たる。
- ループバック**以外**から（アプリで LAN 公開を有効にしていて、WSL2 非ミラー構成で `CRATEFORGE_API=http://<ホストIP>:8787` を使う場合など）は:
  - トークン必須: クエリ `token=<トークン>` またはヘッダ `X-API-Token: <トークン>`。無い/無効なら `401`（アプリ側にトークンが 1 つも無ければ `403`）。
  - 書き込みは大きく制限される。許可されるのは `GET` 全般・`POST /api/tracks/lookup`・`POST /api/analysis/lookup`・`/api/remote/*`・`POST /api/tracks/{id}/rating`・`POST /api/tracks/tags/{add,remove}`・`PUT`/`DELETE /api/tracks/{id}/artwork` のみ。**プレイリスト作成/編集・`PATCH /api/tracks*`・genre-tags は `403`**（ペアリングで sync 役割を与えられたデバイスのトークンを除く）。
  - この `401`/`403` は認証ミドルウェアが返すため `{ "error": ... }` ボディは付かない。
  - `crate-api.sh` はトークンを付与しない（GET なら `token=...` を `key=value` で渡せるが、書き込みは上記制限で通らない）。プレイリスト作成まで行うならループバックで届く構成にする。

## 読み取り

### `GET /api/health`
稼働確認。`{ "name": "crateforge", "serverId": "...", "version": "x.y.z", "trackCount": 1234 }`。`name` はアプリで設定したサーバー名（未設定なら `"crateforge"`）。

### `GET /api/tracks`
候補集めの主力。クエリ（すべて任意, camelCase）:
- `q` — 検索クエリ（下記「`q` の検索構文」）。日本語・中国語など非 ASCII や空白を含む値は **`key=value` 形式**（`crate-api.sh GET /api/tracks q="..."`）で渡す（自動 URL エンコード）。
- `ratingMin` / `ratingMax` — 0–100。例: ★3 以上は `ratingMin=60`。rating 未設定の曲は 0 扱い。
- `genre` — ジャンル部分一致（大小無視）。
- `album` — アルバム名部分一致（大小無視）。
- `artist` — 表示アーティスト名（`artist`、空なら `albumArtist`、どちらも無ければ `"Unknown Artist"`）と**完全一致**。`GET /api/artists` の `artist` 値をそのまま渡せる。
- `albumArtist` — 表示アルバムアーティスト名（`albumArtist`、空なら `artist`、どちらも無ければ `"Unknown Artist"`）と**完全一致**。`GET /api/artists?grouping=albumArtist` の値と対応。
- `yearFrom` / `yearTo` — 年代範囲（指定時、year 未設定の曲は除外）。
- `analyzed` — `true`=解析済みのみ / `false`=未解析のみ。
- `limit` / `offset` — ページング（既定: 上限なし＝全件）。
- `sort` / `order` — 並び替え。`sort` に使えるのは `name` `artist` `albumArtist` `album` `genre` `year` `rating` `playCount` `bpm` `trackNumber` `totalTimeMs` `dateAdded` `lastPlayed` `bitrate` `sampleRate` `bitDepth` `channels` `fileSize` `codec`。`order=desc` 以外は昇順。未指定/不明な `sort` は曲名昇順。

**注意（件数の上限）**: `q` を指定し、**かつ上記の構造化フィルタ（`ratingMin`/`ratingMax`/`genre`/`album`/`artist`/`albumArtist`/`yearFrom`/`yearTo`/`analyzed`）を 1 つも付けない**場合は、DB 側で `limit`/`offset` を適用し**最大 1000 件で打ち切る**（`limit` を 1000 超にしても 1000）。それ以上欲しいときは `offset` でページングする。構造化フィルタを 1 つでも付けた場合や `q` 無しの場合はこの上限は無い。

#### `q` の検索構文
- 空白区切りのトークンは **AND**。値に空白を含めたいときは二重引用符で囲む（`artist:"daft punk"`）。
- フィールド指定の無いトークンは、テキスト 6 列（name / artist / album / albumArtist / genre / comments）のいずれかへの部分一致（OR）。
- フィールド指定トークン（解釈できない値はフリーテキスト扱いに落ちる）:
  - `artist:` `album:` `albumartist:`（`album_artist:` も可）`genre:` `comment:` — その列の部分一致。
  - `year:2015` / `year:2010-2019` — 年（範囲は両端含む）。
  - `rating:` — **★（0〜5、0.5 刻み）で指定**（0–100 ではない）。`rating:4`（rating 80〜99）、`rating:3.5-5`、`rating:>=3`、`rating:<2`、`rating:0`（rating 0〜19。未評価も含む）。
  - `bpm:120-128` / `bpm:124`（単一値は ±2）。解析 BPM があればそれを、無ければ曲の BPM タグを見る。
  - `key:8A` — 実効キー（手動上書き ?? 解析値）の一致。Camelot（`8A`）/ Open Key（`1m`）/ 通常表記（`Am`, `F#m`, `Db`）のいずれでも可。`key:compat:8A` で 8A とハーモニック互換なキー（同キー・平行調・ホイール ±1）をまとめて指定。
  - `energy:0.6-0.9` / `energy:0.7`（単一値は ±0.05）。1 より大きい値はパーセントとみなす（`energy:60-90` = 0.6〜0.9）。解析済みの曲のみ該当。
  - `analyzed:yes` / `analyzed:no`。
  - `tag:bridge`（first-class Tag の value 完全一致、namespace 問わず）/ `tag:mood:dreamy`（namespace + value 完全一致）。大文字小文字は区別しない。

例:
```
crate-api.sh GET "/api/tracks?genre=House&ratingMin=60&yearFrom=2015&limit=300"
# 空白を含む q も key=value 形式で（"?q=a b" と直書きすると URL が壊れる）:
crate-api.sh GET /api/tracks q="energy:0.6-0.9 bpm:120-126" limit=200
# 非 ASCII・空白・特殊文字は key=value 形式で渡す（自動 URL エンコード）:
crate-api.sh GET /api/tracks q=有你的世界 genre=House limit=200
crate-api.sh GET /api/tracks q="key:compat:8A rating:>=3" limit=200
```
返り値: `Track[]`。`Track` の主なフィールド: `trackId, persistentId, name, artist, albumArtist, composer, album, genre, year, rating(0-100), playCount, bpm, comments, totalTimeMs, dateAdded, lastPlayed, keyCamelotUser, locationPath, fileExists` ほか（`bitrateKbps` `sampleRateHz` `codec` などの技術メタデータも含む）。

### `GET /api/tracks/{trackId}`
1 曲取得。無ければ 404。

### `POST /api/tracks/by-ids`
ボディ `{ "trackIds": [i64,...] }` → `Track[]`（入力順を保持。存在しない ID は黙ってスキップ）。

### `POST /api/tracks/lookup`
ボディ `{ "persistentIds": [String,...] }` → `Track[]`（`Track.persistentId` で解決。入力順を保持、見つからないものはスキップ）。DB を変更しない読み取り API。

### `GET /api/tracks/{trackId}/analysis`
`TrackAnalysis | null`（未解析は `null`, 200）。
`{ trackId, version, analyzedAt, bpm, keyCamelot("8A"), keyName("A minor"), energy(0..1), loudnessLufs, replaygainDb, vector, peaks }`。
`keyCamelot` / `keyName` は**実効キー**（ユーザーの手動上書き `keyCamelotUser` があればそれ、無ければ解析値）。`vector`（類似度用特徴量）と `peaks`（波形）は選曲には通常不要。

### `POST /api/analysis/lookup`
ボディ `{ "persistentIds": [String,...], "includePeaks"?: bool }` → 解析済みの曲だけを入力順で返す配列（未解析・不明な ID はスキップ）
`{ persistentId, trackId, version, analyzedAt, bpm, keyCamelot, keyName, energy, loudnessLufs, replaygainDb, vector, peaks? }[]`（`peaks` は `includePeaks=true` のときのみ）。
複数曲の解析値を 1 リクエストでまとめて取れる（`persistentId` は `Track.persistentId`）。DB を変更しない読み取り API。
注意: こちらの `keyCamelot` / `keyName` は**解析値そのまま**（手動上書きは反映されない。実効キーが要るなら `GET /api/tracks/{id}/analysis` か `Track.keyCamelotUser` を併用）。

### `GET /api/tracks/{trackId}/similar`
クエリ: `limit`(既定25), `bpmTol`（基準 BPM に対する**割合**の許容差）, `keyCompatible`(bool, 既定 false。Camelot 互換キーのみ), `energyTol`（0..1 の絶対差）。
基準曲が未解析なら `[]`。返り値: `{ "track": Track, "distance": f64 }[]`（distance 昇順 = 近い順）。

### `GET /api/tracks/{trackId}/tags`
その曲に付いている first-class Tag（後述）→ `{ id, namespace, value }[]`（namespace, value 昇順。`namespace` が空文字なら free tag）。

### `GET /api/stats`
`{ "trackCount", "playlistCount", "totalTimeMs" }`。

### `GET /api/genres`
`{ "tag": "House", "count": 42 }[]`（ジャンルタグの頻度）。

### `GET /api/tags`
first-class Tag（Genre とは独立した、DB のみのタグ。`mood:dreamy` のような `namespace:value` か、`bridge` のような free tag）の一覧。
→ `{ id, namespace, value, count }[]`（付与曲数の多い順。**どの曲にも付いていない tag も `count: 0` で含む**）。`q=tag:...` で絞り込みに使える。

### `GET /api/albums`
distinct なアルバム一覧 → `{ album, albumArtist, trackCount, sampleTrackId }[]`（アルバム名昇順・大小無視。album が空の曲は除外。同名アルバムは 1 件にまとまる）。

### `GET /api/artists`
クエリ: `grouping` = `artist`（既定）| `albumArtist`。distinct な表示アーティスト一覧 → `{ artist, trackCount, sampleTrackId }[]`（表示名昇順・大小無視）。
`artist` は表示名（`grouping=artist` なら artist→albumArtist→`"Unknown Artist"` の順でフォールバック、`albumArtist` なら逆順）。この値を `GET /api/tracks` の `artist` / `albumArtist` クエリにそのまま渡すと完全一致で引ける。
アーティスト軸で母集団を作るとき（名前の表記ゆれ確認・曲数の把握）に使う。

### `GET /api/playlists`
`Playlist[]`。`{ playlistId, persistentId, name, isFolder, isSmart, isUserCreated, parentPersistentId, trackCount }`。
**インポートした iTunes のプレイリストも含む全件**。`parentPersistentId` でフォルダ階層が辿れる。

### `GET /api/playlists/{playlistId}`
プレイリスト単体のメタ + スマート条件。無ければ 404。
返り値: `Playlist` の各フィールド + `smartCriteria`（`SmartCriteria | null`）。
`smartCriteria` は **アプリのルール機能で設定された場合のみ非 null**（iTunes インポート由来のスマートプレイリストや手動プレイリストは `null`。`isSmart=true` でも条件本体が無いことはある）。
構造: `{ matchAll: bool, rules: [{ field, op, value }], limit, sortBy, sortDesc }`。「かっちりルールで自動生成 vs 手選び」の判定材料。

### `GET /api/playlists/{playlistId}/tracks`
クエリ: `limit`(既定500), `offset`, `sort`, `order`。返り値: `Track[]`。
**`sort` 未指定なら登録順（＝キュレーション順）**で返る。プレイリスト内の曲の並び＝セットの流れをそのまま分析に使える。
注意: プレイリストへの**追加日時は保持していない**（「少しずつ足した vs 一気に作った」の時系列は復元不可）。

## 書き込み（プレイリスト）

**改変してよい範囲**: 既存プレイリストは改変しないのが原則。`POST .../tracks`・`PUT .../tracks`・`PATCH`（改名）・`DELETE .../tracks/{trackId}` を使ってよいのは、**このスキルで自分が新規作成したプレイリスト**か、**ユーザーが明示的に対象を指示したプレイリスト**に限る。

### `POST /api/playlists`
ボディ `{ "name": String, "parentPersistentId"?: String, "isFolder"?: bool, "persistentId"?: String }`。
→ `201` + 作成された `Playlist`（`playlistId` を後続で使う）。
- `parentPersistentId` に既存フォルダの `persistentId` を渡すとその配下に作る。
- `persistentId`（任意）は 16 桁の大文字 16 進数。指定した PID のプレイリストが既に在れば**作らずに `200` + 既存の `Playlist`** を返す（冪等作成）。形式不正は `400`。通常は省略してよい。

### `POST /api/playlists/{playlistId}/tracks`
ボディ `{ "trackIds": [i64,...] }` → `{ "added": n }`（`n` = 送った件数）。
既存の末尾に入力順で追記する。**重複チェック・存在チェックはしない**（同じ曲を 2 回送ると 2 回入る）ので、送る前に `trackIds` を重複排除しておく。

### `PUT /api/playlists/{playlistId}/tracks`
ボディ `{ "trackIds": [i64,...] }` → 所属曲を**入力順どおりに全置換** → `204`。
- プレイリストが無ければ `404`。存在しない `trackId` が 1 件でもあれば `400`（`track not found: <id>`）で、その場合**既存の所属・順序は変更されない**（トランザクションでロールバック）。
- 重複排除はしない（入力に同じ ID が 2 回あれば 2 回入る）。
- 用途: 自分が作った叩き台の中身を差し替える（候補の入れ替えをまとめて反映する）とき。入力順がそのまま並びになるが、**曲順付けの目的では使わない**（曲順は人間が GUI で詰める方針）。既存の並びを保ちたいなら `POST .../tracks`（追記）と `DELETE .../tracks/{trackId}`（1 曲外す）を使う。
```
crate-api.sh PUT /api/playlists/45/tracks '{"trackIds":[12,7,30]}'
```

### `PATCH /api/playlists/{playlistId}`
ボディ `{ "name"?: String }` → プレイリスト名を変更 → `204`。プレイリストが無ければ `404`。`name` 省略時は何も変えずに `204`。名前のバリデーションは無い。
（命名規則はスキルでは固定しない。ワークスペースの rules に従う）
```
crate-api.sh PATCH /api/playlists/45 '{"name":"夏の夕暮れ chill house v2 (叩き台)"}'
```

### `DELETE /api/playlists/{playlistId}/tracks/{trackId}`
1 曲外す → `204`。同じ曲が複数回入っていれば先頭側の 1 件だけ外し、後ろを詰める。入っていない曲を指定しても `204`（何もしない）。

### `DELETE /api/playlists/{playlistId}`
プレイリスト（またはフォルダ）を削除 → `204`。無ければ `404`。フォルダを消した場合、配下のプレイリストは削除されずルート直下に移る。
**破壊的操作。スキルでは原則使わない**（ユーザーが対象を明示して削除を指示した場合のみ）。

## 曲メタデータ書き込み

DB を更新したうえで、**実ファイルの ID3 / Vorbis / MP4 タグにも書き戻す**（rekordbox など他アプリにも反映される）。PATCH では、Crateforge 側で整理先フォルダ（自動整理）が設定されていれば GUI の編集と同じくフォルダ移動 + リネームも行う（未設定ならその場でタグだけ更新）。書き込み後は GUI に即時反映（`library-changed`）。
ファイル書き込みは **ベストエフォート**: `locationPath` が無い / ファイルが存在しない場合はスキップ（失敗扱いではない）。実際に書き込みを試みて失敗した件数を `fileWriteFailed` で返す（DB 更新自体は成功している）。

実ファイルまで書き換わる（自動整理が有効ならファイル移動も起きる）ので、**ユーザーの指示かワークスペース方針がある場合に使う**。選曲の過程で「印を付けておきたい」だけなら、ファイルに触れない first-class Tag（後述）や rating 専用エンドポイントの方が影響が小さい。

ジャンルは**空白区切りのタグ集合**として扱う。「末尾にタグを 1 個足す/外す」は genre-tags、「genre 文字列をまるごと置換」「rating 等の他フィールド更新」は PATCH を使う。

### `POST /api/tracks/genre-tags/add`
ボディ `{ "trackIds": [i64,...], "tag": String }` → 各曲の genre 末尾に `tag` を追記（重複は付かない）。
→ `{ "updated": n, "fileWriteFailed": m }`。`tag` が空白のみなら `400`。
`updated` は DB 更新がエラーにならなかった件数で、**存在しない `trackId` も数えられる**（0 行更新でもエラーにならないため）。
```
crate-api.sh POST /api/tracks/genre-tags/add '{"trackIds":[12,7],"tag":"台語"}'
```

### `POST /api/tracks/genre-tags/remove`
ボディ `{ "trackIds": [i64,...], "tag": String }` → 各曲の genre から `tag` を除去（add と対称。比較は ASCII の大文字小文字を区別しない）。
→ `{ "updated": n, "fileWriteFailed": m }`。`tag` が空白のみなら `400`。

### `PATCH /api/tracks/{trackId}`
ボディ = 更新したいフィールドだけ（camelCase, **部分更新**＝未指定は据え置き）。
- 文字列: `name` / `artist` / `albumArtist` / `composer` / `album` / `genre` / `comments`（`""` で空にする）。
- 数値: `year` / `bpm` / `trackNumber` / `trackCount` / `discNumber` / `discCount` / `playCount` / `skipCount`（`null` で値をクリア）。`rating`(0-100)。
- 真偽: `compilation` / `disabled`。
- `keyCamelotUser` — Key の手動上書き（Camelot 表記, 例 `"8A"`）。`null` で解除（解析値に戻る）。
- ファイルタグへ書き戻すのは、更新後の 曲名・artist・albumArtist・composer・album・genre・comments・year・トラック/ディスク番号と総数・compilation・BPM（曲の BPM、未設定なら解析 BPM）・Key（実効キーを `Am` 等の音楽表記で）。**`rating` / `disabled` / `playCount` / `skipCount` はファイルには書かれない**（DB のみ）。
→ `{ "track": Track, "fileWriteFailed": bool, "relocateFailed": bool }`（更新後の全フィールド。移動した場合 `locationPath` は新パス）。存在しない id は `404`。
```
# genre をまるごと置換 + ★5 を付ける
crate-api.sh PATCH /api/tracks/12 '{"genre":"Disco Funk","rating":100}'
```

### `PATCH /api/tracks`（一括）
ボディ `{ "trackIds": [i64,...], "edit": { ...PATCH /api/tracks/{id} と同じフィールド } }` → 各曲に同じ編集を適用（処理内容は単体 PATCH と同一）。
→ `{ "updated": n, "fileWriteFailed": [trackId,...], "relocateFailed": [trackId,...], "notFound": [trackId,...] }`。
```
crate-api.sh PATCH /api/tracks '{"trackIds":[12,7,30],"edit":{"rating":80}}'
```

### `POST /api/tracks/{trackId}/rating`
ボディ `{ "rating": i64 }`（0–100。範囲外はクランプ）→ `204`。**rating だけを DB に書く最小権限の書き込み**（ファイルタグ・整理には触れない）。

## first-class Tag（DB のみ・ファイルに触れない）

Genre とは独立したタグ。`namespace:value`（例 `mood:dreamy`。最初の `:` で分割）か、`:` 無しの free tag（例 `bridge`）。**DB のみで実ファイルには書き戻さない**。`GET /api/tags` で一覧、`GET /api/tracks/{id}/tags` で曲ごと、`q=tag:...` で検索できる。

### `POST /api/tracks/tags/add`
ボディ `{ "trackIds": [i64,...], "tag": String }` → `{ "updated": n }`（新たに付与された件数。既に付いていた曲は数えない）。`tag` が空白のみなら `400`。
```
crate-api.sh POST /api/tracks/tags/add '{"trackIds":[12,7],"tag":"mood:dreamy"}'
```

### `POST /api/tracks/tags/remove`
ボディ `{ "trackIds": [i64,...], "tag": String }` → `{ "updated": n }`（実際に外れた件数）。タグ自体（`GET /api/tags` の行）は `count: 0` で残る。`tag` が空白のみなら `400`。

## 使い分けメモ
- **候補集めはメタデータ主体**（`ratingMin`/`genre`/`yearFrom`/`q`）。解析は「あれば使う」程度に `analyzed=true` や `similar` で補助。
- **アーティスト軸**で集めるなら `GET /api/artists` で表示名を確認 → `GET /api/tracks?artist=<表示名>`（完全一致）。部分一致でよければ `q=artist:<語>`。
- **曲順は付けない**。並べ替え用エンドポイントは敢えて使わない（人間が GUI で詰める）。`PUT .../tracks` も曲順付けには使わない。
- 既存プレイリストは触らず、常に**新規**を `POST /api/playlists` で作る。
- 作った叩き台の手直し（候補の差し替え・改名）は、**このスキルで自分が作ったプレイリストに限り** `POST`/`DELETE .../tracks`・`PUT .../tracks`・`PATCH /api/playlists/{id}` で行ってよい。ユーザーが明示的に対象を指示した場合はそのプレイリストも可。
- `DELETE /api/playlists/{id}` は使わない（ユーザーが明示指示した場合のみ）。
- **既存プレイリストは"お手本"として読む**：`GET /api/playlists` → 関連プレイリストを選び、`GET /api/playlists/{id}/tracks`（キュレーション順）と `GET /api/playlists/{id}`（`smartCriteria`）で**選曲傾向**（ジャンルの混ぜ方・年代/レート分布・1セットの曲数・解析があれば BPM/Key/Energy の並びの締まり具合・smart か手選びか）を読み取り、新規セットの方向付けに使う。読み取り専用で、既存は改変しない。

## スキル用途外のエンドポイント
実装には存在するが選曲には使わないもの（一覧のみ）。
- `GET /` — Web プレイヤー（HTML）。
- `GET /manifest.webmanifest` `/icon-512.png` `/icon-192.png` `/apple-touch-icon.png` `/favicon.ico` — PWA 資産（トークン不要）。
- `POST /api/pair/start` / `GET /api/pair/poll` — モバイル等のペアリング（トークン不要）。
- `GET /api/remote/queue` / `GET /api/remote/state` — 再生キュー・再生状態の取得。
- `POST /api/remote/{play,pause,resume,stop,next,prev,seek,set-queue,volume,shuffle,repeat}` — アプリ本体の再生リモート操作。
- `GET /api/tracks/{trackId}/stream` — 音源ストリーミング（トランスコード対応）。
- `GET /api/tracks/{trackId}/artwork` — アートワーク配信（`size` / `format` でリサイズ）。
- `PUT` / `DELETE /api/tracks/{trackId}/artwork` — 埋め込みアートワークの設定/削除（実ファイルを書き換える）。
- `POST /api/tracks/upload` / `PUT /api/tracks/upload/{uploadId}` — サーバー間同期用の音源アップロード。
- `POST /api/analysis` — サーバー間同期用の解析結果アップロード（条件付き upsert）。
- `GET /api/playlists/{playlistId}/size-estimate` — 転送前のプレイリスト容量見積もり（`{ trackCount, totalBytes, missingFiles }`）。
