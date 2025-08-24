// popup.js v1.4.0-seq + preview
const idsEl = document.getElementById("ids");
const intervalEl = document.getElementById("interval");
const bgEnabledEl = document.getElementById("bgEnabled");
const saveBtn = document.getElementById("saveBtn");
const pokeBtn = document.getElementById("pokeBtn");
const stopBtn = document.getElementById("stopBtn");
const testNotifyBtn = document.getElementById("testNotifyBtn");
const diagBtn = document.getElementById("diagBtn");
const statusBox = document.getElementById("statusBox");
const resultBody = document.getElementById("resultBody");

// preview modal
const modal = document.getElementById("previewModal");
const pvTitle = document.getElementById("pvTitle");
const pvText = document.getElementById("pvText");
const pvHtml = document.getElementById("pvHtml");
const pvClose = document.getElementById("pvClose");
const tabTextLatest = document.getElementById("tabTextLatest");
const tabTextPrev = document.getElementById("tabTextPrev");
const tabTextDiff = document.getElementById("tabTextDiff");
const tabHtmlLatest = document.getElementById("tabHtmlLatest");
const tabHtmlPrev = document.getElementById("tabHtmlPrev");

function parseIds(text) {
  return text
    .split(/[\s,;]+/)
    .map(s => s.trim().toUpperCase())
    .filter(Boolean);
}
function fmt(ts) {
  if (!ts) return "-";
  const d = new Date(ts);
  return d.toLocaleString();
}
function esc(s) { return String(s || "").replaceAll("<","&lt;"); }

// 差分（行単位の超軽量版）
function diffLines(a, b) {
  const A = String(a||"").split(/\r?\n/);
  const B = String(b||"").split(/\r?\n/);
  const max = Math.max(A.length, B.length);
  const out = [];
  for (let i=0;i<max;i++){
    const l = A[i] ?? "";
    const r = B[i] ?? "";
    if (l === r) out.push(`<div class="diff-ctx">${esc(l)}</div>`);
    else {
      if (r) out.push(`<div class="diff-add">+ ${esc(r)}</div>`);
      if (l) out.push(`<div class="diff-del">- ${esc(l)}</div>`);
    }
  }
  return out.join("\n");
}

function renderTable(state) {
  const ids = parseIds(idsEl.value);
  resultBody.innerHTML = "";
  ids.forEach(id => {
    const row = document.createElement("tr");
    const st = state.lastStatus?.[id] || null;
    const checkAt = state.lastCheckAt?.[id] || null;

    // === ここがポイント：今回のチェックで緑にするか ===
    // ・「今回の判定」でのみ緑（changed=true）を表示
    // ・過去に一度でも変更があったという履歴 (lastChangeAt) だけでは緑にしない
    const changedNow = !!(st && st.ok && st.changed === true);
    const statusTxt = st ? (st.ok ? (changedNow ? "変更あり" : "変更なし") : "失敗") : "－";
    const className = st ? (st.ok ? (changedNow ? "ok" : "muted") : "fail") : "muted";
    const icon = changedNow ? "🟢" : (st ? (st.ok ? "⚪" : "❌") : "⚪");
    const note = st?.note ? String(st.note) : "";

    row.innerHTML = `
      <td class="mono col-id">${id}</td>
      <td class="col-check-at">${fmt(checkAt)}</td>
      <td class="${className} col-status">${icon} ${statusTxt}</td>
      <td class="mono col-note">${esc(note).slice(0, 80)}</td>
      <td class="col-actions">
        <button data-open="${id}">開く</button>
        <button data-prev="${id}">プレビュー</button>
      </td>
    `;
    resultBody.appendChild(row);
  });

  // 開く
  resultBody.querySelectorAll("button[data-open]").forEach(btn => {
    btn.addEventListener("click", async () => {
      const incidentId = btn.getAttribute("data-open");
      const resp = await chrome.runtime.sendMessage({ type: "openIncident", incidentId }).catch(() => null);
      if (!resp?.ok) {
        const url = `https://lynx.office.net/incident/${encodeURIComponent(incidentId)}`;
        await chrome.tabs.create({ url });
      }
    });
  });

  // プレビュー
  resultBody.querySelectorAll("button[data-prev]").forEach(btn => {
    btn.addEventListener("click", async () => {
      const incidentId = btn.getAttribute("data-prev");
      pvTitle.textContent = `プレビュー: ${incidentId}`;
      pvText.innerHTML = "読み込み中…";
      pvHtml.style.display = "none";
      pvText.style.display = "block";
      modal.style.display = "block";

      const [textR, htmlR] = await Promise.all([
        chrome.runtime.sendMessage({ type: "getSnapshots", incidentId }),
        chrome.runtime.sendMessage({ type: "getHtmlSnapshots", incidentId })
      ]);

      const lastText = textR?.last || "";
      const prevText = textR?.prev || "";
      const lastHtml = htmlR?.lastHtml || "";
      const prevHtml = htmlR?.prevHtml || "";

      const allTabs = [tabTextLatest, tabTextPrev, tabTextDiff, tabHtmlLatest, tabHtmlPrev];
      const setActiveTab = (activeTab) => {
        allTabs.forEach(tab => {
          tab.classList.toggle("active", tab === activeTab);
        });
      };

      const showView = (mode) => {
        pvText.style.display = mode === "text" ? "block" : "none";
        pvHtml.style.display = mode === "html" ? "block" : "none";
      };

      // --- Text Tabs ---
      tabTextLatest.onclick = () => {
        showView("text");
        pvText.textContent = lastText || "(スナップショット無し)";
        setActiveTab(tabTextLatest);
      };
      tabTextPrev.onclick = () => {
        showView("text");
        pvText.textContent = prevText || "(前回スナップショット無し)";
        setActiveTab(tabTextPrev);
      };
      tabTextDiff.onclick = () => {
        showView("text");
        pvText.innerHTML = diffLines(prevText, lastText);
        setActiveTab(tabTextDiff);
      };

      // --- HTML Tabs ---
      tabHtmlLatest.onclick = () => {
        showView("html");
        pvHtml.srcdoc = lastHtml || "<html><body>(スナップショット無し)</body></html>";
        setActiveTab(tabHtmlLatest);
      };
      tabHtmlPrev.onclick = () => {
        showView("html");
        pvHtml.srcdoc = prevHtml || "<html><body>(前回スナップショット無し)</body></html>";
        setActiveTab(tabHtmlPrev);
      };

      // Initial state
      tabTextLatest.onclick();
    });
  });
}

