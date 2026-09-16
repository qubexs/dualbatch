import type { FlowSettings, Msg } from "../shared/types";
import { MODEL_LABELS } from "../shared/types";
import { FLOW_SELECTORS } from "../shared/selectors";
import { fetchUrlToFile, sendToBackground, sleep } from "../shared/messaging";

const CLICKABLE = 'button, select, [role="button"], [role="option"], [role="menuitem"], [role="combobox"], [role="listbox"], [aria-haspopup], li';

function buttonsAndOptions(): HTMLElement[] {
  return Array.from(document.querySelectorAll(CLICKABLE)) as HTMLElement[];
}

function textOf(e: HTMLElement): string {
  return (e.innerText || e.textContent || "").trim().replace(/\s+/g, " ");
}

function findByText(hints: string[]): HTMLElement | null {
  const els = buttonsAndOptions();
  for (const h of hints) {
    const m = els.find((e) => textOf(e).toLowerCase().includes(h.toLowerCase()));
    if (m) return m;
  }
  return null;
}

/**
 * Last-resort finder: any element whose visible text matches, then walk up
 * to something clickable. Flow renders some pickers as plain divs.
 */
function findByTextAnywhere(re: RegExp): HTMLElement | null {
  const els = Array.from(document.querySelectorAll("body *")) as HTMLElement[];
  for (const el of els) {
    const own = (el.innerText || "").trim();
    if (own.length > 0 && own.length < 60 && re.test(own)) {
      const clickable = el.closest(CLICKABLE + ", a, div") as HTMLElement | null;
      if (clickable) return clickable;
    }
  }
  return null;
}

function findOpener(hints: string[], fallbackRe: RegExp): HTMLElement | null {
  return findByText(hints) ?? findByTextAnywhere(fallbackRe);
}

function visibleOptions(max = 40): string[] {
  return buttonsAndOptions()
    .map((e) => (e.innerText || e.textContent || "").trim().replace(/\s+/g, " "))
    .filter((t) => t.length > 0 && t.length < 80)
    .slice(0, max);
}

async function clickMenuOption(label: string, step: string, jobId: string): Promise<boolean> {
  // Try direct visible option first.
  const direct = findByText([label]);
  if (direct) {
    direct.click();
    await sleep(800);
    return true;
  }
  return false;
}

