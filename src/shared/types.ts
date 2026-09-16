export type FlowModel =
  | "omni-1.1-flash"
  | "veo-3.1-fast"
  | "veo-3.1-lite"
  | "veo-3.1-quality";

export type Aspect = "16:9" | "9:16" | "1:1";
export type Duration = "4s" | "6s" | "8s";
export type Size = "720p" | "1080p";

export interface FlowSettings {
  model: FlowModel;
  aspect: Aspect;
  duration: Duration;
  size: Size;
}

export const DEFAULT_SETTINGS: FlowSettings = {
  model: "omni-1.1-flash",
  aspect: "16:9",
  duration: "6s",
  size: "720p"
};

export const MODEL_LABELS: Record<FlowModel, string> = {
  "omni-1.1-flash": "omni 1.1 flash",
  "veo-3.1-fast": "veo 3.1 fast",
  "veo-3.1-lite": "veo 3.1 lite",
  "veo-3.1-quality": "veo 3.1 quality"
};

export type JobStatus =
  | "idle"
  | "meta_generating"
  | "image_ready"
  | "flow_uploading"
  | "generating"
  | "done"
  | "error";

export interface Job {
  jobId: string;
  prompt: string;
  videoPromptTemplate: string;
  settings: FlowSettings;
  imageUrl?: string;
  status: JobStatus;
  log: string[];
  updatedAt: number;
}

export type Msg =
  | { type: "START_JOB"; prompt: string; videoPromptTemplate: string; settings: FlowSettings }
  | { type: "OPEN_TABS" }
  | { type: "DO_META_GEN"; jobId: string; prompt: string }
  | { type: "META_IMAGE_READY"; jobId: string; imageUrl: string }
  | { type: "DO_FLOW_GEN"; jobId: string; imageUrl: string; videoPrompt: string; settings: FlowSettings }
  | { type: "FLOW_STATUS"; jobId: string; status: JobStatus; note: string }
  | { type: "JOB_ERROR"; jobId: string; step: string; note: string; availableOptions?: string[] };

/** Clamp settings per model limits (omni flash: max 6s / 720p). */
export function normalizeSettings(s: FlowSettings): { settings: FlowSettings; warnings: string[] } {
  const out = { ...s };
  const warnings: string[] = [];
  if (out.model === "omni-1.1-flash" && out.duration === "8s") {
    out.duration = "6s";
    warnings.push("omni 1.1 flash max is 6s — clamped 8s to 6s.");
  }
  if (out.model === "omni-1.1-flash" && out.size === "1080p") {
    out.size = "720p";
    warnings.push("omni 1.1 flash limited to 720p — clamped 1080p to 720p.");
  }
  return { settings: out, warnings };
}
