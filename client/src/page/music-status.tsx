import { useState, useEffect, useCallback, useRef } from "react";

interface SongStatus {
  id: number;
  title: string;
  artist: string;
  fee: number;
  isVip: boolean;
  hasCloud: boolean;
  cloudFile?: string;
  matchType: "none" | "exact" | "artist_overlap" | "title_unique";
  status: "ok" | "complete" | "possible" | "need_upload" | "cloud_only";
}

interface Summary {
  total: number;
  vipHasCloud: number;
  vipPossibleCloud: number;
  vipNeedUpload: number;
  freeOk: number;
  cloudOnly: number;
  cloudTotal: number;
  playlistTotal: number;
}

type FilterType = "all" | "action_required" | "ready" | "cloud_only";

function StatusBadge({ status }: { status: SongStatus["status"] }) {
  const map: Record<SongStatus["status"], { label: string; cls: string; icon: string }> = {
    need_upload: { label: "待补云源", cls: "bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300", icon: "ri-close-circle-line" },
    possible:    { label: "待确认匹配", cls: "bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300", icon: "ri-question-line" },
    complete:    { label: "云源已就绪",  cls: "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300", icon: "ri-checkbox-circle-line" },
    cloud_only:  { label: "仅云端",   cls: "bg-cyan-100 text-cyan-700 dark:bg-cyan-900/40 dark:text-cyan-300", icon: "ri-cloud-line" },
    ok:          { label: "网易云可播", cls: "bg-neutral-100 text-neutral-600 dark:bg-neutral-800 dark:text-neutral-400", icon: "ri-play-circle-line" },
  };
  const { label, cls, icon } = map[status];
  return (
    <span className={`inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-medium ${cls}`}>
      <i className={`${icon} text-[11px]`} />
      {label}
    </span>
  );
}

function FeeBadge({ fee }: { fee: number }) {
  const map: Record<number, { label: string; cls: string }> = {
    0: { label: "免费", cls: "bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300" },
    1: { label: "VIP", cls: "bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300" },
    4: { label: "专辑购买", cls: "bg-purple-100 text-purple-700 dark:bg-purple-900/40 dark:text-purple-300" },
    8: { label: "试听/VIP", cls: "bg-orange-100 text-orange-700 dark:bg-orange-900/40 dark:text-orange-300" },
  };
  const item = map[fee] || { label: `fee=${fee}`, cls: "bg-neutral-100 text-neutral-600 dark:bg-neutral-800 dark:text-neutral-400" };
  return <span className={`inline-flex items-center rounded-md px-2 py-0.5 text-xs font-medium ${item.cls}`}>{item.label}</span>;
}

function CloudBadge({ song }: { song: SongStatus }) {
  if (song.status === "cloud_only") {
    return (
      <span className="inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-xs font-medium bg-cyan-100 text-cyan-600 dark:bg-cyan-900/40 dark:text-cyan-300">
        <i className="ri-cloud-line text-[11px]" />
        仅云端
      </span>
    );
  }

  // 网易云可播歌曲不需要云存储补源
  if (!song.isVip) return <span className="text-xs text-neutral-400">—</span>;

  if (song.status === "possible") {
    return (
      <span className="inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-xs font-medium bg-amber-100 text-amber-600 dark:bg-amber-900/40 dark:text-amber-300">
        <i className="ri-cloud-line text-[11px]" />
待确认匹配
      </span>
    );
  }

  return song.hasCloud ? (
    <span className="inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-xs font-medium bg-emerald-100 text-emerald-600 dark:bg-emerald-900/40 dark:text-emerald-300">
      <i className="ri-cloud-line text-[11px]" />
云源已就绪
    </span>
  ) : (
    <span className="inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-xs font-medium bg-red-100 text-red-600 dark:bg-red-900/40 dark:text-red-300">
      <i className="ri-cloud-off-line text-[11px]"/>
待补云源
    </span>
  );
}

function MatchBadge({ type }: { type: SongStatus["matchType"] }) {
  const map: Record<SongStatus["matchType"], string> = {
    none: "未匹配",
    exact: "精确匹配",
    artist_overlap: "歌手匹配",
    title_unique: "仅歌名唯一",
  };
  return <span className="text-xs text-neutral-400">{map[type]}</span>;
}

