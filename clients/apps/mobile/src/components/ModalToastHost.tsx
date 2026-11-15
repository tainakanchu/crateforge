// モーダル画面（presentation: "modal"）の中に置くトーストの表示先。
// ルートの <ToastHost /> は Stack の兄弟にあるため、iOS ではネイティブのモーダルの裏に隠れる。
// iOS のモーダル画面ではその中にもう 1 つ置いて、同じトーストを画面の上に出す。
// Android はモーダルも通常の画面で、ルートの ToastHost が上に重なるので置かない（二重表示を避ける）。
// 注: iOS 実機での表示は未確認。

import { Platform } from "react-native";

import { ToastHost } from "@/components/Toast";

export default function ModalToastHost() {
  if (Platform.OS !== "ios") return null;
  return <ToastHost />;
}
