// background.js v1.4.0-seq + robust waits
const DEFAULT_INTERVAL_MINUTES = 10;

const DEFAULT_SETTINGS = {
  incidentIds: [],
  rawIdsText: "",
  intervalMinutes: DEFAULT_INTERVAL_MINUTES,
  bgPollingEnabled: true
};

const DEFAULT_RUNTIME = {
  lastHashes: {},
  lastChangeAt: {},
  lastSnapshot: {},   // text
  prevSnapshot: {},   // text
  lastHtml: {},       // html (sanitized)
  prevHtml: {},       // html (sanitized)
  lastCheckAt: {},
  lastStatus: {},
  lastRunAt: null
};

const ALARM_NAME = "incident-bg-poll";
const IMMEDIATE_ALARM_NAME = "incident-bg-poll-now";

const ICON_CANDIDATES = [
  () => chrome.runtime.getURL("icons/icon128.png"),
  () => chrome.runtime.getURL("icons/icon48.png"),
  () => chrome.runtime.getURL("icons/icon32.png"),
  () => chrome.runtime.getURL("icons/icon16.png"),
  () => null
];

async function createNotificationBase(opts) {
  let lastErr = null;
  for (const getUrl of ICON_CANDIDATES) {
    try {
      const iconUrl = getUrl();
      const payload = iconUrl ? { ...opts, iconUrl } : { ...opts };
      const id = opts.id || `n:${Date.now()}`;
      await chrome.notifications.create(id, payload);
      return { ok: true, used: iconUrl || "(none)" };
    } catch (e) { lastErr = e; }
  }
  return { ok: false, error: lastErr?.message || String(lastErr) || "unknown" };
}

async function getSettings() {
  const { settings } = await chrome.storage.sync.get("settings");
  return { ...DEFAULT_SETTINGS, ...(settings || {}) };
}
async function setSettings(next) {
  const cur = await getSettings();
  const merged = { ...cur, ...(next || {}) };
  await chrome.storage.sync.set({ settings: merged });
  return merged;
}
async function getRuntime() {
  const { runtime } = await chrome.storage.local.get("runtime");
  return { ...DEFAULT_RUNTIME, ...(runtime || {}) };
}
async function setRuntime(patch) {
  const cur = await getRuntime();
  const merged = { ...cur, ...(patch || {}) };
  await chrome.storage.local.set({ runtime: merged });
  return merged;
}

async function sha256Hex(str) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(str));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, "0")).join("");
}

function sanitizeText(t) {
  return (t || "")
    .replace(/[ \t]+/g, " ") // Keep newlines for diff view
    .replace(/request[-_ ]?id[:=]?\s*[a-f0-9-]+/ig, "")
    .replace(/updated[:=]?\s*\d{4}-\d{2}-\d{2}[ t]\d{2}:\d{2}:\d{2}(?:\.\d+)?z?/ig, "")
    .trim();
}

// ハッシュ化のための、より積極的なサニタイズ
function sanitizeHtmlForHashing(html) {
  try {
    const doc = new DOMParser().parseFromString(String(html || ""), "text/html");

    // Remove comments first
    doc.querySelectorAll('*').forEach(el => {
        [...el.childNodes].filter(node => node.nodeType === 8)
          .forEach(comment => el.removeChild(comment));
    });

    doc.querySelectorAll("*").forEach(el => {
      // Remove attributes that are likely to be dynamic or irrelevant to content change
      el.removeAttribute("id");
      el.removeAttribute("style");

      const attrsToRemove = [];
      for (const attr of el.attributes) {
        if (attr.name.startsWith("data-")) {
            attrsToRemove.push(attr.name);
        }
      }
      attrsToRemove.forEach(attrName => el.removeAttribute(attrName));

      // Normalize class attributes by sorting them
      if (el.hasAttribute("class")) {
        const classes = el.getAttribute("class").split(/\s+/).filter(Boolean).sort().join(" ");
        el.setAttribute("class", classes);
      }
    });
    return doc.body.innerHTML;
  } catch (e) {
    console.error("Error in sanitizeHtmlForHashing:", e);
    return String(html || "");
  }
}

