import { useEffect, useRef } from "react";
import { useLocation } from "wouter";

const LIVE2D_SCRIPT_ID = "rin-live2d-nova-script";
const LIVE2D_CSS_ID = "rin-live2d-nova-css";
const APLAYER_SCRIPT_ID = "rin-aplayer-script";
const APLAYER_CSS_ID = "rin-aplayer-css";
const APLAYER_FIX_CSS_ID = "rin-aplayer-fix-css";


interface LocalSong {
  name: string;
  artist: string;
  title: string;
  url: string;
}

function loadScript(id: string, src: string) {
  return new Promise<void>((resolve, reject) => {
    const existing = document.getElementById(id) as HTMLScriptElement | null;
    if (existing) {
      if (existing.dataset.loaded === "true") resolve();
      else existing.addEventListener("load", () => resolve(), { once: true });
      return;
    }
    const script = document.createElement("script");
    script.id = id;
    script.src = src;
    script.async = false;
    script.onload = () => { script.dataset.loaded = "true"; resolve(); };
    script.onerror = () => reject(new Error(`Failed to load script: ${src}`));
    document.body.appendChild(script);
  });
}

function loadStylesheet(id: string, href: string) {
  if (document.getElementById(id)) return;
  const link = document.createElement("link");
  link.id = id;
  link.rel = "stylesheet";
  link.href = href;
  document.head.appendChild(link);
}

function removeElement(id: string) {
  document.getElementById(id)?.remove();
}

function removeElements(selector: string) {
  document.querySelectorAll(selector).forEach((element) => element.remove());
}

function setElementsDisplay(selector: string, display: string) {
  document.querySelectorAll<HTMLElement>(selector).forEach((element) => {
    element.style.display = display;
  });
}

function isWidgetDisabledPath(pathname: string) {
  return pathname.startsWith("/admin") || pathname.startsWith("/login") || pathname.startsWith("/callback");
}

function hideLive2DWidget() {
  setElementsDisplay("#waifu, #waifu-toggle, #waifu-tips, .waifu, #live2d, canvas[id*='live2d'], .live2d-widget-container", "none");
}

function showLive2DWidget() {
  setElementsDisplay("#waifu, #waifu-toggle, #waifu-tips, .waifu, #live2d, canvas[id*='live2d'], .live2d-widget-container", "");
}

function cleanupMusicWidget() {
  removeElement("rin-music-widget");
  removeElement(APLAYER_SCRIPT_ID);
  removeElement(APLAYER_CSS_ID);
  removeElement(APLAYER_FIX_CSS_ID);
  removeElements(".aplayer, .aplayer-lrc, .aplayer-list, .aplayer-notice, .aplayer-body, .aplayer-miniswitcher");
}

function Live2DWidget({ hidden }: { hidden: boolean }) {
  useEffect(() => {
    let cancelled = false;
    if (hidden || window.innerWidth < 768) {
      hideLive2DWidget();
      return () => { cancelled = true; hideLive2DWidget(); };
    }
    showLive2DWidget();
    loadStylesheet(LIVE2D_CSS_ID, "https://cdn.jsdelivr.net/gh/nova1751/live2d-api@latest/css/left.min.css");
    loadScript(LIVE2D_SCRIPT_ID, "https://cdn.jsdelivr.net/gh/nova1751/live2d-api@latest/jsdelivr/random/autoload.min.js")
      .then(() => {
        if (cancelled || isWidgetDisabledPath(window.location.pathname)) {
          hideLive2DWidget();
        } else {
          showLive2DWidget();
        }
      })
      .catch(() => undefined);
    return () => { cancelled = true; hideLive2DWidget(); };
  }, [hidden]);
  return null;
}

interface APlayerAudio {
  name: string;
  artist: string;
  url: string;
  cover: string;
  lrc: string;
}

type APlayerInstance = {
  destroy(): void;
  list: {
    show(): void;
    hide(): void;
    audios: APlayerAudio[];
    index?: number;
    switch?(index: number): void;
  };
  audio: HTMLAudioElement;
  play?: () => void;
};

declare const APlayer: new (opts: {
  container: HTMLElement;
  fixed?: boolean;
  mini?: boolean;
  autoplay?: boolean;
  theme?: string;
  loop?: string;
  order?: string;
  preload?: string;
  listFolded?: boolean;
  listMaxHeight?: number;
  audio: APlayerAudio[];
}) => {
  destroy(): void;
  list: { show(): void; hide(): void; audios: APlayerAudio[]; index?: number; switch?(index: number): void };
  audio: HTMLAudioElement;
  play?: () => void;
};


async function fetchLocalSongs(): Promise<LocalSong[]> {
  try {
    const resp = await fetch("/api/music/list", { cache: "no-store" });
    if (!resp.ok) return [];
    const data = await resp.json();
    return (data.songs || []) as LocalSong[];
  } catch {
    return [];
  }
}


