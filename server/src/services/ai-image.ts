import { Hono } from "hono";
import type { AppContext } from "../core/hono-types";
import { profileAsync } from "../core/server-timing";

const DEFAULT_IMAGE_MODEL = "@cf/stabilityai/stable-diffusion-xl-base-1.0";
const DEFAULT_WIDTH = 1024;
const DEFAULT_HEIGHT = 1024;
const DEFAULT_STEPS = 20;
const DEFAULT_GUIDANCE = 7.5;

type ImageGenerationBody = {
  prompt?: string;
  negativePrompt?: string;
  model?: string;
  width?: number;
  height?: number;
  steps?: number;
  guidance?: number;
  seed?: number;
};

function clampInt(value: unknown, fallback: number, min: number, max: number) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, Math.round(numeric)));
}

function clampNumber(value: unknown, fallback: number, min: number, max: number) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, numeric));
}

function bytesFromBase64(value: string) {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

async function normalizeImageResult(result: unknown): Promise<{ bytes: Uint8Array; contentType: string }> {
  if (result instanceof Response) {
    const contentType = result.headers.get("content-type") || "image/jpeg";
    return { bytes: new Uint8Array(await result.arrayBuffer()), contentType };
  }

  if (result instanceof ReadableStream) {
    return { bytes: new Uint8Array(await new Response(result).arrayBuffer()), contentType: "image/jpeg" };
  }

  if (result instanceof Blob) {
    return { bytes: new Uint8Array(await result.arrayBuffer()), contentType: result.type || "image/jpeg" };
  }

  if (result instanceof ArrayBuffer) {
    return { bytes: new Uint8Array(result), contentType: "image/jpeg" };
  }

  if (result instanceof Uint8Array) {
    return { bytes: result, contentType: "image/jpeg" };
  }

  if (result && typeof result === "object" && "image" in result && typeof (result as { image?: unknown }).image === "string") {
    return { bytes: bytesFromBase64((result as { image: string }).image), contentType: "image/png" };
  }

  throw new Error("Workers AI did not return an image");
}

function bytesToBase64(bytes: Uint8Array) {
  let binary = "";
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    const chunk = bytes.subarray(index, index + chunkSize);
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}

function buildDataUrl(bytes: Uint8Array, contentType: string) {
  return `data:${contentType};base64,${bytesToBase64(bytes)}`;
}

export function AIImageService(): Hono {
  const app = new Hono();

  app.post("/image", async (c: AppContext) => {
    const admin = c.get("admin");
    if (!admin) {
      return c.text("Unauthorized", 401);
    }

    const env = c.get("env");
    if (!env.AI || typeof env.AI.run !== "function") {
      return c.json({ error: "Workers AI binding is not configured" }, 500);
    }

    const body = await profileAsync(c, "ai_image_body", async () =>
      c.req.json<ImageGenerationBody>().catch((): ImageGenerationBody => ({})),
    );
    const prompt = (body.prompt || "").trim();
    if (!prompt) {
      return c.json({ error: "Prompt is required" }, 400);
    }

    const model = (body.model || DEFAULT_IMAGE_MODEL).trim() || DEFAULT_IMAGE_MODEL;
    const width = clampInt(body.width, DEFAULT_WIDTH, 256, 2048);
    const height = clampInt(body.height, DEFAULT_HEIGHT, 256, 2048);
    const num_steps = clampInt(body.steps, DEFAULT_STEPS, 1, 20);
    const guidance = clampNumber(body.guidance, DEFAULT_GUIDANCE, 0, 20);
    const seed = body.seed === undefined || body.seed === null
      ? undefined
      : clampInt(body.seed, 0, 0, 2147483647);

    const inputs: Record<string, unknown> = {
      prompt,
      width,
      height,
      num_steps,
      guidance,
    };

    const negativePrompt = (body.negativePrompt || "").trim();
    if (negativePrompt) {
      inputs.negative_prompt = negativePrompt;
    }
    if (seed !== undefined) {
      inputs.seed = seed;
    }

    try {
      const aiResult = await profileAsync(c, "ai_image_generate", () => env.AI.run(model as any, inputs as any));
      const image = await profileAsync(c, "ai_image_normalize", () => normalizeImageResult(aiResult));
      const url = buildDataUrl(image.bytes, image.contentType);

      return c.json({
        url,
        markdown: `![${prompt.replace(/\]/g, "")}](${url})`,
        model,
        width,
        height,
        steps: num_steps,
        guidance,
        seed,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return c.json({ error: message }, 400);
    }
  });

  return app;
}