// シンプルサニタイズ（script/iframe/イベント属性除去）
function sanitizeHtml(html) {
  try {
    const doc = new DOMParser().parseFromString(String(html || ""), "text/html");
    doc.querySelectorAll("script, iframe, object, embed").forEach(el => el.remove());
    doc.querySelectorAll("*").forEach(el => {
      [...el.attributes].forEach(attr => {
        if (/^on/i.test(attr.name)) el.removeAttribute(attr.name);
      });
    });
    let base = doc.querySelector("base");
    if (!base) {
      base = doc.createElement("base");
      base.setAttribute("href", "https://lynx.office.net/");
      doc.head && doc.head.prepend(base);
    }
    doc.querySelectorAll("a[target]").forEach(a => a.removeAttribute("target"));
    doc.querySelectorAll('meta[http-equiv="refresh"]').forEach(m => m.remove());
    return "<!doctype html>\n" + doc.documentElement.outerHTML;
  } catch {
    return String(html || "");
  }
}

async function notifyChange(incidentId, title, hint) {
  const res = await createNotificationBase({
    type: "basic",
    title: `${title || `Incident ${incidentId}`} が更新されました`,
    message: (hint || "更新を検知しました").slice(0, 250),
    priority: 2,
    id: `incident:${incidentId}:${Date.now()}`
  });
  chrome.notifications.onClicked.addListener((clickedId) => {
    if (clickedId && String(clickedId).startsWith("incident:")) {
      const id = clickedId.split(":")[1];
      const url = `https://lynx.office.net/incident/${encodeURIComponent(id)}`;
      chrome.tabs.create({ url });
    }
  });
  return res;
}

async function handleSnapshotFromCS({ incidentId, title, snapshotText, snapshotHtml, contentHtml }) {
  const now = Date.now();
  const oldRuntime = await getRuntime();
  const result = { ok: false, changed: false, note: "" };

  if (!incidentId || !contentHtml || !contentHtml.trim()) {
    result.ok = false;
    result.note = "NO_CONTENT";
    const nextRuntime = {
      ...oldRuntime,
      lastCheckAt: { ...oldRuntime.lastCheckAt, [incidentId]: now },
      lastStatus: { ...oldRuntime.lastStatus, [incidentId]: { ...result } },
    };
    await setRuntime(nextRuntime);
    chrome.runtime.sendMessage({ type: "bgResult", incidentId, result }).catch(()=>{});
    return result;
  }

  // Sanitize and hash the new content
  const safeContentHtml = sanitizeHtmlForHashing(contentHtml);
  const hash = await sha256Hex(safeContentHtml);
  const prevHash = oldRuntime.lastHashes[incidentId];

  // Sanitize other data for storage and preview
  const normText = sanitizeText(snapshotText);
  const safeFullHtml = sanitizeHtml(snapshotHtml);

  const newRuntime = { ...oldRuntime };

  if (prevHash && prevHash !== hash) {
    result.changed = true;
    console.log(`[${new Date().toISOString()}] Change detected for ${incidentId}. Notifying.`);

    // Copy the last known state to the "previous" state fields
    newRuntime.prevSnapshot = { ...oldRuntime.prevSnapshot, [incidentId]: oldRuntime.lastSnapshot?.[incidentId] || "" };
    newRuntime.prevHtml = { ...oldRuntime.prevHtml, [incidentId]: oldRuntime.lastHtml?.[incidentId] || "" };
    newRuntime.lastChangeAt = { ...oldRuntime.lastChangeAt, [incidentId]: now };

    await notifyChange(incidentId, title || `Incident ${incidentId}`, normText.slice(0, 200));
  }

  // Always update the "last" state fields with the current data
  newRuntime.lastHashes = { ...oldRuntime.lastHashes, [incidentId]: hash };
  newRuntime.lastSnapshot = { ...oldRuntime.lastSnapshot, [incidentId]: normText };
  newRuntime.lastHtml = { ...oldRuntime.lastHtml, [incidentId]: safeFullHtml };

  result.ok = true;
  result.note = normText.slice(0, 120);

  // Update check time and status
  newRuntime.lastCheckAt = { ...oldRuntime.lastCheckAt, [incidentId]: now };
  newRuntime.lastStatus = { ...oldRuntime.lastStatus, [incidentId]: { ...result } };

  await setRuntime(newRuntime);
  chrome.runtime.sendMessage({ type: "bgResult", incidentId, result }).catch(()=>{});
  return result;
}

