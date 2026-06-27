import "../../test/setup";
import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BlogWidgets } from "../blog-widgets";

let currentLocation = "/";

vi.mock("wouter", () => ({
  useLocation: () => [currentLocation, vi.fn()],
}));

describe("BlogWidgets", () => {
  beforeEach(() => {
    currentLocation = "/";
    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      value: 1024,
    });
  });

  afterEach(() => {
    cleanup();
    Reflect.deleteProperty(globalThis, "APlayer");
    Reflect.deleteProperty(globalThis, "fetch");
    document.head.innerHTML = "";
    document.body.innerHTML = "";
  });

  it("keeps Live2D assets mounted while admin routes are hidden and restores them on return", () => {
    const { rerender } = render(<BlogWidgets />);
    const waifu = document.createElement("div");
    waifu.id = "waifu";
    document.body.appendChild(waifu);

    currentLocation = "/admin/writing";
    rerender(<BlogWidgets />);

    expect(document.getElementById("waifu")).toBe(waifu);
    expect(waifu.style.display).toBe("none");

    currentLocation = "/";
    rerender(<BlogWidgets />);

    expect(document.getElementById("waifu")).toBe(waifu);
    expect(waifu.style.display).toBe("");
  });

  it("keeps APlayer assets loaded and uses the local music list", async () => {
    let playerAudio: Array<{ name: string; artist: string; url: string }> = [];
    (globalThis as typeof globalThis & { APlayer?: unknown }).APlayer = vi.fn((opts: { container: HTMLElement; audio: Array<{ name: string; artist: string; url: string }> }) => {
      opts.container.className = "aplayer aplayer-fixed aplayer-narrow";
      playerAudio = opts.audio;
      return { destroy: vi.fn(), list: { show: vi.fn(), hide: vi.fn(), audios: [] } };
    });

    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url !== "/api/music/list") {
        throw new Error(`Unexpected playlist request: ${url}`);
      }
      return new Response(JSON.stringify({ songs: [{ name: "Local", title: "Local", artist: "Artist", url: "/api/music/stream/local" }] }), { status: 200 });
    });
    (globalThis as typeof globalThis & { fetch?: unknown }).fetch = fetchMock as typeof fetch;

    render(<BlogWidgets />);

    const script = document.getElementById("rin-aplayer-script") as HTMLScriptElement;
    expect(script).toBeTruthy();
    script.dispatchEvent(new Event("load"));

    await waitFor(() => {
      expect(document.querySelector(".aplayer")).toBeTruthy();
    });
    expect(document.getElementById("rin-aplayer-css")).toBeTruthy();
    expect(document.getElementById("rin-aplayer-script")).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith("/api/music/list", { cache: "no-store" });
    expect(playerAudio).toHaveLength(1);
    expect(playerAudio[0]?.url).toBe("/api/music/stream/local");
  });

  it("keeps the music player alive on admin routes instead of destroying playback", async () => {
    const destroy = vi.fn();
    (globalThis as typeof globalThis & { APlayer?: unknown }).APlayer = vi.fn((opts: { container: HTMLElement; audio: Array<{ name: string; artist: string; url: string }> }) => {
      opts.container.className = "aplayer aplayer-fixed aplayer-narrow";
      return { destroy, list: { show: vi.fn(), hide: vi.fn(), audios: opts.audio } };
    });

    (globalThis as typeof globalThis & { fetch?: unknown }).fetch = vi.fn(async () => {
      return new Response(JSON.stringify({ songs: [{ name: "Local", title: "Local", artist: "Artist", url: "/api/music/stream/local" }] }), { status: 200 });
    }) as typeof fetch;

    const { rerender } = render(<BlogWidgets />);
    const script = document.getElementById("rin-aplayer-script") as HTMLScriptElement;
    script.dispatchEvent(new Event("load"));

    await waitFor(() => {
      expect(document.querySelector("#rin-music-widget")).toBeTruthy();
    });

    const wrapper = document.getElementById("rin-music-widget") as HTMLElement;
    expect(wrapper).toBeTruthy();
    expect(wrapper.style.display).toBe("");

    currentLocation = "/admin/writing";
    rerender(<BlogWidgets />);

    expect(document.getElementById("rin-music-widget")).toBe(wrapper);
    expect(wrapper.style.display).toBe("none");
    expect(destroy).not.toHaveBeenCalled();

    currentLocation = "/";
    rerender(<BlogWidgets />);

    expect(document.getElementById("rin-music-widget")).toBe(wrapper);
    expect(wrapper.style.display).toBe("");
    expect(destroy).not.toHaveBeenCalled();
  });

  it("keeps advancing to the next song when the current audio ends", async () => {
    const switchAudio = vi.fn();
    const play = vi.fn();
    const audio = document.createElement("audio");
    (globalThis as typeof globalThis & { APlayer?: unknown }).APlayer = vi.fn((opts: { container: HTMLElement; audio: Array<{ name: string; artist: string; url: string }> }) => {
      opts.container.className = "aplayer aplayer-fixed aplayer-narrow";
      return {
        destroy: vi.fn(),
        list: { show: vi.fn(), hide: vi.fn(), audios: opts.audio, index: 0, switch: switchAudio },
        audio,
        play,
      };
    });

    (globalThis as typeof globalThis & { fetch?: unknown }).fetch = vi.fn(async () => {
      return new Response(JSON.stringify({ songs: [
        { name: "One", title: "One", artist: "Artist", url: "/api/music/stream/one" },
        { name: "Two", title: "Two", artist: "Artist", url: "/api/music/stream/two" },
      ] }), { status: 200 });
    }) as typeof fetch;

    render(<BlogWidgets />);

    const script = document.getElementById("rin-aplayer-script") as HTMLScriptElement;
    script.dispatchEvent(new Event("load"));

    await waitFor(() => {
      expect(document.querySelector(".aplayer")).toBeTruthy();
    });

    audio.dispatchEvent(new Event("ended"));

    expect(switchAudio).toHaveBeenCalledWith(1);
    expect(play).toHaveBeenCalledTimes(1);
  });
});
