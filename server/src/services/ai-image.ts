import { Hono } from "hono";
import type { AppContext } from "../core/hono-types";
import { profileAsync } from "../core/server-timing";
import { deleteStorageObjects, listStorageObjects, putStorageObject } from "../utils/storage";
import { path_join } from "../utils/path";

const DEFAULT_IMAGE_MODEL = "@cf/stabilityai/stable-diffusion-xl-base-1.0";
const DEFAULT_WIDTH = 1024;
const DEFAULT_HEIGHT = 1024;
const DEFAULT_STEPS = 20;
const DEFAULT_GUIDANCE = 7.5;
const AI_IMAGE_PREFIX = "ai-images/";
const MAX_TEMP_AI_IMAGES = 3;

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

function extensionFromContentType(contentType: string) {
  const normalized = contentType.toLowerCase();
  if (normalized.includes("png")) return "png";
  if (normalized.includes("webp")) return "webp";
  return "jpg";
}

function buildStorageKey(contentType: string) {
  const date = new Date().toISOString().slice(0, 10);
  const extension = extensionFromContentType(contentType);
  return `${AI_IMAGE_PREFIX}${date}/${crypto.randomUUID()}.${extension}`;
}

function getTemporaryImageStoragePrefix(env: Env) {
  return path_join(env.S3_FOLDER || "", AI_IMAGE_PREFIX);
}

function waitUntil(c: AppContext, task: Promise<unknown>) {
  try {
    const executionCtx = (c as unknown as { executionCtx?: ExecutionContext }).executionCtx;
    if (executionCtx && typeof executionCtx.waitUntil === "function") {
      executionCtx.waitUntil(task);
      return;
    }
  } catch {
    // Hono throws when a request was not created with an ExecutionContext.
  }
  void task;
}

async function pruneTemporaryImages(env: Env, keepKey: string) {
  try {
    const storagePrefix = getTemporaryImageStoragePrefix(env);
    const objects = await listStorageObjects(env, storagePrefix);
    const sorted = objects
      .filter((object) => object.key.startsWith(storagePrefix))
      .sort((a, b) => {
        const aTime = a.modified ? Date.parse(a.modified) : 0;
        const bTime = b.modified ? Date.parse(b.modified) : 0;
        if (aTime !== bTime) return bTime - aTime;
        return b.key.localeCompare(a.key);
      });

    const protectedKeys = new Set(sorted.slice(0, MAX_TEMP_AI_IMAGES).map((object) => object.key));
    protectedKeys.add(keepKey);

    const staleKeys = sorted
      .filter((object) => !protectedKeys.has(object.key))
      .map((object) => object.key);

    if (staleKeys.length > 0) {
      await deleteStorageObjects(env, staleKeys);
    }
  } catch (error) {
    console.warn("AI image temporary cleanup failed", error);
  }
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
      const storageKey = buildStorageKey(image.contentType);
      const origin = new URL(c.req.url).origin;
      const stored = await profileAsync(c, "ai_image_store", () =>
        putStorageObject(env, storageKey, image.bytes, image.contentType, origin),
      );
      waitUntil(c, pruneTemporaryImages(env, stored.key));

      return c.json({
        url: stored.url,
        key: stored.key,
        markdown: `![${prompt.replace(/\]/g, "")}](${stored.url})`,
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




