import { splitUrlToken } from "@/features/connect/splitUrlToken";

describe("splitUrlToken", () => {
  it("token 付き URL を分解する", () => {
    expect(splitUrlToken("http://192.168.1.5:8787/?token=abc")).toEqual({
      baseUrl: "http://192.168.1.5:8787",
      token: "abc",
    });
  });
  it("スキーム無し host:port でも分解する", () => {
    expect(splitUrlToken("192.168.1.5:8787?token=a%2Fb")).toEqual({
      baseUrl: "http://192.168.1.5:8787",
      token: "a/b",
    });
  });
  it("token が無ければ null", () => {
    expect(splitUrlToken("192.168.1.5:8787")).toBeNull();
    expect(splitUrlToken("http://h:1/?foo=bar")).toBeNull();
  });
  it("空 token は null", () => {
    expect(splitUrlToken("http://h:1/?token=")).toBeNull();
  });
});