function SummaryCard({ label, count, colorCls, icon }: { label: string; count: number; colorCls: string; icon: string }) {
  return (
    <div className="flex-1 rounded-xl border border-black/10 bg-w p-4 dark:border-white/10">
      <div className="flex items-center gap-3">
        <div className={`rounded-lg p-2 text-lg ${colorCls}`}><i className={icon} /></div>
        <div>
          <p className="text-2xl font-bold t-primary">{count}</p>
          <p className="text-xs text-neutral-500 dark:text-neutral-400">{label}</p>
        </div>
      </div>
    </div>
  );
}

function UploadPanel({ onUploaded }: { onUploaded: () => void }) {
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  async function handleUpload(files: FileList) {
    setUploading(true);
    setError(null);
    setSuccess(null);

    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      const formData = new FormData();
      formData.append("file", file);

      try {
        const resp = await fetch("/api/music/upload", { method: "POST", body: formData });
        const data = await resp.json();
        if (!resp.ok) throw new Error(data.error || `HTTP ${resp.status}`);
      } catch (e: any) {
        setError(`${file.name}: ${e.message || e}`);
        setUploading(false);
        return;
      }
    }

    setSuccess(`成功上传 ${files.length} 个文件`);
    setUploading(false);
    onUploaded();
  }

  return (
    <div className="rounded-xl border border-black/10 dark:border-white/10 p-4">
      <div className="mb-2 flex items-center justify-between">
        <h3 className="text-sm font-semibold t-primary">上传音乐到云存储</h3>
        <span className="text-xs text-neutral-500">/tigris/music/</span>
      </div>
      <div
        className="flex flex-col items-center gap-3 rounded-lg border-2 border-dashed border-neutral-300 p-6 dark:border-neutral-600"
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => { e.preventDefault(); if (e.dataTransfer.files.length > 0) handleUpload(e.dataTransfer.files); }}
      >
        <input
          ref={fileRef}
          type="file"
          accept="audio/*,.mp3,.m4a,.flac,.wav,.ogg,.aac"
          multiple
          className="hidden"
          onChange={(e) => e.target.files && handleUpload(e.target.files)}
        />
        <button
          onClick={() => fileRef.current?.click()}
          disabled={uploading}
          className="rounded-lg bg-blue-500 px-5 py-2 text-sm font-medium text-white hover:bg-blue-600 disabled:opacity-50 transition-colors"
        >
          {uploading ? "上传中..." : "选择文件"}
        </button>
        <p className="text-xs text-neutral-500">支持拖拽上传，建议命名: 歌手 - 歌名.mp3</p>
        {error && <p className="text-xs text-red-500">{error}</p>}
        {success && <p className="text-xs text-green-500">{success}</p>}
      </div>
    </div>
  );
}

