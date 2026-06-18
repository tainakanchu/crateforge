# Crateforge ローカル API リファレンス

ベース URL: `http://127.0.0.1:8787`（既定。`CRATEFORGE_API` で上書き可）。
すべて JSON。エラーは `4xx/5xx` + `{ "error": "..." }`。
呼び出しは `${CLAUDE_SKILL_DIR}/scripts/crate-api.sh <METHOD> <path> [json-body]` を使う。
GET/DELETE では `<path>` の後ろに `key=value` を並べると `curl -G --data-urlencode` で安全にクエリ化される。
**非 ASCII（日本語・中国語など）・空白・`&`・`#` を含む検索は、必ずこの `key=value` 形式で渡すこと**（`?...` に直書きするとエンコードされず壊れる）。

レーティングは **0–100 スケール**（★1=20, ★3=60, ★4=80, ★5=100）。

## 読み取り

### `GET /api/health`
稼働確認。`{ "name": "crateforge", "version": "x.y.z", "trackCount": 1234 }`。

### `GET /api/tracks`
候補集めの主力。クエリ（すべて任意, camelCase）:
- `q` — フリーテキスト検索。テキスト6列(name/artist/album/albumArtist/genre/comments)の部分一致に加え、解析トークン `bpm:120-128` / `key:8A` / `energy:0.6-0.9` が使える。日本語・中国語など非 ASCII や空白を含む値は **`key=value` 形式**（`crate-api.sh GET /api/tracks q="..."`）で渡す（自動 URL エンコード）。
- `ratingMin` / `ratingMax` — 0–100。例: ★3 以上は `ratingMin=60`。
- `genre` — ジャンル部分一致（大小無視）。
- `yearFrom` / `yearTo` — 年代範囲。
- `analyzed` — `true`=解析済みのみ / `false`=未解析のみ。
- `limit` / `offset` — ページング。
- `sort` / `order` — 並び替え（DB に委譲。例 `sort=rating&order=desc`）。

例:
```
crate-api.sh GET "/api/tracks?genre=House&ratingMin=60&yearFrom=2015&limit=300"
crate-api.sh GET "/api/tracks?q=energy:0.6-0.9 bpm:120-126&limit=200"
# 非 ASCII・空白・特殊文字は key=value 形式で渡す（自動 URL エンコード）:
crate-api.sh GET /api/tracks q=有你的世界 genre=House limit=200
```
返り値: `Track[]`。`Track` の主なフィールド: `trackId, name, artist, albumArtist, album, genre, year, rating(0-100), bpm, totalTimeMs, locationPath, fileExists` ほか。

### `GET /api/tracks/{trackId}`
1 曲取得。無ければ 404。

### `POST /api/tracks/by-ids`
ボディ `{ "trackIds": [i64,...] }` → `Track[]`（入力順を保持）。

### `GET /api/tracks/{trackId}/analysis`
`TrackAnalysis | null`（未解析は `null`, 200）。
`{ trackId, bpm, keyCamelot("8A"), keyName, energy(0..1), loudnessLufs, replaygainDb, ... }`。

### `GET /api/tracks/{trackId}/similar`
クエリ: `limit`(既定25), `bpmTol`, `keyCompatible`(bool), `energyTol`。
基準曲が未解析なら `[]`。返り値: `{ "track": Track, "distance": f64 }[]`（distance 昇順 = 近い順）。

### `GET /api/stats`
`{ "trackCount", "playlistCount", "totalTimeMs" }`。

### `GET /api/genres`
`{ "tag": "House", "count": 42 }[]`（ジャンルタグの頻度）。

### `GET /api/playlists`
`Playlist[]`。`{ playlistId, name, isFolder, isSmart, isUserCreated, trackCount }`。

### `GET /api/playlists/{playlistId}/tracks`
クエリ: `limit`(既定500), `offset`, `sort`, `order`。返り値: `Track[]`。

## 書き込み

### `POST /api/playlists`
ボディ `{ "name": String, "parentPersistentId"?: String, "isFolder"?: bool }`。
→ `201` + 作成された `Playlist`（`playlistId` を後続で使う）。

### `POST /api/playlists/{playlistId}/tracks`
ボディ `{ "trackIds": [i64,...] }` → `{ "added": n }`。

### `DELETE /api/playlists/{playlistId}/tracks/{trackId}`
1 曲外す → `204`。

## 曲メタデータ書き込み

DB を更新したうえで、**実ファイルの ID3 / Vorbis / MP4 タグにも書き戻す**（フォルダ整理＝移動はせず、その場でタグだけ更新。rekordbox など他アプリにも反映される）。書き込み後は GUI に即時反映（`library-changed`）。
ファイル書き込みは **ベストエフォート**: `locationPath` が無い / ファイルが存在しない場合はスキップ（失敗扱いではない）。実際に書き込みを試みて失敗した件数を `fileWriteFailed` で返す（DB 更新自体は成功している）。

ジャンルは**空白区切りのタグ集合**として扱う。「末尾にタグを 1 個足す/外す」は genre-tags、「genre 文字列をまるごと置換」「rating 等の他フィールド更新」は PATCH を使う。

### `POST /api/tracks/genre-tags/add`
ボディ `{ "trackIds": [i64,...], "tag": String }` → 各曲の genre 末尾に `tag` を追記（重複は付かない）。
→ `{ "updated": n, "fileWriteFailed": m }`。`tag` が空白のみなら `400`。
```
crate-api.sh POST /api/tracks/genre-tags/add '{"trackIds":[12,7],"tag":"台語"}'
```

### `POST /api/tracks/genre-tags/remove`
ボディ `{ "trackIds": [i64,...], "tag": String }` → 各曲の genre から `tag` を除去（add と対称）。
→ `{ "updated": n, "fileWriteFailed": m }`。`tag` が空白のみなら `400`。

### `PATCH /api/tracks/{trackId}`
ボディ = 更新したいフィールドだけ（camelCase, **部分更新**＝未指定は据え置き）。
`name` / `artist` / `albumArtist` / `album` / `genre` / `year` / `bpm` / `rating`(0-100) / `trackNumber` / `discNumber` / `compilation` など。
→ `{ "track": Track, "fileWriteFailed": bool }`（更新後の全フィールド）。存在しない id は `404`。
```
# genre をまるごと置換 + ★5 を付ける
crate-api.sh PATCH /api/tracks/12 '{"genre":"Disco Funk","rating":100}'
```

## 使い分けメモ
- **候補集めはメタデータ主体**（`ratingMin`/`genre`/`yearFrom`/`q`）。解析は「あれば使う」程度に `analyzed=true` や `similar` で補助。
- **曲順は付けない**。並べ替え用エンドポイントは敢えて使わない（人間が GUI で詰める）。
- 既存プレイリストは触らず、常に**新規**を `POST /api/playlists` で作る。
