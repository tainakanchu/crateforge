// jest-expo 用のグローバルモック。ネイティブモジュールはここで既定モックを与える。
// 各テストは jest.spyOn / jest.mock で個別に上書きできる。

/* eslint-disable @typescript-eslint/no-require-imports */

// --- react-native-reanimated（ナビ/タブが間接的に使う）---
jest.mock("react-native-reanimated", () => {
  try {
    const Reanimated = require("react-native-reanimated/mock");
    if (Reanimated?.default) Reanimated.default.call = () => {};
    return Reanimated;
  } catch {
    return {};
  }
});

// --- expo-secure-store ---
jest.mock("expo-secure-store", () => ({
  getItemAsync: jest.fn(async () => null),
  setItemAsync: jest.fn(async () => undefined),
  deleteItemAsync: jest.fn(async () => undefined),
}));

// --- expo-audio ---
jest.mock("expo-audio", () => {
  const makePlayer = () => ({
    id: "mock-player",
    playing: false,
    muted: false,
    loop: false,
    paused: true,
    isLoaded: true,
    isBuffering: false,
    currentTime: 0,
    duration: 0,
    volume: 1,
    playbackRate: 1,
    play: jest.fn(),
    pause: jest.fn(),
    replace: jest.fn(),
    seekTo: jest.fn(async () => undefined),
    setPlaybackRate: jest.fn(),
    setActiveForLockScreen: jest.fn(),
    updateLockScreenMetadata: jest.fn(),
    clearLockScreenControls: jest.fn(),
    addListener: jest.fn(() => ({ remove: jest.fn() })),
    remove: jest.fn(),
  });
  return {
    createAudioPlayer: jest.fn(() => makePlayer()),
    setAudioModeAsync: jest.fn(async () => undefined),
    setIsAudioActiveAsync: jest.fn(async () => undefined),
    requestNotificationPermissionsAsync: jest.fn(async () => ({ granted: true, status: "granted" })),
  };
});

// --- expo-file-system (new File/Directory/Paths API) ---
jest.mock("expo-file-system", () => {
  class MockFile {
    uri: string;
    exists = false;
    size = 0;
    constructor(...parts: unknown[]) {
      this.uri =
        "file:///mock/" +
        parts
          .map((p) => (typeof p === "string" ? p : ((p as { uri?: string })?.uri ?? "")))
          .join("/");
    }
    create() {}
    delete() {
      this.exists = false;
    }
    text() {
      return Promise.resolve("");
    }
    write() {}
  }
  class MockDirectory {
    uri: string;
    exists = true;
    constructor(...parts: unknown[]) {
      this.uri = "file:///mock/" + parts.map((p) => String(p)).join("/");
    }
    create() {}
    list() {
      return [] as unknown[];
    }
  }
  return {
    File: Object.assign(MockFile, {
      downloadFileAsync: jest.fn(async () => {
        const f = new MockFile("downloaded");
        f.exists = true;
        f.size = 1024;
        return f;
      }),
      createDownloadTask: jest.fn(() => ({ start: jest.fn(async () => undefined) })),
    }),
    Directory: MockDirectory,
    Paths: { document: new MockDirectory("document"), cache: new MockDirectory("cache") },
  };
});

// --- expo-camera ---
jest.mock("expo-camera", () => {
  const React = require("react");
  return {
    CameraView: (props: Record<string, unknown>) =>
      React.createElement("CameraView", props, (props as { children?: unknown }).children),
    useCameraPermissions: jest.fn(() => [
      { granted: true, status: "granted", canAskAgain: true },
      jest.fn(async () => ({ granted: true, status: "granted" })),
    ]),
  };
});

// --- expo-image ---
jest.mock("expo-image", () => {
  const React = require("react");
  return {
    Image: (props: Record<string, unknown>) =>
      React.createElement("ExpoImage", props, (props as { children?: unknown }).children),
  };
});

// --- expo-router ---
jest.mock("expo-router", () => {
  const React = require("react");
  const router = {
    push: jest.fn(),
    replace: jest.fn(),
    back: jest.fn(),
    navigate: jest.fn(),
    setParams: jest.fn(),
    dismiss: jest.fn(),
    dismissAll: jest.fn(),
    canGoBack: jest.fn(() => true),
  };
  const withScreen = (name: string) => {
    const Comp = (props: Record<string, unknown>) =>
      React.createElement(name, props, (props as { children?: unknown }).children);
    (Comp as unknown as { Screen: unknown }).Screen = (props: Record<string, unknown>) =>
      React.createElement(`${name}.Screen`, props, (props as { children?: unknown }).children);
    return Comp;
  };
  return {
    router,
    useRouter: () => router,
    useLocalSearchParams: jest.fn(() => ({})),
    useGlobalSearchParams: jest.fn(() => ({})),
    usePathname: jest.fn(() => "/"),
    useSegments: jest.fn(() => []),
    useFocusEffect: jest.fn(),
    useNavigation: jest.fn(() => ({ setOptions: jest.fn() })),
    Link: (props: Record<string, unknown>) =>
      React.createElement("Link", props, (props as { children?: unknown }).children),
    Redirect: (props: Record<string, unknown>) =>
      React.createElement("Redirect", props, (props as { children?: unknown }).children),
    Stack: withScreen("Stack"),
    Tabs: withScreen("Tabs"),
  };
});
