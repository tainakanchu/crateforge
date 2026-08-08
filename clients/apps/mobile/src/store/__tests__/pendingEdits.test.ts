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
