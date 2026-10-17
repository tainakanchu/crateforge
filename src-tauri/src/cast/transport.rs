//! Cast 端末との送受信路。
//!
//! セッションは [`CastChannel`] (送信 / 受信の mpsc 対) だけを見る。実ソケットは
//! [`TlsTransport`] が TLS 接続を張り、読み書きをそれぞれのタスクで回して channel に繋ぐ。
//! 受信側 channel が閉じる = 接続断。テストでは [`MockTransport`] で端末側を直接操作する。

use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Duration;

use futures_util::future::BoxFuture;
use tokio::sync::mpsc;

use super::proto::{read_frame, write_frame, CastMessage};

/// 1 本の Cast 接続。`rx` が `None` を返したら接続は切れている。
pub struct CastChannel {
    pub tx: mpsc::UnboundedSender<CastMessage>,
    pub rx: mpsc::UnboundedReceiver<CastMessage>,
}

/// 端末への接続を張る境界。`connect` を呼ぶたびに新しい接続を返す (再接続にも使う)。
pub trait CastTransport: Send + Sync + 'static {
    fn connect(&self, addr: SocketAddr) -> BoxFuture<'static, std::io::Result<CastChannel>>;
}

/// TCP 接続 + TLS ハンドシェイクのタイムアウト。
const CONNECT_TIMEOUT: Duration = Duration::from_secs(8);

/// 実機向けの TLS トランスポート。
pub struct TlsTransport {
    config: Arc<rustls::ClientConfig>,
}

impl TlsTransport {
    pub fn new() -> Result<Self, String> {
        let provider = Arc::new(rustls::crypto::ring::default_provider());
        let config = rustls::ClientConfig::builder_with_provider(provider.clone())
            .with_safe_default_protocol_versions()
            .map_err(|e| e.to_string())?
            .dangerous()
            .with_custom_certificate_verifier(Arc::new(AcceptCastDeviceCert { provider }))
            .with_no_client_auth();
        Ok(Self {
            config: Arc::new(config),
        })
    }
}

impl CastTransport for TlsTransport {
    fn connect(&self, addr: SocketAddr) -> BoxFuture<'static, std::io::Result<CastChannel>> {
        let connector = tokio_rustls::TlsConnector::from(self.config.clone());
        Box::pin(async move {
            let fut = async {
                let tcp = tokio::net::TcpStream::connect(addr).await?;
                let _ = tcp.set_nodelay(true);
                let name = rustls::pki_types::ServerName::IpAddress(addr.ip().into());
                connector.connect(name, tcp).await
            };
            let tls = tokio::time::timeout(CONNECT_TIMEOUT, fut)
                .await
                .map_err(|_| {
                    std::io::Error::new(std::io::ErrorKind::TimedOut, "connect timeout")
                })??;
            let (mut reader, mut writer) = tokio::io::split(tls);
            let (out_tx, mut out_rx) = mpsc::unbounded_channel::<CastMessage>();
            let (in_tx, in_rx) = mpsc::unbounded_channel::<CastMessage>();
            // 受信タスク: 読めなくなったら in_tx を drop して接続断を伝える。
            tokio::spawn(async move {
                while let Ok(msg) = read_frame(&mut reader).await {
                    if in_tx.send(msg).is_err() {
                        break;
                    }
                }
            });
            // 送信タスク: セッションが tx を drop したら終了 (= ソケットを閉じる)。
            tokio::spawn(async move {
                while let Some(msg) = out_rx.recv().await {
                    if write_frame(&mut writer, &msg).await.is_err() {
                        break;
                    }
                }
                use tokio::io::AsyncWriteExt;
                let _ = writer.shutdown().await;
            });
            Ok(CastChannel {
                tx: out_tx,
                rx: in_rx,
            })
        })
    }
}

