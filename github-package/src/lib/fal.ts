import { fal } from "@fal-ai/client";
import {
  MODEL_SPEC_MAP,
  buildFalInput,
  extractVideoUrl,
  type ModelSpec,
  type UnifiedPayload,
} from "./models";

export function initFalFromLocalStorage() {
  if (typeof window === "undefined") {
    return fal;
  }
  const key = localStorage.getItem("FAL_KEY")?.trim();
  if (key) {
    fal.config({ credentials: key });
  }
  return fal;
}

export function setFalKey(key: string) {
  if (typeof window === "undefined") {
    return;
  }
  const trimmed = key.trim();
  if (!trimmed) {
    localStorage.removeItem("FAL_KEY");
    return;
  }
  localStorage.setItem("FAL_KEY", trimmed);
  fal.config({ credentials: trimmed });
}

export function getModelSpec(modelId: string): ModelSpec {
  const spec = MODEL_SPEC_MAP[modelId];
  if (!spec) {
    throw new Error(`Unknown model id: ${modelId}`);
  }
  return spec;
}

export async function runFal(
  modelId: string,
  payload: UnifiedPayload,
  onQueueUpdate?: (event: unknown) => void
) {
  const spec = getModelSpec(modelId);
  const client = initFalFromLocalStorage();
  const input = buildFalInput(spec, payload);
  const result = await client.subscribe(spec.endpoint, {
    input,
    logs: true,
    onQueueUpdate,
  });
  const url = extractVideoUrl(spec, result.data);
  if (!url) {
    throw new Error("Video URL not found in response");
  }
  return { url, raw: result.data };
}
