// createFilePersister の単体テスト。
// expo-file-system をインメモリ実装でローカルモックし、
// persistClient → restoreClient → removeClient の一連の動作を検証する。

import type { PersistedClient } from "@tanstack/react-query-persist-client";

// jest.mock はホイストされるため、ファクトリ内で参照できる変数名は
// "mock" プレフィックス（大文字小文字不問）で始まる必要がある。
// ファクトリの外から beforeEach でリセットするため、
// インスタンスは "mockFileState" 経由で管理する。

// インメモリ File のシングルトン状態。テスト間で beforeEach にリセットする。
// jest.mock ファクトリ内から直接参照されるので mockFs という名前にする。
let mockFs: {
  content: string | undefined;
  exists: boolean;
  create: () => void;
  write: (s: string) => void;
  text: () => Promise<string>;
  delete: () => void;
};

function makeMockFs() {
  return {
    content: undefined as string | undefined,
    get exists() {
      return this.content !== undefined;
    },
    create() {},
    write(s: string) {
      this.content = s;
    },
    text() {
      return Promise.resolve(this.content ?? "");
    },
    delete() {
      this.content = undefined;
    },
  };
}

jest.mock("expo-file-system", () => ({
  // File コンストラクタは常に mockFs を返す（同一インスタンスを共有）。
  // ファクトリ内では mockFs は参照できないため、jest.fn で後から差し込む。
  File: jest.fn(() => mockFs),
  Directory: jest.fn(() => ({ exists: true, create: jest.fn(), uri: "file:///mock/document" })),
  Paths: { document: { uri: "file:///mock/document" } },
}));

// モック設定後にインポートする（jest.mock はホイストされるので問題ない）。
import { createFilePersister } from "@/lib/queryPersister";

/** テスト用の最小 PersistedClient。 */
function makeClient(buster = "v1"): PersistedClient {
  return {
    timestamp: Date.now(),
    buster,
    clientState: { queries: [], mutations: [] },
  };
}

beforeEach(() => {
  // テストごとにインメモリ状態をリセット。
  mockFs = makeMockFs();
  const { File } = jest.requireMock("expo-file-system") as { File: jest.Mock };
  File.mockImplementation(() => mockFs);
});

describe("createFilePersister", () => {
  it("persistClient → restoreClient でデータをラウンドトリップできる", async () => {
    const persister = createFilePersister();
    const client = makeClient();

    await persister.persistClient(client);
    const restored = await persister.restoreClient();

    expect(restored).toEqual(client);
  });

  it("restoreClient: ファイルが存在しない場合は undefined を返す", async () => {
    const persister = createFilePersister();
    const result = await persister.restoreClient();
    expect(result).toBeUndefined();
  });

  it("restoreClient: 壊れた JSON でも undefined を返し例外をスローしない", async () => {
    const persister = createFilePersister();
    // 直接インメモリ状態に不正 JSON を書き込む。
    mockFs.content = "{ invalid json }}}";

    await expect(persister.restoreClient()).resolves.toBeUndefined();
  });

  it("removeClient: ファイルを削除し、以後の restoreClient が undefined になる", async () => {
    const persister = createFilePersister();
    await persister.persistClient(makeClient());

    // 削除前は存在する。
    expect(mockFs.exists).toBe(true);

    persister.removeClient();

    // 削除後はファイルが消える。
    expect(mockFs.exists).toBe(false);
    const result = await persister.restoreClient();
    expect(result).toBeUndefined();
  });

  it("removeClient: ファイルが存在しない状態でも例外をスローしない", () => {
    const persister = createFilePersister();
    expect(() => persister.removeClient()).not.toThrow();
  });

  it("persistClient: write() がエラーを投げても例外をスローしない", async () => {
    const persister = createFilePersister();
    mockFs.write = () => {
      throw new Error("disk full");
    };

    await expect(persister.persistClient(makeClient())).resolves.toBeUndefined();
  });
});
