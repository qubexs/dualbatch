import { useEffect, useState } from "react";
import type { Aspect, Duration, FlowModel, FlowSettings, Job, Size } from "../shared/types";
import { DEFAULT_SETTINGS, MODEL_LABELS, normalizeSettings } from "../shared/types";

const MODELS: FlowModel[] = ["omni-1.1-flash", "veo-3.1-fast", "veo-3.1-lite", "veo-3.1-quality"];

export default function App() {
  const [prompt, setPrompt] = useState("a lighthouse at sunset, photoreal");
  const [template, setTemplate] = useState("{prompt}, cinematic motion, slow push-in");
  const [settings, setSettings] = useState<FlowSettings>(DEFAULT_SETTINGS);
  const [showSettings, setShowSettings] = useState(true);
  const [job, setJob] = useState<Job | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);

  useEffect(() => {
    chrome.storage.sync.get("flowSettings").then((r) => {
      if (r.flowSettings) setSettings({ ...DEFAULT_SETTINGS, ...r.flowSettings });
    });
    const refresh = async () => {
      const { jobs, lastJobId } = await chrome.storage.local.get(["jobs", "lastJobId"]);
      const j = (jobs as Record<string, Job> | undefined)?.[(lastJobId as string) ?? ""];
      if (j) setJob(j);
    };
    void refresh();
    const iv = setInterval(refresh, 1500);
    return () => clearInterval(iv);
  }, []);

  const update = (patch: Partial<FlowSettings>) => {
    setSettings((prev) => {
      const next = { ...prev, ...patch };
      void chrome.storage.sync.set({ flowSettings: next });
      return next;
    });
  };

  const start = async () => {
    const { settings: norm, warnings: w } = normalizeSettings(settings);
    setWarnings(w);
    if (JSON.stringify(norm) !== JSON.stringify(settings)) {
      setSettings(norm);
      await chrome.storage.sync.set({ flowSettings: norm });
    }
    await chrome.runtime.sendMessage({
      type: "START_JOB",
      prompt,
      videoPromptTemplate: template,
      settings: norm
    });
  };

  const openTabs = async () => {
    await chrome.runtime.sendMessage({ type: "OPEN_TABS" });
  };

  return (
    <div className="wrap">
      <h1>Meta → Flow</h1>
      <label className="lbl">Image prompt (meta.ai)</label>
      <textarea value={prompt} onChange={(e) => setPrompt(e.target.value)} rows={3} />

      <button className="link" onClick={() => setShowSettings((s) => !s)}>
        {showSettings ? "▾ Settings" : "▸ Settings"}
      </button>
      {showSettings && (
        <div className="card">
          <label className="lbl">Model</label>
          <select value={settings.model} onChange={(e) => update({ model: e.target.value as FlowModel })}>
            {MODELS.map((m) => (
              <option key={m} value={m}>
                {MODEL_LABELS[m]}
              </option>
            ))}
          </select>
          <div className="row">
            <div>
              <label className="lbl">Time</label>
              <select value={settings.duration} onChange={(e) => update({ duration: e.target.value as Duration })}>
                {(["4s", "6s", "8s"] as Duration[]).map((d) => (
                  <option key={d} value={d}>{d}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="lbl">Aspect</label>
              <select value={settings.aspect} onChange={(e) => update({ aspect: e.target.value as Aspect })}>
                {(["16:9", "9:16", "1:1"] as Aspect[]).map((a) => (
                  <option key={a} value={a}>{a}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="lbl">Size</label>
              <select value={settings.size} onChange={(e) => update({ size: e.target.value as Size })}>
                {(["720p", "1080p"] as Size[]).map((s) => (
                  <option key={s} value={s}>{s}</option>
                ))}
              </select>
            </div>
          </div>
          <label className="lbl">Video prompt template (use {"{prompt}"})</label>
          <input value={template} onChange={(e) => setTemplate(e.target.value)} />
          {settings.model === "omni-1.1-flash" && <p className="hint">omni flash: max 6s / 720p (auto-clamped).</p>}
        </div>
      )}

      {warnings.map((w) => (
        <p key={w} className="warn">{w}</p>
      ))}

      <div className="row btns">
        <button className="primary" onClick={start}>Start pipeline</button>
        <button onClick={openTabs}>Open both tabs</button>
      </div>

      {job && (
        <div className="card">
          <p><b>Status:</b> {job.status}</p>
          <div className="log">{job.log.slice(-12).map((l, i) => <div key={i}>{l}</div>)}</div>
        </div>
      )}
      <p className="hint">Log in to meta.ai + Flow first. Keep both tabs open during a run.</p>
    </div>
  );
}
