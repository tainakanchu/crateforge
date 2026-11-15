import { test } from "node:test";
import assert from "node:assert/strict";
import {
  addTracksToPlaylist,
  addedToPlaylistMessage,
  enqueueTracks,
  playNextTracks,
  playQueueFrom,
  playTracks,
  playableIds,
  runTrackAction,
  setRatingForTracks,
  trackActionFailureMessage,
} from "../../src/lib/trackActions.ts";

/** 呼び出しを記録するフェイク API。enqueueTrackNext は実装と同じく「現在曲の直後」へ挿入する。 */
function fakeApi(opts: { failOn?: string } = {}) {
  const calls: string[] = [];
  const queue: number[] = [0]; // 0 = 再生中の曲
  const rec = (name: string, ...args: unknown[]) => {
    calls.push(`${name}(${args.map((a) => JSON.stringify(a)).join(",")})`);
    if (opts.failOn === calls[calls.length - 1]) throw new Error(`failed: ${name}`);
  };
  return {
    calls,
    queue,
    ensureNormalPlay: async () => rec("ensureNormalPlay"),
    setQueue: async (ids: number[], start: number) => rec("setQueue", ids, start),
    playTrack: async (id: number) => rec("playTrack", id),
    enqueueTrack: async (id: number) => {
      rec("enqueueTrack", id);
      queue.push(id);
    },
    enqueueTrackNext: async (id: number) => {
      rec("enqueueTrackNext", id);
      queue.splice(1, 0, id);
    },
    setTrackRating: async (id: number, rating: number) => rec("setTrackRating", id, rating),
    addTracksToPlaylist: async (playlistId: number, ids: number[]) => {
      rec("addTracksToPlaylist", playlistId, ids);
      return ids.length - 1; // 重複ぶんは追加されない想定
    },
  };
}

const t = (trackId: number, fileExists = true) => ({ trackId, fileExists });

test("playableIds: ファイルの無い曲を除き、並び順を保つ", () => {
  assert.deepEqual(playableIds([t(3), t(1, false), t(2)]), [3, 2]);
});

test("playTracks: 試聴を抜けてからキューを張り、先頭を再生する", async () => {
  const api = fakeApi();
  assert.equal(await playTracks(api, [t(1), t(2, false), t(3)]), true);
  assert.deepEqual(api.calls, ["ensureNormalPlay()", "setQueue([1,3],0)", "playTrack(1)"]);
});

test("playTracks: startId の曲から再生する (キュー上の位置で指定)", async () => {
  const api = fakeApi();
  await playTracks(api, [t(1), t(2, false), t(3)], 3);
  assert.deepEqual(api.calls, ["ensureNormalPlay()", "setQueue([1,3],1)", "playTrack(3)"]);
});

test("playTracks: startId が再生できない曲なら先頭から", async () => {
  const api = fakeApi();
  await playTracks(api, [t(1), t(2, false), t(3)], 2);
  assert.deepEqual(api.calls.slice(1), ["setQueue([1,3],0)", "playTrack(1)"]);
});

test("playTracks: 再生できる曲が無ければ何も呼ばず false", async () => {
  const api = fakeApi();
  assert.equal(await playTracks(api, [t(1, false)]), false);
  assert.equal(await playTracks(api, []), false);
  assert.deepEqual(api.calls, []);
});

test("playQueueFrom: playId を渡すとキュー位置とは別にその曲を再生する", async () => {
  const api = fakeApi();
  await playQueueFrom(api, [1, 3], 0, 2);
  assert.deepEqual(api.calls, ["ensureNormalPlay()", "setQueue([1,3],0)", "playTrack(2)"]);
});

test("playTracks: 失敗はそのまま throw し、後続を呼ばない", async () => {
  const api = fakeApi({ failOn: "setQueue([1],0)" });
  await assert.rejects(playTracks(api, [t(1)]), /failed: setQueue/);
  assert.deepEqual(api.calls, ["ensureNormalPlay()", "setQueue([1],0)"]);
});

test("enqueueTracks: 順に末尾へ追加する", async () => {
  const api = fakeApi();
  await enqueueTracks(api, [1, 2, 3]);
  assert.deepEqual(api.queue, [0, 1, 2, 3]);
});

test("playNextTracks: 反転して挿入し、現在曲の直後に選択順で並ぶ", async () => {
  const api = fakeApi();
  await playNextTracks(api, [1, 2, 3]);
  assert.deepEqual(api.calls, [
    "enqueueTrackNext(3)",
    "enqueueTrackNext(2)",
    "enqueueTrackNext(1)",
  ]);
  assert.deepEqual(api.queue, [0, 1, 2, 3]);
});

