import type { Msg } from "./types";

export function sendToBackground(msg: Msg): Promise<unknown> {
  return chrome.runtime.sendMessage(msg);
}

export async function sendToTab(tabId: number, msg: Msg): Promise<unknown> {
  return chrome.tabs.sendMessage(tabId, msg);
}

export async function fetchUrlToFile(url: string, filename: string): Promise<File> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`fetch image failed: ${res.status}`);
  const blob = await res.blob();
  const type = blob.type || "image/png";
  return new File([blob], filename, { type });
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export function logLine(line: string): string {
  const t = new Date().toLocaleTimeString();
  return `[${t}] ${line}`;
}
