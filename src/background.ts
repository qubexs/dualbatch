import type { Job, JobStatus, Msg } from "./shared/types";
import { logLine } from "./shared/messaging";

const META_URL = "https://www.meta.ai/";
const FLOW_URL = "https://flow.google.com/";
const META_TIMEOUT_MS = 180_000; // image gen + up to 120s settle pause
const FLOW_TIMEOUT_MS = 60_000;

function isFlowUrl(u?: string): boolean {
  return !!u && (u.includes("flow.google.com") || u.includes("labs.google"));
}

interface TabRefs {
  metaTabId?: number;
  flowTabId?: number;
}

async function getRefs(): Promise<TabRefs> {
  const r = await chrome.storage.local.get(["metaTabId", "flowTabId"]);
  return { metaTabId: r.metaTabId as number | undefined, flowTabId: r.flowTabId as number | undefined };
}

async function findOrCreate(url: string, match: (u?: string) => boolean): Promise<number> {
  const tabs = await chrome.tabs.query({});
  const existing = tabs.find((t) => match(t.url));
  if (existing?.id != null) {
    await chrome.tabs.update(existing.id, { active: true });
    return existing.id;
  }
  const created = await chrome.tabs.create({ url, active: false });
  return created.id!;
}

function newJobId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

async function tabExists(tabId?: number): Promise<boolean> {
  if (tabId == null) return false;
  try {
    await chrome.tabs.get(tabId);
    return true;
  } catch {
    return false;
  }
}

function waitForTabComplete(tabId: number, timeoutMs = 15_000): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      resolve();
    }, timeoutMs);
    const listener = (id: number, info: chrome.tabs.TabChangeInfo, tab: chrome.tabs.Tab) => {
      if (id === tabId && info.status === "complete") {
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(listener);
        // document_idle scripts need a beat after complete.
        setTimeout(resolve, 1200);
      }
    };
    chrome.tabs.onUpdated.addListener(listener);
    // Already complete? resolve shortly.
    chrome.tabs.get(tabId).then((t) => {
      if (t.status === "complete") {
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(listener);
        setTimeout(resolve, 1200);
      }
    }).catch(() => {
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(listener);
      resolve();
    });
  });
}

/**
 * Content scripts only exist in tabs that loaded AFTER the extension was
 * loaded/reloaded. Retry delivery, then reload the tab once and retry —
 * otherwise the user must manually refresh the tab.
 */
async function deliver(tabId: number, msg: Msg, label: string): Promise<boolean> {
  for (let i = 0; i < 4; i++) {
    try {
      await chrome.tabs.sendMessage(tabId, msg);
      return true;
    } catch {
      await new Promise((r) => setTimeout(r, 1500));
    }
  }
  try {
    await chrome.tabs.reload(tabId);
    await waitForTabComplete(tabId);
    for (let i = 0; i < 4; i++) {
      try {
        await chrome.tabs.sendMessage(tabId, msg);
        return true;
      } catch {
        await new Promise((r) => setTimeout(r, 1500));
      }
    }
  } catch {
    /* fall through to failure */
  }
  return false;
}

async function patchJob(jobId: string, patch: Partial<Job>, line?: string): Promise<Job | undefined> {
  const { jobs } = await chrome.storage.local.get("jobs");
  const all = (jobs ?? {}) as Record<string, Job>;
  const cur = all[jobId];
  if (!cur) return undefined;
  const next: Job = {
    ...cur,
    ...patch,
    log: line ? [...cur.log, logLine(line)] : cur.log,
    updatedAt: Date.now()
  };
  all[jobId] = next;
  await chrome.storage.local.set({ jobs: all, lastJobId: jobId });
  return next;
}

