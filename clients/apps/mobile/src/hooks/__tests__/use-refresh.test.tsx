// 一覧の更新手段（round-2 M7）。
import { act, renderHook } from "@testing-library/react-native";

import { usePullToRefresh } from "@/hooks/use-refresh";

describe("usePullToRefresh (M7)", () => {
  test("onRefresh で refetch し、終わるまで refreshing=true", async () => {
    let resolve: () => void = () => undefined;
    const refetch = jest.fn(() => new Promise<void>((r) => (resolve = r)));
    const { result } = await renderHook(() => usePullToRefresh(refetch));
    expect(result.current.refreshing).toBe(false);
    await act(async () => {
      result.current.onRefresh();
    });
    expect(refetch).toHaveBeenCalledTimes(1);
    expect(result.current.refreshing).toBe(true);
    await act(async () => {
      resolve();
    });
    expect(result.current.refreshing).toBe(false);
  });
});
