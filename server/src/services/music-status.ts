import { Hono } from "hono";
import type { Variables } from "../core/hono-types";
import { listMusicFiles } from "./music-proxy";

const PLAYLIST_IDS = ["13715807689", "3778678"];
const METING_API_BASE = "https://api.i-meto.com/meting/api";
const NETEASE_API_BASE = "https://music.163.com/api";

interface MetingTrack {
  title: string;
  author: string;
  url: string;
  pic?: string;
  lrc?: string;
}

interface SongTrack {
  id: number;
  title: string;
  artist: string;
  fee: number;
  playable: boolean;
}

interface NeteaseSongDetail {
  id: number;
  fee?: number;
}

interface NeteasePlayerUrl {
  id: number;
  code?: number;
  url?: string | null;
  freeTrialInfo?: unknown;
  freeTrialPrivilege?: {
    resConsumable?: boolean;
    userConsumable?: boolean;
    cannotListenReason?: number | null;
  };
}

interface CloudSong {
  name: string;
  title: string;
  artist: string;
  titleKeys: Set<string>;
  artistKey: string;
  artistTokens: Set<string>;
}

type MatchType = "none" | "exact" | "artist_overlap" | "title_unique";

interface CloudMatch {
  type: MatchType;
  file?: CloudSong;
}

const CHAR_VARIANTS: Record<string, string> = {
  "龍": "龙",
  "寬": "宽",
  "亞": "亚",
  "曠": "旷",
  "願": "愿",
  "綺": "绮",
  "陸": "陆",
  "罷": "吧",
};

async function fetchMetingPlaylist(id: string): Promise<MetingTrack[]> {
  const url = `${METING_API_BASE}?server=netease&type=playlist&id=${encodeURIComponent(id)}`;
  try {
    const resp = await fetch(url);
    if (!resp.ok) {
      console.error(`[music-status] Failed to fetch Meting playlist ${id}: ${resp.status}`);
      return [];
    }
    const data = await resp.json() as MetingTrack[];
    return Array.isArray(data) ? data : [];
  } catch (e) {
    console.error(`[music-status] Error fetching Meting playlist ${id}:`, e);
    return [];
  }
}

function extractNeteaseId(url: string): number | null {
  const match = url.match(/[?&]id=(\d+)/);
  return match ? Number(match[1]) : null;
}

async function fetchSongFees(ids: number[]): Promise<Map<number, number>> {
  const fees = new Map<number, number>();
  const uniqueIds = [...new Set(ids)].filter(Number.isFinite);

  for (let i = 0; i < uniqueIds.length; i += 100) {
    const chunk = uniqueIds.slice(i, i + 100);
    const url = `${NETEASE_API_BASE}/song/detail?ids=${encodeURIComponent(JSON.stringify(chunk))}`;
    try {
      const resp = await fetch(url, {
        headers: {
          "User-Agent": "Mozilla/5.0",
          "Referer": "https://music.163.com/",
        },
      });
      if (!resp.ok) {
        console.error(`[music-status] Failed to fetch song detail: ${resp.status}`);
        continue;
      }
      const data = await resp.json() as { songs?: NeteaseSongDetail[] };
      for (const song of data.songs || []) {
        fees.set(song.id, song.fee ?? 0);
      }
    } catch (e) {
      console.error("[music-status] Error fetching song detail:", e);
    }
  }

  return fees;
}

async function fetchPlayableMap(ids: number[]): Promise<Map<number, boolean>> {
  const result = new Map<number, boolean>();
  const uniqueIds = [...new Set(ids)].filter(Number.isFinite);

  for (let i = 0; i < uniqueIds.length; i += 100) {
    const chunk = uniqueIds.slice(i, i + 100);
    const url = `${NETEASE_API_BASE}/song/enhance/player/url?ids=${encodeURIComponent(JSON.stringify(chunk))}&br=128000`;
    try {
      const resp = await fetch(url, {
        headers: {
          "User-Agent": "Mozilla/5.0",
          "Referer": "https://music.163.com/",
        },
      });
      if (!resp.ok) {
        console.error(`[music-status] Failed to fetch player url: ${resp.status}`);
        continue;
      }
      const data = await resp.json() as { data?: NeteasePlayerUrl[] };
      for (const item of data.data || []) {
        const playable = item.code === 200 && Boolean(item.url) && !item.freeTrialInfo;
        result.set(item.id, playable);
      }
    } catch (e) {
      console.error("[music-status] Error fetching player url:", e);
    }
  }

  return result;
}

