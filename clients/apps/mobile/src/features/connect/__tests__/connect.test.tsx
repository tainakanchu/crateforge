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
    await render(<ConnectScreen />);
    await act(async () => {
      useConnection.setState({ status: "error", error: "接続がタイムアウトしました" });
    });

    expect(screen.getByText("接続がタイムアウトしました")).toBeTruthy();
  });
});

describe("ConnectScreen ?token= の自動分解", () => {
  beforeEach(() => {
    resetTestState();
    jest.restoreAllMocks();
  });

  it("URL 欄に token 付き URL を貼ると URL とトークン欄に分解される", async () => {
    const connect = jest.spyOn(useConnection.getState(), "connect").mockResolvedValue(true);
    await render(<ConnectScreen />);

    await act(async () => {
      fireEvent.changeText(
        screen.getByLabelText("サーバー URL"),
        "http://192.168.1.5:8787/?token=abc123",
      );
    });
    expect(screen.getByLabelText("サーバー URL").props.value).toBe("http://192.168.1.5:8787");
    expect(screen.getByLabelText("トークン").props.value).toBe("abc123");

    fireEvent.press(screen.getByLabelText("接続"));
    expect(connect).toHaveBeenCalledWith("http://192.168.1.5:8787", "abc123");
  });

  it("スキーム無しでも分解できる", async () => {
    await render(<ConnectScreen />);
    await act(async () => {
      fireEvent.changeText(screen.getByLabelText("サーバー URL"), "192.168.1.5:8787/?token=zz");
    });
    expect(screen.getByLabelText("サーバー URL").props.value).toBe("http://192.168.1.5:8787");
    expect(screen.getByLabelText("トークン").props.value).toBe("zz");
  });

  it("保存済み URL / トークンを初期表示する", async () => {
    useConnection.setState({ baseUrl: "http://10.0.0.2:8787", token: "tok" });
    await render(<ConnectScreen />);
    expect(screen.getByLabelText("サーバー URL").props.value).toBe("http://10.0.0.2:8787");
    expect(screen.getByLabelText("トークン").props.value).toBe("tok");
  });
});