function setStatus(msg) {
  // This function is now only for temporary status updates
  statusBox.textContent = msg;
}

function renderLogs(logs) {
  if (!logs || !logs.length) {
    statusBox.textContent = "（ログはありません）";
    return;
  }
  const lines = logs.map(log => `[${new Date(log.ts).toLocaleString()}] ${log.msg}`);
  statusBox.textContent = lines.join("\n");
}

function updateButtonStates(isChecking) {
  pokeBtn.disabled = isChecking;
  stopBtn.hidden = !isChecking;
}

async function load() {
  const resp = await chrome.runtime.sendMessage({ type: "getSettings" });
  if (resp?.ok) {
    const st = resp.state;
    if (st.rawIdsText && typeof st.rawIdsText === "string") {
      idsEl.value = st.rawIdsText;
    } else {
      idsEl.value = (st.incidentIds || []).join("\n");
    }
    intervalEl.value = st.intervalMinutes || 10;
    bgEnabledEl.checked = !!st.bgPollingEnabled;
    renderTable(st);
    renderLogs(st.logs);
    updateButtonStates(st.isChecking);
  }
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.runtime) {
    const newRuntime = changes.runtime.newValue;
    renderLogs(newRuntime.logs);
    updateButtonStates(newRuntime.isChecking);
    // Re-render table to update status icons
    renderTable(newRuntime);
  }
});

saveBtn.addEventListener("click", async () => {
  const rawIdsText = idsEl.value;
  const incidentIds = parseIds(rawIdsText);
  const intervalMinutes = Number(intervalEl.value) || 10;
  const bgPollingEnabled = bgEnabledEl.checked;
  await chrome.runtime.sendMessage({ type: "saveSettings", payload: { incidentIds, intervalMinutes, bgPollingEnabled, rawIdsText } });
  setStatus("✅ 設定を保存しました。（5秒後に一度だけ自動実行します）");
  const res = await chrome.runtime.sendMessage({ type: "getSettings" });
  if (res?.ok) renderTable(res.state);
});

pokeBtn.addEventListener("click", async () => {
  setStatus("🔄 バックグラウンドチェックを開始しました…");
  await chrome.runtime.sendMessage({ type: "pokeAll" });
});

stopBtn.addEventListener("click", async () => {
  setStatus("⏹️ チェックの中断をリクエストしました…");
  await chrome.runtime.sendMessage({ type: "stop" });
});

testNotifyBtn.addEventListener("click", async () => {
  let level = "(unknown)";
  try {
    if (chrome.notifications?.getPermissionLevel) {
      level = await new Promise((resolve) => chrome.notifications.getPermissionLevel(resolve));
    }
  } catch {}
  try {
    const r = await chrome.runtime.sendMessage({ type: "testNotify" });
    if (r?.ok) setStatus(`🔔 テスト通知を送信しました。通知権限: ${level}（使用: ${r.used || "-"}）`);
    else setStatus(`⚠️ 通知テストに失敗しました。通知権限: ${level}（詳細: ${r?.error || "unknown"}）`);
  } catch (e) {
    setStatus(`⚠️ 通知テストに失敗しました（メッセージ送信エラー）。通知権限: ${level}（詳細: ${e?.message || e}）`);
  }
});

diagBtn.addEventListener("click", async () => {
  const res = await chrome.runtime.sendMessage({ type: "diagnostics" });
  if (!res?.ok) { setStatus("診断情報を取得できませんでした。"); return; }
  const alarms = res.alarms || [];
  const nexts = alarms.map(a => `${a.name}: 次回 ${a.scheduledTime ? new Date(a.scheduledTime).toLocaleString() : "-"}`).join("\n") || "（アラームなし）";
  const lastRun = res.state?.lastRunAt ? new Date(res.state.lastRunAt).toLocaleString() : "-";
  const enabled = res.state?.bgPollingEnabled ? "有効" : "無効";
  setStatus(`⚙️ 診断\n- 背景監視: ${enabled}\n- 前回実行: ${lastRun}\n- アラーム一覧:\n${nexts}`);
});

// ログはストレージから読み込むので、動的なメッセージリスナーは不要

// modal close
pvClose.onclick = () => { modal.style.display = "none"; };
modal.addEventListener("click", (e) => {
  if (e.target === modal) modal.style.display = "none";
});

load();
