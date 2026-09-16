import type { FlowSettings, Msg } from "../shared/types";
import { META_SELECTORS } from "../shared/selectors";
import { sendToBackground, sleep } from "../shared/messaging";

function isVisible(el: Element): boolean {
  const r = (el as HTMLElement).getBoundingClientRect?.();
  if (r && (r.width < 2 || r.height < 2)) return false;
  const style = getComputedStyle(el as HTMLElement);
  return style.display !== "none" && style.visibility !== "hidden";
}

/** Collect every editor candidate, visible ones first. */
function allEditors(): HTMLElement[] {
  const seen = new Set<HTMLElement>();
  for (const s of META_SELECTORS.editor) {
    try {
      for (const el of Array.from(document.querySelectorAll(s))) {
        if (el instanceof HTMLElement && !seen.has(el)) seen.add(el);
      }
    } catch {
      /* ignore bad selector */
    }
  }
  const all = [...seen];
  return all.sort((a, b) => Number(isVisible(b)) - Number(isVisible(a)));
}

async function waitForEditor(timeoutMs = 20_000): Promise<HTMLElement | null> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const found = allEditors().find(isVisible) ?? allEditors()[0] ?? null;
    if (found) return found;
    await sleep(500);
  }
  return null;
}

function editorText(el: HTMLElement): string {
  if (el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement) return el.value;
  return el.innerText ?? el.textContent ?? "";
}

/** Insert text with several strategies; returns true if the text stuck. */
async function setEditorText(el: HTMLElement, text: string): Promise<boolean> {
  el.scrollIntoView({ block: "center" });
  el.focus();
  (el as HTMLElement & { click?: () => void }).click?.();
  await sleep(200);

  if (el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement) {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value")?.set?.call(el, "");
    Object.getOwnPropertyDescriptor(proto, "value")?.set?.call(el, text);
    el.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  } else {
    // Rich editors (Lexical/ProseMirror/Draft): select-all + typed insertion.
    const sel = window.getSelection();
    try {
      const range = document.createRange();
      range.selectNodeContents(el);
      sel?.removeAllRanges();
      sel?.addRange(range);
    } catch {
      /* ignore */
    }
    let ok = false;
    try {
      ok = document.execCommand("selectAll", false) || ok;
    } catch {
      /* ignore */
    }
    try {
      ok = document.execCommand("insertText", false, text) || ok;
    } catch {
      /* ignore */
    }
    if (!editorText(el).includes(text.slice(0, 20))) {
      // Fallback: direct write + synthetic beforeinput/input so React picks it up.
      el.focus();
      try {
        (el as HTMLElement).textContent = "";
        document.execCommand("selectAll", false);
      } catch {
        /* ignore */
      }
      el.dispatchEvent(new InputEvent("beforeinput", { bubbles: true, composed: true, inputType: "insertText", data: text }));
      el.textContent = text;
      // Place caret at end so Enter goes to the right node.
      try {
        const range = document.createRange();
        range.selectNodeContents(el);
        range.collapse(false);
        sel?.removeAllRanges();
        sel?.addRange(range);
      } catch {
        /* ignore */
      }
      el.dispatchEvent(new InputEvent("input", { bubbles: true, composed: true, inputType: "insertText", data: text }));
    }
  }
  await sleep(400);
  return editorText(el).includes(text.slice(0, 20));
}

function findSendButton(editor: HTMLElement): HTMLElement | null {
  // 1. Explicit send-labeled buttons.
  for (const s of ['button[aria-label*="Send" i]', 'button[data-testid*="send"]', 'button[type="submit"]']) {
    try {
      const btns = Array.from(document.querySelectorAll(s)) as HTMLElement[];
      const vis = btns.find(isVisible);
      if (vis) return vis;
    } catch {
      /* ignore */
    }
  }
  // 2. Button near the editor (same form / composer container).
  const root = editor.closest("form") ?? editor.parentElement?.closest("div") ?? document.body;
  const near = Array.from(root.querySelectorAll("button")) as HTMLElement[];
  const withSvg = near.filter(isVisible).reverse().find((b) => b.querySelector("svg"));
  if (withSvg) return withSvg;
  // 3. Any visible button with an icon, page-wide.
  const anyBtn = (Array.from(document.querySelectorAll("button")) as HTMLElement[]).filter(isVisible);
  return anyBtn.reverse().find((b) => b.querySelector("svg")) ?? null;
}

function isDisabled(btn: HTMLElement): boolean {
  return (
    (btn as HTMLButtonElement).disabled ||
    btn.getAttribute("aria-disabled") === "true" ||
    btn.getAttribute("data-disabled") === "true"
  );
}

async function submitPrompt(editor: HTMLElement): Promise<boolean> {
  // Strategy 1: click an enabled send button (wait for it to enable after typing).
  for (let i = 0; i < 10; i++) {
    const btn = findSendButton(editor);
    if (btn && !isDisabled(btn)) {
      btn.click();
      await sleep(800);
      return true;
    }
    await sleep(500);
  }
  // Strategy 2: synthetic Enter on the focused node (full key init for React).
  const target = (document.activeElement as HTMLElement) ?? editor;
  for (const type of ["keydown", "keypress", "keyup"] as const) {
    target.dispatchEvent(
      new KeyboardEvent(type, { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true, composed: true })
    );
  }
  await sleep(800);
  // Strategy 3: submit enclosing form.
  const form = editor.closest("form") as HTMLFormElement | null;
  if (form) {
    try {
      form.requestSubmit();
      return true;
    } catch {
      form.submit();
      return true;
    }
  }
  // Disabled send button as last resort — click anyway.
  const btn = findSendButton(editor);
  if (btn) {
    btn.click();
    return true;
  }
  return false;
}

