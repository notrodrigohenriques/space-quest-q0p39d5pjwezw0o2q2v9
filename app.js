/* Ragnar's Space Quest — child-facing only. Draft quests must never render. */
(() => {
  const TZ = "America/Regina";
  const STORE = "ragnar-quest-state-v1";
  const MIGRATIONS_KEY = "ragnar-quest-migrations";
  const DB_NAME = "ragnar-quest";
  const DB_VER = 2;
  const XP_PER_PAGE = 10;
  const STARS_PER_PAGE = 3;

  const $ = (id) => document.getElementById(id);
  const params = new URLSearchParams(location.search);
  const demoMode = params.get("demo");

  let data = null;
  let state = null;
  let pendingBlob = null;
  let pinUiMode = "enter";
  let lastDataSnapshot = "";
  let refreshTimer = null;
  let refreshInFlight = null;
  let lastRefreshAt = 0;
  let uploadNoteState = null;
  let permissionWatcherBound = false;
  let refreshGesturesBound = false;
  const DATA_POLL_MS = 5 * 60 * 1000;
  const REFRESH_DEBOUNCE_MS = 750;

  function todayISO(override) {
    if (override) return override;
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: data?.timezone || TZ,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date());
  }

  function friendlyDate(iso) {
    const [y, m, d] = iso.split("-").map(Number);
    const dt = new Date(Date.UTC(y, m - 1, d, 18));
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: TZ,
      weekday: "long",
      month: "long",
      day: "numeric",
    }).format(dt);
  }

  function loadLocalState() {
    try {
      return JSON.parse(localStorage.getItem(STORE) || "null") || {};
    } catch {
      return {};
    }
  }

  function saveLocalState() {
    localStorage.setItem(STORE, JSON.stringify(state));
    syncStateToIdb();
  }

  function isStandalone() {
    return window.navigator.standalone === true ||
      window.matchMedia("(display-mode: standalone)").matches ||
      params.get("standalone") === "1";
  }

  function openQuestPending() {
    const today = effectiveToday();
    return Boolean(approvedQuestFor(today) && !isCompleted(today));
  }

  function badgeCountForToday() {
    return openQuestPending() ? 1 : 0;
  }

  async function updateAppBadge() {
    const count = badgeCountForToday();
    try {
      if (count > 0 && "setAppBadge" in navigator) {
        await navigator.setAppBadge(count);
      } else if (count === 0 && "clearAppBadge" in navigator) {
        await navigator.clearAppBadge();
      }
    } catch (err) {
      /* badging is best-effort, especially before a Home Screen install */
    }
  }

  function emptyProgress() {
    return { xp: 0, stars: 0, streak: 0, lastCompletedDate: null, completed: {}, awardedBadges: [] };
  }

  function mergeProgress(server, local, demo) {
    const s = server || emptyProgress();
    const l = local || {};
    const out = {
      xp: Math.max(s.xp || 0, l.xp || 0),
      stars: Math.max(s.stars || 0, l.stars || 0),
      streak: Math.max(s.streak || 0, l.streak || 0),
      lastCompletedDate: laterDate(s.lastCompletedDate, l.lastCompletedDate),
      completed: { ...(s.completed || {}), ...(l.completed || {}) },
      awardedBadges: Array.from(new Set([...(s.awardedBadges || data.awardedBadges || []), ...(l.awardedBadges || [])])),
      pin: l.pin || null,
    };
    if (demo && data.demo) {
      Object.assign(out.completed, data.demo.completed || {});
      out.awardedBadges = Array.from(new Set([...out.awardedBadges, ...(data.demo.awardedBadges || [])]));
      const n = Object.keys(out.completed).length;
      out.xp = Math.max(out.xp, n * XP_PER_PAGE);
      out.stars = Math.max(out.stars, n * STARS_PER_PAGE);
      out.streak = Math.max(out.streak, Math.min(n, 2));
    }
    return out;
  }

  function laterDate(a, b) {
    if (!a) return b || null;
    if (!b) return a;
    return a >= b ? a : b;
  }

  function currentLevel() {
    const levels = data.levels || [];
    let found = levels[0] || { level: 1, name: "Space Cadet", xp: 0 };
    for (const lv of levels) {
      if ((state.xp || 0) >= lv.xp) found = lv;
    }
    const next = levels.find((lv) => lv.xp > found.xp);
    return { ...found, next };
  }

  function approvedQuestFor(date) {
    const list = Array.isArray(data.quests) ? data.quests : [];
    const found = list.find((q) => q && q.date === date && q.status === "approved" && q.prompt);
    if (found) return found;
    if (demoMode && data.demo?.quest && data.demo.quest.status === "approved") {
      const q = data.demo.quest;
      if (q.date === date) return q;
    }
    return null;
  }

  function effectiveToday() {
    if (demoMode && data.demo?.today) return data.demo.today;
    return todayISO();
  }

  function isCompleted(date) {
    return Boolean(state.completed && state.completed[date]);
  }

  function addDays(iso, n) {
    const [y, m, d] = iso.split("-").map(Number);
    const dt = new Date(Date.UTC(y, m - 1, d));
    dt.setUTCDate(dt.getUTCDate() + n);
    return dt.toISOString().slice(0, 10);
  }

  function computeStreak(completed, today) {
    const set = new Set(Object.keys(completed || {}));
    let start = set.has(today) ? today : addDays(today, -1);
    if (!set.has(start)) return 0;
    let n = 0;
    let cur = start;
    while (set.has(cur)) {
      n += 1;
      cur = addDays(cur, -1);
    }
    return n;
  }

  function undoCompletion(date) {
    const rec = state.completed && state.completed[date];
    if (!rec) return false;
    const xp = Number(rec.xp || XP_PER_PAGE);
    const stars = Number(rec.stars || STARS_PER_PAGE);
    delete state.completed[date];
    state.xp = Math.max(0, (state.xp || 0) - xp);
    state.stars = Math.max(0, (state.stars || 0) - stars);
    const remaining = Object.keys(state.completed || {});
    if (state.lastCompletedDate === date) {
      remaining.sort();
      state.lastCompletedDate = remaining.length ? remaining[remaining.length - 1] : null;
    }
    state.streak = computeStreak(state.completed, effectiveToday());
    let badges = new Set(state.awardedBadges || []);
    if (!remaining.length) badges.delete("page-snapper");
    if (state.streak < 3) badges.delete("streak-3");
    if (state.streak < 7) badges.delete("streak-7");
    state.awardedBadges = Array.from(badges);
    return true;
  }

  async function photosForDate(date) {
    try {
      const db = await openDB();
      const rows = await new Promise((resolve, reject) => {
        if (!db.objectStoreNames.contains("photos")) {
          resolve([]);
          return;
        }
        const tx = db.transaction("photos", "readonly");
        const r = tx.objectStore("photos").getAll();
        r.onsuccess = () => resolve(r.result || []);
        r.onerror = () => reject(r.error);
      });
      db.close();
      return (rows || []).filter((row) => row && row.date === date);
    } catch (err) {
      return [];
    }
  }

  function loadMigrations() {
    try { return JSON.parse(localStorage.getItem(MIGRATIONS_KEY) || "[]"); } catch { return []; }
  }

  function saveMigrations(list) {
    localStorage.setItem(MIGRATIONS_KEY, JSON.stringify(list));
  }

  async function runMigrations() {
    const done = loadMigrations();
    const id = "undo-2026-11-26-grownups-test";
    if (done.includes(id)) return false;
    const date = "2026-11-26";
    const rec = state.completed && state.completed[date];
    if (!rec) {
      done.push(id);
      saveMigrations(done);
      return false;
    }
    const photos = await photosForDate(date);
    const hasPhoto = rec.source === "photo" || photos.length > 0;
    if (hasPhoto) {
      done.push(id);
      saveMigrations(done);
      return false;
    }
    const changed = undoCompletion(date);
    if (changed) saveLocalState();
    done.push(id);
    saveMigrations(done);
    return changed;
  }

  function maybeAwardBadges(date) {
    const badges = new Set(state.awardedBadges || []);
    badges.add("page-snapper");
    const streak = computeStreak(state.completed, effectiveToday());
    if (streak >= 3) badges.add("streak-3");
    if (streak >= 7) badges.add("streak-7");
    state.awardedBadges = Array.from(badges);
    state.streak = streak;
  }

  function renderHud() {
    const lv = currentLevel();
    $("hud").innerHTML = `
      <div class="chip" title="Level"><strong>Lv ${lv.level}</strong> ${escapeHtml(lv.name)}</div>
      <div class="chip">⭐ <strong>${state.stars || 0}</strong></div>
      <div class="chip">🔥 <strong>${state.streak || 0}</strong> day streak</div>
    `;
  }

  function renderQuest() {
    const today = effectiveToday();
    const quest = approvedQuestFor(today);
    const card = $("questCard");
    if (!quest) {
      const start = data.cycle?.start;
      const beforeStart = start && today < start;
      card.innerHTML = `
        <div class="waiting">
          <p class="kicker">Today’s Quest</p>
          <h2>${beforeStart ? "Your voyage starts soon" : "A new quest is on its way"}</h2>
          <p>${beforeStart
            ? "Your first planet will light up when a quest is ready. Keep your pencil close!"
            : "When today’s quest is ready, it will appear right here."}</p>
        </div>`;
      return;
    }

    const done = isCompleted(today);
    const planet = (data.planets || []).find((p) => p.date === today);
    card.innerHTML = `
      ${done ? `<div class="done-banner">Mission complete — ${escapeHtml(planet?.name || "today’s planet")} is lit!</div>` : ""}
      <p class="kicker">Today’s Quest${planet ? " · " + escapeHtml(planet.name) : ""}</p>
      <h2 class="quest-title">${escapeHtml(quest.title || "Write your page")}</h2>
      <p class="quest-prompt">${escapeHtml(quest.prompt)}</p>
      <div class="powerup">
        <div class="bolt" aria-hidden="true">⚡</div>
        <p><span class="label">Power-up${quest.powerUpName ? " · " + escapeHtml(quest.powerUpName) : ""}</span>${escapeHtml(quest.powerUp || "")}</p>
      </div>
      ${done
        ? `<p class="muted">You already turned in today’s page. Nice work, explorer.</p>`
        : `<button type="button" class="btn primary block" id="snapBtn">📸 Snap my page!</button>
           <p class="upload-note" id="uploadNote"></p>`}
    `;
    const snap = $("snapBtn");
    if (snap) snap.addEventListener("click", () => $("pagePhoto").click());
    const note = $("uploadNote");
    if (note && uploadNoteState) {
      note.className = uploadNoteState.className;
      note.textContent = uploadNoteState.text;
    }
  }

  function renderStrengths() {
    $("strengths").innerHTML = (data.strengths || [])
      .slice(0, 3)
      .map((s) => `<li>${escapeHtml(s)}</li>`)
      .join("");
    $("levelUp").textContent = data.levelUpNext || "";
  }

  function renderMap() {
    const today = effectiveToday();
    const planets = data.planets || [];
    $("planetMap").innerHTML = planets.map((p) => {
      const done = isCompleted(p.date);
      const locked = p.date > today && !done;
      const isToday = p.date === today;
      const cls = ["planet", done ? "done" : "", locked ? "locked" : "", isToday ? "today" : ""]
        .filter(Boolean).join(" ");
      const label = locked ? "Not yet" : done ? "Lit!" : isToday ? "Today" : p.name;
      return `<li class="${cls}">
        <span class="orb" style="background:${p.color}" title="${escapeHtml(p.name)}">${done ? "★" : isToday ? "🚀" : locked ? "•" : ""}</span>
        <span class="pname">${escapeHtml(p.name)}</span>
        <span class="pname muted">${escapeHtml(label)}</span>
      </li>`;
    }).join("");
    const doneCount = planets.filter((p) => isCompleted(p.date)).length;
    $("mapCaption").textContent = `${doneCount} of ${planets.length} planets lit · Voyage 1`;
  }

  function renderBadges() {
    const have = new Set(state.awardedBadges || []);
    $("badges").innerHTML = (data.badges || []).map((b) => {
      const on = have.has(b.id);
      return `<li class="badge ${on ? "" : "locked"}">
        <span class="emo">${b.emoji || "🏅"}</span>
        <span class="bname">${escapeHtml(b.name)}</span>
        <span class="bhint">${on ? "You earned this!" : escapeHtml(b.hint || "")}</span>
      </li>`;
    }).join("");
  }

  function renderAll() {
    if ($("greet")) $("greet").textContent = `Hi, ${data.childName || "explorer"}!`;
    renderHud();
    renderQuest();
    renderStrengths();
    renderMap();
    renderBadges();
    maybeShowInstallTip();
    // If alerts are already allowed, flip the banner synchronously so the
    // "Turn on" button never flashes while we wait on the service worker.
    if (isStandalone() && notificationPermission() === "granted") {
      setAlertsOnState();
    }
    renderAlerts();
    updateAppBadge();
    const shot = params.get("shot");
    if (shot === "map") document.body.classList.add("shot-map");
    if (shot === "badges") document.body.classList.add("shot-badges");
    if (demoMode === "snap") {
      $("previewImage").src = "./icons/sample-page.jpg";
      $("previewOverlay").hidden = false;
    }
  }

  function afterStateChange() {
    saveLocalState();
    renderAll();
    updateAppBadge();
  }

  function maybeShowInstallTip() {
    $("installTip").hidden = isStandalone() || Boolean(demoMode) || params.get("test") === "1";
  }

  function notificationConfig() {
    const n = data.notifications || {};
    return {
      url: n.url || (data.upload && data.upload.url) || "",
      token: n.subscribeToken || "",
      vapidPublicKey: n.vapidPublicKey || "",
    };
  }

  function urlBase64ToUint8Array(base64String) {
    const padding = "=".repeat((4 - base64String.length % 4) % 4);
    const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
    const raw = atob(base64);
    const out = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i += 1) out[i] = raw.charCodeAt(i);
    return out;
  }

  async function postBackend(payload) {
    const { url } = notificationConfig();
    if (!url) return { ok: false, error: "not-configured" };
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "text/plain;charset=utf-8" },
        body: JSON.stringify(payload),
        redirect: "follow",
      });
      // Apps Script often 302s to googleusercontent without CORS, so the
      // browser may give an opaque response or reject even when the server saved.
      if (res.type === "opaque" || res.type === "opaqueredirect") {
        return { ok: false, opaque: true };
      }
      const json = await res.json().catch(() => null);
      if (json && typeof json === "object") return json;
      return { ok: Boolean(res.ok) };
    } catch (err) {
      return { ok: false, opaque: true, error: "network" };
    }
  }

  let testMockSubscription = null;

  async function getExistingSubscription() {
    if (params.get("test") === "1" && testMockSubscription) return testMockSubscription;
    try {
      if (!("serviceWorker" in navigator) || !window.PushManager) return null;
      const reg = await navigator.serviceWorker.ready;
      return await reg.pushManager.getSubscription();
    } catch (err) {
      return null;
    }
  }

  function notificationPermission() {
    try {
      if (typeof Notification !== "undefined" && Notification.permission) {
        return Notification.permission;
      }
    } catch (err) { /* ignore */ }
    return "default";
  }

  async function queryNotificationPermission() {
    const direct = notificationPermission();
    if (direct === "granted" || direct === "denied") return direct;
    try {
      if (navigator.permissions && navigator.permissions.query) {
        const status = await navigator.permissions.query({ name: "notifications" });
        if (status && status.state === "granted") return "granted";
        if (status && status.state === "denied") return "denied";
        if (status && status.state === "prompt") return "default";
      }
    } catch (err) { /* iOS may not support this query */ }
    return direct;
  }

  function hideAlertsButton() {
    const btn = $("alertsBtn");
    if (!btn) return;
    btn.hidden = true;
    btn.setAttribute("hidden", "");
    btn.setAttribute("aria-hidden", "true");
    btn.disabled = true;
    btn.style.display = "none";
  }

  function showAlertsButton() {
    const btn = $("alertsBtn");
    if (!btn) return;
    btn.hidden = false;
    btn.removeAttribute("hidden");
    btn.removeAttribute("aria-hidden");
    btn.disabled = false;
    btn.style.display = "";
  }

  function setAlertsOnState() {
    const card = $("alertsCard");
    const help = $("alertsHelp");
    const note = $("alertsNote");
    const onEl = $("alertsOn");
    hideAlertsButton();
    if (help) help.hidden = true;
    if (note) note.hidden = true;
    // Hide the whole turn-on card. A tiny status line is enough.
    if (card) {
      card.hidden = true;
      card.classList.add("is-on");
    }
    if (!isStandalone()) {
      if (onEl) onEl.hidden = true;
      return;
    }
    if (onEl) onEl.hidden = false;
  }

  async function renderAlerts() {
    const card = $("alertsCard");
    if (!card) return;
    const supported = "Notification" in window && "serviceWorker" in navigator &&
      window.PushManager;
    const standalone = isStandalone();
    if (!supported || !standalone) {
      card.hidden = true;
      return;
    }
    // Immediate sync path: never leave the Turn on button up once Allow was tapped.
    if (notificationPermission() === "granted") {
      setAlertsOnState();
      return;
    }
    const perm = await queryNotificationPermission();
    if (perm === "granted" || notificationPermission() === "granted") {
      setAlertsOnState();
      return;
    }
    card.hidden = false;
    card.classList.remove("is-on");
    const help = $("alertsHelp");
    const note = $("alertsNote");
    const onEl = $("alertsOn");
    if (onEl) onEl.hidden = true;
    if (help) help.hidden = false;
    if (perm === "denied") {
      hideAlertsButton();
      help.textContent = "That’s okay. You can turn on alerts later in iPad Settings if you change your mind.";
      if (note) note.hidden = true;
    } else {
      showAlertsButton();
      help.textContent = "I can ping you when a new writing mission is ready.";
      if (note) note.hidden = true;
    }
  }

  async function onPermissionMaybeChanged() {
    const perm = await queryNotificationPermission();
    if (perm === "granted" || notificationPermission() === "granted") {
      setAlertsOnState();
      updateAppBadge();
      ensureSubscription();
      return;
    }
    await renderAlerts();
    updateAppBadge();
  }

  function watchPermissionChanges() {
    if (permissionWatcherBound) return;
    permissionWatcherBound = true;
    try {
      if (navigator.permissions && navigator.permissions.query) {
        navigator.permissions.query({ name: "notifications" }).then((status) => {
          status.addEventListener("change", () => { onPermissionMaybeChanged(); });
          if (status.state === "granted") onPermissionMaybeChanged();
        }).catch(() => {});
      }
    } catch (err) { /* ignore */ }
  }

  async function enableAlerts(ev) {
    if (ev) ev.preventDefault();
    const btn = $("alertsBtn");
    const note = $("alertsNote");
    if (btn) btn.disabled = true;
    try {
      if (!("Notification" in window)) return;
      const perm = await Notification.requestPermission();
      const grantedNow = perm === "granted" || notificationPermission() === "granted" ||
        (await queryNotificationPermission()) === "granted";
      if (!grantedNow) {
        await renderAlerts();
        return;
      }
      // Flip the banner immediately after Allow — do not wait on subscribe or fetch.
      setAlertsOnState();
      updateAppBadge();
      await navigator.serviceWorker.register("./sw.js");
      const reg = await navigator.serviceWorker.ready;
      const cfg = notificationConfig();
      if (!cfg.vapidPublicKey) throw new Error("no-vapid");
      let sub = await reg.pushManager.getSubscription();
      if (!sub) {
        sub = await reg.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array(cfg.vapidPublicKey),
        });
      }
      if (cfg.url && cfg.token && sub) {
        await postBackend({
          action: "subscribe",
          token: cfg.token,
          subscription: sub.toJSON(),
        });
      }
      setAlertsOnState();
      updateAppBadge();
    } catch (err) {
      if (notificationPermission() === "granted" || (await queryNotificationPermission()) === "granted") {
        setAlertsOnState();
        updateAppBadge();
        return;
      }
      if (note) {
        note.hidden = false;
        note.className = "upload-note wait";
        note.textContent = "I couldn’t turn on alerts this time. We can try again later.";
      }
    } finally {
      if (notificationPermission() === "granted") hideAlertsButton();
      else if (btn) btn.disabled = false;
    }
  }

  async function ensureSubscription() {
    if (!("Notification" in window) || Notification.permission !== "granted") {
      await renderAlerts();
      return;
    }
    setAlertsOnState();
    if (!("serviceWorker" in navigator) || !window.PushManager) return;
    const cfg = notificationConfig();
    try {
      const reg = await navigator.serviceWorker.ready;
      let sub = await reg.pushManager.getSubscription();
      if (!sub && cfg.vapidPublicKey) {
        sub = await reg.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array(cfg.vapidPublicKey),
        });
      }
      if (sub && cfg.url && cfg.token) {
        await postBackend({
          action: "subscribe",
          token: cfg.token,
          subscription: sub.toJSON(),
        });
      }
    } catch (err) {
      /* retry on a later launch */
    }
    await renderAlerts();
  }

  function snapshotData(obj) {
    try { return JSON.stringify(obj); } catch (err) { return ""; }
  }

  async function refreshFromServer(reason) {
    if (params.get("shot")) return false;
    if (refreshInFlight) return refreshInFlight;
    const run = (async () => {
      lastRefreshAt = Date.now();
      try {
        const fresh = await loadData();
        const snap = snapshotData(fresh);
        if (!snap) return false;
        if (snap === lastDataSnapshot) {
          await onPermissionMaybeChanged();
          return false;
        }
        lastDataSnapshot = snap;
        data = fresh;
        const local = loadLocalState();
        state = mergeProgress(data.progress, local, Boolean(demoMode));
        applyDemoStateTweaks();
        renderAll();
        return true;
      } catch (err) {
        await onPermissionMaybeChanged();
        return false;
      } finally {
        refreshInFlight = null;
      }
    })();
    refreshInFlight = run;
    return run;
  }

  function scheduleRefresh(reason) {
    const wait = Math.max(0, REFRESH_DEBOUNCE_MS - (Date.now() - lastRefreshAt));
    clearTimeout(scheduleRefresh._t);
    scheduleRefresh._t = setTimeout(() => { refreshFromServer(reason); }, wait);
  }

  function startDataPoll() {
    stopDataPoll();
    refreshTimer = setInterval(() => {
      if (document.visibilityState === "visible") refreshFromServer("poll");
    }, DATA_POLL_MS);
  }

  function stopDataPoll() {
    if (refreshTimer) {
      clearInterval(refreshTimer);
      refreshTimer = null;
    }
  }

  function maybeUpdateServiceWorker() {
    if (!("serviceWorker" in navigator) || params.get("shot")) return;
    navigator.serviceWorker.getRegistration("./sw.js").then((reg) => {
      if (reg) return reg.update();
    }).catch(() => {});
  }

  function onAppVisible(reason) {
    if (document.visibilityState && document.visibilityState !== "visible" && reason === "visibility") {
      return;
    }
    // Instant UI update for alerts/badge — do not wait for the network.
    const perm = notificationPermission();
    if (perm === "granted") {
      setAlertsOnState();
      updateAppBadge();
      ensureSubscription();
    } else {
      onPermissionMaybeChanged();
    }
    maybeUpdateServiceWorker();
    if (reason === "focus") scheduleRefresh(reason);
    else refreshFromServer(reason);
    if (document.visibilityState === "visible") startDataPoll();
  }

  function bindRefreshListeners() {
    if (refreshGesturesBound) return;
    refreshGesturesBound = true;
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") onAppVisible("visibility");
      else stopDataPoll();
    });
    window.addEventListener("pageshow", (ev) => {
      onAppVisible(ev.persisted ? "pageshow-bfcache" : "pageshow");
    });
    window.addEventListener("focus", () => onAppVisible("focus"));
    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.addEventListener("message", (ev) => {
        const msg = ev.data || {};
        if (msg.type === "push" || msg.type === "refresh-data") {
          refreshFromServer("push");
        }
      });
      // Reload on a *new* controlling SW, not the first claim after install.
      let hadController = Boolean(navigator.serviceWorker.controller);
      navigator.serviceWorker.addEventListener("controllerchange", () => {
        if (!hadController) {
          hadController = true;
          return;
        }
        if (window.__sqSwReloading) return;
        window.__sqSwReloading = true;
        location.reload();
      });
    }
    const header = $("appHeader");
    if (header) {
      header.addEventListener("click", (ev) => {
        if (ev.target && ev.target.closest && ev.target.closest("button, a, input")) return;
        refreshFromServer("header");
      });
    }
    let pullStartY = 0;
    let pulling = false;
    window.addEventListener("touchstart", (ev) => {
      if (window.scrollY <= 0 && ev.touches && ev.touches[0]) {
        pullStartY = ev.touches[0].clientY;
        pulling = true;
      } else {
        pulling = false;
      }
    }, { passive: true });
    window.addEventListener("touchend", (ev) => {
      if (!pulling) return;
      pulling = false;
      const y = (ev.changedTouches && ev.changedTouches[0] && ev.changedTouches[0].clientY) || 0;
      if (window.scrollY <= 0 && y - pullStartY > 72) refreshFromServer("pull");
    }, { passive: true });
  }

  function escapeHtml(str) {
    return String(str ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function openDB() {
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

  async function syncStateToIdb() {
    try {
      const db = await openDB();
      await new Promise((resolve, reject) => {
        if (!db.objectStoreNames.contains("appState")) {
          resolve();
          return;
        }
        const tx = db.transaction("appState", "readwrite");
        tx.objectStore("appState").put({
          key: "progress",
          completed: (state && state.completed) || {},
          updatedAt: new Date().toISOString(),
        });
        tx.oncomplete = resolve;
        tx.onerror = () => reject(tx.error);
      });
      db.close();
    } catch (err) {
      /* IDB sync is best-effort */
    }
  }

  async function savePhotoRecord(record) {
    const db = await openDB();
    await new Promise((resolve, reject) => {
      const tx = db.transaction("photos", "readwrite");
      tx.objectStore("photos").put(record);
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  }

  async function pendingUploads() {
    const db = await openDB();
    const rows = await new Promise((resolve, reject) => {
      const tx = db.transaction("photos", "readonly");
      const r = tx.objectStore("photos").getAll();
      r.onsuccess = () => resolve(r.result || []);
      r.onerror = () => reject(r.error);
    });
    db.close();
    return rows.filter((row) => row.status === "pending" || row.status === "failed");
  }

  async function markPhotoStatus(id, status, extra) {
    const db = await openDB();
    await new Promise((resolve, reject) => {
      const tx = db.transaction("photos", "readwrite");
      const store = tx.objectStore("photos");
      const g = store.get(id);
      g.onsuccess = () => {
        const row = g.result;
        if (row) store.put({ ...row, status, ...extra });
      };
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  }

  function readFile(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
  }

  async function compressImage(file, maxEdge = 2000, quality = 0.82) {
    const bitmap = await createImageBitmap(file);
    let { width, height } = bitmap;
    const scale = Math.min(1, maxEdge / Math.max(width, height));
    width = Math.round(width * scale);
    height = Math.round(height * scale);
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    ctx.drawImage(bitmap, 0, 0, width, height);
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", quality));
    bitmap.close();
    return blob || file;
  }

  function showPreview(url) {
    $("previewImage").src = url;
    $("previewOverlay").hidden = false;
  }

  function hidePreview() {
    $("previewOverlay").hidden = true;
    $("previewImage").src = "";
    pendingBlob = null;
  }

  async function onPhotoChosen(file) {
    if (!file) return;
    pendingBlob = await compressImage(file);
    const url = URL.createObjectURL(pendingBlob);
    showPreview(url);
  }

  async function confirmPhoto() {
    if (!pendingBlob) return;
    const today = effectiveToday();
    const quest = approvedQuestFor(today);
    if (!quest) return;
    $("confirmBtn").disabled = true;
    const id = `${today}-${Date.now()}`;
    const record = {
      id,
      date: today,
      createdAt: new Date().toISOString(),
      type: pendingBlob.type || "image/jpeg",
      blob: pendingBlob,
      status: "pending",
    };
    await savePhotoRecord(record);
    completeQuest(today, "photo");
    hidePreview();
    $("confirmBtn").disabled = false;
    playCelebration(today);
    uploadWithRetry(record);
  }

  function completeQuest(date, source) {
    if (isCompleted(date)) {
      maybeAwardBadges(date);
      saveLocalState();
      renderAll();
      return;
    }
    state.completed[date] = { stars: STARS_PER_PAGE, xp: XP_PER_PAGE, source, at: new Date().toISOString() };
    state.xp = (state.xp || 0) + XP_PER_PAGE;
    state.stars = (state.stars || 0) + STARS_PER_PAGE;
    state.lastCompletedDate = date;
    maybeAwardBadges(date);
    saveLocalState();
    renderAll();
  }

  function playCelebration(date) {
    const planet = (data.planets || []).find((p) => p.date === date);
    const lv = currentLevel();
    $("celeTitle").textContent = "You did it!";
    $("celeDetail").textContent = planet
      ? `${planet.name} is lit. Your page is on its way to the family journal.`
      : "Your page is on its way to the family journal.";
    $("celeAwards").innerHTML = `
      <span class="award-pill">⭐ +${STARS_PER_PAGE} stars</span>
      <span class="award-pill">✨ +${XP_PER_PAGE} XP</span>
      <span class="award-pill">Lv ${lv.level} ${escapeHtml(lv.name)}</span>
    `;
    const burst = $("burst");
    burst.innerHTML = "";
    const colors = ["#ffd166", "#ff7a59", "#7dffc4", "#7ec8ff", "#c4b5fd", "#fff"];
    for (let i = 0; i < 36; i += 1) {
      const spark = document.createElement("span");
      spark.className = "spark";
      const angle = (Math.PI * 2 * i) / 36;
      const dist = 140 + (i % 5) * 40;
      spark.style.left = "50%";
      spark.style.top = "40%";
      spark.style.background = colors[i % colors.length];
      spark.style.setProperty("--x", `${Math.cos(angle) * dist}px`);
      spark.style.setProperty("--y", `${Math.sin(angle) * dist}px`);
      spark.style.animationDelay = `${(i % 8) * 0.03}s`;
      burst.appendChild(spark);
    }
    $("celeOverlay").hidden = false;
  }

  async function blobToBase64(blob) {
    const dataUrl = await readFile(blob);
    return String(dataUrl).split(",")[1] || "";
  }

  function uploadConfig(date) {
    const url = (data.upload && data.upload.url) || "";
    const quest = approvedQuestFor(date);
    const token = (quest && quest.uploadToken) || (data.upload && data.upload.token) || "";
    return { url, token };
  }

  async function uploadWithRetry(record) {
    const note = $("uploadNote");
    const { url, token } = uploadConfig(record.date);
    if (!url || !token) {
      if (note) {
        note.className = "upload-note wait";
        note.textContent = "Saved on this iPad. A grown-up will hook up the family journal send later.";
      }
      uploadNoteState = { className: "upload-note wait", text: "Saved on this iPad. A grown-up will hook up the family journal send later." };
      return;
    }
    if (note) {
      note.className = "upload-note wait";
      note.textContent = "Sending your page to the family journal…";
    }
    uploadNoteState = { className: "upload-note wait", text: (note && note.textContent) || "Sending your page to the family journal…" };
    try {
      const imageBase64 = await blobToBase64(record.blob);
      const body = JSON.stringify({
        token,
        date: record.date,
        filename: `${record.date}-ragnar-page.jpg`,
        mime: "image/jpeg",
        imageBase64,
      });
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "text/plain;charset=utf-8" },
        body,
      });
      if (!res.ok) throw new Error("upload-failed");
      const json = await res.json().catch(() => ({}));
      if (json && json.ok === false) throw new Error(json.error || "upload-failed");
      await markPhotoStatus(record.id, "uploaded", { uploadedAt: new Date().toISOString() });
      if (note) {
        note.className = "upload-note ok";
        note.textContent = "Your page is in the family journal!";
      }
      uploadNoteState = { className: "upload-note ok", text: "Your page is in the family journal!" };
      renderQuest();
      updateAppBadge();
    } catch (err) {
      await markPhotoStatus(record.id, "failed");
      if (note) {
        note.className = "upload-note wait";
        note.textContent = "Saved on this iPad. We’ll send it when the internet is back.";
      }
      uploadNoteState = { className: "upload-note wait", text: "Saved on this iPad. We’ll send it when the internet is back." };
      renderQuest();
    }
  }

  async function flushQueue() {
    const rows = await pendingUploads().catch(() => []);
    for (const row of rows) {
      await uploadWithRetry(row);
    }
  }

  function openPinFlow(ev) {
    if (ev) ev.preventDefault();
    pinUiMode = state.pin ? "enter" : "set";
    showPinDialog();
  }

  function showPinDialog() {
    const input = $("pinInput");
    const ok = $("pinOk");
    const help = $("pinHelp");
    const title = $("pinTitle");
    const err = $("pinError");
    if (err) {
      err.hidden = true;
      err.textContent = "";
    }
    const undoBtn = $("pinUndo");
    if (undoBtn) undoBtn.hidden = true;
    if (pinUiMode === "saved") {
      title.textContent = "PIN saved";
      help.textContent = "This PIN stays on this iPad only. Open Grown-ups again if you need to mark a quest done without the camera.";
      input.value = "";
      input.hidden = true;
      ok.hidden = false;
      ok.textContent = "OK";
    } else if (pinUiMode === "undo") {
      title.textContent = "Today’s quest is already done";
      help.textContent = "You can undo that if it was a mistake. The quest will show again for Ragnar.";
      input.value = "";
      input.hidden = true;
      ok.hidden = true;
      if (undoBtn) undoBtn.hidden = false;
    } else {
      input.hidden = false;
      input.value = "";
      ok.hidden = false;
      ok.textContent = "Continue";
      if (pinUiMode === "enter") {
        title.textContent = "Grown-ups";
        help.textContent = "Enter the 4-digit PIN to mark today’s quest done if the camera cannot be used.";
      } else {
        title.textContent = "Set a grown-up PIN";
        help.textContent = "Choose a 4-digit PIN. It stays on this iPad only. Use it if the camera cannot snap a page.";
      }
    }
    $("pinOverlay").hidden = false;
    if (pinUiMode !== "saved") {
      setTimeout(() => {
        try { input.focus({ preventScroll: true }); } catch (err) { input.focus(); }
      }, 150);
    }
  }

  function handlePin() {
    const err = $("pinError");
    if (pinUiMode === "saved") {
      $("pinOverlay").hidden = true;
      return;
    }
    const value = ($("pinInput").value || "").trim();
    if (err) err.hidden = true;
    if (!/^\d{4}$/.test(value)) {
      if (err) {
        err.hidden = false;
        err.textContent = "Please use exactly 4 digits.";
      }
      return;
    }
    if (!state.pin) {
      state.pin = value;
      afterStateChange();
      pinUiMode = "saved";
      showPinDialog();
      return;
    }
    if (value !== state.pin) {
      if (err) {
        err.hidden = false;
        err.textContent = "That PIN does not match.";
      }
      return;
    }
    const today = effectiveToday();
    const quest = approvedQuestFor(today);
    if (!quest) {
      if (err) {
        err.hidden = false;
        err.textContent = "There’s no approved quest to mark done today.";
      }
      $("pinInput").value = "";
      return;
    }
    if (isCompleted(today)) {
      pinUiMode = "undo";
      showPinDialog();
      return;
    }
    $("pinOverlay").hidden = true;
    completeQuest(today, "parent-pin");
    playCelebration(today);
  }

  function handleUndoDone() {
    const today = effectiveToday();
    if (!isCompleted(today)) {
      $("pinOverlay").hidden = true;
      return;
    }
    if (undoCompletion(today)) afterStateChange();
    $("pinOverlay").hidden = true;
  }

  function bind() {
    $("pagePhoto").addEventListener("change", (ev) => {
      const file = ev.target.files && ev.target.files[0];
      ev.target.value = "";
      if (file) onPhotoChosen(file);
    });
    $("retakeBtn").addEventListener("click", () => {
      hidePreview();
      $("pagePhoto").click();
    });
    $("confirmBtn").addEventListener("click", confirmPhoto);
    $("celeDone").addEventListener("click", () => { $("celeOverlay").hidden = true; });
    $("grownupsBtn").addEventListener("click", openPinFlow);
    $("pinCancel").addEventListener("click", () => { $("pinOverlay").hidden = true; });
    const pinUndo = $("pinUndo");
    if (pinUndo) pinUndo.addEventListener("click", handleUndoDone);
    $("pinOk").addEventListener("click", handlePin);
    $("pinInput").addEventListener("keydown", (ev) => {
      if (ev.key === "Enter") handlePin();
    });
    const alertsBtn = $("alertsBtn");
    if (alertsBtn) alertsBtn.addEventListener("click", enableAlerts);
  }

  async function loadData() {
    const res = await fetch("./data.json", { cache: "no-store" });
    if (!res.ok) throw new Error("data");
    return res.json();
  }

  function applyDemoStateTweaks() {
    if (demoMode === "complete") {
      const today = effectiveToday();
      if (!isCompleted(today) && approvedQuestFor(today)) {
        state.completed[today] = { stars: STARS_PER_PAGE, xp: XP_PER_PAGE, source: "photo" };
        state.xp = (state.xp || 0) + XP_PER_PAGE;
        state.stars = (state.stars || 0) + STARS_PER_PAGE;
        maybeAwardBadges(today);
      }
    }
  }

  async function start() {
    data = await loadData().catch(() => ({
      childName: "Ragnar",
      timezone: TZ,
      strengths: [],
      badges: [],
      planets: [],
      quests: [],
      progress: emptyProgress(),
      levels: [{ level: 1, name: "Space Cadet", xp: 0 }],
    }));
    const local = loadLocalState();
    const demo = Boolean(demoMode);
    state = mergeProgress(data.progress, local, demo);
    if (!demo) {
      /* Production: ignore any leftover demo completions if they were never saved locally. */
    }
    applyDemoStateTweaks();
    lastDataSnapshot = snapshotData(data);
    bind();
    bindRefreshListeners();
    watchPermissionChanges();
    await runMigrations();
    renderAll();
    if (demoMode === "complete") {
      playCelebration(effectiveToday());
    }
    if (demoMode === "snap") {
      setupDemoSnap();
    }
    if ("serviceWorker" in navigator && !params.get("shot")) {
      navigator.serviceWorker.register("./sw.js").then((reg) => {
        try { reg.update(); } catch (err) { /* ignore */ }
        if (!demoMode) ensureSubscription();
        else renderAlerts();
      }).catch(() => { renderAlerts(); });
    }
    startDataPoll();
    if (params.get("test") === "1") {
      window.__spaceQuestTest = {
        badgeCount: () => badgeCountForToday(),
        openQuestPending: () => openQuestPending(),
        isStandalone: () => isStandalone(),
        alertsVisible: () => Boolean($("alertsCard") && !$("alertsCard").hidden),
        alertsButtonVisible: () => {
          const btn = $("alertsBtn");
          if (!btn) return false;
          const style = window.getComputedStyle(btn);
          return style.display !== "none" && style.visibility !== "hidden" && !btn.hidden;
        },
        alertsOnVisible: () => {
          const el = $("alertsOn");
          if (!el || el.hidden) return false;
          const style = window.getComputedStyle(el);
          return style.display !== "none" && style.visibility !== "hidden";
        },
        alertsButtonDisplay: () => $("alertsBtn") ? window.getComputedStyle($("alertsBtn")).display : "missing",
        setMockSubscription: (sub) => { testMockSubscription = sub; },
        undoCompletion,
        runMigrations,
        isCompleted: (date) => isCompleted(date || effectiveToday()),
        stars: () => state.stars || 0,
        xp: () => state.xp || 0,
        streak: () => state.streak || 0,
        completedDates: () => Object.keys((state && state.completed) || {}),
        pinOverlayVisible: () => Boolean($("pinOverlay") && !$("pinOverlay").hidden),
        pinTitle: () => $("pinTitle") ? $("pinTitle").textContent : "",
        pinHelp: () => $("pinHelp") ? $("pinHelp").textContent : "",
        pinError: () => ($("pinError") && !$("pinError").hidden) ? $("pinError").textContent : "",
        pinInputHidden: () => Boolean($("pinInput") && $("pinInput").hidden),
        hasPin: () => Boolean(state.pin),
        today: () => effectiveToday(),
        hasVapid: () => Boolean(notificationConfig().vapidPublicKey),
        hasSetAppBadge: "setAppBadge" in navigator,
        hasPushManager: Boolean(window.PushManager),
        setAlertsOnState,
        renderAlerts,
        refreshFromServer,
        onAppVisible,
        onPermissionMaybeChanged,
        notificationPermission,
        queryNotificationPermission,
        questTitle: () => ($("questCard") && $("questCard").querySelector(".quest-title") || {}).textContent || "",
        questText: () => $("questCard") ? $("questCard").innerText : "",
        hudText: () => $("hud") ? $("hud").innerText : "",
        snapshot: () => lastDataSnapshot,
      };
      document.body.dataset.test = JSON.stringify({
        badgeCount: window.__spaceQuestTest.badgeCount(),
        openQuestPending: window.__spaceQuestTest.openQuestPending(),
        isStandalone: window.__spaceQuestTest.isStandalone(),
        alertsVisible: window.__spaceQuestTest.alertsVisible(),
        alertsButtonVisible: window.__spaceQuestTest.alertsButtonVisible(),
        alertsOnVisible: window.__spaceQuestTest.alertsOnVisible(),
        today: window.__spaceQuestTest.today(),
        hasVapid: window.__spaceQuestTest.hasVapid(),
        hasSetAppBadge: window.__spaceQuestTest.hasSetAppBadge,
        hasPushManager: window.__spaceQuestTest.hasPushManager,
      });
    }
    flushQueue();
  }

  async function setupDemoSnap() {
    const today = effectiveToday();
    if (!approvedQuestFor(today)) return;
    try {
      const res = await fetch("./icons/sample-page.jpg");
      if (!res.ok) return;
      pendingBlob = await res.blob();
      showPreview(URL.createObjectURL(pendingBlob));
    } catch {
      /* no sample image */
    }
  }

  start();
})();
