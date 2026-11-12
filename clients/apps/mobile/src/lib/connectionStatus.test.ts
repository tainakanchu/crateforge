import { REAUTH_HREF, connectionLabel, connectionRecovery, formatClock } from "./connectionStatus";

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
    // 状態行と同じ趣旨（不一致）を補足で繰り返さない（round-3 N2）。確認場所だけ添える。
    expect(l.detail).toContain("設定 → モバイル / API");
    expect(l.detail).not.toMatch(/違います|一致しません|不一致/);
  });
  it("その他のエラー / 未接続", () => {
    expect(connectionLabel({ ...base, status: "error", errorKind: "server" }).text).toBe("エラー");
    expect(connectionLabel(base).text).toBe("未接続");
  });
});

describe("connectionRecovery（未接続時の理由と導線）", () => {
  it("トークン不一致 → トークンを入力し直す", () => {
    const r = connectionRecovery({ ...base, status: "error", errorKind: "unauthorized" });
    expect(r.action).toBe("reauth");
    expect(r.actionLabel).toBe("トークンを入力し直す");
    expect(REAUTH_HREF).toBe("/connect?reauth=1");
  });
  it("オフライン → 再試行（最終接続つき）", () => {
    const at = new Date(2026, 0, 2, 9, 5).getTime();
    const r = connectionRecovery({ ...base, status: "error", errorKind: "network", lastOkAt: at });
    expect(r.action).toBe("retry");
    expect(r.reason).toBe("デスクトップに届きません（最終接続 09:05）");
  });
  it("Crateforge ではない URL → 接続先を変更", () => {
    const r = connectionRecovery({ ...base, status: "error", errorKind: "notCrateforge" });
    expect(r.action).toBe("connect");
    expect(r.actionLabel).toBe("接続先を変更");
  });
  it("未設定 → サーバーに接続", () => {
    const r = connectionRecovery({ ...base, baseUrl: null });
    expect(r.action).toBe("connect");
    expect(r.actionLabel).toBe("サーバーに接続");
  });
});
