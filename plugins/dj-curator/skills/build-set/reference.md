# Crateforge ローカル API リファレンス

ベース URL: `http://127.0.0.1:8787`（既定。`CRATEFORGE_API` で上書き可）。
すべて JSON。エラーは `4xx/5xx` + `{ "error": "..." }`。
呼び出しは `${CLAUDE_SKILL_DIR}/scripts/crate-api.sh <METHOD> <path> [json-body]` を使う。

レーティングは **0–100 スケール**（★1=20, ★3=60, ★4=80, ★5=100）。

## 読み取り

### `GET /api/health`
稼働確認。`{ "name": "crateforge", "version": "x.y.z", "trackCount": 1234 }`。

### `GET /api/tracks`
候補集めの主力。クエリ（すべて任意, camelCase）:
- `q` — フリーテキスト検索。テキスト6列(name/artist/album/albumArtist/genre/comments)の部分一致に加え、解析トークン `bpm:120-128` / `key:8A` / `energy:0.6-0.9` が使える。
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

## 使い分けメモ
- **候補集めはメタデータ主体**（`ratingMin`/`genre`/`yearFrom`/`q`）。解析は「あれば使う」程度に `analyzed=true` や `similar` で補助。
- **曲順は付けない**。並べ替え用エンドポイントは敢えて使わない（人間が GUI で詰める）。
- 既存プレイリストは触らず、常に**新規**を `POST /api/playlists` で作る。
