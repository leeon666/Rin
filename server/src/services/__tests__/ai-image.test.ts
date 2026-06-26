import { afterEach, describe, expect, it, mock } from "bun:test";
import { AIImageService } from "../ai-image";
import { cleanupTestDB, createTestUser, setupTestApp } from "../../../tests/fixtures";

const originalFetch = globalThis.fetch;

describe("AIImageService", () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("returns a generated image as an ephemeral data URL without storing it", async () => {
    const fetchCalls: string[] = [];
    globalThis.fetch = mock(async (input: RequestInfo | URL) => {
      fetchCalls.push(String(input));
      return new Response("unexpected storage call", { status: 500 });
    }) as typeof fetch;

    const { app, env, sqlite } = await setupTestApp(() => AIImageService(), {
      AI: {
        run: mock(async () => ({ image: "AQID" })),
      } as unknown as Ai,
    });

    try {
      createTestUser(sqlite);
      const response = await app.request("/image", {
        method: "POST",
        headers: {
          authorization: "Bearer mock_token_1",
          "content-type": "application/json",
        },
        body: JSON.stringify({ prompt: "test prompt", model: "@cf/test" }),
      }, env);

      expect(response.status).toBe(200);
      const payload = await response.json() as { url: string; key?: string; markdown: string };
      expect(payload.url).toBe("data:image/png;base64,AQID");
      expect(payload.key).toBeUndefined();
      expect(payload.markdown).toBe("![test prompt](data:image/png;base64,AQID)");
      expect(fetchCalls).toHaveLength(0);
    } finally {
      cleanupTestDB(sqlite);
    }
  });
});