function normalize(value: string): string {
  let result = value.normalize("NFKC").toLowerCase();
  result = result.replace(/[龍寬亞曠願綺陸罷]/g, char => CHAR_VARIANTS[char] || char);
  return result.replace(/[\s\-_()[\]【】（）《》「」『』·.,，。!！?？:：'"“”‘’/\\]/g, "");
}

function splitArtists(value: string): string[] {
  return value
    .split(/[,，、/&＋+]|\s+feat\.?\s+|\s+ft\.?\s+/i)
    .map(item => item.trim())
    .filter(Boolean);
}

function normalizeArtists(value: string): Set<string> {
  const tokens = new Set<string>();
  const full = normalize(value);
  if (full) tokens.add(full);
  for (const artist of splitArtists(value)) {
    const token = normalize(artist);
    if (token) tokens.add(token);
  }
  return tokens;
}

function stripVersion(value: string): string {
  return value
    .replace(/\s*[（(][^）)]*(live|伴奏|伴唱|remix|remaster|version|版|feat\.|ft\.)[^）)]*[）)]/ig, "")
    .replace(/\s*[-—–]\s*(live|remix|remaster|version).*$/ig, "")
    .replace(/\s*(live版|live|remix版|remix)$/ig, "")
    .trim();
}

function extractParenthesesAliases(value: string): string[] {
  const aliases: string[] = [];
  const matches = value.matchAll(/[（(]([^）)]+)[）)]/g);
  for (const match of matches) {
    const alias = match[1]
      .replace(/^又名[:：]/, "")
      .replace(/^feat\..*$/i, "")
      .trim();
    if (alias && !/live|伴奏|伴唱|remix|remaster|version|版/i.test(alias)) {
      aliases.push(alias);
    }
  }
  return aliases;
}

function titleKeys(value: string): Set<string> {
  const candidates = new Set<string>([value, stripVersion(value), ...extractParenthesesAliases(value)]);
  const keys = new Set<string>();
  for (const candidate of candidates) {
    const key = normalize(candidate);
    if (key) keys.add(key);
  }
  return keys;
}

function parseCloudFilename(name: string): CloudSong | null {
  const base = name.replace(/\.[^.]+$/, "");
  const idx = base.indexOf(" - ");
  if (idx <= 0) return null;

  const artist = base.substring(0, idx).trim();
  const title = base.substring(idx + 3).trim();
  return {
    name,
    title,
    artist,
    titleKeys: titleKeys(title),
    artistKey: normalize(artist),
    artistTokens: normalizeArtists(artist),
  };
}

function hasArtistOverlap(a: Set<string>, b: Set<string>): boolean {
  for (const item of a) {
    if (b.has(item)) return true;
  }
  return false;
}

function buildCloudSongs(files: Array<{ name: string; path: string }>): CloudSong[] {
  return files
    .map(file => parseCloudFilename(file.name))
    .filter((song): song is CloudSong => Boolean(song));
}

function findCloudMatch(track: SongTrack, cloudSongs: CloudSong[]): CloudMatch {
  const songTitleKeys = titleKeys(track.title);
  const songArtistKey = normalize(track.artist);
  const songArtistTokens = normalizeArtists(track.artist);

  const sameTitle = cloudSongs.filter(cloud => {
    for (const titleKey of songTitleKeys) {
      if (cloud.titleKeys.has(titleKey)) return true;
    }
    return false;
  });

  for (const cloud of sameTitle) {
    if (cloud.artistKey === songArtistKey) {
      return { type: "exact", file: cloud };
    }
  }

  for (const cloud of sameTitle) {
    if (hasArtistOverlap(songArtistTokens, cloud.artistTokens)) {
      return { type: "artist_overlap", file: cloud };
    }
  }

  if (sameTitle.length === 1) {
    return { type: "title_unique", file: sameTitle[0] };
  }

  return { type: "none" };
}

