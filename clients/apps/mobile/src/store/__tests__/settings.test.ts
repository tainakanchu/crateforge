// useSettings ストアの単体テスト。SecureStore はグローバルモック。
// setDownloadQuality が state を更新し永続化、hydrate が復元することを検証する。

import * as SecureStore from "expo-secure-store";

import { useSettings } from "@crateforge/core";

const getItem = SecureStore.getItemAsync as jest.Mock;
const setItem = SecureStore.setItemAsync as jest.Mock;

beforeEach(() => {
  jest.clearAllMocks();
  getItem.mockReset().mockResolvedValue(null);
  setItem.mockReset().mockResolvedValue(undefined);
  // 既定へ戻す。
  useSettings.setState({
    downloadQuality: "aac192",
    rowMetaFields: ["bpm"],
    trackSort: { field: "name", order: "asc" },
  });
});

describe("useSettings", () => {
  it("既定の音質は aac192", () => {
    expect(useSettings.getState().downloadQuality).toBe("aac192");
  });

  it("setDownloadQuality が state を更新し SecureStore に永続化する", () => {
    useSettings.getState().setDownloadQuality("aac256");
    expect(useSettings.getState().downloadQuality).toBe("aac256");
    expect(setItem).toHaveBeenCalledWith("crateforge.downloadQuality", "aac256");

    useSettings.getState().setDownloadQuality("original");
    expect(useSettings.getState().downloadQuality).toBe("original");
  });

  it("hydrate が永続化された有効な音質を復元する", async () => {
    getItem.mockResolvedValueOnce("aac128").mockResolvedValueOnce(null).mockResolvedValueOnce(null);
    await useSettings.getState().hydrate();
    expect(useSettings.getState().downloadQuality).toBe("aac128");
  });

  it("hydrate は不正な値なら既定のままにする", async () => {
    getItem.mockResolvedValueOnce("garbage").mockResolvedValueOnce(null).mockResolvedValueOnce(null);
    await useSettings.getState().hydrate();
    expect(useSettings.getState().downloadQuality).toBe("aac192");
  });

  it("既定の rowMetaFields は ['bpm']", () => {
    expect(useSettings.getState().rowMetaFields).toEqual(["bpm"]);
  });

  it("toggleRowMetaField がフィールドを追加する", () => {
    useSettings.getState().toggleRowMetaField("year");
    expect(useSettings.getState().rowMetaFields).toContain("year");
    expect(useSettings.getState().rowMetaFields).toContain("bpm");
  });

  it("toggleRowMetaField がフィールドを削除する", () => {
    useSettings.getState().toggleRowMetaField("bpm");
    expect(useSettings.getState().rowMetaFields).not.toContain("bpm");
  });

  it("setTrackSort がソートを更新する", () => {
    useSettings.getState().setTrackSort({ field: "artist", order: "desc" });
    const state = useSettings.getState();
    expect(state.trackSort.field).toBe("artist");
    expect(state.trackSort.order).toBe("desc");
    expect(setItem).toHaveBeenCalledWith(
      "crateforge.trackSort",
      JSON.stringify({ field: "artist", order: "desc" }),
    );
  });

  it("既定の trackSort は { field: 'name', order: 'asc' }", () => {
    expect(useSettings.getState().trackSort).toEqual({ field: "name", order: "asc" });
  });
});