/// Cast 端末は自己署名証明書を使うため、Cast 接続に限って証明書検証を行わない。
/// (Default Media Receiver の利用に deviceauth は不要。署名自体の検証はプロバイダに任せる)
#[derive(Debug)]
struct AcceptCastDeviceCert {
    provider: Arc<rustls::crypto::CryptoProvider>,
}

impl rustls::client::danger::ServerCertVerifier for AcceptCastDeviceCert {
    fn verify_server_cert(
        &self,
        _end_entity: &rustls::pki_types::CertificateDer<'_>,
        _intermediates: &[rustls::pki_types::CertificateDer<'_>],
        _server_name: &rustls::pki_types::ServerName<'_>,
        _ocsp_response: &[u8],
        _now: rustls::pki_types::UnixTime,
    ) -> Result<rustls::client::danger::ServerCertVerified, rustls::Error> {
        Ok(rustls::client::danger::ServerCertVerified::assertion())
    }

    fn verify_tls12_signature(
        &self,
        message: &[u8],
        cert: &rustls::pki_types::CertificateDer<'_>,
        dss: &rustls::DigitallySignedStruct,
    ) -> Result<rustls::client::danger::HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls12_signature(
            message,
            cert,
            dss,
            &self.provider.signature_verification_algorithms,
        )
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &rustls::pki_types::CertificateDer<'_>,
        dss: &rustls::DigitallySignedStruct,
    ) -> Result<rustls::client::danger::HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls13_signature(
            message,
            cert,
            dss,
            &self.provider.signature_verification_algorithms,
        )
    }

    fn supported_verify_schemes(&self) -> Vec<rustls::SignatureScheme> {
        self.provider
            .signature_verification_algorithms
            .supported_schemes()
    }
}

/// テスト用トランスポート。`connect` のたびに [`MockDevice`] を 1 つ作って
/// `devices` へ流す。`fail_next` を立てると次の接続を失敗させる。
#[cfg(test)]
pub struct MockTransport {
    devices: mpsc::UnboundedSender<MockDevice>,
    fail: Arc<std::sync::atomic::AtomicUsize>,
}

/// テスト側から見た端末。`from_sender` に Sender の送信、`to_sender` で端末からの送信。
/// `to_sender` を drop すると接続断になる。
#[cfg(test)]
pub struct MockDevice {
    pub from_sender: mpsc::UnboundedReceiver<CastMessage>,
    pub to_sender: mpsc::UnboundedSender<CastMessage>,
}

#[cfg(test)]
impl MockTransport {
    pub fn new() -> (Self, mpsc::UnboundedReceiver<MockDevice>) {
        let (tx, rx) = mpsc::unbounded_channel();
        (
            Self {
                devices: tx,
                fail: Arc::new(std::sync::atomic::AtomicUsize::new(0)),
            },
            rx,
        )
    }

    /// 以降 `n` 回の接続を失敗させる。
    pub fn fail_next(&self, n: usize) {
        self.fail.store(n, std::sync::atomic::Ordering::SeqCst);
    }
}

#[cfg(test)]
impl CastTransport for MockTransport {
    fn connect(&self, _addr: SocketAddr) -> BoxFuture<'static, std::io::Result<CastChannel>> {
        use std::sync::atomic::Ordering;
        let failing = self
            .fail
            .fetch_update(Ordering::SeqCst, Ordering::SeqCst, |n| n.checked_sub(1))
            .is_ok();
        let devices = self.devices.clone();
        Box::pin(async move {
            if failing {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::ConnectionRefused,
                    "mock refused",
                ));
            }
            let (out_tx, out_rx) = mpsc::unbounded_channel();
            let (in_tx, in_rx) = mpsc::unbounded_channel();
            let _ = devices.send(MockDevice {
                from_sender: out_rx,
                to_sender: in_tx,
            });
            Ok(CastChannel {
                tx: out_tx,
                rx: in_rx,
            })
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tls_config_builds_with_ring_only() {
        assert!(TlsTransport::new().is_ok());
    }
}