export function MusicStatusPage() {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [songs, setSongs] = useState<SongStatus[]>([]);
  const [filter, setFilter] = useState<FilterType>("all");

  const fetchStatus = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const resp = await fetch("/api/music-status/status");
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const data = await resp.json();
      setSummary(data.summary);
      setSongs(Array.isArray(data.songs) ? data.songs : []);
    } catch (e: any) {
      setError(e.message || "Failed to fetch");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchStatus(); }, [fetchStatus]);

  const filtered = songs.filter((song) => {
    if (filter === "all") return true;
    if (filter === "action_required") return song.status === "need_upload" || song.status === "possible";
    if (filter === "ready") return song.status === "complete" || song.status === "ok";
    return song.status === "cloud_only";
  });

  return (
    <div className="space-y-6">
      {/* Summary cards */}
      {summary && (
        <div className="flex flex-wrap gap-4">
          <SummaryCard label="全部歌曲" count={summary.total} colorCls="bg-neutral-100 text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300" icon="ri-music-2-line" />
          <SummaryCard label="待处理" count={summary.vipNeedUpload + summary.vipPossibleCloud} colorCls="bg-red-100 text-red-600 dark:bg-red-900/40 dark:text-red-300" icon="ri-error-warning-line" />
          <SummaryCard label="已就绪" count={summary.freeOk + summary.vipHasCloud} colorCls="bg-emerald-100 text-emerald-600 dark:bg-emerald-900/40 dark:text-emerald-300" icon="ri-checkbox-circle-line" />
          <SummaryCard label="仅云端" count={summary.cloudOnly} colorCls="bg-cyan-100 text-cyan-600 dark:bg-cyan-900/40 dark:text-cyan-300" icon="ri-cloud-line" />
        </div>
      )}

      {/* Upload panel */}
      <UploadPanel onUploaded={fetchStatus} />

      {/* Filter tabs */}
      <div className="flex items-center gap-2 border-b border-black/5 dark:border-white/5 pb-3">
        {([
          { key: "all" as const, label: "全部" },
          { key: "action_required" as const, label: "待处理" },
          { key: "ready" as const, label: "已就绪" },
          { key: "cloud_only" as const, label: "仅云端" },
        ] as { key: FilterType; label: string }[]).map(({ key, label }) => (
          <button
            key={key}
            onClick={() => setFilter(key)}
            className={`rounded-lg px-3 py-1.5 text-sm font-medium transition-colors ${filter === key ? "bg-theme text-white" : "t-primary hover:bg-neutral-100 dark:hover:bg-white/5"}`}
          >
            {label}
          </button>
        ))}
        <button
          onClick={fetchStatus}
          className="ml-auto flex items-center gap-1 rounded-lg px-3 py-1.5 text-sm font-medium t-primary hover:bg-neutral-100 dark:hover:bg-white/5 transition-colors"
        >
          <i className={`ri-refresh-line text-base ${loading ? "animate-spin" : ""}`} />
          刷新
        </button>
      </div>

      {/* Error */}
      {error && (
        <div className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-600 dark:border-red-800 dark:bg-red-900/20 dark:text-red-300">
          <i className="ri-error-warning-line mr-2" />
          {error}
        </div>
      )}

      {/* Loading */}
      {loading && (
        <div className="flex justify-center py-12">
          <i className="ri-loader-line animate-spin text-3xl text-theme" />
        </div>
      )}

      {/* Table */}
      {!loading && (
        <div className="overflow-x-auto rounded-xl border border-black/10 dark:border-white/10">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-black/5 bg-neutral-50 text-left text-xs font-medium uppercase tracking-[0.1em] text-neutral-500 dark:border-white/5 dark:bg-neutral-900/50 dark:text-neutral-400">
                <th className="px-4 py-3">#</th>
                <th className="px-4 py-3">歌曲名</th>
                <th className="px-4 py-3">歌手</th>
                <th className="px-4 py-3">网易云权限</th>
                <th className="px-4 py-3">云存储</th>
                <th className="px-4 py-3">匹配文件</th>
                <th className="px-4 py-3">状态</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-black/5 dark:divide-white/5">
              {filtered.length === 0 && (
                <tr>
                  <td colSpan={7} className="px-4 py-8 text-center text-sm text-neutral-400">
                    暂无数据
                  </td>
                </tr>
              )}
              {filtered.map((song, i) => (
                <tr key={`${song.title}-${song.artist}-${i}`} className={`hover:bg-neutral-50 dark:hover:bg-white/[0.02] transition-colors ${song.status === "need_upload" ? "bg-red-50/50 dark:bg-red-900/10" : ""}`}>
                  <td className="px-4 py-3 text-neutral-400">{i + 1}</td>
                  <td className="px-4 py-3 font-medium t-primary">{song.title}</td>
                  <td className="px-4 py-3 text-neutral-600 dark:text-neutral-300">{song.artist}</td>
                  <td className="px-4 py-3"><FeeBadge fee={song.fee} /></td>
                  <td className="px-4 py-3"><CloudBadge song={song} /></td>
                  <td className="px-4 py-3 max-w-[260px]">
                    {song.cloudFile ? (
                      <div className="space-y-1">
                        <div className="truncate text-xs text-neutral-600 dark:text-neutral-300" title={song.cloudFile}>{song.cloudFile}</div>
                        <MatchBadge type={song.matchType} />
                      </div>
                    ) : (
                      <MatchBadge type={song.matchType} />
                    )}
                  </td>
                  <td className="px-4 py-3"><StatusBadge status={song.status} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Hint for missing VIP songs */}
      {summary && summary.vipNeedUpload > 0 && (
        <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-700 dark:border-amber-800 dark:bg-amber-900/20 dark:text-amber-300">
          <i className="ri-lightbulb-line mr-2" />
          有 <strong>{summary.vipNeedUpload}</strong> 首网易云不可完整播放的歌曲缺少云存储源。
          请将对应歌曲文件（命名格式：<code className="mx-1 rounded bg-amber-100 px-1.5 py-0.5 text-xs dark:bg-amber-800/40">歌手 - 歌名.m4a</code>）上传到 CloudPaste 的 <code className="mx-1 rounded bg-amber-100 px-1.5 py-0.5 text-xs dark:bg-amber-800/40">/tigris/music/</code> 路径下。
        </div>
      )}
    </div>
  );
}
