import { Hono } from "hono";
import type { Variables } from "../core/hono-types";

// Cached CloudPaste auth token (survives across requests in the same isolate)
interface CachedToken {
    token: string;
    expiresAt: number; // ms timestamp
}

let cachedToken: CachedToken | null = null;

// Cached file listing (refresh every 10 minutes)
interface CachedListing {
    items: Array<{ name: string; path: string }>;
    fetchedAt: number;
}

let cachedListing: CachedListing | null = null;
const LISTING_CACHE_MS = 10 * 60 * 1000; // 10 minutes

const CLOUDPASTE_MOUNT = "tigris";
const CLOUDPASTE_MUSIC_FOLDER = "music";
function getPublicMusicId(filename: string): string {
    let hash = 2166136261;
    for (let i = 0; i < filename.length; i++) {
        hash ^= filename.charCodeAt(i);
        hash = Math.imul(hash, 16777619);
    }
    return `m-${(hash >>> 0).toString(36)}-${filename.length.toString(36)}`;
}

function getAudioContentType(filename: string): string {
    const ext = filename.split(".").pop()?.toLowerCase();
    switch (ext) {
        case "mp3": return "audio/mpeg";
        case "m4a": return "audio/mp4";
        case "flac": return "audio/flac";
        case "wav": return "audio/wav";
        case "ogg": return "audio/ogg";
        case "aac": return "audio/aac";
        case "wma": return "audio/x-ms-wma";
        default: return "application/octet-stream";
    }
}

async function getCloudPasteToken(env: Env): Promise<string | null> {
    // Return cached token if still valid (with 1 hour buffer)
    if (cachedToken && cachedToken.expiresAt > Date.now() + 3600 * 1000) {
        return cachedToken.token;
    }

    const baseUrl = env.CLOUDPASTE_API_BASE || "https://cloudpaste-leeon-backend.leeon123.workers.dev";
    const username = env.CLOUDPASTE_USERNAME;
    const password = env.CLOUDPASTE_PASSWORD;

    if (!username || !password) {
        console.error("[music-proxy] CLOUDPASTE_USERNAME or CLOUDPASTE_PASSWORD not set");
        return null;
    }

    try {
        const resp = await fetch(`${baseUrl}/api/admin/login`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ username, password }),
        });

        if (!resp.ok) {
            console.error(`[music-proxy] Login failed: ${resp.status}`);
            return null;
        }

        const data = await resp.json() as any;
        if (!data.success || !data.data?.token) {
            console.error(`[music-proxy] Login response:`, data);
            return null;
        }

        const expiresAt = data.data.expiresAt
            ? new Date(data.data.expiresAt).getTime()
            : Date.now() + 6 * 24 * 60 * 60 * 1000; // fallback 6 days

        cachedToken = {
            token: data.data.token,
            expiresAt,
        };

        return cachedToken.token;
    } catch (e) {
        console.error("[music-proxy] Login error:", e);
        return null;
    }
}

async function getPresignedUrl(env: Env, musicPath: string): Promise<string | null> {
    const token = await getCloudPasteToken(env);
    if (!token) return null;

    const baseUrl = env.CLOUDPASTE_API_BASE || "https://cloudpaste-leeon-backend.leeon123.workers.dev";
    const fullPath = `/${CLOUDPASTE_MOUNT}/${CLOUDPASTE_MUSIC_FOLDER}/${musicPath}`;
    const encodedPath = encodeURIComponent(fullPath);

    // Use /api/fs/download which returns 302 to a pre-signed URL
    const resp = await fetch(`${baseUrl}/api/fs/download?path=${encodedPath}`, {
        method: "HEAD",
        redirect: "manual",
        headers: { "Authorization": `Bearer ${token}` },
    });

    if (resp.status === 401) {
        // Token expired, clear cache and retry once
        cachedToken = null;
        const newToken = await getCloudPasteToken(env);
        if (!newToken) return null;

        const retryResp = await fetch(`${baseUrl}/api/fs/download?path=${encodedPath}`, {
            method: "HEAD",
            redirect: "manual",
            headers: { "Authorization": `Bearer ${newToken}` },
        });

        const location = retryResp.headers.get("location");
        return location;
    }

    if (resp.status !== 302) {
        console.error(`[music-proxy] download returned ${resp.status}, expected 302`);
        return null;
    }

    return resp.headers.get("location");
}

