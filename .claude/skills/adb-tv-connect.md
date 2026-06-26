---
name: adb-tv-connect
description: WSL2 から Android TV（Sony BRAVIA, 既定 192.168.0.16:5555）へ adb 接続する手順。EASビルドAPKの adb install や実機確認の前段。Use when the user says "adb つないで", "adb devices つないで", "テレビに adb 接続", "TVに繋いで", "adb connect", or wants to sideload / inspect / launch an app on the Android TV.
---

# adb → Android TV 接続スキル (WSL2)

## 対象
- 端末: Sony BRAVIA 4K (`model:BRAVIA_4K_VH2` / `BRAVIA_VH2_M_JP`)
- 既定アドレス: `192.168.0.16:5555`（ユーザー自宅TVのLAN IP。変わっていたら都度確認する）
- 環境: WSL2（adb 特有のハングが起きる）

## 結論（ハマりどころ2つ。先にこれを知っておく）
1. **`pkill -f adb` は使わない** — `-f` はコマンド行全体にマッチするので、"adb" を含む実行中シェル自身まで SIGKILL してしまう（コマンドが出力ゼロのまま exit 1 で死んだらこれが原因）。必ず **`pkill -9 -x adb`**（プロセス名の完全一致）を使う。
2. **WSL2 では adb サーバの自動デーモン化がハングする** — `adb start-server` や暗黙のサーバ起動が固まり、`adb connect` / `adb devices` まで巻き添えで無限待ちになる。**`nodaemon server` をバックグラウンドで明示起動**すれば回避できる。

## 手順

### 0. すべての adb 呼び出しは `timeout` で包む（無限ハング回避の保険）

### 1. 切り分け（adb を疑う前にネットワークを確認）
```bash
ping -c 3 -W 2 192.168.0.16                       # 到達性
timeout 5 bash -c 'exec 3<>/dev/tcp/192.168.0.16/5555' && echo OPEN || echo CLOSED  # 5555 開いてる?
```
- ping NG → ネットワーク不通 / IP違い
- ping OK だが 5555 CLOSED → **TV側で adb が待ち受けていない**。TVの開発者向けオプションで「ADB debugging / ネットワークデバッグ」をONにする（Android TV: 設定 → デバイス設定 → 開発者向けオプション）。再起動やスリープでポートが落ちることがある。USB接続できるなら `adb tcpip 5555` で開く。

### 2. スタックした adb を掃除して、サーバをバックグラウンド起動
```bash
pkill -9 -x adb 2>/dev/null; sleep 1
nohup adb nodaemon server > /tmp/adbserver.log 2>&1 &
disown
sleep 3
timeout 4 bash -c 'exec 3<>/dev/tcp/127.0.0.1/5037' && echo "5037 LISTENING"   # ローカルadbサーバが立ったか
```
サーバログ(`/tmp/adbserver.log`)に `loaded new key from '.../.android/adbkey'` 等が出ていれば起動成功。

### 3. 接続
```bash
timeout 15 adb connect 192.168.0.16:5555
timeout 15 adb devices -l
```
期待する出力:
```
192.168.0.16:5555   device   product:BRAVIA_VH2_M_JP model:BRAVIA_4K_VH2 device:BRAVIA_VH2 transport_id:1
```
`device` 状態なら認証も通っている。`unauthorized` なら TV画面に出る RSA 許可ダイアログを承認する。

### 4. 接続後にできること
```bash
adb install -r path/to/app.apk            # EASビルドAPKの sideload（再インストールは -r）
adb shell pm list packages | grep crate   # パッケージ確認
adb shell monkey -p <package> 1           # アプリ起動
adb logcat                                # ログ
```

## 補足
- サーバが一度バックグラウンドで立てば、以降の `adb install` / `adb shell` は（端末/サーバを再起動するまで）普通に通る。
- 典型フロー: `eas build -p android --profile preview` 完了 → Artifact URL から APK をダウンロード → `adb install -r` で TV に入れて、アイコン表示・ロック画面/通知の再生ウィジェットを実機確認。
