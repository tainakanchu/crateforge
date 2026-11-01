//! CastV2 の `CastMessage` (protobuf) の手書き encode/decode と framing。
//!
//! ```text
//! message CastMessage {
//!   required ProtocolVersion protocol_version = 1;  // CASTV2_1_0 = 0
//!   required string source_id = 2;
//!   required string destination_id = 3;
//!   required string namespace = 4;
//!   required PayloadType payload_type = 5;          // STRING = 0, BINARY = 1
//!   optional string payload_utf8 = 6;
//!   optional bytes payload_binary = 7;
//! }
//! ```
//! ワイヤ上は「4 byte ビッグエンディアンの長さ + 上記メッセージ」の繰り返し。
//! フィールドが 7 つしかないので protobuf の codegen は使わず、varint と
//! length-delimited だけを手で扱う。

use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};

/// 1 フレームの上限 (Cast 仕様上のメッセージ上限は 64 KiB)。
pub const MAX_FRAME_LEN: usize = 64 * 1024;

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct CastMessage {
    pub source_id: String,
    pub destination_id: String,
    pub namespace: String,
    /// JSON 文字列ペイロード。BINARY ペイロードの場合は空。
    pub payload_utf8: String,
    /// BINARY ペイロード (deviceauth 用)。本実装では送らないが受信時は保持する。
    pub payload_binary: Option<Vec<u8>>,
}

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum ProtoError {
    #[error("truncated message")]
    Truncated,
    #[error("varint overflow")]
    VarintOverflow,
    #[error("unsupported wire type {0}")]
    WireType(u8),
    #[error("invalid utf-8 in field {0}")]
    Utf8(u32),
    #[error("frame too large: {0} bytes")]
    TooLarge(usize),
}

impl From<ProtoError> for std::io::Error {
    fn from(e: ProtoError) -> Self {
        std::io::Error::new(std::io::ErrorKind::InvalidData, e)
    }
}

fn put_varint(buf: &mut Vec<u8>, mut v: u64) {
    while v >= 0x80 {
        buf.push((v as u8) | 0x80);
        v >>= 7;
    }
    buf.push(v as u8);
}

fn put_bytes(buf: &mut Vec<u8>, field: u32, data: &[u8]) {
    put_varint(buf, ((field << 3) | 2) as u64);
    put_varint(buf, data.len() as u64);
    buf.extend_from_slice(data);
}

fn get_varint(data: &[u8], pos: &mut usize) -> Result<u64, ProtoError> {
    let mut out = 0u64;
    for shift in (0..64).step_by(7) {
        let b = *data.get(*pos).ok_or(ProtoError::Truncated)?;
        *pos += 1;
        out |= ((b & 0x7f) as u64) << shift;
        if b & 0x80 == 0 {
            return Ok(out);
        }
    }
    Err(ProtoError::VarintOverflow)
}

impl CastMessage {
    /// protobuf 本体 (長さプレフィクスなし) へエンコードする。
    pub fn encode(&self) -> Vec<u8> {
        let mut buf = Vec::with_capacity(64 + self.payload_utf8.len());
        // protocol_version = CASTV2_1_0 (0)。proto2 の required なので 0 でも書く。
        put_varint(&mut buf, 1 << 3);
        put_varint(&mut buf, 0);
        put_bytes(&mut buf, 2, self.source_id.as_bytes());
        put_bytes(&mut buf, 3, self.destination_id.as_bytes());
        put_bytes(&mut buf, 4, self.namespace.as_bytes());
        put_varint(&mut buf, 5 << 3);
        match &self.payload_binary {
            Some(bin) => {
                put_varint(&mut buf, 1);
                put_bytes(&mut buf, 7, bin);
            }
            None => {
                put_varint(&mut buf, 0);
                put_bytes(&mut buf, 6, self.payload_utf8.as_bytes());
            }
        }
        buf
    }

    /// protobuf 本体をデコードする。未知フィールドは読み飛ばす。
    pub fn decode(data: &[u8]) -> Result<Self, ProtoError> {
        let mut msg = CastMessage::default();
        let mut pos = 0;
        while pos < data.len() {
            let key = get_varint(data, &mut pos)?;
            let field = (key >> 3) as u32;
            match (key & 7) as u8 {
                0 => {
                    get_varint(data, &mut pos)?;
                }
                1 => pos = pos.checked_add(8).ok_or(ProtoError::Truncated)?,
                5 => pos = pos.checked_add(4).ok_or(ProtoError::Truncated)?,
                2 => {
                    let len = get_varint(data, &mut pos)? as usize;
                    let end = pos.checked_add(len).ok_or(ProtoError::Truncated)?;
                    let bytes = data.get(pos..end).ok_or(ProtoError::Truncated)?;
                    pos = end;
                    let text =
                        || String::from_utf8(bytes.to_vec()).map_err(|_| ProtoError::Utf8(field));
                    match field {
                        2 => msg.source_id = text()?,
                        3 => msg.destination_id = text()?,
                        4 => msg.namespace = text()?,
                        6 => msg.payload_utf8 = text()?,
                        7 => msg.payload_binary = Some(bytes.to_vec()),
                        _ => {}
                    }
                }
                wt => return Err(ProtoError::WireType(wt)),
            }
            if pos > data.len() {
                return Err(ProtoError::Truncated);
            }
        }
        Ok(msg)
    }