async function rescheduleAlarm() {
  const s = await getSettings();
  await chrome.alarms.clear(ALARM_NAME);
  await chrome.alarms.clear(IMMEDIATE_ALARM_NAME);
  if (s.bgPollingEnabled) {
    const period = Math.max(1, Number(s.intervalMinutes) || DEFAULT_INTERVAL_MINUTES);
    await chrome.alarms.create(ALARM_NAME, { periodInMinutes: period });
  }
}

chrome.runtime.onInstalled.addListener(async () => {
  const { settings } = await chrome.storage.sync.get("settings");
  if (!settings) await chrome.storage.sync.set({ settings: DEFAULT_SETTINGS });
  const { runtime } = await chrome.storage.local.get("runtime");
  if (!runtime) await chrome.storage.local.set({ runtime: DEFAULT_RUNTIME });
  await rescheduleAlarm();
  chrome.action.setBadgeText({ text: "" });
});
chrome.runtime.onStartup?.addListener(async () => { await rescheduleAlarm(); });
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "sync" && changes.settings) rescheduleAlarm();
});

let queueRunning = false;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// 逐次：同一バッチ内で連続処理
async function pollOnceAll() {
  const s = await getSettings();
  if (!s.bgPollingEnabled) return;
  const ids = (s.incidentIds || []).map(x => x.trim()).filter(Boolean);
  if (!ids.length) return;
  if (queueRunning) return;
  queueRunning = true;

  chrome.runtime.sendMessage({ type: "bgStart", ids }).catch(()=>{});
  let changedCount = 0;

  try {
    for (const id of ids) {
      const r = await openInactiveTabAndSnapshot(id);
      if (r?.changed) changedCount++;
      await sleep(150);
    }
  } finally {
    const now = Date.now();
    const rt = await getRuntime();
    rt.lastRunAt = now;
    await setRuntime(rt);
    chrome.action.setBadgeText({ text: changedCount ? String(Math.min(99, changedCount)) : "" });
    chrome.runtime.sendMessage({ type: "bgDone", changedCount, at: now }).catch(()=>{});
    queueRunning = false;
  }
}

chrome.alarms.onAlarm.addListener(async (a) => {
  if (a.name === ALARM_NAME || a.name === IMMEDIATE_ALARM_NAME) {
    chrome.runtime.sendMessage({ type: "bgTick", name: a.name, when: Date.now() }).catch(()=>{});
    await pollOnceAll();
    if (a.name === IMMEDIATE_ALARM_NAME) await chrome.alarms.clear(IMMEDIATE_ALARM_NAME);
  }
});

