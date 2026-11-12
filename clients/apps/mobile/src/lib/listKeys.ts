// FlatList の key。プレイリストは同じ曲を複数回含められるので trackId だけでは key が重複する
// （React の重複 key 警告・行の取り違え）。位置を添えて一意にする（round-3 N6）。

export function positionalTrackKey(t: { trackId: number }, index: number): string {
  return `${t.trackId}-${index}`;
}
