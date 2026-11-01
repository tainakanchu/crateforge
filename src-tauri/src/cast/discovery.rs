//! 同一 LAN の Google Cast 端末を mDNS (`_googlecast._tcp.local.`) で探索する。
//!
//! `_crateforge._tcp` の広告 ([`crate::mdns`]) とは別の `ServiceDaemon` で browse する。
//! 解決・消失イベントは純粋な [`DeviceRegistry`] に畳み込み、端末 ID (TXT `id`) で
//! 重複を除く。IP / ポートが変わったら同じ ID のまま更新する。

use std::collections::BTreeMap;
use std::net::IpAddr;
use std::sync::{Arc, Mutex};

use mdns_sd::{ServiceDaemon, ServiceEvent};

use super::{CastDevice, CastError, CastErrorCode};

pub const SERVICE_TYPE: &str = "_googlecast._tcp.local.";

/// mDNS の解決結果を、レジストリが必要とする形に抜き出したもの。
#[derive(Debug, Clone, PartialEq)]
pub struct ResolvedService {
    pub fullname: String,
    /// TXT `id`。
    pub id: Option<String>,
    /// TXT `fn` (ユーザーが付けた端末名)。
    pub friendly_name: Option<String>,
    /// TXT `md` (機種名)。
    pub model: Option<String>,
    pub addrs: Vec<IpAddr>,
    pub port: u16,
}

#[derive(Debug, Clone, PartialEq)]
pub enum DiscoveryEvent {
    Resolved(ResolvedService),
    Removed { fullname: String },
}

/// 発見済み端末の一覧 (端末 ID → (mDNS fullname, 端末))。
#[derive(Debug, Default)]
pub struct DeviceRegistry {
    by_id: BTreeMap<String, (String, CastDevice)>,
}

/// 接続に使うアドレスを選ぶ。IPv4 を優先し、スコープ ID が要るリンクローカル IPv6 は使わない。
fn pick_addr(addrs: &[IpAddr]) -> Option<IpAddr> {
    let mut v4: Vec<IpAddr> = addrs.iter().copied().filter(IpAddr::is_ipv4).collect();
    v4.sort();
    if let Some(a) = v4.first() {
        return Some(*a);
    }
    let mut v6: Vec<IpAddr> = addrs
        .iter()
        .copied()
        .filter(|a| matches!(a, IpAddr::V6(v6) if (v6.segments()[0] & 0xffc0) != 0xfe80))
        .collect();
    v6.sort();
    v6.first().copied()
}

impl DeviceRegistry {
    /// イベントを適用し、一覧が変わったら true。
    pub fn apply(&mut self, ev: DiscoveryEvent) -> bool {
        match ev {
            DiscoveryEvent::Resolved(s) => {
                let Some(addr) = pick_addr(&s.addrs) else {
                    return false;
                };
                // TXT id が無い端末は fullname を ID 代わりにする。
                let id =
                    s.id.filter(|i| !i.is_empty())
                        .unwrap_or_else(|| s.fullname.clone());
                let name = s
                    .friendly_name
                    .filter(|n| !n.is_empty())
                    .unwrap_or_else(|| {
                        s.fullname
                            .strip_suffix(&format!(".{SERVICE_TYPE}"))
                            .unwrap_or(&s.fullname)
                            .to_string()
                    });
                let device = CastDevice {
                    id: id.clone(),
                    name,
                    model: s.model.filter(|m| !m.is_empty()),
                    host: addr.to_string(),
                    port: s.port,
                };
                let entry = (s.fullname, device);
                if self.by_id.get(&id) == Some(&entry) {
                    return false;
                }
                self.by_id.insert(id, entry);
                true
            }
            DiscoveryEvent::Removed { fullname } => {
                let before = self.by_id.len();
                self.by_id.retain(|_, (fname, _)| *fname != fullname);
                self.by_id.len() != before
            }
        }
    }