// List all audio files in the Tigris music folder via CloudPaste API
export async function listMusicFiles(env: Env): Promise<Array<{ name: string; path: string }>> {
    // Return cached listing if fresh
    if (cachedListing && Date.now() - cachedListing.fetchedAt < LISTING_CACHE_MS) {
        return cachedListing.items;
    }

    const token = await getCloudPasteToken(env);
    if (!token) return [];

    const baseUrl = env.CLOUDPASTE_API_BASE || "https://cloudpaste-leeon-backend.leeon123.workers.dev";
    const folderPath = `/${CLOUDPASTE_MOUNT}/${CLOUDPASTE_MUSIC_FOLDER}`;
    const encodedPath = encodeURIComponent(folderPath);

    try {
        const resp = await fetch(`${baseUrl}/api/fs/list?path=${encodedPath}`, {
            headers: { "Authorization": `Bearer ${token}` },
        });

        if (resp.status === 401) {
            cachedToken = null;
            const newToken = await getCloudPasteToken(env);
            if (!newToken) return [];

            const retryResp = await fetch(`${baseUrl}/api/fs/list?path=${encodedPath}`, {
                headers: { "Authorization": `Bearer ${newToken}` },
            });
            const data = await retryResp.json() as any;
            if (!data.success) return [];
            return extractAudioFiles(data);
        }

        const data = await resp.json() as any;
        if (!data.success) return [];

        const items = extractAudioFiles(data);
        cachedListing = { items, fetchedAt: Date.now() };
        return items;
    } catch (e) {
        console.error("[music-proxy] List error:", e);
        return [];
    }
}

function extractAudioFiles(data: any): Array<{ name: string; path: string }> {
    const items = data?.data?.items;
    if (!Array.isArray(items)) return [];
    return items
        .filter((item: any) => {
            const name: string = item.name || "";
            return /\.(m4a|mp3|flac|wav|ogg|aac|wma)$/i.test(name);
        })
        .map((item: any) => ({
            name: item.name,
            path: item.name, // just the filename, the proxy handles the full path
        }));
}