export function MusicStatusService(): Hono<{
  Bindings: Env;
  Variables: Variables;
}> {
  const app = new Hono<{
    Bindings: Env;
    Variables: Variables;
  }>();

  app.get("/status", async (c) => {
    if (!c.get("admin")) {
      return c.text("Forbidden", 403);
    }

    const env = c.env;

    const metingResults = await Promise.all(
      PLAYLIST_IDS.map(fetchMetingPlaylist)
    );
    const metingSongs = metingResults.flat();
    const ids = metingSongs
      .map(song => extractNeteaseId(song.url))
      .filter((id): id is number => id !== null);
    const [feeMap, playableMap] = await Promise.all([
      fetchSongFees(ids),
      fetchPlayableMap(ids),
    ]);

    const cloudFiles = await listMusicFiles(env);
    const cloudSongs = buildCloudSongs(cloudFiles);

    const seen = new Set<string>();
    const uniqueSongs: SongTrack[] = [];
    for (const song of metingSongs) {
      const id = extractNeteaseId(song.url);
      if (!id) continue;
      const key = normalize(song.title) + "|" + normalize(song.author);
      if (seen.has(key)) continue;
      seen.add(key);
      uniqueSongs.push({
        id,
        title: song.title,
        artist: song.author,
        fee: feeMap.get(id) ?? 0,
        playable: playableMap.get(id) ?? true,
      });
    }

    const songs: Array<{
      id: number;
      title: string;
      artist: string;
      fee: number;
      isVip: boolean;
      hasCloud: boolean;
      cloudFile?: string;
      matchType: MatchType;
      status: "ok" | "complete" | "possible" | "need_upload" | "cloud_only";
    }> = [];
    const matchedCloudFiles = new Set<string>();

    for (const song of uniqueSongs) {
      const isVip = !song.playable;
      const match = findCloudMatch(song, cloudSongs);
      const hasCloud = match.type === "exact" || match.type === "artist_overlap";
      const possibleCloud = match.type === "title_unique";
      if (match.file) matchedCloudFiles.add(match.file.name);

      let status: "ok" | "complete" | "possible" | "need_upload";
      if (!isVip) {
        status = "ok";
      } else if (hasCloud) {
        status = "complete";
      } else if (possibleCloud) {
        status = "possible";
      } else {
        status = "need_upload";
      }

      songs.push({
        id: song.id,
        title: song.title,
        artist: song.artist,
        fee: song.fee,
        isVip,
        hasCloud: hasCloud || possibleCloud,
        cloudFile: match.file?.name,
        matchType: match.type,
        status,
      });
    }

    for (const cloud of cloudSongs) {
      if (matchedCloudFiles.has(cloud.name)) continue;
      songs.push({
        id: 0,
        title: cloud.title,
        artist: cloud.artist,
        fee: 0,
        isVip: false,
        hasCloud: true,
        cloudFile: cloud.name,
        matchType: "none",
        status: "cloud_only",
      });
    }

    const order: Record<string, number> = { need_upload: 0, possible: 1, complete: 2, cloud_only: 3, ok: 4 };
    songs.sort((a, b) => {
      const d = order[a.status] - order[b.status];
      return d !== 0 ? d : a.title.localeCompare(b.title, "zh-CN");
    });

    const summary = {
      total: songs.length,
      vipHasCloud: songs.filter(s => s.status === "complete").length,
      vipPossibleCloud: songs.filter(s => s.status === "possible").length,
      vipNeedUpload: songs.filter(s => s.status === "need_upload").length,
      freeOk: songs.filter(s => s.status === "ok").length,
      cloudOnly: songs.filter(s => s.status === "cloud_only").length,
      cloudTotal: cloudSongs.length,
      playlistTotal: uniqueSongs.length,
    };

    return c.json({ summary, songs });
  });

  return app;
}
