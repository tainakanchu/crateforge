// pendingEdits ストアの enqueue / 置き換え / 衝突記録テスト。

import * as SecureStore from "expo-secure-store";

import { usePendingEdits } from "../pendingEdits";

const setItem = SecureStore.setItemAsync as jest.Mock;

beforeEach(() => {
  jest.clearAllMocks();
  setItem.mockResolvedValue(undefined);
  usePendingEdits.setState({
    ops: [],
    conflicts: [],
    flushing: false,
    hydrated: true,
  });
});

describe("usePendingEdits: あとで聴くの重複", () => {
  const kinds = () => usePendingEdits.getState().ops.map((o) => `${o.kind}:${o.trackId}`);

  it("同じ曲の review-later は 1 件にまとめる", () => {
    const { enqueue } = usePendingEdits.getState();
    enqueue({ kind: "review-later", trackId: 1 });
    enqueue({ kind: "review-later", trackId: 1 });
    enqueue({ kind: "review-later", trackId: 2 });
    expect(kinds()).toEqual(["review-later:1", "review-later:2"]);
  });

  it("以前の版が積んだ tag-add(review:later) も同じ曲なら review-later に置き換える", () => {
    const { enqueue } = usePendingEdits.getState();
    enqueue({ kind: "tag-add", trackId: 1, tag: "review:later" });
    enqueue({ kind: "tag-add", trackId: 1, tag: "mood:chill" });
    enqueue({ kind: "tag-add", trackId: 2, tag: "review:later" });
    enqueue({ kind: "review-later", trackId: 1 });
    expect(kinds()).toEqual(["tag-add:1", "tag-add:2", "review-later:1"]);
    expect(usePendingEdits.getState().ops[0]).toMatchObject({ tag: "mood:chill" });
  });
});

describe("usePendingEdits", () => {
  it("enqueue が id と createdAt を付与する", () => {
    const op = usePendingEdits.getState().enqueue({
      kind: "rating",
      trackId: 1,
      rating: 80,
      baseRating: null,
    });
    expect(op.id).toBeTruthy();
    expect(op.createdAt).toBeTruthy();
    expect(usePendingEdits.getState().ops).toHaveLength(1);
  });

  it("同一曲の rating は最新で置き換える", () => {
    usePendingEdits.getState().enqueue({
      kind: "rating",
      trackId: 1,
      rating: 40,
      baseRating: null,
    });
    usePendingEdits.getState().enqueue({
      kind: "rating",
      trackId: 1,
      rating: 100,
      baseRating: 40,
    });
    const ops = usePendingEdits.getState().ops;
    expect(ops).toHaveLength(1);
    expect(ops[0].kind).toBe("rating");
    if (ops[0].kind === "rating") {
      expect(ops[0].rating).toBe(100);
      expect(ops[0].baseRating).toBe(40);
    }
  });

  it("同一曲・同一タグの add は置き換える", () => {
    usePendingEdits.getState().enqueue({
      kind: "tag-add",
      trackId: 2,
      tag: "mood:chill",
    });
    usePendingEdits.getState().enqueue({
      kind: "tag-add",
      trackId: 2,
      tag: "mood:chill",
    });
    expect(usePendingEdits.getState().ops).toHaveLength(1);
  });

  it("markConflict は ops から外して conflicts に入れる", () => {
    const op = usePendingEdits.getState().enqueue({
      kind: "rating",
      trackId: 3,
      rating: 100,
      baseRating: 80,
    });
    if (op.kind !== "rating") throw new Error("expected rating");
    usePendingEdits.getState().markConflict(op, 40);
    expect(usePendingEdits.getState().ops).toHaveLength(0);
    expect(usePendingEdits.getState().conflicts).toHaveLength(1);
    expect(usePendingEdits.getState().conflicts[0].serverRating).toBe(40);
  });

  it("remove でキューから消える", () => {
    const op = usePendingEdits.getState().enqueue({
      kind: "review-later",
      trackId: 4,
    });
    usePendingEdits.getState().remove(op.id);
    expect(usePendingEdits.getState().ops).toHaveLength(0);
  });
});
