import "../../test/setup";
import { cleanup, render } from "@testing-library/react";
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
});
