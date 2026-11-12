import { connectionLabel, formatClock } from "./connectionStatus";

const base = { status: "idle", errorKind: null, checking: false, lastOkAt: null, baseUrl: "http://h:1" } as const;

describe("connectionLabel", () => {
  it("接続済み", () => {
    expect(connectionLabel({ ...base, status: "connected" }).text).toBe("接続済み");
  });
  it("確認中（connecting / recheck 中）", () => {
    expect(connectionLabel({ ...base, status: "connecting" }).text).toBe("確認中");
    expect(connectionLabel({ ...base, status: "connected", checking: true }).text).toBe("確認中");
    expect(connectionLabel({ ...base, status: "error", errorKind: "network", checking: true }).text).toBe("確認中");
  });
  it("オフライン（最終接続 hh:mm）", () => {
    const at = new Date(2026, 0, 2, 9, 5).getTime();
    const l = connectionLabel({ ...base, status: "error", errorKind: "network", lastOkAt: at });
    expect(l.text).toBe("オフライン（最終接続 09:05）");
    expect(l.tone).toBe("offline");
    expect(l.detail).toContain("デスクトップに接続できません");
    expect(formatClock(at)).toBe("09:05");
  });
  it("オフライン（最終接続不明）", () => {
    expect(connectionLabel({ ...base, status: "error", errorKind: "timeout" }).text).toBe("オフライン");
  });
  it("トークン不一致", () => {
    const l = connectionLabel({ ...base, status: "error", errorKind: "unauthorized" });
    expect(l.text).toBe("トークン不一致");
    expect(l.detail).toContain("トークンが違います");
  });
  it("その他のエラー / 未接続", () => {
    expect(connectionLabel({ ...base, status: "error", errorKind: "server" }).text).toBe("エラー");
    expect(connectionLabel(base).text).toBe("未接続");
  });
});
