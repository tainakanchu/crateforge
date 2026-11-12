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

describe("ConnectScreen トークン再入力・文言（round-2 M6/M9）", () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { useLocalSearchParams } = require("expo-router") as { useLocalSearchParams: jest.Mock };

  beforeEach(() => {
    resetTestState();
    jest.restoreAllMocks();
    useLocalSearchParams.mockReturnValue({});
  });

  it("reauth=1 では URL は残し、旧トークンは入れない", async () => {
    useLocalSearchParams.mockReturnValue({ reauth: "1" });
    useConnection.setState({ baseUrl: "http://10.0.0.2:8787", token: "old" });
    await render(<ConnectScreen />);
    expect(screen.getByLabelText("サーバー URL").props.value).toBe("http://10.0.0.2:8787");
    expect(screen.getByLabelText("トークン").props.value).toBe("");
    expect(screen.getByText(/新しいトークンを入力してください/)).toBeTruthy();
  });

  it("トークン不一致(401)の状態で開いたときも旧トークンは入れない", async () => {
    useConnection.setState({
      baseUrl: "http://10.0.0.2:8787",
      token: "old",
      status: "error",
      errorKind: "unauthorized",
      error: "トークンが違います",
    });
    await render(<ConnectScreen />);
    expect(screen.getByLabelText("トークン").props.value).toBe("");
  });

  it("トークン空欄で 401 →「LAN 接続にはトークンが必要です」", async () => {
    jest.spyOn(useConnection.getState(), "connect").mockImplementation(async () => {
      useConnection.setState({ status: "error", errorKind: "unauthorized", error: "トークンが違います。…" });
      return false;
    });
    await render(<ConnectScreen />);
    await act(async () => {
      fireEvent.changeText(screen.getByLabelText("サーバー URL"), "192.168.1.5:8787");
    });
    await act(async () => {
      fireEvent.press(screen.getByLabelText("接続"));
    });
    expect(screen.getByText(/LAN 接続にはトークンが必要です/)).toBeTruthy();
  });

  it("エラーに「オフライン:」等の接頭辞を付けず、入力を変えたら消す", async () => {
    await render(<ConnectScreen />);
    await act(async () => {
      useConnection.setState({
        baseUrl: "http://h:1",
        status: "error",
        errorKind: "notCrateforge",
        error: "Crateforge の API ではない URL です",
      });
    });
    expect(screen.getByText("Crateforge の API ではない URL です")).toBeTruthy();
    expect(screen.queryByText(/オフライン/)).toBeNull();

    await act(async () => {
      fireEvent.changeText(screen.getByLabelText("サーバー URL"), "192.168.1.6:8787");
    });
    expect(screen.queryByText("Crateforge の API ではない URL です")).toBeNull();
  });

  it("トークン欄の placeholder は利用者向け文言", async () => {
    await render(<ConnectScreen />);
    expect(screen.getByLabelText("トークン").props.placeholder).toBe("デスクトップに表示されたトークン");
  });
});
