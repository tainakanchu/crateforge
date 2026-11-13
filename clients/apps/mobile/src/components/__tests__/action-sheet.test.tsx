import { render, screen, fireEvent, act, waitFor } from "@testing-library/react-native";

import ActionSheet, { ActionSheetHost, showActionSheet, useActionSheet } from "@/components/ActionSheet";

jest.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 20, left: 0 }),
}));

describe("ActionSheet", () => {
  beforeEach(() => {
    useActionSheet.setState({ current: null });
  });

  it("options が null のときは何も描画しない", async () => {
    await render(<ActionSheet options={null} onClose={() => {}} />);
    expect(screen.queryByText("キャンセル")).toBeNull();
  });

  it("4 つ以上の項目（Alert の上限超え）を全て表示する", async () => {
    const actions = Array.from({ length: 9 }, (_, i) => ({ label: `項目${i + 1}` }));
    await render(<ActionSheet options={{ title: "並び順", actions }} onClose={() => {}} />);
    for (let i = 1; i <= 9; i++) expect(screen.getByText(`項目${i}`)).toBeTruthy();
    expect(screen.getByText("並び順")).toBeTruthy();
    expect(screen.getByLabelText("キャンセル")).toBeTruthy();
  });

  it("項目を押すと閉じてから onPress が実行される", async () => {
    const onClose = jest.fn();
    const onPress = jest.fn();
    await render(
      <ActionSheet options={{ actions: [{ label: "次に再生", onPress }] }} onClose={onClose} />,
    );
    await fireEvent.press(screen.getByLabelText("次に再生"));
    expect(onClose).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(onPress).toHaveBeenCalledTimes(1));
  });

  it("キャンセルと背景タップで onPress 無しに閉じる", async () => {
    const onClose = jest.fn();
    const onPress = jest.fn();
    await render(<ActionSheet options={{ actions: [{ label: "A", onPress }] }} onClose={onClose} />);
    await fireEvent.press(screen.getByLabelText("キャンセル"));
    await fireEvent.press(screen.getByLabelText("メニューを閉じる", { includeHiddenElements: true }));
    expect(onClose).toHaveBeenCalledTimes(2);
    expect(onPress).not.toHaveBeenCalled();
  });

  it("選択中の項目に selected 状態と ✓ が付く", async () => {
    await render(
      <ActionSheet
        options={{ actions: [{ label: "名前", selected: true }, { label: "年" }] }}
        onClose={() => {}}
      />,
    );
    expect(screen.getByText("✓ 名前")).toBeTruthy();
    expect(screen.getByLabelText("名前").props.accessibilityState).toEqual({ selected: true });
  });

  it("showActionSheet → Host で表示され、選択後に閉じる", async () => {
    await render(<ActionSheetHost />);
    await act(async () => {
      showActionSheet({ title: "メニュー", actions: [{ label: "A" }, { label: "B" }] });
    });
    expect(screen.getByText("メニュー")).toBeTruthy();
    await fireEvent.press(screen.getByLabelText("A"));
    expect(useActionSheet.getState().current).toBeNull();
  });
});
