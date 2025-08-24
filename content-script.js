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
    // テキスト（検知用）
    const text = document.body
      ? (document.body.innerText || "")
      : (document.documentElement.innerText || "");
    // HTML（プレビュー用）
    const html = document.documentElement
      ? document.documentElement.outerHTML
      : "<html></html>";
    return { text, html, title: document.title || "" };
  }

  function hasMeaningfulDom() {
    const root = document.getElementById("root");
    if (!root || root.children.length === 0) return false;

    // ローディングスピナーだけの場合はまだ待つ
    if (root.children.length === 1) {
      const child = root.children[0];
      if (child.getAttribute('role') === 'progressbar' || /spinner/i.test(child.className)) {
        return false;
      }
    }

    // 主要なコンテナや、代表的な要素、テキスト量などで判断
    const main = document.querySelector("main, [role='main']");
    const header = document.querySelector("h1, h2, [data-automation-id='header']");
    const cards = document.querySelector(".ms-Stack, .ms-Card, [class*='card']");
    const txtLen = (document.body?.innerText || "").trim().length;

    return (
      (main && main.children.length > 0) ||
      (header && header.innerText.trim() !== "") ||
      cards ||
      (txtLen >= 100)
    );
  }

  async function waitForMeaningfulContent({ timeoutMs = 45000, quietMs = 800 } = {}) {
    const start = performance.now();
    if (hasMeaningfulDom()) {
      // 直後のちらつきを抑えるため少し静穏待ち
      await sleep(quietMs);
      return true;
    }

    // 変化を監視
    let resolved = false;
    const ready = new Promise((resolve) => {
      const mo = new MutationObserver(() => {
        if (hasMeaningfulDom()) {
          mo.disconnect();
          resolved = true;
          // 直後の追加レンダリングを待つ
          sleep(quietMs).then(() => resolve(true));
        }
      });
      mo.observe(document.documentElement || document.body, {
        childList: true, subtree: true, attributes: false, characterData: false
      });
      // 最終タイムアウト
      setTimeout(() => {
        if (!resolved) {
          mo.disconnect();
          resolve(false);
        }
      }, timeoutMs);
    });

    return ready;
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
    // SPA レンダー完了を待つ（最大45s）
    await waitForMeaningfulContent({ timeoutMs: 45000, quietMs: 800 });
    await sendSnapshot("init");
  })();
})();