// イベント駆動でスナップショットを取得
async function openInactiveTabAndSnapshot(incidentId) {
  const url = `https://lynx.office.net/incident/${encodeURIComponent(incidentId)}`;
  let tabId = null;

  return new Promise(async (resolve) => {
    const timeout = setTimeout(() => {
      cleanupAndFail("TIMEOUT");
    }, 90000); // 90秒でタイムアウト

    const onSnapshot = async (msg, sender) => {
      if (msg?.type === "snapshotFromCS" && sender.tab?.id === tabId && msg.payload?.incidentId === incidentId) {
        const result = await handleSnapshotFromCS(msg.payload);
        cleanup();
        resolve(result);
      }
    };

    const cleanup = () => {
      clearTimeout(timeout);
      chrome.runtime.onMessage.removeListener(onSnapshot);
      if (tabId) {
        chrome.tabs.remove(tabId).catch(() => {});
        tabId = null;
      }
    };

    const cleanupAndFail = async (note) => {
      const rt = await getRuntime();
      rt.lastCheckAt[incidentId] = Date.now();
      rt.lastStatus[incidentId] = { ok: false, changed: false, note };
      await setRuntime(rt);
      chrome.runtime.sendMessage({ type: "bgResult", incidentId, result: rt.lastStatus[incidentId] }).catch(() => {});
      cleanup();
      resolve(rt.lastStatus[incidentId]);
    };

    try {
      chrome.runtime.onMessage.addListener(onSnapshot);
      const wins = await chrome.windows.getAll({ populate: false, windowTypes: ["normal"] });
      const targetWindowId = wins.length > 0 ? wins[0].id : (await chrome.windows.create({ focused: false })).id;
      const tab = await chrome.tabs.create({ url, active: false, windowId: targetWindowId });
      tabId = tab.id;

      // タブのロード完了を待ってから注入
      await new Promise(res => {
        const listener = (tid, info) => {
          if (tid === tabId && info.status === "complete") {
            chrome.tabs.onUpdated.removeListener(listener);
            res();
          }
        };
        chrome.tabs.onUpdated.addListener(listener);
      });

      await chrome.scripting.executeScript({
        target: { tabId: tabId },
        files: ["content-script.js"],
      });
    } catch (e) {
      cleanupAndFail(`ERROR: ${e?.message || e}`);
    }
  });
}

// ===== messaging =====
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    if (msg?.type === "saveSettings") {
      const { incidentIds, intervalMinutes, bgPollingEnabled, rawIdsText } = msg.payload || {};
      await setSettings({
        incidentIds,
        intervalMinutes: Math.max(1, Number(intervalMinutes) || DEFAULT_INTERVAL_MINUTES),
        bgPollingEnabled: !!bgPollingEnabled,
        rawIdsText: String(rawIdsText || "")
      });
      await rescheduleAlarm();
      await chrome.alarms.create(IMMEDIATE_ALARM_NAME, { when: Date.now() + 5000 });
      sendResponse({ ok: true });
    } else if (msg?.type === "getSettings") {
      const s = await getSettings();
      const r = await getRuntime();
      sendResponse({ ok: true, state: { ...s, ...r } });
    } else if (msg?.type === "pokeAll") {
      pollOnceAll();
      sendResponse({ ok: true });
    } else if (msg?.type === "snapshotFromCS") {
      const res = await handleSnapshotFromCS(msg.payload);
      sendResponse({ ok: true, res });
    } else if (msg?.type === "openIncident") {
      const { incidentId } = msg;
      if (!incidentId) return sendResponse({ ok: false });
      const url = `https://lynx.office.net/incident/${encodeURIComponent(incidentId)}`;
      await chrome.tabs.create({ url });
      sendResponse({ ok: true });
    } else if (msg?.type === "getSnapshots") {
      const { incidentId } = msg;
      const rt = await getRuntime();
      sendResponse({
        ok: true,
        incidentId,
        last: rt.lastSnapshot?.[incidentId] || "",
        prev: rt.prevSnapshot?.[incidentId] || ""
      });
    } else if (msg?.type === "getHtmlSnapshots") {
      const { incidentId } = msg;
      const rt = await getRuntime();
      sendResponse({
        ok: true,
        incidentId,
        lastHtml: rt.lastHtml?.[incidentId] || "",
        prevHtml: rt.prevHtml?.[incidentId] || ""
      });
    } else if (msg?.type === "testNotify") {
      const base = {
        type: "basic",
        title: "通知テスト",
        message: "これは拡張機能の通知テストです。OS の通知センターで確認してください。",
        priority: 1
      };
      const r = await createNotificationBase(base);
      sendResponse(r);
    } else if (msg?.type === "diagnostics") {
      const s = await getSettings();
      const r = await getRuntime();
      const alarms = await chrome.alarms.getAll();
      sendResponse({ ok: true, state: { ...s, ...r }, alarms });
    }
  })();
  return true;
});
