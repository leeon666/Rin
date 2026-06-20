import { path_join } from "./path";

import { buildS3ObjectUrl, createS3Client, putObject as putS3Object } from "./s3";

type StorageTarget =
  | {
      type: "cloudpaste";
      folder: string;
      apiBaseUrl: string;
      publicBaseUrl: string;
      uploadRoot: string;
      authToken: string;
    }
  | {
      type: "r2";
      bucket: R2Bucket;
      folder: string;
      publicBaseUrl: string;
    }
  | {
      type: "s3";
      env: Env;
      folder: string;
      publicBaseUrl: string;
};

type CloudPasteStorageTarget = Extract<StorageTarget, { type: "cloudpaste" }>;

function trimTrailingSlash(value: string) {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

function normalizeCloudPasteRoot(value?: string) {
  const raw = (value || "/").trim();
  const withLeading = raw.startsWith("/") ? raw : `/${raw}`;
  return withLeading.replace(/\/+/g, "/").replace(/\/+$/, "") || "/";
}

function buildCloudPasteAuthHeader(token: string) {
  return token.startsWith("ApiKey ") || token.startsWith("Bearer ") ? token : `ApiKey ${token}`;
}

function hasCloudPasteConfig(env: Env) {
  return Boolean(env.CLOUDPASTE_API_BASE || env.CLOUDPASTE_AUTH_TOKEN);
}

function resolveCloudPasteTarget(env: Env, folder: string): CloudPasteStorageTarget {
  if (!env.CLOUDPASTE_API_BASE) {
    throw new Error("CLOUDPASTE_API_BASE is not defined");
  }
  if (!env.CLOUDPASTE_AUTH_TOKEN) {
    throw new Error("CLOUDPASTE_AUTH_TOKEN is not defined");
  }

  return {
    type: "cloudpaste",
    folder,
    apiBaseUrl: trimTrailingSlash(env.CLOUDPASTE_API_BASE),
    publicBaseUrl: trimTrailingSlash(env.CLOUDPASTE_PUBLIC_BASE || env.CLOUDPASTE_API_BASE),
    uploadRoot: normalizeCloudPasteRoot(env.CLOUDPASTE_UPLOAD_PATH || "/"),
    authToken: env.CLOUDPASTE_AUTH_TOKEN,
  };
}

export function resolveStorageTarget(env: Env): StorageTarget {
  const folder = env.S3_FOLDER || "";
  const publicBaseUrl = trimTrailingSlash(env.S3_ACCESS_HOST || env.S3_ENDPOINT || "");

  if (hasCloudPasteConfig(env)) {
    return resolveCloudPasteTarget(env, folder);
  }

  if (env.R2_BUCKET) {
    return {
      type: "r2",
      bucket: env.R2_BUCKET,
      folder,
      publicBaseUrl,
    };
  }

  if (!env.S3_ENDPOINT) {
    throw new Error("S3_ENDPOINT is not defined");
  }
  if (!env.S3_ACCESS_KEY_ID) {
    throw new Error("S3_ACCESS_KEY_ID is not defined");
  }
  if (!env.S3_SECRET_ACCESS_KEY) {
    throw new Error("S3_SECRET_ACCESS_KEY is not defined");
  }
  if (!env.S3_BUCKET) {
    throw new Error("S3_BUCKET is not defined");
  }

  return {
    type: "s3",
    env,
    folder,
    publicBaseUrl,
  };
}

function buildS3BucketUrl(env: Env) {
  const endpoint = trimTrailingSlash(env.S3_ENDPOINT || "");
  const bucket = env.S3_BUCKET;
  if (env.S3_FORCE_PATH_STYLE === "true") {
    return `${endpoint}/${bucket}`;
  }
  const url = new URL(endpoint);
  return `${url.protocol}//${bucket}.${url.host}`;
}

function buildS3ListObjectsUrl(env: Env, prefix: string) {
  const url = new URL(buildS3BucketUrl(env));
  url.searchParams.set("list-type", "2");
  url.searchParams.set("prefix", prefix);
  return url.toString();
}

function decodeXmlText(value: string) {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function parseS3ListObjectsXml(xml: string): Array<{ key: string; modified?: string }> {
  const objects: Array<{ key: string; modified?: string }> = [];
  for (const match of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
    const body = match[1] || "";
    const key = body.match(/<Key>([\s\S]*?)<\/Key>/)?.[1];
    if (!key) continue;
    const modified = body.match(/<LastModified>([\s\S]*?)<\/LastModified>/)?.[1];
    objects.push({
      key: decodeXmlText(key),
      modified: modified ? decodeXmlText(modified) : undefined,
    });
  }
  return objects;
}
function encodeStorageKey(key: string) {
  return key
    .split("/")
    .filter((segment) => segment.length > 0)
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}

function buildBlobUrl(storageKey: string, baseUrl?: string) {
  const encodedKey = encodeStorageKey(storageKey);
  const path = `/api/blob/${encodedKey}`;

  if (!baseUrl) {
    return path;
  }

  return `${trimTrailingSlash(baseUrl)}${path}`;
}

function buildCloudPasteFsPath(env: Env, storageKey: string) {
  const root = normalizeCloudPasteRoot(env.CLOUDPASTE_UPLOAD_PATH || "/");
  return path_join(root, storageKey);
}

function toFetchBody(body: Blob | ArrayBuffer | Uint8Array | string): BodyInit {
  if (body instanceof Uint8Array) {
    const copy = new Uint8Array(body.byteLength);
    copy.set(body);
    return copy.buffer;
  }
  return body as BodyInit;
}

function splitCloudPasteUploadPath(fsPath: string) {
  const normalized = normalizeCloudPasteRoot(fsPath);
  const segments = normalized.split("/").filter(Boolean);
  const filename = segments.pop();

  if (!filename) {
    throw new Error("CloudPaste storage key must include a file name");
  }

  const directory = segments.length > 0 ? `/${segments.join("/")}/` : "/";
  return { directory, filename };
}

async function putCloudPasteObject(
  target: CloudPasteStorageTarget,
  fsPath: string,
  body: Blob | ArrayBuffer | Uint8Array | string,
  contentType?: string,
) {
  const { directory, filename } = splitCloudPasteUploadPath(fsPath);
  const url = new URL(`${target.apiBaseUrl}/api/fs/upload`);
  url.searchParams.set("path", directory);

  const headers = new Headers({
    Authorization: buildCloudPasteAuthHeader(target.authToken),
    "x-fs-filename": encodeURIComponent(filename),
  });

  if (contentType) {
    headers.set("Content-Type", contentType);
  }

  const response = await fetch(url.toString(), {
    method: "PUT",
    headers,
    body: toFetchBody(body),
  });

  if (!response.ok) {
    const details = await response.text().catch(() => "");
    const suffix = details.trim() ? `: ${details.slice(0, 500)}` : "";
    throw new Error(`CloudPaste upload failed: ${response.status} ${response.statusText}${suffix}`);
  }
}

async function listCloudPasteObjects(env: Env, prefix: string) {
  const target = resolveCloudPasteTarget(env, env.S3_FOLDER || "");
  const normalizedPrefix = prefix.endsWith("/") ? prefix : `${prefix}/`;
  const rootPath = buildCloudPasteFsPath(env, normalizedPrefix);
  const queue = [rootPath.endsWith("/") ? rootPath : `${rootPath}/`];
  const objects: Array<{ key: string; modified?: string }> = [];
  const seen = new Set<string>();

  while (queue.length > 0) {
    const currentPath = queue.shift() || "/";
    if (seen.has(currentPath)) continue;
    seen.add(currentPath);

    const url = new URL(`${target.apiBaseUrl}/api/fs/list`);
    url.searchParams.set("path", currentPath);
    url.searchParams.set("refresh", "true");

    const response = await fetch(url.toString(), {
      headers: { Authorization: buildCloudPasteAuthHeader(target.authToken) },
    });

    if (response.status === 404) {
      continue;
    }

    if (!response.ok) {
      throw new Error(`CloudPaste list failed: ${response.status} ${response.statusText}`);
    }

    const payload = await response.json().catch(() => null) as { data?: { items?: Array<Record<string, unknown>> } } | null;
    const items = Array.isArray(payload?.data?.items) ? payload.data.items : [];

    for (const item of items) {
      const itemPath = typeof item.path === "string" ? item.path : "";
      if (!itemPath) continue;
      if (item.isDirectory) {
        queue.push(itemPath.endsWith("/") ? itemPath : `${itemPath}/`);
        continue;
      }

      const key = itemPath.startsWith(target.uploadRoot)
        ? itemPath.slice(target.uploadRoot.length).replace(/^\/+/, "")
        : itemPath.replace(/^\/+/, "");
      if (key.startsWith(normalizedPrefix)) {
        objects.push({
          key,
          modified: typeof item.modified === "string" ? item.modified : undefined,
        });
      }
    }
  }

  return objects;
}

async function deleteCloudPasteObjects(env: Env, keys: string[]) {
  if (keys.length === 0) return;
  const target = resolveCloudPasteTarget(env, env.S3_FOLDER || "");
  const paths = keys.map((key) => buildCloudPasteFsPath(env, key));
  const response = await fetch(`${target.apiBaseUrl}/api/fs/batch-remove`, {
    method: "DELETE",
    headers: {
      Authorization: buildCloudPasteAuthHeader(target.authToken),
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ paths }),
  });

  if (!response.ok && response.status !== 404) {
    throw new Error(`CloudPaste delete failed: ${response.status} ${response.statusText}`);
  }
}
async function fetchCloudPasteObject(
  env: Env,
  storageKey: string,
  method: "GET" | "HEAD",
): Promise<Response | null> {
  const target = resolveCloudPasteTarget(env, env.S3_FOLDER || "");
  const fsPath = buildCloudPasteFsPath(env, storageKey);
  const url = new URL(`${target.apiBaseUrl}/api/fs/content`);
  url.searchParams.set("path", fsPath);

  const response = await fetch(url.toString(), {
    method: method === "HEAD" ? "GET" : method,
    headers: {
      Authorization: buildCloudPasteAuthHeader(target.authToken),
    },
  });

  if (response.status === 404) {
    return null;
  }

  if (!response.ok) {
    throw new Error(`Failed to fetch CloudPaste object: ${response.status} ${response.statusText}`);
  }

  if (method === "HEAD") {
    return new Response(null, {
      status: 200,
      headers: response.headers,
    });
  }

  return response;
}

function createStorageResponse(object: R2ObjectBody | R2Object, body?: BodyInit | null) {
  const headers = new Headers();
  object.writeHttpMetadata(headers);

  if (object.httpEtag) {
    headers.set("ETag", object.httpEtag);
  }

  if (!headers.has("Content-Length")) {
    headers.set("Content-Length", String(object.size));
  }

  if (!headers.has("Last-Modified")) {
    headers.set("Last-Modified", object.uploaded.toUTCString());
  }

  return new Response(body ?? null, {
    status: 200,
    headers,
  });
}

export async function getStorageObject(env: Env, storageKey: string): Promise<Response | null> {
  if (hasCloudPasteConfig(env)) {
    return fetchCloudPasteObject(env, storageKey, "GET");
  }

  if (env.R2_BUCKET) {
    const object = await env.R2_BUCKET.get(storageKey);
    if (!object) {
      return null;
    }
    return createStorageResponse(object, object.body);
  }

  const client = createS3Client(env);
  const response = await client.fetch(buildS3ObjectUrl(env, storageKey), {
    method: "GET",
  });

  if (response.status === 404) {
    return null;
  }

  if (!response.ok) {
    throw new Error(`Failed to fetch storage object: ${response.status} ${response.statusText}`);
  }

  return response;
}

export async function headStorageObject(env: Env, storageKey: string): Promise<Response | null> {
  if (hasCloudPasteConfig(env)) {
    return fetchCloudPasteObject(env, storageKey, "HEAD");
  }

  if (env.R2_BUCKET) {
    const object = await env.R2_BUCKET.head(storageKey);
    if (!object) {
      return null;
    }
    return createStorageResponse(object);
  }

  const client = createS3Client(env);
  const response = await client.fetch(buildS3ObjectUrl(env, storageKey), {
    method: "HEAD",
  });

  if (response.status === 404) {
    return null;
  }

  if (!response.ok) {
    throw new Error(`Failed to inspect storage object: ${response.status} ${response.statusText}`);
  }

  return response;
}

export function getStoragePublicUrl(env: Env, storageKey: string, baseUrl?: string) {
  if (hasCloudPasteConfig(env)) {
    return buildBlobUrl(storageKey, baseUrl);
  }

  if (env.S3_ACCESS_HOST) {
    return `${trimTrailingSlash(env.S3_ACCESS_HOST)}/${storageKey}`;
  }

  return buildBlobUrl(storageKey, baseUrl);
}

export async function putStorageObject(
  env: Env,
  key: string,
  body: Blob | ArrayBuffer | Uint8Array | string,
  contentType?: string,
  baseUrl?: string,
) {
  const target = resolveStorageTarget(env);
  const storageKey = path_join(target.folder, key);

  return putStorageObjectAtKey(env, storageKey, body, contentType, baseUrl);
}

export async function putStorageObjectAtKey(
  env: Env,
  storageKey: string,
  body: Blob | ArrayBuffer | Uint8Array | string,
  contentType?: string,
  baseUrl?: string,
) {
  if (hasCloudPasteConfig(env)) {
    const target = resolveCloudPasteTarget(env, env.S3_FOLDER || "");
    await putCloudPasteObject(target, buildCloudPasteFsPath(env, storageKey), body, contentType);
  } else if (env.R2_BUCKET) {
    await env.R2_BUCKET.put(storageKey, body, {
      httpMetadata: contentType ? { contentType } : undefined,
    });
  } else {
    const client = createS3Client(env);
    await putS3Object(client, env, storageKey, body, contentType);
  }

  return {
    key: storageKey,
    url: getStoragePublicUrl(env, storageKey, baseUrl),
  };
}

export async function listStorageObjects(env: Env, prefix: string): Promise<Array<{ key: string; modified?: string }>> {
  const normalizedPrefix = prefix.endsWith("/") ? prefix : `${prefix}/`;

  if (hasCloudPasteConfig(env)) {
    return listCloudPasteObjects(env, normalizedPrefix);
  }

  if (env.R2_BUCKET) {
    const result = await env.R2_BUCKET.list({ prefix: normalizedPrefix });
    return result.objects.map((object) => ({
      key: object.key,
      modified: object.uploaded.toISOString(),
    }));
  }

  const client = createS3Client(env);
  const response = await client.fetch(buildS3ListObjectsUrl(env, normalizedPrefix), {
    method: "GET",
  });

  if (!response.ok) {
    throw new Error(`Failed to list S3 objects: ${response.status} ${response.statusText}`);
  }

  return parseS3ListObjectsXml(await response.text());
}

export async function deleteStorageObjects(env: Env, keys: string[]) {
  const uniqueKeys = Array.from(new Set(keys.filter(Boolean)));
  if (uniqueKeys.length === 0) return;

  if (hasCloudPasteConfig(env)) {
    await deleteCloudPasteObjects(env, uniqueKeys);
    return;
  }

  if (env.R2_BUCKET) {
    await Promise.all(uniqueKeys.map((key) => env.R2_BUCKET!.delete(key)));
    return;
  }

  const client = createS3Client(env);
  await Promise.all(uniqueKeys.map(async (key) => {
    const response = await client.fetch(buildS3ObjectUrl(env, key), { method: "DELETE" });
    if (!response.ok && response.status !== 404) {
      throw new Error(`Failed to delete S3 object: ${response.status} ${response.statusText}`);
    }
  }));
}



