import { render, screen, fireEvent, act } from "@testing-library/react-native";

import ConnectScreen from "@/app/connect";
import { useConnection } from "@crateforge/core";
import { resetTestState } from "@/test-utils";

// SafeAreaProvider をテストツリーに張らずに insets を固定で返す。
jest.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }),
}));

describe("ConnectScreen", () => {
  beforeEach(() => {
    resetTestState();
    jest.restoreAllMocks();
  });

  it("URL を入力して接続を押すと connect が呼ばれる", async () => {
    const connect = jest
      .spyOn(useConnection.getState(), "connect")
      .mockResolvedValue(true);

    await render(<ConnectScreen />);

    // RNTL v14 では state 更新が非同期 act 内で反映されるため、入力を確定させてから押下する。
    await act(async () => {
      fireEvent.changeText(screen.getByLabelText("サーバー URL"), "192.168.1.5:8787");
    });
    fireEvent.press(screen.getByLabelText("接続"));

    expect(connect).toHaveBeenCalledWith("192.168.1.5:8787", null);
  });

  it("token 入力時はそれを渡す", async () => {
    const connect = jest
      .spyOn(useConnection.getState(), "connect")
      .mockResolvedValue(true);

    await render(<ConnectScreen />);

    await act(async () => {
      fireEvent.changeText(screen.getByLabelText("サーバー URL"), "host:8787");
      fireEvent.changeText(screen.getByLabelText("トークン"), "secret");
    });
    fireEvent.press(screen.getByLabelText("接続"));

    expect(connect).toHaveBeenCalledWith("host:8787", "secret");
  });

  it("error 状態のときエラーメッセージを表示する", async () => {
    useConnection.setState({ status: "error", error: "接続がタイムアウトしました" });

    await render(<ConnectScreen />);

    expect(screen.getByText("接続がタイムアウトしました")).toBeTruthy();
  });
});