test("playNextTracks: 渡した配列を書き換えない", async () => {
  const ids = [1, 2, 3];
  await playNextTracks(fakeApi(), ids);
  assert.deepEqual(ids, [1, 2, 3]);
});

test("setRatingForTracks: 全曲に同じ値を付け、失敗したらそこで止まる", async () => {
  const ok = fakeApi();
  await setRatingForTracks(ok, [1, 2], 80);
  assert.deepEqual(ok.calls, ["setTrackRating(1,80)", "setTrackRating(2,80)"]);

  const ng = fakeApi({ failOn: "setTrackRating(2,80)" });
  await assert.rejects(setRatingForTracks(ng, [1, 2, 3], 80));
  assert.deepEqual(ng.calls, ["setTrackRating(1,80)", "setTrackRating(2,80)"]);
});

test("addTracksToPlaylist: 追加数とプレイリスト名を返す", async () => {
  const api = fakeApi();
  const playlists = [{ playlistId: 7, name: "Warm up" }];
  const r = await addTracksToPlaylist(api, playlists, 7, [1, 2, 3]);
  assert.deepEqual(r, { added: 2, name: "Warm up" });
  assert.equal(addedToPlaylistMessage(r), "「Warm up」に 2 曲を追加しました");
  // 一覧に無いプレイリストは既定の名前
  assert.equal((await addTracksToPlaylist(api, [], 9, [1])).name, "プレイリスト");
});

// ---- 失敗の通知 (ui-spec §4.4: 曲操作の失敗はトーストで知らせる) ----

test("runTrackAction: 成功したら true を返し、通知しない", async () => {
  const notes: string[] = [];
  let ran = false;
  const ok = await runTrackAction((m) => notes.push(m), "enqueue", async () => {
    ran = true;
  });
  assert.equal(ok, true);
  assert.equal(ran, true);
  assert.deepEqual(notes, []);
});

test("runTrackAction: 失敗したら throw せず false を返し、理由つきで 1 回通知する", async (t) => {
  t.mock.method(console, "error", () => {});
  const notes: string[] = [];
  const ok = await runTrackAction((m) => notes.push(m), "enqueue", async () => {
    throw new Error("device busy");
  });
  assert.equal(ok, false);
  assert.deepEqual(notes, ["キューへの追加に失敗しました: device busy"]);
});

test("runTrackAction: Tauri の {message} 形式の失敗も理由を読む ([object Object] にしない)", async (t) => {
  t.mock.method(console, "error", () => {});
  const notes: string[] = [];
  await runTrackAction((m) => notes.push(m), "rating", async () => {
    throw { code: "db", message: "database is locked" };
  });
  assert.deepEqual(notes, ["レーティングを変更できませんでした: database is locked"]);
});

test("runTrackAction: 実 API の手順と組み合わせると、途中の失敗が通知される", async (t) => {
  t.mock.method(console, "error", () => {});
  const api = fakeApi({ failOn: "enqueueTrackNext(2)" });
  const notes: string[] = [];
  const ok = await runTrackAction((m) => notes.push(m), "playNext", () =>
    playNextTracks(api, [1, 2, 3]),
  );
  assert.equal(ok, false);
  assert.equal(notes.length, 1);
  assert.match(notes[0], /^「次に再生」への追加に失敗しました: failed: enqueueTrackNext$/);
});

test("trackActionFailureMessage: どの操作にも文言があり、理由が付く", () => {
  const kinds = [
    "play",
    "enqueue",
    "playNext",
    "rating",
    "addToPlaylist",
    "removeFromPlaylist",
    "addTag",
    "removeTag",
    "saveGenre",
    "analyze",
    "reveal",
  ] as const;
  const seen = new Set<string>();
  for (const kind of kinds) {
    const msg = trackActionFailureMessage(kind, "理由");
    assert.match(msg, /^.+: 理由$/, kind);
    assert.ok(!msg.startsWith("undefined"), kind);
    seen.add(msg);
  }
  assert.equal(seen.size, kinds.length, "操作ごとに文言が違う");
});

test("trackActionFailureMessage: 再生は曲名が分かれば添える", () => {
  assert.equal(
    trackActionFailureMessage("play", new Error("file not found"), "Song A"),
    "『Song A』を再生できませんでした: file not found",
  );
  assert.equal(
    trackActionFailureMessage("play", new Error("file not found")),
    "再生に失敗しました: file not found",
  );
  // 再生以外は曲名を使わない
  assert.equal(trackActionFailureMessage("enqueue", "x", "Song A"), "キューへの追加に失敗しました: x");
});
