import { useEffect, useMemo, useState } from "react";
import { open as openShell } from "@tauri-apps/plugin-shell";
import { Icon } from "./Icon";

interface LicensePkg {
  name: string;
  version: string;
  kind: "rust" | "npm" | "runtime";
  license: string;
  repository: string | null;
  text: string;
}

interface LicenseData {
  counts: { total: number; rust: number; npm: number; runtime: number };
  packages: LicensePkg[];
}

const KIND_LABEL: Record<LicensePkg["kind"], string> = {
  rust: "Rust",
  npm: "JS",
  runtime: "実行時",
};

/// 全依存とライセンス全文を表示する。データ(数 MB)は開いたときだけ遅延ロードする。
export function LicenseList() {
  const [data, setData] = useState<LicenseData | null>(null);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    import("../generated/third-party-licenses.json")
      .then((m) => {
        if (alive) setData(m.default as unknown as LicenseData);
      })
      .catch((e) => alive && setError(`${e}`));
    return () => {
      alive = false;
    };
  }, []);

  const filtered = useMemo(() => {
    if (!data) return [];
    const q = query.trim().toLowerCase();
    if (!q) return data.packages;
    return data.packages.filter(
      (p) =>
        p.name.toLowerCase().includes(q) || p.license.toLowerCase().includes(q),
    );
  }, [data, query]);

  if (error) return <div className="rip-error">ライセンス情報の読み込みに失敗: {error}</div>;
  if (!data) return <div className="lic-loading">読み込み中…</div>;

  return (
    <div className="lic-wrap">
      <div className="lic-top">
        <span className="lic-count">
          全 {data.counts.total} 件（Rust {data.counts.rust} / JS {data.counts.npm} / 実行時{" "}
          {data.counts.runtime}）
        </span>
        <input
          className="rip-input lic-search"
          placeholder="名前・ライセンスで絞り込み"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>
      <div className="lic-list">
        {filtered.map((p) => {
          const id = `${p.kind}:${p.name}:${p.version}`;
          const isOpen = open === id;
          return (
            <div key={id} className={"lic-item" + (isOpen ? " open" : "")}>
              <button className="lic-head" onClick={() => setOpen(isOpen ? null : id)}>
                <Icon name={isOpen ? "chevronD" : "chevronR"} size={13} />
                <span className="lic-name">{p.name}</span>
                <span className="lic-ver">{p.version}</span>
                <span className={"lic-kind k-" + p.kind}>{KIND_LABEL[p.kind]}</span>
                <span className="lic-lic">{p.license}</span>
              </button>
              {isOpen && (
                <div className="lic-body">
                  {p.repository && (
                    <button
                      className="lic-repo"
                      onClick={() =>
                        openShell(p.repository!).catch(() =>
                          window.open(p.repository!, "_blank"),
                        )
                      }
                    >
                      <Icon name="info" size={12} /> {p.repository}
                    </button>
                  )}
                  <pre className="lic-text">{p.text || "(ライセンス全文を取得できませんでした)"}</pre>
                </div>
              )}
            </div>
          );
        })}
        {filtered.length === 0 && <div className="lic-loading">該当なし</div>}
      </div>
    </div>
  );
}
