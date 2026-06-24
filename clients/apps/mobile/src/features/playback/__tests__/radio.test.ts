// startRadio のユニットテスト。client.similar をモックして、
// - オンライン: setQueue([seed, ...similar], 0) を呼び true を返す
// - 種自身が類似に混ざっても除外される
// - 類似が空なら false（キュー差し替えなし）
// - オフライン(client null): false（similar も呼ばれない）
// を検証する。

import { type SimilarHit, type Track, usePlayer } from "@crateforge/core";
import { startRadio } from "@/features/playback/radio";
import { setTestConnection, resetTestState } from "@/test-utils";

// router.push は副作用なので no-op モック（jest.setup の expo-router モックでも可だが明示）。
import { router } from "expo-router";

function track(id: number): Track {
  return { id, trackId: id, name: `T${id}` } as Track;
}

function hit(id: number): SimilarHit {
  return { track: track(id), distance: id };
}

beforeEach(() => {
  resetTestState();
  jest.clearAllMocks();
});

describe("startRadio", () => {
  it("オンライン: seed + 類似曲を setQueue して true を返す", async () => {
    const client = setTestConnection();
    const similarSpy = jest
      .spyOn(client, "similar")
      .mockResolvedValue([hit(1), hit(2), hit(3)]);
    const setQueue = jest.spyOn(usePlayer.getState(), "setQueue");

    const seed = track(100);
    const ok = await startRadio(seed);

    expect(ok).toBe(true);
    expect(similarSpy).toHaveBeenCalledWith(100, { limit: 25 });
    expect(setQueue).toHaveBeenCalledTimes(1);
    expect(setQueue).toHaveBeenCalledWith(
      [seed, track(1), track(2), track(3)],
      0,
    );
    expect(router.push).toHaveBeenCalledWith("/player");
  });

  it("類似に種自身が含まれても除外される", async () => {
    const client = setTestConnection();
    jest.spyOn(client, "similar").mockResolvedValue([hit(100), hit(2)]);
    const setQueue = jest.spyOn(usePlayer.getState(), "setQueue");

    const seed = track(100);
    const ok = await startRadio(seed);

    expect(ok).toBe(true);
    expect(setQueue).toHaveBeenCalledWith([seed, track(2)], 0);
  });

  it("類似が空なら false でキューは差し替えない", async () => {
    const client = setTestConnection();
    jest.spyOn(client, "similar").mockResolvedValue([]);
    const setQueue = jest.spyOn(usePlayer.getState(), "setQueue");

    const ok = await startRadio(track(100));

    expect(ok).toBe(false);
    expect(setQueue).not.toHaveBeenCalled();
    expect(router.push).not.toHaveBeenCalled();
  });

  it("オフライン(client null)では false で similar を呼ばない", async () => {
    // resetTestState 済みで client は null。
    const setQueue = jest.spyOn(usePlayer.getState(), "setQueue");

    const ok = await startRadio(track(100));

    expect(ok).toBe(false);
    expect(setQueue).not.toHaveBeenCalled();
    expect(router.push).not.toHaveBeenCalled();
  });

  it("similar が例外を投げたら false を返す", async () => {
    const client = setTestConnection();
    jest.spyOn(client, "similar").mockRejectedValue(new Error("network"));
    const setQueue = jest.spyOn(usePlayer.getState(), "setQueue");

    const ok = await startRadio(track(100));

    expect(ok).toBe(false);
    expect(setQueue).not.toHaveBeenCalled();
  });
});