function stripUploadSuffix(base: string): string {
    return base
        .replace(/#[A-Za-z0-9_-]{4,}$/, "")
        .replace(/_[A-Za-z0-9_-]{5,}$/, "")
        .trim();
}

function tidyCompactDisplay(value: string): string {
    return value
        .replace(/[._]+/g, " ")
        .replace(/\s+/g, " ")
        .trim();
}

// Parse "artist - title.ext" and compact "title-artist#suffix.ext" formats from filename.
function parseFilename(name: string): { artist: string; title: string } {
    const base = stripUploadSuffix(name.replace(/\.[^.]+$/, ""));
    const idx = base.indexOf(" - ");
    if (idx > 0) {
        return {
            artist: base.substring(0, idx).trim(),
            title: base.substring(idx + 3).trim(),
        };
    }

    const compactReverse = base.match(/^(.+?)[._\s]*-[._\s]*(.+)$/);
    if (compactReverse && /[._]/.test(compactReverse[1]) && !/[._]/.test(compactReverse[2])) {
        return {
            artist: tidyCompactDisplay(compactReverse[2]),
            title: tidyCompactDisplay(compactReverse[1]),
        };
    }

    return { artist: "", title: tidyCompactDisplay(base) };
}

async function resolveMusicFilename(env: Env, requested: string): Promise<string | null> {
    const decoded = decodeURIComponent(requested);
    const files = await listMusicFiles(env);
    const byId = files.find(file => getPublicMusicId(file.name) === decoded);
    if (byId) return byId.name;

    const byFilename = files.find(file => file.name === decoded);
    return byFilename?.name ?? null;
}

async function streamMusicFile(env: Env, filename: string, request: Request): Promise<Response> {
    const presignedUrl = await getPresignedUrl(env, filename);
    if (!presignedUrl) {
        return new Response("Failed to get music URL", { status: 502 });
    }

    const requestHeaders = new Headers();
    const range = request.headers.get("range");
    const ifRange = request.headers.get("if-range");
    if (range) requestHeaders.set("range", range);
    if (ifRange) requestHeaders.set("if-range", ifRange);

    const upstream = await fetch(presignedUrl, {
        headers: requestHeaders,
        redirect: "follow",
    });

    const headers = new Headers();
    for (const header of ["accept-ranges", "content-length", "content-range", "etag", "last-modified"]) {
        const value = upstream.headers.get(header);
        if (value) headers.set(header, value);
    }
    headers.set("Content-Type", upstream.headers.get("content-type") || getAudioContentType(filename));
    headers.set("Cache-Control", "private, max-age=3600");
    headers.set("Content-Disposition", "inline");
    headers.set("X-Content-Type-Options", "nosniff");

    return new Response(upstream.body, {
        status: upstream.status,
        statusText: upstream.statusText,
        headers,
    });
}

export function MusicProxyService(): Hono<{
    Bindings: Env;
    Variables: Variables;
}> {
    const app = new Hono<{
        Bindings: Env;
        Variables: Variables;
    }>();

    // GET /list - List all VIP songs from Tigris storage
    app.get("/list", async (c) => {
        try {
            const env = c.env;
            const files = await listMusicFiles(env);
            const songs = files.map((f) => {
                const parsed = parseFilename(f.name);
                const id = getPublicMusicId(f.name);
                return {
                    id,
                    name: parsed.title,
                    artist: parsed.artist,
                    title: parsed.title,
                    url: "/api/music/stream/" + encodeURIComponent(id),
                };
            });
            c.header("Cache-Control", "no-store");
            return c.json({ songs });
        } catch (e: any) {
            console.error("[music-proxy] List error:", e?.message || e);
            return c.json({ songs: [] });
        }
    });

    // POST /upload - Upload file to CloudPaste Tigris
    app.post("/upload", async (c) => {
        const admin = c.get("admin");
        if (!admin) return c.text("Unauthorized", 401);

        try {
            const env = c.env;
            const formData = await c.req.formData();
            const file = formData.get("file") as File | null;
            if (!file) return c.json({ error: "No file provided" }, 400);

            // sanitize filename: remove characters that break URLs / CloudPaste paths
            const originalName = file.name || "unknown";
            const safeName = originalName.replace(/[/\\?#%]/g, "_");

            // Rebuild the uploaded File as a Blob before forwarding it to CloudPaste.
            // This avoids losing the body when the Worker proxies multipart data.
            const fileBuffer = await file.arrayBuffer();
            const fileBlob = new Blob([fileBuffer], { type: file.type || "application/octet-stream" });

            const token = await getCloudPasteToken(env);
            if (!token) return c.json({ error: "Failed to authenticate with CloudPaste" }, 502);

            const baseUrl = env.CLOUDPASTE_API_BASE || "https://cloudpaste-leeon-backend.leeon123.workers.dev";
            const uploadPath = `/${CLOUDPASTE_MOUNT}/${CLOUDPASTE_MUSIC_FOLDER}`;

            const uploadForm = new FormData();
            uploadForm.append("file", fileBlob, safeName);
            uploadForm.append("path", uploadPath);
            uploadForm.append("filename", safeName);
            uploadForm.append("overwrite", "true");

            const uploadResp = await fetch(
                `${baseUrl}/api/fs/upload`,
                {
                    method: "POST",
                    headers: { Authorization: `Bearer ${token}` },
                    body: uploadForm,
                }
            );

            const respBody = await uploadResp.text();
            if (!uploadResp.ok) {
                console.error(`[music-proxy] Upload failed: ${uploadResp.status} ${respBody}`);
                return c.json({ error: `Upload failed: ${respBody}` }, 502);
            }

            // Clear listing cache so next request picks up the new file
            cachedListing = null;

            return c.json({
                success: true,
                filename: safeName,
                originalName,
                path: `/${CLOUDPASTE_MOUNT}/${CLOUDPASTE_MUSIC_FOLDER}/${safeName}`,
                cloudpaste: (() => { try { return JSON.parse(respBody); } catch { return null; } })(),
            });
        } catch (e: any) {
            console.error("[music-proxy] Upload error:", e?.message || e);
            return c.json({ error: `Upload error: ${e?.message || "unknown"}` }, 500);
        }
    });

    // GET /stream/:id - Stream via this Worker so the player never sees CloudPaste URLs.
    app.get("/stream/:id", async (c) => {
        try {
            const filename = await resolveMusicFilename(c.env, c.req.param("id"));
            if (!filename) {
                return c.text("Music file not found", 404);
            }

            return streamMusicFile(c.env, filename, c.req.raw);
        } catch (e: any) {
            console.error("[music-proxy] Stream error:", e?.message || e);
            return c.text(`Proxy error: ${e?.message || "unknown"}`, 500);
        }
    });

    // GET /* - Backward-compatible stream endpoint for old /api/music/<filename> URLs.
    app.get("/*", async (c) => {
        try {
            const env = c.env;
            const fullPath = c.req.path;
            const musicPath = fullPath.replace(/^\/music\//, "").replace(/^\/+/, "");

            if (!musicPath || musicPath === "list") {
                return c.text("Path is required", 400);
            }

            const filename = await resolveMusicFilename(env, musicPath);
            if (!filename) {
                return c.text("Music file not found", 404);
            }

            return streamMusicFile(env, filename, c.req.raw);
        } catch (e: any) {
            console.error("[music-proxy] Error:", e?.message || e);
            return c.text(`Proxy error: ${e?.message || "unknown"}`, 500);
        }
    });

    return app;
}
