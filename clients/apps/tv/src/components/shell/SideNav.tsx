// 左サイドナビ（10ft UI のシェル左カラム）。
// ナビ項目 7 つ（ホーム/曲/アルバム/アーティスト/プレイリスト/検索/設定）＋ミニプレイヤー。
// D-pad 左端でフォーカスがナビに留まるよう FocusGuide で trapFocusLeft を設定。
// 各項目は Focusable を使用し、現在ルートのハイライトを usePathname で判定する。

import { View, Text, StyleSheet } from "react-native";
import { useRouter, usePathname } from "expo-router";
import { Ionicons } from "@expo/vector-icons";

import { Focusable } from "@/components/focus/Focusable";
import { FocusGuide } from "@/components/focus/FocusGuide";
import { PALETTE, TV_FONT, TV_LAYOUT, FOCUS_RING } from "@/theme/palette";

/** ナビ項目の定義。 */
const NAV_ITEMS = [
  { label: "ホーム", icon: "home-outline", route: "/" },
  { label: "曲", icon: "musical-notes-outline", route: "/songs" },
  { label: "アルバム", icon: "albums-outline", route: "/albums" },
  { label: "アーティスト", icon: "person-outline", route: "/artists" },
  { label: "プレイリスト", icon: "list-outline", route: "/playlists" },
  { label: "検索", icon: "search-outline", route: "/search" },
  { label: "設定", icon: "settings-outline", route: "/settings" },
] as const satisfies ReadonlyArray<{
  label: string;
  icon: React.ComponentProps<typeof Ionicons>["name"];
  route: string;
}>;

export function SideNav() {
  const router = useRouter();
  const pathname = usePathname();

  return (
    // D-pad 左端でフォーカスが外に出ないよう trapFocusLeft
    <FocusGuide trapFocusLeft style={styles.nav}>
      {/* ロゴ・アプリ名 */}
      <View style={styles.logoArea}>
        <Text style={styles.logoText}>Crateforge</Text>
        <Text style={styles.logoSub}>TV</Text>
      </View>

      {/* ナビ項目リスト */}
      <View style={styles.items}>
        {NAV_ITEMS.map((item, idx) => {
          const isActive = pathname === item.route;
          return (
            <Focusable
              key={item.route}
              // 最初の項目にデフォルトフォーカス（画面遷移後の初期フォーカス用）
              hasTVPreferredFocus={idx === 0}
              onSelect={() => {
                router.push(item.route as Parameters<typeof router.push>[0]);
              }}
              style={[styles.item, isActive && styles.itemActive]}
              focusedStyle={styles.itemFocused}
              accessibilityLabel={item.label}
            >
              <Ionicons
                name={item.icon}
                size={26}
                color={isActive ? PALETTE.teal : PALETTE.textSub}
              />
              <Text style={[styles.label, isActive && styles.labelActive]}>
                {item.label}
              </Text>
            </Focusable>
          );
        })}
      </View>

    </FocusGuide>
  );
}

const styles = StyleSheet.create({
  nav: {
    width: TV_LAYOUT.sideNavWidth,
    backgroundColor: PALETTE.navBg,
    borderRightWidth: 1,
    borderRightColor: PALETTE.border,
    flexDirection: "column",
    paddingTop: TV_LAYOUT.sideNavPaddingV,
  },
  logoArea: {
    flexDirection: "row",
    alignItems: "baseline",
    paddingHorizontal: TV_LAYOUT.sideNavPaddingH,
    marginBottom: 24,
    gap: 6,
  },
  logoText: {
    fontSize: TV_FONT.md,
    fontWeight: "700",
    color: PALETTE.teal,
  },
  logoSub: {
    fontSize: TV_FONT.xs,
    fontWeight: "400",
    color: PALETTE.textSub,
  },
  items: {
    gap: 4,
  },
  item: {
    flexDirection: "row",
    alignItems: "center",
    gap: 14,
    paddingHorizontal: TV_LAYOUT.sideNavPaddingH,
    height: TV_LAYOUT.navItemHeight,
    borderRadius: 8,
    marginHorizontal: 8,
    borderWidth: FOCUS_RING.borderWidth,
    borderColor: "transparent",
  },
  itemActive: {
    backgroundColor: PALETTE.navActive,
    borderColor: "transparent",
  },
  itemFocused: {
    borderWidth: FOCUS_RING.borderWidth,
    borderColor: PALETTE.teal,
    borderRadius: FOCUS_RING.borderRadius,
    backgroundColor: PALETTE.focusBg,
  },
  label: {
    fontSize: TV_FONT.sm,
    color: PALETTE.textSub,
    fontWeight: "400",
  },
  labelActive: {
    color: PALETTE.teal,
    fontWeight: "600",
  },
});
