// 接続の死活監視（round-2 M8）: 前面かつ接続中は一定間隔で静かに health 確認、オフライン中は再試行。

import { AppState } from "react-native";
import { render } from "@testing-library/react-native";

import { useConnection, useConnectionMonitor } from "@crateforge/core";
import { resetTestState, setTestConnection } from "@/test-utils";

function Probe(props: { heartbeatMs?: number; offlineRetryMs?: number }) {
  useConnectionMonitor(props);
  return null;
}

beforeEach(() => {
  resetTestState();
  jest.useFakeTimers();
  Object.defineProperty(AppState, "currentState", { value: "active", configurable: true });
});

afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
});

test("接続中は heartbeat 間隔で silent recheck する", async () => {
  setTestConnection();
  useConnection.setState({ hydrated: true });
  const recheck = jest.spyOn(useConnection.getState(), "recheck").mockResolvedValue(true);
  await render(<Probe heartbeatMs={1000} offlineRetryMs={500} />);
  jest.advanceTimersByTime(999);
  expect(recheck).not.toHaveBeenCalled();
  jest.advanceTimersByTime(1);
  expect(recheck).toHaveBeenCalledWith({ silent: true });
});

test("オフライン中は再試行間隔で（checking 表示ありの）recheck", async () => {
  useConnection.setState({
    hydrated: true,
    baseUrl: "http://h:1",
    status: "error",
    errorKind: "network",
    client: null,
  });
  const recheck = jest.spyOn(useConnection.getState(), "recheck").mockResolvedValue(false);
  await render(<Probe heartbeatMs={1000} offlineRetryMs={500} />);
  jest.advanceTimersByTime(500);
  expect(recheck).toHaveBeenCalledWith({ silent: false });
});

test("トークン不一致・未接続では定期確認しない", async () => {
  useConnection.setState({
    hydrated: true,
    baseUrl: "http://h:1",
    status: "error",
    errorKind: "unauthorized",
    client: null,
  });
  const recheck = jest.spyOn(useConnection.getState(), "recheck").mockResolvedValue(false);
  await render(<Probe heartbeatMs={1000} offlineRetryMs={500} />);
  jest.advanceTimersByTime(5000);
  expect(recheck).not.toHaveBeenCalled();
});