function diagnostics(): string[] {
  const out: string[] = [`url=${location.href}`];
  out.push(`textarea=${document.querySelectorAll("textarea").length}`);
  out.push(`contenteditable=${document.querySelectorAll('[contenteditable="true"]').length}`);
  out.push(`textbox=${document.querySelectorAll('[role="textbox"]').length}`);
  out.push(`buttons=${document.querySelectorAll("button").length}`);
  const placeholders = Array.from(document.querySelectorAll("textarea, input"))
    .map((e) => (e as HTMLTextAreaElement).placeholder || (e as HTMLElement).getAttribute("aria-label") || "")
    .filter(Boolean)
    .slice(0, 5);
  if (placeholders.length) out.push(`fields: ${placeholders.join(" | ")}`);
  const btnLabels = (Array.from(document.querySelectorAll("button")) as HTMLElement[])
    .map((b) => (b.getAttribute("aria-label") || b.innerText || "").trim().replace(/\s+/g, " ").slice(0, 30))
    .filter(Boolean)
    .slice(0, 8);
  if (btnLabels.length) out.push(`buttons: ${btnLabels.join(" | ")}`);
  const cands = allEditors().length;
  out.push(`editorCandidates=${cands}`);
  return out;
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

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result as string);
    r.onerror = () => reject(new Error("could not read image blob"));
    r.readAsDataURL(blob);
  });
}

async function runMetaGen(jobId: string, prompt: string, settings: FlowSettings): Promise<void> {
  if (document.querySelector(META_SELECTORS.loginWall)) {
    await sendToBackground({ type: "JOB_ERROR", jobId, step: "meta-login", note: "Please log in to meta.ai first, then retry." });
    return;
  }
  // Wait for SPA to render the composer instead of failing on first paint.
  const editor = await waitForEditor(20_000);
  if (!editor) {
    await sendToBackground({
      type: "JOB_ERROR",
      jobId,
      step: "meta-prompt-box",
      note: "Could not find meta.ai prompt box after 20s.",
      availableOptions: diagnostics()
    });
    return;
  }
  const seen = new Set(
    Array.from(document.querySelectorAll(META_SELECTORS.image)).map((i) => (i as HTMLImageElement).currentSrc || (i as HTMLImageElement).src)
  );
  const stuck = await setEditorText(editor, prompt);
  if (!stuck) {
    await sendToBackground({
      type: "JOB_ERROR",
      jobId,
      step: "meta-fill",
      note: "Found the prompt box but the text did not stick (rich editor rejected synthetic input).",
      availableOptions: diagnostics()
    });
    return;
  }

  const submitted = await submitPrompt(editor);
  if (!submitted) {
    await sendToBackground({
      type: "JOB_ERROR",
      jobId,
      step: "meta-send",
      note: "Prompt typed but no send control worked.",
      availableOptions: diagnostics()
    });
    return;
  }

  try {
    const url = await waitForNewImage(seen, 115_000);
    // Random settle pause (default 10–30s) so the full-res image finishes
    // rendering and the handoff looks human.
    const minS = Math.max(0, settings.metaDelayMinSec ?? 10);
    const maxS = Math.max(minS, settings.metaDelayMaxSec ?? 30);
    const pauseMs = Math.floor((minS + Math.random() * (maxS - minS)) * 1000);
    await sendToBackground({
      type: "FLOW_STATUS",
      jobId,
      status: "meta_generating",
      note: `Image complete. Human-like pause ${(pauseMs / 1000).toFixed(0)}s before download.`
    });
    await sleep(pauseMs);
    // Download the bytes here (same origin as the CDN img) and hand them
    // to Flow as a data URL — no auth/CORS gamble on the Flow side.
    let imageData: string | undefined;
    let mimeType: string | undefined;
    try {
      const res = await fetch(url, { credentials: "include" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const blob = await res.blob();
      mimeType = blob.type || "image/png";
      imageData = await blobToDataUrl(blob);
    } catch (e) {
      // Fall back to URL-only handoff; Flow tab will try fetching itself.
      await sendToBackground({
        type: "FLOW_STATUS",
        jobId,
        status: "meta_generating",
        note: `Download in meta.ai tab failed (${(e as Error).message}); handing off URL only.`
      });
    }
    await sendToBackground({ type: "META_IMAGE_READY", jobId, imageUrl: url, imageData, mimeType });
  } catch (e) {
    await sendToBackground({
      type: "JOB_ERROR",
      jobId,
      step: "meta-wait-image",
      note: `${(e as Error).message}. Prompt was submitted but no image appeared — check the meta.ai tab.`,
      availableOptions: diagnostics()
    });
  }
}

chrome.runtime.onMessage.addListener((msg: Msg) => {
  if (msg.type === "DO_META_GEN") void runMetaGen(msg.jobId, msg.prompt, msg.settings);
});
