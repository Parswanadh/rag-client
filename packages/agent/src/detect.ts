/** Compute-tier detection (Stage 0: detect + report; engines land in later stages).
 * Tier order: chrome-nano (free win) -> webllm (WebGPU) -> api fallback.
 * Never downloads weights until the tier check passes.
 */
export type Tier = "nano" | "webllm" | "api" | "unknown";

export interface TierInfo {
  tier: Tier;
  detail: string;
  webgpu: boolean;
  ramGB: number;
  cores: number;
  mobile: boolean;
}

declare global {
  interface Navigator {
    deviceMemory?: number;
    gpu?: { requestAdapter(): Promise<unknown> };
  }
  interface Window {
    LanguageModel?: { availability(): Promise<string> };
  }
}

export async function detectTier(): Promise<TierInfo> {
  const nav = navigator;
  const ramGB = nav.deviceMemory ?? 0;
  const cores = nav.hardwareConcurrency ?? 0;
  const mobile = /Android|iPhone|iPad|Mobile/i.test(nav.userAgent);
  let webgpu = false;
  try {
    if (nav.gpu) webgpu = !!(await nav.gpu.requestAdapter());
  } catch {
    webgpu = false;
  }
  let nano = false;
  try {
    if (window.LanguageModel) nano = (await window.LanguageModel.availability()) === "readily";
  } catch {
    nano = false;
  }
  if (nano) return { tier: "nano", detail: "Chrome built-in Nano ready", webgpu, ramGB, cores, mobile };
  if (webgpu && !mobile && ramGB >= 4 && cores >= 4)
    return { tier: "webllm", detail: "WebGPU + desktop-class RAM/CPU", webgpu, ramGB, cores, mobile };
  if (webgpu && mobile && ramGB >= 4)
    return { tier: "webllm", detail: "WebGPU mobile — tiny models only", webgpu, ramGB, cores, mobile };
  return {
    tier: webgpu ? "api" : "api",
    detail: webgpu ? "WebGPU present but below local thresholds — API fallback" : "No WebGPU — API fallback",
    webgpu, ramGB, cores, mobile,
  };
}
