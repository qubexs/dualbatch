import type { Job, JobStatus, Msg } from "./shared/types";
import { logLine } from "./shared/messaging";

const META_URL = "https://www.meta.ai/";
const FLOW_URL = "https://labs.google.com/flow";
const META_TIMEOUT_MS = 120_000;
const FLOW_TIMEOUT_MS = 60_000;

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
      const flowTabId = await findOrCreate(FLOW_URL, (u) => !!u && u.includes("labs.google"));
      await chrome.storage.local.set({ metaTabId, flowTabId });
      sendResponse({ metaTabId, flowTabId });
      return;
    }

    if (msg.type === "START_JOB") {
      const refs = await getRefs();
      const metaTabId = refs.metaTabId ?? (await findOrCreate(META_URL, (u) => !!u && u.includes("meta.ai")));
      const flowTabId = refs.flowTabId ?? (await findOrCreate(FLOW_URL, (u) => !!u && u.includes("labs.google")));
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

      // Give tabs a moment to have content scripts ready.
      setTimeout(() => {
        chrome.tabs.sendMessage(metaTabId, { type: "DO_META_GEN", jobId, prompt: msg.prompt } satisfies Msg).catch(() =>
          patchJob(jobId, { status: "error" }, "Could not reach meta.ai tab. Open meta.ai and retry.")
        );
      }, 800);

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
      const refs = await getRefs();
      if (refs.flowTabId == null) {
        await patchJob(msg.jobId, { status: "error" }, "Flow tab id unknown. Click Open both tabs.");
        return;
      }
      const { jobs } = await chrome.storage.local.get("jobs");
      const cur = (jobs as Record<string, Job>)[msg.jobId];
      const videoPrompt = (cur?.videoPromptTemplate || "{prompt}, cinematic motion").replace("{prompt}", cur?.prompt ?? "");
      await patchJob(msg.jobId, { status: "flow_uploading" }, `Sending image to Flow tab ${refs.flowTabId}.`);
      chrome.tabs
        .sendMessage(refs.flowTabId, {
          type: "DO_FLOW_GEN",
          jobId: msg.jobId,
          imageUrl: msg.imageUrl,
          videoPrompt,
          settings: cur.settings
        } satisfies Msg)
        .catch(() => patchJob(msg.jobId, { status: "error" }, "Could not reach Flow tab. Open labs.google.com/flow and retry."));

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
