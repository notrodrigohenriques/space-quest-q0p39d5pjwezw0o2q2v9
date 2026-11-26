/* Ragnar's Space Quest — cache the app shell, badges, and mission alerts. */
const CACHE = "ragnar-quest-v4";
const TZ = "America/Regina";
const DB_NAME = "ragnar-quest";
const DB_VER = 2;
const PRECACHE = [
  "./",
  "./index.html",
  "./styles.css",
  "./app.js",
  "./data.json",
  "./manifest.webmanifest",
  "./fonts/fredoka.css",
  "./fonts/fredoka-latin.woff2",
  "./fonts/fredoka-latin-ext.woff2",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/apple-touch-icon.png"
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(PRECACHE)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  const isData = url.pathname.endsWith("/data.json") || url.pathname.endsWith("data.json");
  if (isData) {
    event.respondWith(networkFirst(req));
    return;
  }
  event.respondWith(cacheFirst(req));
});

self.addEventListener("push", (event) => {
  event.waitUntil(handlePush(event));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(openApp());
});

self.addEventListener("pushsubscriptionchange", (event) => {
  event.waitUntil(handleSubscriptionChange(event));
});

async function cacheFirst(req) {
  const cached = await caches.match(req, { ignoreSearch: true });
  if (cached) return cached;
  try {
    const fresh = await fetch(req);
    const cache = await caches.open(CACHE);
    cache.put(req, fresh.clone());
    return fresh;
  } catch (err) {
    if (req.mode === "navigate") {
      const fallback = await caches.match("./index.html");
      if (fallback) return fallback;
    }
    throw err;
  }
}

async function networkFirst(req) {
  const cache = await caches.open(CACHE);
  try {
    const fresh = await fetch(req, { cache: "no-store" });
    cache.put(req, fresh.clone());
    return fresh;
  } catch (err) {
    const cached = await caches.match(req, { ignoreSearch: true });
    if (cached) return cached;
    throw err;
  }
}

function todayISO() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

function approvedQuestFor(data, date) {
  const list = Array.isArray(data && data.quests) ? data.quests : [];
  return list.find((q) => q && q.date === date && q.status === "approved" && q.prompt) || null;
}

async function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VER);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("photos")) {
        db.createObjectStore("photos", { keyPath: "id" });
      }
      if (!db.objectStoreNames.contains("appState")) {
        db.createObjectStore("appState", { keyPath: "key" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function readCompleted() {
  try {
    const db = await openDB();
    const row = await new Promise((resolve, reject) => {
      if (!db.objectStoreNames.contains("appState")) {
        resolve(null);
        return;
      }
      const tx = db.transaction("appState", "readonly");
      const g = tx.objectStore("appState").get("progress");
      g.onsuccess = () => resolve(g.result || null);
      g.onerror = () => reject(g.error);
    });
    db.close();
    return (row && row.completed) || {};
  } catch (err) {
    return {};
  }
}

async function loadData() {
  try {
    const res = await fetch("./data.json", { cache: "no-store" });
    if (res.ok) return res.json();
  } catch (err) {
    /* fall through to cache */
  }
  const cached = await caches.match("./data.json", { ignoreSearch: true });
  if (cached) return cached.json();
  return {};
}

function hasOpenQuest(data, completed, date) {
  const quest = approvedQuestFor(data, date);
  if (!quest) return false;
  return !completed[date];
}

async function updateBadge(pending) {
  if (!("setAppBadge" in self.navigator) && !(self.registration && "setAppBadge" in self.registration)) {
    return;
  }
  try {
    if (pending) {
      if (self.navigator && self.navigator.setAppBadge) await self.navigator.setAppBadge(1);
      else if (self.registration.setAppBadge) await self.registration.setAppBadge(1);
    } else if (self.navigator && self.navigator.clearAppBadge) {
      await self.navigator.clearAppBadge();
    } else if (self.registration.clearAppBadge) {
      await self.registration.clearAppBadge();
    }
  } catch (err) {
    /* badging is best-effort */
  }
}

async function handlePush(event) {
  let payload = {};
  try {
    if (event.data) payload = event.data.json();
  } catch (err) {
    try {
      payload = { body: event.data && event.data.text && event.data.text() };
    } catch (err2) {
      payload = {};
    }
  }

  const data = await loadData();
  const date = todayISO();
  const completed = await readCompleted();
  const pending = hasOpenQuest(data, completed, date);
  await updateBadge(pending);

  // iOS requires a notification to be shown for every push.
  let title = payload.title || "Space Quest";
  let body = payload.body || "";
  if (!body) {
    body = pending
      ? "Your mission is ready! 🚀"
      : "You're all caught up, explorer!";
  } else if (payload.kind === "mission" && !pending) {
    body = "You're all caught up, explorer!";
  }

  await self.registration.showNotification(title, {
    body,
    icon: "./icons/icon-192.png",
    badge: "./icons/icon-192.png",
    data: { url: "./" },
  });

  const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
  for (const client of windows) {
    client.postMessage({ type: "push", kind: payload.kind || "mission" });
  }
}

async function openApp() {
  const url = new URL("./", self.registration.scope).href;
  const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
  for (const client of windows) {
    if (client.url.startsWith(self.registration.scope) && "focus" in client) {
      return client.focus();
    }
  }
  if (self.clients.openWindow) return self.clients.openWindow(url);
}

async function handleSubscriptionChange(event) {
  // The page re-subscribes on launch if permission is already granted.
  if (event.oldSubscription && event.newSubscription) {
    return;
  }
}