async function selectViaOpener(
  openerHints: string[],
  openerFallback: RegExp,
  label: string,
  step: string,
  jobId: string
): Promise<void> {
  const opener = findOpener(openerHints, openerFallback);
  if (!opener) {
    await sendToBackground({ type: "JOB_ERROR", jobId, step, note: `Could not find ${step} control`, availableOptions: visibleOptions() });
    throw new Error(step);
  }
  opener.click();
  await sleep(900);
  // Menu may render in a portal — search whole doc, clickable set first then anywhere.
  const direct = findByText([label]) ?? findByTextAnywhere(new RegExp(label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"));
  if (direct) {
    direct.click();
    await sleep(800);
    return;
  }
  await sendToBackground({
    type: "JOB_ERROR",
    jobId,
    step,
    note: `Could not find option "${label}"`,
    availableOptions: visibleOptions()
  });
  throw new Error(step);
}

async function applySettings(settings: FlowSettings, jobId: string): Promise<void> {
  const modelLabel = MODEL_LABELS[settings.model];
  // Each step is independent — a missing model picker must not skip the rest.
  await selectViaOpener(FLOW_SELECTORS.modelButtonHints, /veo|omni|flash|model/i, modelLabel, "flow-model", jobId).catch(() => undefined);
  await selectViaOpener(["Aspect", "Ratio", "16:9", "9:16"], /aspect|ratio|16:9|9:16|1:1/i, settings.aspect, "flow-aspect", jobId).catch(() => undefined);
  await selectViaOpener(["Duration", "Length", "4s", "6s", "8s", "10s"], /duration|length|second/i, settings.duration, "flow-duration", jobId).catch(() => undefined);
  await selectViaOpener(["Resolution", "Quality", "720p", "1080p"], /resolution|quality|720|1080/i, settings.size, "flow-size", jobId).catch(() => undefined);
}

function findPromptBox(): HTMLElement | null {
  // Prefer the observed Flow prompt container, then the editable inside it.
  for (const sel of FLOW_SELECTORS.promptBoxContainer) {
    const container = document.querySelector(sel) as HTMLElement | null;
    if (container) {
      const inner =
        (container.querySelector('[contenteditable="true"], textarea, [role="textbox"]') as HTMLElement | null) ??
        container;
      return inner;
    }
  }
  const boxes = FLOW_SELECTORS.promptBox
    .flatMap((s) => Array.from(document.querySelectorAll(s)) as HTMLElement[])
    .filter((el) => (el as HTMLInputElement).type !== "file");
  return boxes[boxes.length - 1] ?? boxes[0] ?? null;
}

function fillPrompt(text: string): boolean {
  const box = findPromptBox();
  if (!box) return false;
  box.focus();
  if (box instanceof HTMLTextAreaElement || box instanceof HTMLInputElement) {
    const proto = box instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value")?.set?.call(box, text);
    box.dispatchEvent(new Event("input", { bubbles: true }));
  } else {
    document.execCommand("selectAll", false);
    document.execCommand("insertText", false, text);
  }
  return true;
}

function allFileInputs(): HTMLInputElement[] {
  return Array.from(document.querySelectorAll('input[type="file"]')) as HTMLInputElement[];
}

/** Strategy 1: real file inputs (visible or hidden). */
function tryFileInputs(file: File): boolean {
  for (const input of allFileInputs()) {
    try {
      const dt = new DataTransfer();
      dt.items.add(file);
      input.files = dt.files;
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
      return true;
    } catch {
      /* try next input */
    }
  }
  return false;
}

function dropTargets(): HTMLElement[] {
  const out: HTMLElement[] = [];
  const promptContainer =
    FLOW_SELECTORS.promptBoxContainer
      .map((s) => document.querySelector(s) as HTMLElement | null)
      .find(Boolean) ?? null;
  if (promptContainer) out.push(promptContainer);
  for (const el of Array.from(document.querySelectorAll("div, section, button, [role]")) as HTMLElement[]) {
    const t = textOf(el);
    if (t.length > 0 && t.length < 80 && /drop|upload|add.+image|reference|ingredient|start.+frame|attach|image/i.test(t)) {
      if (!out.includes(el)) out.push(el);
      if (out.length >= 6) break;
    }
  }
  return out;
}

/** Strategy 2: synthetic drag-and-drop onto likely drop zones. */
function tryDrop(file: File): boolean {
  for (const target of dropTargets()) {
    try {
      const dt = new DataTransfer();
      dt.items.add(file);
      for (const type of ["dragenter", "dragover", "drop"] as const) {
        const ev = new DragEvent(type, { bubbles: true, composed: true });
        Object.defineProperty(ev, "dataTransfer", { value: dt });
        target.dispatchEvent(ev);
      }
      return true;
    } catch {
      /* try next target */
    }
  }
  return false;
}

/** Strategy 3: clipboard paste into the prompt box. */
async function tryPaste(file: File): Promise<boolean> {
  try {
    await navigator.clipboard.write([new ClipboardItem({ [file.type || "image/png"]: file })]);
  } catch {
    return false;
  }
  try {
    const box = findPromptBox();
    (box ?? document.body).focus();
    const dt = new DataTransfer();
    dt.items.add(file);
    const ev = new ClipboardEvent("paste", { bubbles: true, composed: true });
    Object.defineProperty(ev, "clipboardData", { value: dt });
    (box ?? document.activeElement ?? document.body).dispatchEvent(ev);
    return true;
  } catch {
    return false;
  }
}

function uploadDiagnostics(): string[] {
  const opts = visibleOptions();
  opts.unshift(`fileInputs=${allFileInputs().length}`);
  opts.unshift(`url=${location.href}`);
  return opts;
}

async function uploadImage(imageUrl: string, imageData: string | undefined, jobId: string): Promise<void> {
  const file = imageData
    ? new File([await (await fetch(imageData)).blob()], "meta-image.png", { type: "image/png" })
    : await fetchUrlToFile(imageUrl, "meta-image.png");

  if (tryFileInputs(file)) {
    await sendToBackground({ type: "FLOW_STATUS", jobId, status: "flow_uploading", note: "Image attached via file input." });
    return;
  }
  if (tryDrop(file)) {
    await sendToBackground({ type: "FLOW_STATUS", jobId, status: "flow_uploading", note: "No file input — image dropped onto canvas zone. Verify it appears in the Flow tab." });
    return;
  }
  if (await tryPaste(file)) {
    await sendToBackground({ type: "FLOW_STATUS", jobId, status: "flow_uploading", note: "No file input/drop zone — image pasted from clipboard. Verify it appears in the Flow tab." });
    return;
  }
  await sendToBackground({
    type: "JOB_ERROR",
    jobId,
    step: "flow-upload",
    note: "Could not upload image (no file input, drop zone, or clipboard paste worked). Attach the downloaded meta-<job>.png manually.",
    availableOptions: uploadDiagnostics()
  });
  throw new Error("flow-upload");
}

/** Random human-like pause, default 10–20s before touching the prompt box. */
function randomDelayMs(minMs = 10_000, maxMs = 20_000): number {
  return Math.floor(minMs + Math.random() * (maxMs - minMs));
}

async function runFlowGen(jobId: string, imageUrl: string, videoPrompt: string, settings: FlowSettings, imageData?: string): Promise<void> {
  if (document.querySelector(FLOW_SELECTORS.loginWall)) {
    await sendToBackground({ type: "JOB_ERROR", jobId, step: "flow-login", note: "Please log in to Google Flow first, then retry." });
    return;
  }
  await sendToBackground({ type: "FLOW_STATUS", jobId, status: "flow_uploading", note: `Applying ${MODEL_LABELS[settings.model]} ${settings.duration} ${settings.aspect} ${settings.size}.` });
  await applySettings(settings, jobId);

  try {
    await uploadImage(imageUrl, imageData, jobId);
  } catch {
    return; // error already reported with diagnostics; stop before prompt fill
  }

  await sleep(800);
  const humanPause = randomDelayMs(10_000, 20_000);
  await sendToBackground({
    type: "FLOW_STATUS",
    jobId,
    status: "flow_uploading",
    note: `Human-like pause ${(humanPause / 1000).toFixed(0)}s before filling prompt.`
  });
  await sleep(humanPause);
  if (!fillPrompt(videoPrompt)) {
    await sendToBackground({ type: "JOB_ERROR", jobId, step: "flow-prompt", note: "Could not find Flow prompt box." });
    return;
  }
  await sleep(500);
  const gen = findByText(FLOW_SELECTORS.generateHints) ?? findByTextAnywhere(/generate|create|submit/i);
  if (!gen) {
    await sendToBackground({ type: "JOB_ERROR", jobId, step: "flow-generate", note: "Prompt filled but no Generate button found.", availableOptions: visibleOptions() });
    return;
  }
  gen.click();
  await sendToBackground({ type: "FLOW_STATUS", jobId, status: "generating", note: "Generate clicked in Flow. Watch the Flow tab for progress." });
}

chrome.runtime.onMessage.addListener((msg: Msg) => {
  if (msg.type === "DO_FLOW_GEN") void runFlowGen(msg.jobId, msg.imageUrl, msg.videoPrompt, msg.settings, msg.imageData);
});
