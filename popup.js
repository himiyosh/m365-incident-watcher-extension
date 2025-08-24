// popup.js v1.4.0-seq + preview
const idsEl = document.getElementById("ids");
const intervalEl = document.getElementById("interval");
const bgEnabledEl = document.getElementById("bgEnabled");
const saveBtn = document.getElementById("saveBtn");
const pokeBtn = document.getElementById("pokeBtn");
const testNotifyBtn = document.getElementById("testNotifyBtn");
const diagBtn = document.getElementById("diagBtn");
const statusBox = document.getElementById("statusBox");
const resultBody = document.getElementById("resultBody");

// preview modal
const modal = document.getElementById("previewModal");
const pvTitle = document.getElementById("pvTitle");
const pvText = document.getElementById("pvText");
const pvClose = document.getElementById("pvClose");
const tabLatest = document.getElementById("tabLatest");
const tabPrev = document.getElementById("tabPrev");
const tabDiff = document.getElementById("tabDiff");

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
      modal.style.display = "block";
      const r = await chrome.runtime.sendMessage({ type: "getSnapshots", incidentId }).catch(()=>null);
      const last = r?.last || "";
      const prev = r?.prev || "";

      // 既定は最新
      pvText.textContent = last || "(スナップショット無し)";

      tabLatest.onclick = () => { pvText.textContent = last || "(スナップショット無し)"; };
      tabPrev.onclick   = () => { pvText.textContent = prev || "(前回スナップショット無し)"; };
      tabDiff.onclick   = () => { pvText.innerHTML = diffLines(prev, last); };
    });
  });
}

function setStatus(msg) {
  statusBox.textContent = msg + "\n" + statusBox.textContent;
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
  }
}

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

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === "bgStart") {
    setStatus(`⏳ チェック開始: ${msg.ids.length} 件`);
  } else if (msg?.type === "bgResult") {
    const id = msg.incidentId;
    const st = msg.result;
    const icon = st.ok ? (st.changed ? "🟢" : "⚪") : "❌";
    const line = `${icon} ${id}: ${st.ok ? (st.changed ? "変更あり" : "変更なし") : "失敗"} ${st.note ? "｜ " + String(st.note).slice(0,60) : ""}`;
    setStatus(line);
    chrome.runtime.sendMessage({ type: "getSettings" }).then(res => res?.state && renderTable(res.state));
  } else if (msg?.type === "bgDone") {
    const when = new Date(msg.at).toLocaleString();
    setStatus(`✅ チェック完了（変更: ${msg.changedCount}） @ ${when}`);
  } else if (msg?.type === "bgTick") {
    const when = new Date(msg.when).toLocaleString();
    setStatus(`⏰ アラーム(${msg.name})発火 @ ${when}`);
  }
});

// modal close
pvClose.onclick = () => { modal.style.display = "none"; };
modal.addEventListener("click", (e) => {
  if (e.target === modal) modal.style.display = "none";
});

load();
