/* 磯読み — Service Worker
   地磯は圏外が多い。行く前に取り込んでおけば、現地で通信が無くても動く。

   ・アプリ本体は常にキャッシュから出す（起動を速く、圏外でも確実に）
   ・データ(data/*.js)は重いので、押されたときにまとめて取り込む
   ・地図タイルは見たぶんだけ残す（上限つき。無制限に貯めない）
*/
const VER = "isoyomi-5537cc87d4c0";
const SHELL = VER + "-shell";
const DATA = VER + "-data";
const TILES = VER + "-tiles";
const TILE_MAX = 3000;                 // だいたい 150MB 相当で頭打ちにする

const SHELL_FILES = [
  "./", "./index.html", "./manifest.webmanifest",
  "./lib/leaflet.js", "./lib/leaflet.css",
  "./lib/images/marker-icon.png", "./lib/images/marker-icon-2x.png",
  "./lib/images/marker-shadow.png", "./lib/images/layers.png", "./lib/images/layers-2x.png",
  "./icon-192.png", "./icon-512.png",
  "./data/stations.js", "./data/tide.js"
];

const DATA_FILES = [
  "./data/coast_iso.js", "./data/coast_other.js", "./data/depth.js", "./data/seabed.js",
  "./data/weed.js", "./data/obstruction.js", "./data/coral.js", "./data/fishery.js",
  "./data/light.js", "./data/port.js", "./data/sdb.js", "./data/rock_marks.js",
  "./data/coast_rock/index.js"          // 区画ごとのファイルは、画面から一覧を渡されて取り込む
];

self.addEventListener("install", e => {
  // ブラウザの HTTP キャッシュに古い版が残っていても拾わないよう、取り直して入れる
  e.waitUntil(caches.open(SHELL)
    .then(c => c.addAll(SHELL_FILES.map(u => new Request(u, { cache: "reload" }))))
    .then(() => self.skipWaiting()));
});

self.addEventListener("activate", e => {
  e.waitUntil(
    caches.keys()
      .then(ks => Promise.all(ks.filter(k => !k.startsWith(VER)).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

/* タイルは古いものから捨てて上限を守る */
async function trimTiles() {
  const c = await caches.open(TILES);
  const keys = await c.keys();
  if (keys.length <= TILE_MAX) return;
  for (const k of keys.slice(0, keys.length - TILE_MAX)) await c.delete(k);
}

self.addEventListener("fetch", e => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  const sameOrigin = url.origin === self.location.origin;

  // 地図タイル：あれば出す。無ければ取ってきて残す
  if (/cyberjapandata\.gsi\.go\.jp|msil\.go\.jp/.test(url.hostname)) {
    e.respondWith((async () => {
      const c = await caches.open(TILES);
      const hit = await c.match(req);
      if (hit) return hit;
      try {
        const res = await fetch(req);
        if (res.ok) { c.put(req, res.clone()); trimTiles(); }
        return res;
      } catch (err) {
        // statusText は ISO-8859-1 しか通らない。日本語を入れると Response が作れず、取得そのものが失敗する
        return new Response("", { status: 504, statusText: "Offline" });
      }
    })());
    return;
  }

  // 予報API：通信できたときだけ。キャッシュしない（古い予報を出すほうが害）
  if (/open-meteo\.com/.test(url.hostname)) return;

  if (!sameOrigin) return;

  // 画面そのもの（index.html）は通信できれば新しいほうを出す。キャッシュ優先にすると、
  // 新しい版を公開しても開き直すまで古い画面が出続ける。圏外・4秒で返らないときは残してあるもの
  if (req.mode === "navigate") {
    e.respondWith((async () => {
      try {
        const ctl = new AbortController();
        const timer = setTimeout(() => ctl.abort(), 4000);
        const res = await fetch(req.url, { signal: ctl.signal, cache: "no-store", credentials: "same-origin" });
        clearTimeout(timer);
        if (res.ok) (await caches.open(SHELL)).put("./index.html", res.clone());
        return res;
      } catch (err) {
        return (await caches.match("./index.html")) || new Response("オフラインです", { status: 504 });
      }
    })());
    return;
  }

  // アプリ本体とデータ：キャッシュ優先
  e.respondWith((async () => {
    const hit = await caches.match(req);
    if (hit) return hit;
    try {
      const res = await fetch(req);
      if (res.ok && /\/data\//.test(url.pathname)) (await caches.open(DATA)).put(req, res.clone());
      return res;
    } catch (err) {
      const fallback = await caches.match("./index.html");
      return fallback || new Response("オフラインです", { status: 504 });
    }
  })());
});

/* 画面から「オフライン用に取り込む」を押されたとき */
self.addEventListener("message", e => {
  if (!e.data || e.data.type !== "prefetch") return;
  const port = e.ports && e.ports[0];
  const extra = Array.isArray(e.data.extra) ? e.data.extra.filter(f => /^\.\/data\/[\w./-]+\.js$/.test(f)) : [];
  const files = DATA_FILES.concat(extra);
  (async () => {
    const c = await caches.open(DATA);
    let done = 0;
    for (const f of files) {
      try {
        const res = await fetch(f, { cache: "reload" });
        if (res.ok) await c.put(f, res);
      } catch (err) { /* 1つ落ちても続ける。後でもう一度押せばよい */ }
      done++;
      if (port) port.postMessage({ done, total: files.length, file: f });
    }
    if (port) port.postMessage({ done, total: files.length, finished: true });
  })();
});