    /// 名前順の一覧。
    pub fn devices(&self) -> Vec<CastDevice> {
        let mut list: Vec<CastDevice> = self.by_id.values().map(|(_, d)| d.clone()).collect();
        list.sort_by(|a, b| {
            a.name
                .to_lowercase()
                .cmp(&b.name.to_lowercase())
                .then(a.id.cmp(&b.id))
        });
        list
    }

    pub fn get(&self, id: &str) -> Option<CastDevice> {
        self.by_id.get(id).map(|(_, d)| d.clone())
    }

    pub fn clear(&mut self) {
        self.by_id.clear();
    }
}

fn to_event(ev: ServiceEvent) -> Option<DiscoveryEvent> {
    match ev {
        ServiceEvent::ServiceResolved(info) => {
            let txt = |k: &str| info.get_property_val_str(k).map(str::to_string);
            Some(DiscoveryEvent::Resolved(ResolvedService {
                fullname: info.get_fullname().to_string(),
                id: txt("id"),
                friendly_name: txt("fn"),
                model: txt("md"),
                addrs: info.get_addresses().iter().copied().collect(),
                port: info.get_port(),
            }))
        }
        ServiceEvent::ServiceRemoved(_, fullname) => Some(DiscoveryEvent::Removed { fullname }),
        _ => None,
    }
}

type OnChange = Arc<dyn Fn(Vec<CastDevice>) + Send + Sync>;

struct Inner {
    daemon: Option<ServiceDaemon>,
    registry: DeviceRegistry,
    /// browse のやり直しで古い受信スレッドの結果を捨てるための世代番号。
    generation: u64,
}

/// mDNS browse の実行体。最初の `ensure_started` で探索を始め、以後バックグラウンドで
/// 一覧を更新し続ける。変化のたびに `on_change` を呼ぶ。
#[derive(Clone)]
pub struct CastDiscovery {
    inner: Arc<Mutex<Inner>>,
    on_change: OnChange,
}

impl CastDiscovery {
    pub fn new(on_change: impl Fn(Vec<CastDevice>) + Send + Sync + 'static) -> Self {
        Self {
            inner: Arc::new(Mutex::new(Inner {
                daemon: None,
                registry: DeviceRegistry::default(),
                generation: 0,
            })),
            on_change: Arc::new(on_change),
        }
    }

    /// まだ探索していなければ開始する。
    pub fn ensure_started(&self) -> Result<(), CastError> {
        let mut inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        if inner.daemon.is_some() {
            return Ok(());
        }
        self.start_locked(&mut inner)
    }

    /// 一覧を捨てて探索をやり直す (UI の「再検索」)。
    pub fn restart(&self) -> Result<(), CastError> {
        let result = {
            let mut inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
            Self::stop_locked(&mut inner);
            inner.registry.clear();
            self.start_locked(&mut inner)
        };
        // コールバックはロック外で呼ぶ (中で devices() を呼んでもデッドロックしないように)。
        (self.on_change)(Vec::new());
        result
    }

    pub fn stop(&self) {
        let mut inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        Self::stop_locked(&mut inner);
    }

    pub fn devices(&self) -> Vec<CastDevice> {
        let inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        inner.registry.devices()
    }

    pub fn get(&self, id: &str) -> Option<CastDevice> {
        let inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        inner.registry.get(id)
    }

    fn stop_locked(inner: &mut Inner) {
        inner.generation += 1;
        if let Some(d) = inner.daemon.take() {
            let _ = d.stop_browse(SERVICE_TYPE);
            let _ = d.shutdown();
        }
    }

