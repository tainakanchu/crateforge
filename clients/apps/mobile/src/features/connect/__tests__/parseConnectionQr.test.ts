import { parseConnectionQr } from "@/features/connect/QrScanner";

describe("parseConnectionQr", () => {
  it("token 付き URL を baseUrl + token に分解する", () => {
    expect(parseConnectionQr("http://192.168.1.5:8787/?token=abc")).toEqual({
      baseUrl: "http://192.168.1.5:8787",
      token: "abc",
    });
  });

  it("token 無しなら token は null", () => {
    expect(parseConnectionQr("http://192.168.1.5:8787/")).toEqual({
      baseUrl: "http://192.168.1.5:8787",
      token: null,
    });
  });

  it("空 token は null 扱い", () => {
    expect(parseConnectionQr("http://192.168.1.5:8787/?token=")).toEqual({
      baseUrl: "http://192.168.1.5:8787",
      token: null,
    });
  });

  it("パス無し・https も扱える", () => {
    expect(parseConnectionQr("https://host.local:9000?token=xyz")).toEqual({
      baseUrl: "https://host.local:9000",
      token: "xyz",
    });
  });

  it("URL エンコードされた token をデコードする", () => {
    const parsed = parseConnectionQr("http://10.0.0.2:8787/?token=a%2Bb%3Dc");
    expect(parsed?.token).toBe("a+b=c");
  });

  it("不正な入力は null", () => {
    expect(parseConnectionQr("not a url")).toBeNull();
    expect(parseConnectionQr("")).toBeNull();
    expect(parseConnectionQr("ftp://192.168.1.5/?token=abc")).toBeNull();
  });
});
