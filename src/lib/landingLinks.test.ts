import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("landingLinks", () => {
  it("keeps app destinations on the current origin by default", async () => {
    vi.resetModules();
    const { APP_URL, appHref } = await import("./landingLinks");

    expect(APP_URL).toBe("");
    expect(appHref("/app/jobs")).toBe("/app/jobs");
    expect(appHref("app/jobs")).toBe("/app/jobs");
    expect(appHref("/")).toBe("/");
  });

  it("moves app destinations to VITE_APP_URL without a double slash", async () => {
    vi.stubEnv("VITE_APP_URL", "https://app.clearance.example/");
    vi.resetModules();
    const { APP_URL, appHref } = await import("./landingLinks");

    expect(APP_URL).toBe("https://app.clearance.example");
    expect(appHref("/app/jobs")).toBe("https://app.clearance.example/app/jobs");
    expect(appHref("auth")).toBe("https://app.clearance.example/auth");
  });
});
