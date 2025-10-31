import { initFalFromLocalStorage } from "./fal";

export type ImageSizePreset =
  | "square_hd"
  | "square"
  | "portrait_4_3"
  | "portrait_16_9"
  | "landscape_4_3"
  | "landscape_16_9";

export type ImageJob = {
  prompt: string;
  imageUrls: string[];
  size?: ImageSizePreset | { width: number; height: number };
  seed?: number;
  temporal?: boolean;
  steps?: number;
};

export type ImageModelSpec = {
  id: string;
  label: string;
  endpoint: string;
  mode: "edit" | "hybrid";
  maxRefs: number;
  mapInput: (
    job: ImageJob
  ) => Record<
    string,
    string | number | boolean | string[] | undefined | ImageJob["size"]
  >;
  getUrls: (out: unknown) => string[];
};

export const IMAGE_MODELS: ImageModelSpec[] = [
  {
    id: "nano-banana-edit",
    label: "Nano Banana — Edit",
    endpoint: "fal-ai/nano-banana/edit",
    mode: "edit",
    maxRefs: 4,
    mapInput: ({ prompt, imageUrls, size, seed }) => ({
      prompt,
      image_urls: imageUrls.slice(0, 4),
      ...(size ? { image_size: size } : {}),
      ...(seed !== undefined ? { seed } : {}),
    }),
    getUrls: (output) =>
      ((output as { images?: Array<{ url?: string }> })?.images ?? [])
        .map((image) => image?.url)
        .filter(Boolean) as string[],
  },
  {
    id: "qwen-image-edit-plus",
    label: "Qwen Image Edit Plus (2509)",
    endpoint: "fal-ai/qwen-image-edit-plus",
    mode: "edit",
    maxRefs: 4,
    mapInput: ({ prompt, imageUrls, size, seed, steps }) => ({
      prompt,
      image_urls: imageUrls.slice(0, 4),
      image_size: size ?? "square_hd",
      num_inference_steps: steps ?? 50,
      guidance_scale: 4,
      num_images: 1,
      enable_safety_checker: true,
      output_format: "png",
      acceleration: "regular",
      ...(seed !== undefined ? { seed } : {}),
    }),
    getUrls: (output) =>
      ((output as { images?: Array<{ url?: string }> })?.images ?? [])
        .map((image) => image?.url)
        .filter(Boolean) as string[],
  },
  {
    id: "seedream-v4-edit",
    label: "Seedream v4 — Edit",
    endpoint: "fal-ai/bytedance/seedream/v4/edit",
    mode: "edit",
    maxRefs: 4,
    mapInput: ({ prompt, imageUrls, size, seed }) => ({
      prompt,
      image_urls: imageUrls.slice(0, 4),
      ...(size ? { image_size: size } : {}),
      ...(seed !== undefined ? { seed } : {}),
    }),
    getUrls: (output) =>
      ((output as { images?: Array<{ url?: string }> })?.images ?? [])
        .map((image) => image?.url)
        .filter(Boolean) as string[],
  },
  {
    id: "chrono-edit",
    label: "Temporal Edit — Chrono Edit",
    endpoint: "fal-ai/chrono-edit",
    mode: "edit",
    maxRefs: 1,
    mapInput: ({ prompt, imageUrls, temporal, steps, seed }) => ({
      prompt,
      image_url: imageUrls[0],
      enable_prompt_expansion: true,
      enable_safety_checker: true,
      enable_temporal_reasoning: temporal ?? true,
      num_inference_steps: steps ?? 8,
      num_temporal_reasoning_steps: 8,
      output_format: "jpeg",
      ...(seed !== undefined ? { seed } : {}),
    }),
    getUrls: (output) =>
      ((output as { images?: Array<{ url?: string }> })?.images ?? [])
        .map((image) => image?.url)
        .filter(Boolean) as string[],
  },
  {
    id: "gemini-flash-edit-multi",
    label: "Gemini Flash Edit — Multi Image",
    endpoint: "fal-ai/gemini-flash-edit/multi",
    mode: "edit",
    maxRefs: 8,
    mapInput: ({ prompt, imageUrls, size, seed }) => ({
      prompt,
      image_urls: imageUrls.slice(0, 8),
      ...(size ? { image_size: size } : {}),
      ...(seed !== undefined ? { seed } : {}),
    }),
    getUrls: (output) => {
      const payload = output as {
        images?: Array<{ url?: string }>;
        image?: { url?: string };
      };
      const list =
        payload?.images ??
        (payload?.image ? [payload.image] : []);
      return list.map((img) => img?.url).filter(Boolean) as string[];
    },
  },
];

export async function runImageJob(
  spec: ImageModelSpec,
  job: ImageJob
): Promise<{
  request_id?: string;
  requestId?: string;
  data: unknown;
}> {
  const client = initFalFromLocalStorage();
  const result = await client.subscribe(spec.endpoint, {
    input: spec.mapInput(job),
    logs: true,
  });
  return result;
}
