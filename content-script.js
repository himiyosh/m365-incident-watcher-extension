// content-script.js — HTML/テキスト両スナップショット + 意味のある描画待機（NO_SNAPSHOT対策）
(() => {
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

  function getIncidentIdFromUrl() {
    try {
      const m = location.pathname.match(/\/incident\/([^/?#]+)/i);
      return m ? decodeURIComponent(m[1]) : "";
    } catch { return ""; }
  }

  function captureSnapshots() {
    const html = document.documentElement ? document.documentElement.outerHTML : "<html></html>";
    const text = document.body ? (document.body.innerText || "") : "";
    return { text, html, title: document.title || "" };
  }

  function isContentReady() {
    const innerText = document.body?.innerText || '';
    // "Loading..." が含まれている間は待機
    if (/(^|\s)Loading\.\.\.($|\s)/i.test(innerText)) {
      return false;
    }
    // 主要なヘッダー（h1, h2）に意味のあるテキストがあるか
    const header = document.querySelector("h1, h2");
    if (header && header.innerText.trim().length > 5) {
      return true;
    }
    // 全体のテキスト量が一定以上あるか（フォールバック）
    if (innerText.trim().length > 150) {
      return true;
    }
    return false;
  }

  async function waitForMeaningfulContent({ timeoutMs = 45000, quietMs = 1000 } = {}) {
    if (isContentReady()) {
      await sleep(quietMs);
      return true;
    }
    return new Promise((resolve) => {
      let timeoutId = null;
      const mo = new MutationObserver(() => {
        if (isContentReady()) {
          mo.disconnect();
          clearTimeout(timeoutId);
          // 最終レンダリングの揺らぎを吸収
          sleep(quietMs).then(() => resolve(true));
        }
      });
      mo.observe(document.documentElement || document.body, {
        childList: true, subtree: true, characterData: true
      });
      timeoutId = setTimeout(() => {
        mo.disconnect();
        resolve(isContentReady());
      }, timeoutMs);
    });
  }

  async function sendSnapshot(kind = "auto") {
    const incidentId = getIncidentIdFromUrl();
    const { text, html, title } = captureSnapshots();
    chrome.runtime.sendMessage({
      type: "snapshotFromCS",
      payload: {
        incidentId,
        title,
        snapshotText: text,
        snapshotHtml: html,
        by: kind
      }
    }, () => {});
  }

  // poke で再送（短めに待つ）
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    (async () => {
      if (msg?.type === "poke") {
        await waitForMeaningfulContent({ timeoutMs: 10000, quietMs: 600 });
        await sendSnapshot("poke");
        sendResponse && sendResponse({ ok: true });
      }
    })();
    return true;
  });

  // 初期化：ロード/描画を十分待ってから送信
  (async () => {
    // ページロード完了をできるだけ待つ
    if (document.readyState !== "complete") {
      await new Promise(res => window.addEventListener("load", res, { once: true }));
    }
    // SPA レンダー完了を待つ（最大45s, 安定化1.5s）
    await waitForMeaningfulContent({ timeoutMs: 45000, quietMs: 1500 });
    await sendSnapshot("init");
  })();
})();