chrome.runtime.onMessage.addListener((msg: Msg, _sender, sendResponse) => {
  (async () => {
    if (msg.type === "OPEN_TABS") {
      const metaTabId = await findOrCreate(META_URL, (u) => !!u && u.includes("meta.ai"));
      const flowTabId = await findOrCreate(FLOW_URL, isFlowUrl);
      await chrome.storage.local.set({ metaTabId, flowTabId });
      sendResponse({ metaTabId, flowTabId });
      return;
    }

    if (msg.type === "START_JOB") {
      const refs = await getRefs();
      let metaTabId = (await tabExists(refs.metaTabId)) ? refs.metaTabId! : await findOrCreate(META_URL, (u) => !!u && u.includes("meta.ai"));
      let flowTabId = (await tabExists(refs.flowTabId)) ? refs.flowTabId! : await findOrCreate(FLOW_URL, isFlowUrl);
      await chrome.storage.local.set({ metaTabId, flowTabId });

      const jobId = newJobId();
      const job: Job = {
        jobId,
        prompt: msg.prompt,
        videoPromptTemplate: msg.videoPromptTemplate,
        settings: msg.settings,
        status: "meta_generating",
        log: [logLine(`Job started. Sending prompt to meta.ai tab ${metaTabId}.`)],
        updatedAt: Date.now()
      };
      const { jobs } = await chrome.storage.local.get("jobs");
      await chrome.storage.local.set({ jobs: { ...((jobs ?? {}) as Record<string, Job>), [jobId]: job }, lastJobId: jobId });

      // Wait for the tab to finish loading, then deliver with retries
      // (content scripts are missing in tabs opened before the extension reloaded).
      setTimeout(async () => {
        await waitForTabComplete(metaTabId);
        const ok = await deliver(metaTabId, { type: "DO_META_GEN", jobId, prompt: msg.prompt, settings: msg.settings } satisfies Msg, "meta");
        if (!ok) {
          await patchJob(
            jobId,
            { status: "error" },
            "Could not reach meta.ai tab even after refresh. Manually refresh the meta.ai tab once, then press Start again."
          );
        }
      }, 300);

      // Timeout guard for meta step.
      setTimeout(async () => {
        const { jobs: j } = await chrome.storage.local.get("jobs");
        const cur = (j as Record<string, Job> | undefined)?.[jobId];
        if (cur && cur.status === "meta_generating") {
          await patchJob(jobId, { status: "error" }, "Timed out waiting for meta.ai image (120s).");
        }
      }, META_TIMEOUT_MS);

      sendResponse({ jobId, metaTabId, flowTabId });
      return;
    }

    if (msg.type === "META_IMAGE_READY") {
      await patchJob(msg.jobId, { status: "image_ready", imageUrl: msg.imageUrl }, `Image ready: ${msg.imageUrl.slice(0, 80)}...`);
      // Real download to the user's Downloads folder (best-effort, never fails the job).
      try {
        const filename = `meta-${msg.jobId}.png`;
        if (msg.imageData) {
          const dataUrl = msg.imageData.startsWith("data:")
            ? msg.imageData
            : `data:${msg.mimeType || "image/png"};base64,${msg.imageData}`;
          await chrome.downloads.download({ url: dataUrl, filename, saveAs: false });
          await patchJob(msg.jobId, {}, `Downloaded ${filename} to Downloads.`);
        } else {
          await chrome.downloads.download({ url: msg.imageUrl, filename, saveAs: false });
          await patchJob(msg.jobId, {}, `Downloaded ${filename} to Downloads.`);
        }
      } catch (e) {
        await patchJob(msg.jobId, {}, `Download skipped (${(e as Error).message}); continuing with handoff.`);
      }
      const refs = await getRefs();
      if (refs.flowTabId == null) {
        await patchJob(msg.jobId, { status: "error" }, "Flow tab id unknown. Click Open both tabs.");
        return;
      }
      const { jobs } = await chrome.storage.local.get("jobs");
      const cur = (jobs as Record<string, Job>)[msg.jobId];
      const videoPrompt = (cur?.videoPromptTemplate || "{prompt}, cinematic motion").replace("{prompt}", cur?.prompt ?? "");
      await patchJob(msg.jobId, { status: "flow_uploading" }, `Sending image to Flow tab ${refs.flowTabId}.`);
      const flowMsg = {
        type: "DO_FLOW_GEN",
        jobId: msg.jobId,
        imageUrl: msg.imageUrl,
        imageData: msg.imageData,
        videoPrompt,
        settings: cur.settings
      } satisfies Msg;
      deliver(refs.flowTabId, flowMsg, "flow").then((ok) => {
        if (!ok) {
          void patchJob(
            msg.jobId,
            { status: "error" },
            "Could not reach Flow tab even after refresh. Manually refresh the flow.google.com tab once, then press Start again."
          );
        }
      });

      setTimeout(async () => {
        const { jobs: j } = await chrome.storage.local.get("jobs");
        const c = (j as Record<string, Job> | undefined)?.[msg.jobId];
        if (c && (c.status === "flow_uploading" || c.status === "image_ready")) {
          await patchJob(msg.jobId, { status: "error" }, "Timed out waiting for Flow upload (60s).");
        }
      }, FLOW_TIMEOUT_MS);
      sendResponse({ ok: true });
      return;
    }

    if (msg.type === "FLOW_STATUS") {
      await patchJob(msg.jobId, { status: msg.status as JobStatus }, msg.note);
      sendResponse({ ok: true });
      return;
    }

    if (msg.type === "JOB_ERROR") {
      const extra = msg.availableOptions?.length ? ` Options seen: ${msg.availableOptions.slice(0, 10).join(" | ")}` : "";
      await patchJob(msg.jobId, { status: "error" }, `Error at ${msg.step}: ${msg.note}.${extra}`);
      sendResponse({ ok: true });
      return;
    }
  })();
  return true; // async response
});
