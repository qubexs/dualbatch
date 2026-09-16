import type { FlowSettings, Msg } from "../shared/types";
import { MODEL_LABELS } from "../shared/types";
import { FLOW_SELECTORS } from "../shared/selectors";
import { fetchUrlToFile, sendToBackground, sleep } from "../shared/messaging";

function buttonsAndOptions(): HTMLElement[] {
  return Array.from(document.querySelectorAll('button, [role="option"], [role="menuitem"], [role="button"], li')) as HTMLElement[];
}

function findByText(hints: string[]): HTMLElement | null {
  const els = buttonsAndOptions();
  for (const h of hints) {
    const m = els.find((e) => (e.innerText || e.textContent || "").toLowerCase().includes(h.toLowerCase()));
    if (m) return m;
  }
  return null;
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

async function selectViaOpener(openerHints: string[], label: string, step: string, jobId: string): Promise<void> {
  const opener = findByText(openerHints);
  if (!opener) {
    await sendToBackground({ type: "JOB_ERROR", jobId, step, note: `Could not find ${step} control`, availableOptions: visibleOptions() });
    throw new Error(step);
  }
  opener.click();
  await sleep(900);
  const ok = await clickMenuOption(label, step, jobId);
  if (!ok) {
    await sendToBackground({
      type: "JOB_ERROR",
      jobId,
      step,
      note: `Could not find option "${label}"`,
      availableOptions: visibleOptions()
    });
    throw new Error(step);
  }
}

async function applySettings(settings: FlowSettings, jobId: string): Promise<void> {
  const modelLabel = MODEL_LABELS[settings.model];
  try {
    await selectViaOpener(FLOW_SELECTORS.modelButtonHints, modelLabel, "flow-model", jobId);
  } catch {
    return; // error already reported; continue best-effort
  }
  await selectViaOpener(["Aspect", "Ratio", "16:9", "9:16"], settings.aspect, "flow-aspect", jobId).catch(() => undefined);
  await selectViaOpener(["Duration", "Length", "4s", "6s", "8s", "10s"], settings.duration, "flow-duration", jobId).catch(() => undefined);
  await selectViaOpener(["Resolution", "Quality", "720p", "1080p"], settings.size, "flow-size", jobId).catch(() => undefined);
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

async function uploadImage(imageUrl: string, imageData?: string): Promise<void> {
  const input = document.querySelector(FLOW_SELECTORS.fileInput) as HTMLInputElement | null;
  // Prefer bytes downloaded in the meta.ai tab (data URL) — no CORS/auth gamble here.
  const file = imageData
    ? new File([await (await fetch(imageData)).blob()], "meta-image.png", { type: "image/png" })
    : await fetchUrlToFile(imageUrl, "meta-image.png");
  if (!input) {
    // No file input found — try drag-drop target fallback is out of scope for v1.
    throw new Error("no-file-input");
  }
  const dt = new DataTransfer();
  dt.items.add(file);
  input.files = dt.files;
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new Event("change", { bubbles: true }));
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
    await uploadImage(imageUrl, imageData);
  } catch {
    await sendToBackground({
      type: "JOB_ERROR",
      jobId,
      step: "flow-upload",
      note: "Could not upload image (no file input found or image fetch blocked). Try downloading manually.",
      availableOptions: visibleOptions()
    });
    return;
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
  const gen = findByText(FLOW_SELECTORS.generateHints);
  if (gen) gen.click();
  await sendToBackground({ type: "FLOW_STATUS", jobId, status: "generating", note: "Generation started in Flow. Watch the Flow tab for progress." });
}

chrome.runtime.onMessage.addListener((msg: Msg) => {
  if (msg.type === "DO_FLOW_GEN") void runFlowGen(msg.jobId, msg.imageUrl, msg.videoPrompt, msg.settings, msg.imageData);
});