    fn start_locked(&self, inner: &mut Inner) -> Result<(), CastError> {
        let err = |e: mdns_sd::Error| {
            CastError::new(
                CastErrorCode::Internal,
                format!("Cast 端末の探索を開始できません (マルチキャスト/ファイアウォール設定を確認): {e}"),
            )
        };
        let daemon = ServiceDaemon::new().map_err(err)?;
        let rx = daemon.browse(SERVICE_TYPE).map_err(err)?;
        inner.generation += 1;
        let generation = inner.generation;
        inner.daemon = Some(daemon);

        let shared = self.inner.clone();
        let on_change = self.on_change.clone();
        std::thread::spawn(move || {
            // daemon の shutdown で channel が閉じるとループを抜ける。
            while let Ok(ev) = rx.recv() {
                let Some(ev) = to_event(ev) else { continue };
                let changed = {
                    let mut inner = shared.lock().unwrap_or_else(|e| e.into_inner());
                    if inner.generation != generation {
                        break;
                    }
                    inner.registry.apply(ev).then(|| inner.registry.devices())
                };
                if let Some(list) = changed {
                    on_change(list);
                }
            }
        });
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn resolved(fullname: &str, id: &str, name: &str, ip: &str) -> DiscoveryEvent {
        DiscoveryEvent::Resolved(ResolvedService {
            fullname: fullname.into(),
            id: Some(id.into()),
            friendly_name: Some(name.into()),
            model: Some("Chromecast".into()),
            addrs: vec![ip.parse().unwrap()],
            port: 8009,
        })
    }

    #[test]
    fn dedupes_by_id_and_reports_changes() {
        let mut r = DeviceRegistry::default();
        assert!(r.apply(resolved(
            "A._googlecast._tcp.local.",
            "id1",
            "Living",
            "192.168.1.10"
        )));
        // 同じ内容の再解決は変化なし。
        assert!(!r.apply(resolved(
            "A._googlecast._tcp.local.",
            "id1",
            "Living",
            "192.168.1.10"
        )));
        assert!(r.apply(resolved(
            "B._googlecast._tcp.local.",
            "id2",
            "bedroom",
            "192.168.1.11"
        )));
        let names: Vec<_> = r.devices().into_iter().map(|d| d.name).collect();
        assert_eq!(names, vec!["bedroom", "Living"]);
    }

    #[test]
    fn ip_change_updates_same_device() {
        let mut r = DeviceRegistry::default();
        r.apply(resolved(
            "A._googlecast._tcp.local.",
            "id1",
            "Living",
            "192.168.1.10",
        ));
        assert!(r.apply(resolved(
            "A._googlecast._tcp.local.",
            "id1",
            "Living",
            "192.168.1.20"
        )));
        let list = r.devices();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].host, "192.168.1.20");
        assert_eq!(list[0].socket_addr().unwrap().port(), 8009);
    }

    #[test]
    fn removal_by_fullname() {
        let mut r = DeviceRegistry::default();
        r.apply(resolved(
            "A._googlecast._tcp.local.",
            "id1",
            "Living",
            "192.168.1.10",
        ));
        assert!(!r.apply(DiscoveryEvent::Removed {
            fullname: "Z._googlecast._tcp.local.".into()
        }));
        assert!(r.apply(DiscoveryEvent::Removed {
            fullname: "A._googlecast._tcp.local.".into()
        }));
        assert!(r.devices().is_empty());
        assert!(r.get("id1").is_none());
    }

    #[test]
    fn prefers_ipv4_and_skips_link_local_v6() {
        let mut r = DeviceRegistry::default();
        r.apply(DiscoveryEvent::Resolved(ResolvedService {
            fullname: "A._googlecast._tcp.local.".into(),
            id: None,
            friendly_name: None,
            model: None,
            addrs: vec!["fe80::1".parse().unwrap(), "192.168.1.5".parse().unwrap()],
            port: 8009,
        }));
        let d = &r.devices()[0];
        assert_eq!(d.host, "192.168.1.5");
        // id / fn が無ければ fullname から補う。
        assert_eq!(d.id, "A._googlecast._tcp.local.");
        assert_eq!(d.name, "A");

        // リンクローカル v6 しか無い端末は使えないので登録しない。
        assert!(!r.apply(DiscoveryEvent::Resolved(ResolvedService {
            fullname: "B._googlecast._tcp.local.".into(),
            id: Some("b".into()),
            friendly_name: None,
            model: None,
            addrs: vec!["fe80::2".parse().unwrap()],
            port: 8009,
        })));
    }
}
