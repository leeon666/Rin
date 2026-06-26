import "../../test/setup";
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { FeedCard } from "../feed_card";
import { ClientConfigContext, defaultClientConfigWrapper } from "../../state/config";

describe("FeedCard", () => {
  it("keeps space for cover images without embedded metadata", () => {
    const { container } = render(
      <ClientConfigContext.Provider value={defaultClientConfigWrapper}>
        <FeedCard
          id="1"
          title="Title"
          summary="Summary"
          hashtags={[]}
          createdAt={new Date("2026-06-20T00:00:00Z")}
          updatedAt={new Date("2026-06-20T00:00:00Z")}
          avatar="https://example.com/cover.jpg"
          preview
        />
      </ClientConfigContext.Provider>,
    );

    const imageFrame = container.querySelector("img")?.parentElement as HTMLElement;
    expect(imageFrame.style.aspectRatio).toBe("16 / 9");
  });
});
