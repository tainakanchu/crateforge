// TVFocusGuideView の薄いラッパー。
// TV デバイスでフォーカスの流れを制御する（例: 左端でサイドナビへ戻す、右端でコンテンツへ移す）。
// 非 TV 環境（dev / テスト）では素の View にフォールバックし、クラッシュしない。

import React from "react";
import { Platform, View, type ViewProps } from "react-native";

// TVFocusGuideView の prop 型（react-native TV ビルドに存在する）。
// 型定義がない環境でも TypeScript エラーにならないよう、ここで宣言する。
interface TVFocusGuideViewProps extends ViewProps {
  /** フォーカスを誘導したい要素の ref 配列。 */
  destinations?: React.RefObject<View | null>[];
  autoFocus?: boolean;
  focusable?: boolean;
  enabled?: boolean;
  /** 左端に来たとき、フォーカスをトラップ（戻さない）か。 */
  trapFocusLeft?: boolean;
  /** 右端に来たとき、フォーカスをトラップするか。 */
  trapFocusRight?: boolean;
  /** 上端に来たとき、フォーカスをトラップするか。 */
  trapFocusUp?: boolean;
  /** 下端に来たとき、フォーカスをトラップするか。 */
  trapFocusDown?: boolean;
}

// TV ビルドの TVFocusGuideView を動的に取得する。
// Platform.isTV のガードで非 TV 環境では null にする。
const TVFocusGuideViewNative: React.ComponentType<TVFocusGuideViewProps> | null = (() => {
  if (!Platform.isTV) return null;
  try {
    // react-native の TV ビルドに含まれる（Android TV / Apple TV 共通）。
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const RN = require("react-native") as Record<string, unknown>;
    if ("TVFocusGuideView" in RN && typeof RN.TVFocusGuideView === "function") {
      return RN.TVFocusGuideView as React.ComponentType<TVFocusGuideViewProps>;
    }
  } catch {
    // ロード失敗（TV 以外のビルド等）: フォールバックへ
  }
  return null;
})();

export interface FocusGuideProps extends TVFocusGuideViewProps {
  children?: React.ReactNode;
}

/**
 * TVFocusGuideView のフォールバック付きラッパー。
 *
 * ## 使い方（後続エージェント向け）
 *
 * ### サイドナビ全体をトラップ（左端から抜けさせない）
 * ```tsx
 * <FocusGuide trapFocusLeft style={styles.nav}>
 *   {navItems.map(...)}
 * </FocusGuide>
 * ```
 *
 * ### フォーカスを特定の要素へ誘導
 * ```tsx
 * const firstItemRef = useRef<View>(null);
 * <FocusGuide destinations={[firstItemRef]}>
 *   <View ref={firstItemRef}>...</View>
 * </FocusGuide>
 * ```
 *
 * 非 TV 環境では `destinations`, `trapFocus*` 等のプロップは無視され、素の View として動作する。
 */
export function FocusGuide({ children, ...props }: FocusGuideProps) {
  if (!TVFocusGuideViewNative) {
    // 非 TV 環境: TV 固有 prop を除いた View にフォールバック
    const {
      destinations: _d,
      autoFocus: _a,
      focusable: _f,
      enabled: _e,
      trapFocusLeft: _l,
      trapFocusRight: _r,
      trapFocusUp: _u,
      trapFocusDown: _dn,
      ...viewProps
    } = props;
    return <View {...viewProps}>{children}</View>;
  }

  return (
    <TVFocusGuideViewNative {...props}>
      {children}
    </TVFocusGuideViewNative>
  );
}
