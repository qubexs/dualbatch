import type { Msg } from "../shared/types";
import { META_SELECTORS } from "../shared/selectors";
import { sendToBackground, sleep } from "../shared/messaging";

function queryFirst(selectors: string[]): HTMLElement | null {
  for (const s of selectors) {
    try {
      const el = document.querySelector(s) as HTMLElement | null;
      if (el && el.offsetParent !== null) return el;
    } catch {
      /* ignore bad selector */
    }
  }
  // fallback: any visible match even if offsetParent check failed
  for (const s of selectors) {
    const el = document.querySelector(s) as HTMLElement | null;
    if (el) return el;
  }
  return null;
}

function setEditorText(el: HTMLElement, text: string): void {
  el.focus();
  if (el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement) {
    const setter = Object.getOwnPropertyDescriptor(
      el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype,
      "value"
    )?.set;
    setter?.call(el, text);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  } else {
    // contenteditable
    document.execCommand("selectAll", false);
    document.execCommand("insertText", false, text);
    el.dispatchEvent(new InputEvent("input", { bubbles: true, data: text }));
  }
}

function pickBestImageUrl(img: HTMLImageElement): string {
  const srcset = img.getAttribute("srcset");
  if (srcset) {
    const parts = srcset.split(",").map((p) => p.trim().split(" "));
    const last = parts[parts.length - 1]?.[0];
    if (last) return new URL(last, location.href).href;
  }
  return img.currentSrc || img.src;
}

function waitForNewImage(alreadySeen: Set<string>, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      obs.disconnect();
      reject(new Error("timeout waiting for generated image"));
    }, timeoutMs);

    const check = (): string | null => {
      const imgs = Array.from(document.querySelectorAll(META_SELECTORS.image)) as HTMLImageElement[];
      for (const img of imgs) {
        const url = pickBestImageUrl(img);
        if (url && !alreadySeen.has(url) && url.startsWith("http") && img.naturalWidth > 64) return url;
      }
      return null;
    };

    const obs = new MutationObserver(() => {
      const found = check();
      if (found) {
        clearTimeout(timer);
        obs.disconnect();
        resolve(found);
      }
    });
    obs.observe(document.documentElement, { childList: true, subtree: true, attributes: true });

    // Poll too, in case images load without DOM churn we catch.
    const iv = setInterval(() => {
      const found = check();
      if (found) {
        clearTimeout(timer);
        clearInterval(iv);
        obs.disconnect();
        resolve(found);
      }
    }, 1500);
    setTimeout(() => clearInterval(iv), timeoutMs);
  });
}

async function runMetaGen(jobId: string, prompt: string): Promise<void> {
  if (document.querySelector(META_SELECTORS.loginWall)) {
    await sendToBackground({ type: "JOB_ERROR", jobId, step: "meta-login", note: "Please log in to meta.ai first, then retry." });
    return;
  }
  const editor = queryFirst(META_SELECTORS.editor);
  if (!editor) {
    await sendToBackground({ type: "JOB_ERROR", jobId, step: "meta-prompt-box", note: "Could not find meta.ai prompt box. Selectors may need updating." });
    return;
  }
  const seen = new Set(
    Array.from(document.querySelectorAll(META_SELECTORS.image)).map((i) => (i as HTMLImageElement).currentSrc || (i as HTMLImageElement).src)
  );
  setEditorText(editor, prompt);
  await sleep(600);

  const sendBtn = queryFirst(META_SELECTORS.sendButton);
  if (sendBtn) sendBtn.click();
  else {
    editor.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", bubbles: true }));
  }

  try {
    const url = await waitForNewImage(seen, 115_000);
    await sendToBackground({ type: "META_IMAGE_READY", jobId, imageUrl: url });
  } catch (e) {
    await sendToBackground({ type: "JOB_ERROR", jobId, step: "meta-wait-image", note: (e as Error).message });
  }
}

chrome.runtime.onMessage.addListener((msg: Msg) => {
  if (msg.type === "DO_META_GEN") void runMetaGen(msg.jobId, msg.prompt);
});
