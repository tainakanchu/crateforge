import * as SecureStore from "expo-secure-store";

import { useConnection } from "@crateforge/core";

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

const fetchMock = jest.fn();
const getItem = SecureStore.getItemAsync as jest.Mock;
const setItem = SecureStore.setItemAsync as jest.Mock;
const delItem = SecureStore.deleteItemAsync as jest.Mock;

const healthBody = { name: "crateforge", version: "0.7.1", trackCount: 3 };

beforeEach(() => {
  fetchMock.mockReset();
  global.fetch = fetchMock as unknown as typeof fetch;
  getItem.mockReset().mockResolvedValue(null);
  setItem.mockReset().mockResolvedValue(undefined);
  delItem.mockReset().mockResolvedValue(undefined);
  useConnection.setState({
    baseUrl: null,
    token: null,
    status: "idle",
    error: null,
    client: null,
  });
});

describe("connect", () => {
  it("connects and persists on healthy probe", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(healthBody));
    const ok = await useConnection.getState().connect("host:8787", "tok");
    expect(ok).toBe(true);
    const st = useConnection.getState();
    expect(st.status).toBe("connected");
    expect(st.client).not.toBeNull();
    expect(st.client?.baseUrl).toBe("http://host:8787");
    expect(setItem).toHaveBeenCalledWith("crateforge.baseUrl", "http://host:8787");
    expect(setItem).toHaveBeenCalledWith("crateforge.token", "tok");
  });

  it("fails and sets error on bad probe", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: "x" }, 500));
    const ok = await useConnection.getState().connect("host:8787", "tok");
    expect(ok).toBe(false);
    const st = useConnection.getState();
    expect(st.status).toBe("error");
    expect(st.client).toBeNull();
    expect(st.error).toBeTruthy();
  });

  it("rejects empty url without fetching", async () => {
    const ok = await useConnection.getState().connect("   ", "tok");
    expect(ok).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(useConnection.getState().status).toBe("error");
  });

  it("deletes token key when token is null", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(healthBody));
    await useConnection.getState().connect("host:8787", null);
    expect(delItem).toHaveBeenCalledWith("crateforge.token");
  });
});

describe("hydrate", () => {
  it("stays idle when nothing stored", async () => {
    await useConnection.getState().hydrate();
    expect(useConnection.getState().status).toBe("idle");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reconnects from stored creds", async () => {
    getItem.mockImplementation(async (k: string) =>
      k === "crateforge.baseUrl" ? "http://h:2" : "stored-tok",
    );
    fetchMock.mockResolvedValueOnce(jsonResponse(healthBody));
    await useConnection.getState().hydrate();
    const st = useConnection.getState();
    expect(st.status).toBe("connected");
    expect(st.client?.token).toBe("stored-tok");
  });

  it("marks error when stored server is unreachable", async () => {
    getItem.mockImplementation(async (k: string) =>
      k === "crateforge.baseUrl" ? "http://h:2" : null,
    );
    fetchMock.mockRejectedValueOnce(new Error("network down"));
    await useConnection.getState().hydrate();
    const st = useConnection.getState();
    expect(st.status).toBe("error");
    expect(st.baseUrl).toBe("http://h:2"); // info retained for retry
  });
});

describe("disconnect", () => {
  it("clears creds and resets", async () => {
    useConnection.setState({ baseUrl: "http://h:2", token: "t", status: "connected" });
    await useConnection.getState().disconnect();
    expect(delItem).toHaveBeenCalledWith("crateforge.baseUrl");
    expect(delItem).toHaveBeenCalledWith("crateforge.token");
    const st = useConnection.getState();
    expect(st.status).toBe("idle");
    expect(st.baseUrl).toBeNull();
    expect(st.client).toBeNull();
  });
});