function localToAPlayerAudio(song: LocalSong): APlayerAudio {
  return {
    name: song.title || song.name,
    artist: song.artist,
    url: song.url,
    cover: "",
    lrc: "",
  };
}

function applyMusicVisibility(hidden: boolean) {
  const wrapper = document.getElementById("rin-music-widget") as HTMLDivElement | null;
  if (wrapper) {
    wrapper.style.display = hidden ? "none" : "";
  }
}

function bindMusicFallback(player: APlayerInstance) {
  const audio = player.audio;
  if (!audio) {
    return;
  }

  const advance = () => {
    if (player.list.audios.length <= 1) {
      return;
    }

    const currentIndex = typeof player.list.index === "number" ? player.list.index : 0;
    const nextIndex = (currentIndex + 1) % player.list.audios.length;
    player.list.switch?.(nextIndex);
    player.play?.();
  };

  audio.addEventListener("ended", advance);
  audio.addEventListener("error", advance);
  audio.addEventListener("stalled", () => {
    if (document.visibilityState === "hidden") {
      advance();
    }
  });
}

function injectAPlayerFixCss() {
  if (document.getElementById(APLAYER_FIX_CSS_ID)) return;
  const style = document.createElement("style");
  style.id = APLAYER_FIX_CSS_ID;
  style.textContent = `
    #rin-music-widget {
      position: fixed !important;
      left: 0 !important;
      bottom: 0 !important;
      z-index: 2147483646 !important;
      width: auto !important;
      max-width: none !important;
      transform: translateZ(0);
      pointer-events: auto;
    }
    .aplayer .aplayer-list { overflow-y: auto !important; -webkit-overflow-scrolling: touch; overscroll-behavior: contain; }
    .aplayer .aplayer-list ol { max-height: none !important; }
    .aplayer.aplayer-fixed { min-height: 66px !important; min-width: 66px !important; }
    .aplayer.aplayer-fixed.aplayer-narrow { width: 66px !important; }
    .aplayer.aplayer-fixed .aplayer-body { position: relative !important; left: auto !important; right: auto !important; bottom: auto !important; }
    .aplayer.aplayer-fixed .aplayer-list { max-height: 500px; }
`;
  document.head.appendChild(style);
}

function MusicWidget({ hidden }: { hidden: boolean }) {
  const hiddenRef = useRef(hidden);
  const playerRef = useRef<APlayerInstance | null>(null);

  useEffect(() => {
    hiddenRef.current = hidden;
    applyMusicVisibility(hidden);
  }, [hidden]);

  useEffect(() => {
    const containerId = "rin-music-widget";
    let cancelled = false;

    injectAPlayerFixCss();
    loadStylesheet(APLAYER_CSS_ID, "https://cdn.jsdelivr.net/npm/aplayer@1.10.1/dist/APlayer.min.css");

    Promise.all([
      loadScript(APLAYER_SCRIPT_ID, "https://cdn.jsdelivr.net/npm/aplayer@1.10.1/dist/APlayer.min.js"),
      fetchLocalSongs(),
    ])
      .then(([, localSongs]) => {
        if (cancelled) return;
        if (document.getElementById(containerId)) return;

        const norm = (s: string) => s.replace(/[\s\-_()[\]\uFF08\uFF09]/g, "").toLowerCase();
        const seen = new Set<string>();
        const audio: APlayerAudio[] = [];

        // Local VIP songs first (full playback from Tigris storage)
        for (const song of localSongs) {
          const key = norm(song.title || song.name) + "|" + norm(song.artist);
          if (!seen.has(key)) { seen.add(key); audio.push(localToAPlayerAudio(song)); }
        }


        if (audio.length === 0) {
          cleanupMusicWidget();
          return;
        }

        const wrapper = document.createElement("div");
        wrapper.id = containerId;
        wrapper.style.display = hiddenRef.current ? "none" : "";
        document.body.appendChild(wrapper);

        const player = new APlayer({
          container: wrapper, fixed: true, mini: true, autoplay: false,
          theme: "#FC466B", loop: "all", order: "random", preload: "metadata",
          listFolded: true, listMaxHeight: 500, audio,
        });
        bindMusicFallback(player);
        playerRef.current = player;
      })
      .catch(() => undefined);

    return () => {
      cancelled = true;
      playerRef.current?.destroy();
      playerRef.current = null;
      cleanupMusicWidget();
    };
  }, []);
  return null;
}

export function BlogWidgets() {
  const [location] = useLocation();
  const pathname = typeof window !== "undefined" ? window.location.pathname : location;
  const hidden = isWidgetDisabledPath(location) || isWidgetDisabledPath(pathname);

  return (
    <>
      <MusicWidget hidden={hidden} />
      <Live2DWidget hidden={hidden} />
    </>
  );
}