    /// 長さプレフィクス付きの 1 フレームにする。
    pub fn to_frame(&self) -> Vec<u8> {
        let body = self.encode();
        let mut out = Vec::with_capacity(4 + body.len());
        out.extend_from_slice(&(body.len() as u32).to_be_bytes());
        out.extend_from_slice(&body);
        out
    }
}

/// ストリームから 1 フレーム読む。部分読み込みは `read_exact` が吸収する。
pub async fn read_frame<R: AsyncRead + Unpin>(r: &mut R) -> std::io::Result<CastMessage> {
    let mut len = [0u8; 4];
    r.read_exact(&mut len).await?;
    let len = u32::from_be_bytes(len) as usize;
    if len > MAX_FRAME_LEN {
        return Err(ProtoError::TooLarge(len).into());
    }
    let mut body = vec![0u8; len];
    r.read_exact(&mut body).await?;
    Ok(CastMessage::decode(&body)?)
}

/// 1 フレーム書き込む。
pub async fn write_frame<W: AsyncWrite + Unpin>(
    w: &mut W,
    msg: &CastMessage,
) -> std::io::Result<()> {
    let frame = msg.to_frame();
    if frame.len() - 4 > MAX_FRAME_LEN {
        return Err(ProtoError::TooLarge(frame.len() - 4).into());
    }
    w.write_all(&frame).await?;
    w.flush().await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample() -> CastMessage {
        CastMessage {
            source_id: "sender-0".into(),
            destination_id: "receiver-0".into(),
            namespace: "urn:x-cast:com.google.cast.tp.connection".into(),
            payload_utf8: r#"{"type":"CONNECT","日本語":"✓"}"#.into(),
            payload_binary: None,
        }
    }

    #[test]
    fn roundtrip_string_payload() {
        let m = sample();
        assert_eq!(CastMessage::decode(&m.encode()).unwrap(), m);
    }

    #[test]
    fn roundtrip_binary_payload_and_long_field() {
        let m = CastMessage {
            payload_utf8: String::new(),
            payload_binary: Some(vec![0, 1, 2, 255]),
            // 128 byte 超で長さ varint が 2 byte になるケース。
            namespace: "n".repeat(300),
            ..sample()
        };
        assert_eq!(CastMessage::decode(&m.encode()).unwrap(), m);
    }

    #[test]
    fn known_bytes_layout() {
        let m = CastMessage {
            source_id: "s".into(),
            destination_id: "d".into(),
            namespace: "n".into(),
            payload_utf8: "{}".into(),
            payload_binary: None,
        };
        assert_eq!(
            m.encode(),
            vec![
                0x08, 0x00, 0x12, 1, b's', 0x1a, 1, b'd', 0x22, 1, b'n', 0x28, 0x00, 0x32, 2, b'{',
                b'}'
            ]
        );
    }

    #[test]
    fn decode_skips_unknown_fields_and_rejects_truncation() {
        let mut data = sample().encode();
        // 未知の varint フィールド 15 と fixed32 フィールド 16 を足しても読める。
        data.extend_from_slice(&[15 << 3, 0x96, 0x01]);
        data.extend_from_slice(&[0x85, 0x01, 1, 2, 3, 4]);
        assert_eq!(CastMessage::decode(&data).unwrap(), sample());

        let full = sample().encode();
        assert_eq!(
            CastMessage::decode(&full[..full.len() - 3]),
            Err(ProtoError::Truncated)
        );
    }

    #[tokio::test]
    async fn framing_survives_partial_reads() {
        let (mut client, mut server) = tokio::io::duplex(8);
        let msgs = vec![
            sample(),
            CastMessage {
                payload_utf8: "{\"type\":\"PING\"}".into(),
                ..sample()
            },
        ];
        let bytes: Vec<u8> = msgs.iter().flat_map(|m| m.to_frame()).collect();
        let writer = tokio::spawn(async move {
            // 1 byte ずつ書いて分割受信を再現する。
            for b in bytes {
                client.write_all(&[b]).await.unwrap();
            }
        });
        for expected in &msgs {
            assert_eq!(&read_frame(&mut server).await.unwrap(), expected);
        }
        writer.await.unwrap();
    }

    #[tokio::test]
    async fn oversized_frame_is_rejected() {
        let (mut client, mut server) = tokio::io::duplex(64);
        client
            .write_all(&((MAX_FRAME_LEN as u32) + 1).to_be_bytes())
            .await
            .unwrap();
        let err = read_frame(&mut server).await.unwrap_err();
        assert_eq!(err.kind(), std::io::ErrorKind::InvalidData);
    }
}
