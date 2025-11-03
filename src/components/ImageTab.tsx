import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  IMAGE_MODELS,
  type ImageJob,
  type ImageModelSpec,
  type ImageSizePreset,
  runImageJob,
} from "../lib/image-models";
import { initFalFromLocalStorage } from "../lib/fal";
import { getModelPricingLabel } from "../lib/pricing";
import { arrayBufferToBase64 } from "../lib/file-utils";
import { formatCompactTimestamp } from "../lib/time";
import { Spinner } from "./ui/Spinner";

type Render = {
  id: string;
  modelId: string;
  prompt: string;
  assets: RenderAsset[];
  refs: string[];
  size?: ImageSizePreset;
  seed?: number;
  temporal?: boolean;
  createdAt: number;
  raw: unknown;
};

type RenderAsset = {
  previewUrl: string;
  downloadUrl: string;
  fileName: string;
};

const primaryActionButton =
  "w-full rounded-xl bg-gradient-to-r from-sky-500 via-blue-500 to-indigo-500 py-2 text-sm font-semibold text-white shadow-lg shadow-sky-500/25 transition duration-200 hover:-translate-y-0.5 hover:shadow-[0_24px_80px_rgba(59,130,246,0.35)]";

const SIZE_OPTIONS: ImageSizePreset[] = [
  "square_hd",
  "square",
  "portrait_4_3",
  "portrait_16_9",
  "landscape_4_3",
  "landscape_16_9",
];

function createLocalId(prefix: string) {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function extractUploadUrl(uploadResult: unknown): string | undefined {
  if (!uploadResult) return undefined;
  if (typeof uploadResult === "string") {
    return uploadResult;
  }
  if (typeof uploadResult === "object") {
    const record = uploadResult as {
      url?: string;
      signedUrl?: string;
      signed_url?: string;
      data?: {
        url?: string;
        signed_url?: string;
        signedUrl?: string;
      };
    };
    return (
      record.url ??
      record.signedUrl ??
      record.signed_url ??
      record.data?.url ??
      record.data?.signed_url ??
      record.data?.signedUrl
    );
  }
  return undefined;
}

async function storeAssetsOnDisk(
  urls: string[],
  renderId: string,
  createdAt: number
): Promise<RenderAsset[]> {
  if (!urls.length || typeof window === "undefined") return [];
  const timestamp = new Date(createdAt);
  const stamp = formatCompactTimestamp(timestamp);
  return Promise.all(
    urls.map(async (url, index) => {
      const name = `${renderId}-asset-${index + 1}-${stamp}`;
      try {
        const response = await fetch(url);
        if (!response.ok) {
          throw new Error(`Failed to fetch asset ${url}`);
        }
        const blob = await response.blob();
        const arrayBuffer = await blob.arrayBuffer();
        const base64 = arrayBufferToBase64(arrayBuffer);
        const extension =
          blob.type && blob.type.includes("/")
            ? blob.type.split("/")[1] ?? "bin"
            : "bin";
        const fileName = `${name}.${extension}`;
        const saveResponse = await fetch("/api/assets", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            name: fileName,
            data: base64,
          }),
        });
        if (!saveResponse.ok) {
          throw new Error("Failed to persist asset");
        }
        const localUrl = `/assets/${encodeURIComponent(fileName)}`;
        return {
          previewUrl: localUrl,
          downloadUrl: localUrl,
          fileName,
        };
      } catch {
        return {
          previewUrl: url,
          downloadUrl: url,
          fileName: `${name}.jpg`,
        };
      }
    })
  );
}

const RENDER_STORAGE_KEY = "image-render-history";

function loadStoredRenders(): Render[] {
  if (typeof window === "undefined") return [];
  const raw = window.localStorage.getItem(RENDER_STORAGE_KEY);
  if (!raw) return [];
  try {
    const data = JSON.parse(raw) as unknown[];
    if (!Array.isArray(data)) return [];
    return data
      .map((entry) => {
        if (!entry || typeof entry !== "object") return null;
        const record = entry as Record<string, unknown>;
        const id =
          typeof record.id === "string" ? record.id : createLocalId("render");
        const createdAt =
          typeof record.createdAt === "number"
            ? record.createdAt
            : Date.now();
        const modelId =
          typeof record.modelId === "string"
            ? record.modelId
            : IMAGE_MODELS[0].id;
        const prompt =
          typeof record.prompt === "string" ? record.prompt : "";
        const refs = Array.isArray(record.refs)
          ? (record.refs.filter((ref) => typeof ref === "string") as string[])
          : [];
        const size =
          typeof record.size === "string"
            ? (record.size as ImageSizePreset)
            : undefined;
        const seed =
          typeof record.seed === "number" ? (record.seed as number) : undefined;
        const temporal =
          typeof record.temporal === "boolean"
            ? (record.temporal as boolean)
            : undefined;
        const assetsInput = record.assets;
        let assets: RenderAsset[] = [];
        if (Array.isArray(assetsInput)) {
          assets = assetsInput
            .map((asset, index) => {
              if (!asset || typeof asset !== "object") return null;
              const assetRecord = asset as Record<string, unknown>;
              const previewUrl =
                typeof assetRecord.previewUrl === "string"
                  ? assetRecord.previewUrl
                  : undefined;
              const downloadUrl =
                typeof assetRecord.downloadUrl === "string"
                  ? assetRecord.downloadUrl
                  : previewUrl;
              const fileName =
                typeof assetRecord.fileName === "string"
                  ? assetRecord.fileName
                  : `${id}-asset-${index + 1}.jpg`;
              if (!previewUrl || !downloadUrl) return null;
              return {
                previewUrl,
                downloadUrl,
                fileName,
              };
            })
            .filter((asset): asset is RenderAsset => Boolean(asset));
        }
        if (
          assets.length === 0 &&
          Array.isArray((record as { urls?: unknown }).urls)
        ) {
          const urls = (record as { urls?: unknown }).urls;
          const stamp = formatCompactTimestamp(new Date(createdAt));
          assets = (urls ?? [])
            .filter((url): url is string => typeof url === "string")
            .map((url, index) => ({
              previewUrl: url,
              downloadUrl: url,
              fileName: `${id}-asset-${index + 1}-${stamp}.jpg`,
            }));
        }
        return {
          id,
          modelId,
          prompt,
          assets,
          refs,
          size,
          seed,
          temporal,
          createdAt,
          raw: undefined,
        };
      })
      .filter((render): render is Render => Boolean(render));
  } catch {
    return [];
  }
}

function persistRenders(renders: Render[]) {
  if (typeof window === "undefined") return;
  try {
    const payload = renders.map((render) => {
      const { raw: unusedRaw, ...rest } = render;
      void unusedRaw;
      return rest;
    });
    window.localStorage.setItem(RENDER_STORAGE_KEY, JSON.stringify(payload));
  } catch {
    // Ignore persistence errors silently.
  }
}

export default function ImageTab() {
  const [modelId, setModelId] = useState<string>(IMAGE_MODELS[0].id);
  const [prompt, setPrompt] = useState("");
  const [size, setSize] = useState<ImageSizePreset>("square_hd");
  const [seed, setSeed] = useState<number | undefined>();
  const [temporal, setTemporal] = useState(true);
  const [imageUrls, setImageUrls] = useState<string[]>([]);
  const [renders, setRenders] = useState<Render[]>([]);
  const [busy, setBusy] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const dragCounterRef = useRef(0);

  const spec: ImageModelSpec = useMemo(
    () => IMAGE_MODELS.find((model) => model.id === modelId)!,
    [modelId]
  );
  const pricingLabel = useMemo(
    () => getModelPricingLabel(spec.id),
    [spec.id]
  );
  const canUseTemporal = spec.id === "chrono-edit";

  useEffect(() => {
    if (spec.maxRefs > 0 && imageUrls.length > spec.maxRefs) {
      setImageUrls((prev) => prev.slice(0, spec.maxRefs));
    }
    if (spec.maxRefs === 0 && imageUrls.length > 0) {
      setImageUrls([]);
    }
    if (spec.id !== "chrono-edit") {
      setTemporal(true);
    }
  }, [spec, imageUrls.length]);

  useEffect(() => {
    const stored = loadStoredRenders();
    if (stored.length) {
      setRenders(stored);
    }
  }, []);

  useEffect(() => {
    persistRenders(renders);
  }, [renders]);

  const canAddMore =
    spec.maxRefs > 0 && imageUrls.length < spec.maxRefs;

  const uploadFiles = useCallback(
    async (files: File[]) => {
      if (!files.length || spec.maxRefs === 0) return;
      const client = initFalFromLocalStorage();
      try {
        const uploads = await Promise.all(
          files.map(async (file) => {
            const result = await client.storage.upload(file);
            const url = extractUploadUrl(result);
            if (!url) {
              throw new Error(`Unable to upload ${file.name}`);
            }
            return url;
          })
        );
        setImageUrls((prev) =>
          [...prev, ...uploads].slice(0, spec.maxRefs)
        );
      } catch (error) {
        const message =
          error instanceof Error
            ? error.message
            : "Failed to upload reference image.";
        window.alert(message);
      }
    },
    [spec.maxRefs]
  );

  const handleDrop = useCallback(
    (event: React.DragEvent<HTMLDivElement>) => {
      if (!canAddMore) return;
      event.preventDefault();
      event.stopPropagation();
      const files = Array.from(event.dataTransfer.files).filter((file) =>
        file.type.startsWith("image")
      );
      uploadFiles(files);
      dragCounterRef.current = 0;
      setIsDragging(false);
    },
    [canAddMore, uploadFiles]
  );

  const handlePaste = useCallback(
    (event: React.ClipboardEvent<HTMLTextAreaElement>) => {
      if (!canAddMore) return;
      const items = event.clipboardData.items;
      const files: File[] = [];
      for (let i = 0; i < items.length; i += 1) {
        const item = items[i];
        if (item.kind === "file") {
          const file = item.getAsFile();
          if (file) files.push(file);
        }
      }
      if (files.length) {
        event.preventDefault();
        uploadFiles(files);
      }
    },
    [canAddMore, uploadFiles]
  );

  const removeReference = useCallback((index: number) => {
    setImageUrls((prev) => prev.filter((_, idx) => idx !== index));
  }, []);

  const handleDragEnter = useCallback(
    (event: React.DragEvent<HTMLDivElement>) => {
      if (!canAddMore) return;
      event.preventDefault();
      event.stopPropagation();
      dragCounterRef.current += 1;
      setIsDragging(true);
    },
    [canAddMore]
  );

  const handleDragLeave = useCallback(
    (event: React.DragEvent<HTMLDivElement>) => {
      if (!canAddMore) return;
      event.preventDefault();
      event.stopPropagation();
      dragCounterRef.current = Math.max(0, dragCounterRef.current - 1);
      if (dragCounterRef.current === 0) {
        setIsDragging(false);
      }
    },
    [canAddMore]
  );

  const handleDragOver = useCallback(
    (event: React.DragEvent<HTMLDivElement>) => {
      if (!canAddMore) return;
      event.preventDefault();
    },
    [canAddMore]
  );

  const generate = useCallback(async () => {
    if (busy) return;
    if (!prompt.trim()) {
      window.alert("Please provide a prompt.");
      return;
    }
    if (spec.maxRefs > 0 && imageUrls.length === 0) {
      window.alert("Add at least one reference image.");
      return;
    }
    setBusy(true);
    try {
      const job: ImageJob = {
        prompt: prompt.trim(),
        imageUrls,
        size,
        seed,
        temporal,
      };
      const result = await runImageJob(spec, job);
      const urls = spec.getUrls(result?.data) ?? [];
      const requestId =
        (result?.request_id as string) ??
        (result?.requestId as string) ??
        createLocalId("imgjob");
      const createdAt = Date.now();
      const assets = await storeAssetsOnDisk(urls, requestId, createdAt);
      setRenders((prev) => [
        {
          id: requestId,
          modelId,
          prompt: job.prompt,
          assets,
          refs: imageUrls,
          size,
          seed,
          temporal: spec.id === "chrono-edit" ? temporal : undefined,
          createdAt,
          raw: result?.data,
        },
        ...prev,
      ]);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Image generation failed.";
      window.alert(message);
    } finally {
      setBusy(false);
    }
  }, [busy, imageUrls, modelId, prompt, seed, size, spec, temporal]);

  const recreate = useCallback(
    (render: Render) => {
      setModelId(render.modelId);
      setPrompt(render.prompt);
      setImageUrls(render.refs);
      if (render.size) setSize(render.size);
      setSeed(render.seed);
      if (render.modelId === "chrono-edit" && render.temporal !== undefined) {
        setTemporal(render.temporal);
      }
    },
    []
  );

  const handleAssetDownload = useCallback(
    async (asset: RenderAsset) => {
      try {
        const response = await fetch(asset.downloadUrl);
        if (!response.ok) {
          throw new Error(`Failed to fetch image (${response.status})`);
        }
        const blob = await response.blob();
        const objectUrl = URL.createObjectURL(blob);
        const anchor = document.createElement("a");
        anchor.href = objectUrl;
        anchor.download = asset.fileName;
        document.body.appendChild(anchor);
        anchor.click();
        document.body.removeChild(anchor);
        URL.revokeObjectURL(objectUrl);
      } catch (error) {
        window.alert(
          error instanceof Error
            ? error.message
            : "Unable to download image."
        );
      }
    },
    []
  );

  return (
    <div className="flex flex-1 flex-col gap-3.5 lg:flex-row lg:items-start">
      <section className="glass-surface relative flex w-full max-w-xs flex-shrink-0 flex-col overflow-hidden px-3.5 py-3.5 lg:max-w-xs">
        <div className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-white/40 to-transparent" />
        <div className="flex h-full flex-col gap-3">
          <div className="flex items-center justify-between rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-xs text-slate-200">
            <span className="font-semibold uppercase tracking-wide">Model</span>
            <select
              value={modelId}
              onChange={(event) => setModelId(event.target.value)}
              className="h-8 rounded-md border border-white/10 bg-black/30 px-2 text-xs text-white outline-none transition focus:border-sky-400 focus:ring-1 focus:ring-sky-400"
            >
              {IMAGE_MODELS.map((model) => (
                <option key={model.id} value={model.id}>
                  {model.label}
                </option>
              ))}
            </select>
          </div>

          {spec.maxRefs > 0 ? (
            <div
              onDragEnter={handleDragEnter}
              onDragLeave={handleDragLeave}
              onDragOver={handleDragOver}
              onDrop={handleDrop}
              className={`relative rounded-xl border px-3 py-3 transition duration-200 ${
                isDragging
                  ? "border-sky-400 bg-sky-500/10 shadow-[0_0_30px_rgba(14,165,233,0.25)]"
                  : "border-white/10 bg-white/5"
              } ${!canAddMore ? "opacity-70" : ""}`}
            >
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                multiple
                className="hidden"
                onChange={(event) => {
                  const files = event.currentTarget.files
                    ? Array.from(event.currentTarget.files)
                    : [];
                  uploadFiles(files);
                  if (fileInputRef.current) {
                    fileInputRef.current.value = "";
                  }
                }}
              />
              <div className="flex items-center justify-between">
                <div className="text-xs font-semibold uppercase tracking-wide text-slate-200">
                  Image References
                </div>
                <div className="text-[11px] font-semibold text-slate-500">
                  {imageUrls.length}/{spec.maxRefs}
                </div>
              </div>

              <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3">
                {imageUrls.map((url, index) => (
                  <div
                    key={`${url}-${index}`}
                    className="group relative aspect-square overflow-hidden rounded-xl border border-white/10 bg-black/30"
                  >
                    <img
                      src={url}
                      alt={`reference-${index + 1}`}
                      className="absolute inset-0 h-full w-full object-cover"
                    />
                    <span className="absolute left-2 bottom-2 rounded-full bg-black/60 px-2 py-0.5 text-[11px] font-semibold text-white">
                      @img{index + 1}
                    </span>
                    <button
                      type="button"
                      onClick={() => removeReference(index)}
                      className="absolute right-2 top-2 rounded-full border border-white/20 bg-black/70 px-2 py-1 text-[10px] font-semibold text-white opacity-0 transition group-hover:opacity-100"
                      aria-label={`Remove reference ${index + 1}`}
                    >
                      ✕
                    </button>
                  </div>
                ))}
                {canAddMore ? (
                  <button
                    type="button"
                    onClick={() => fileInputRef.current?.click()}
                    className="flex aspect-square w-full flex-col items-center justify-center gap-1 rounded-xl border border-dashed border-white/15 bg-black/20 text-sm font-semibold text-slate-400 transition hover:border-sky-400 hover:text-sky-200"
                  >
                    <span className="text-2xl leading-none text-slate-200">+</span>
                    <span className="text-[11px] uppercase tracking-wide">
                      Add
                    </span>
                    <span className="text-[10px] font-normal text-slate-500">
                      Drop or click
                    </span>
                  </button>
                ) : null}
              </div>

              <p className="mt-3 text-[11px] text-slate-500">
                Drag &amp; drop images, click Add, or paste into the prompt.
              </p>
            </div>
          ) : null}

          <div className="rounded-lg border border-white/10 bg-white/5 px-3 py-3">
            <textarea
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
              rows={3}
              onPaste={handlePaste}
              placeholder="Describe the edit"
              className="w-full resize-none rounded-md border border-white/10 bg-black/30 px-2 py-2 text-sm text-white outline-none transition focus:border-sky-400 focus:ring-1 focus:ring-sky-400"
            />
          </div>

          <div className="flex gap-2">
            <select
              value={size}
              onChange={(event) =>
                setSize(event.target.value as ImageSizePreset)
              }
              className="flex-1 rounded-md border border-white/10 bg-black/30 px-3 py-2 text-sm text-white outline-none transition focus:border-sky-400 focus:ring-1 focus:ring-sky-400"
            >
              {SIZE_OPTIONS.map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </select>
            <input
              type="number"
              placeholder="Seed"
              className="w-24 rounded-md border border-white/10 bg-black/30 px-3 py-2 text-sm text-white outline-none transition focus:border-sky-400 focus:ring-1 focus:ring-sky-400"
              value={seed ?? ""}
              onChange={(event) =>
                setSeed(
                  event.target.value
                    ? Number.parseInt(event.target.value, 10)
                    : undefined
                )
              }
            />
          </div>
          {canUseTemporal ? (
            <label className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wide text-slate-300">
              <input
                type="checkbox"
                checked={temporal}
                onChange={(event) => setTemporal(event.target.checked)}
              />
              Temporal reasoning
            </label>
          ) : null}

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={generate}
              disabled={busy}
              className={`${primaryActionButton} flex-1 ${
                busy ? "opacity-60" : ""
              }`}
            >
              <span className="flex items-center justify-center gap-2">
                {busy && <Spinner size="sm" />}
                {busy ? "Generating…" : "Generate"}
              </span>
            </button>
            {pricingLabel ? (
              <span className="whitespace-nowrap rounded-full border border-white/10 bg-white/5 px-3 py-1 text-[11px] font-semibold text-slate-200">
                {pricingLabel}
              </span>
            ) : null}
          </div>
        </div>
      </section>

      <aside className="glass-surface relative flex w-full flex-1 flex-col gap-2.5 overflow-hidden px-3.5 py-3.5">
        <div className="pointer-events-none absolute inset-x-4 top-0 h-px bg-gradient-to-r from-transparent via-white/30 to-transparent" />
        <div className="flex items-center justify-between">
          <div>
            <div className="text-xs font-semibold uppercase tracking-wide text-slate-400">
              Renders
            </div>
            <div className="mt-0.5 text-base font-semibold text-white">
              Latest edits
            </div>
          </div>
          <div className="rounded-full bg-white/5 px-3 py-1 text-[11px] font-semibold text-slate-300 sm:text-xs">
            {renders.length} total
          </div>
        </div>
        <div className="fade-mask flex max-h-[calc(100vh-200px)] flex-col gap-2.5 overflow-y-auto pr-2">
          {renders.length === 0 ? (
            <div className="rounded-xl border border-white/5 bg-white/5 px-3.5 py-4 text-sm text-slate-400">
              Your generated edits will appear here. Use “Recreate” to resend with tweaks.
            </div>
          ) : (
            renders.map((render) => (
              <div
                key={render.id}
                className="space-y-2.5 rounded-xl border border-white/5 bg-white/10 px-3.5 py-3 backdrop-blur-xl transition duration-200 hover:-translate-y-1 hover:shadow-[0_24px_80px_rgba(17,94,163,0.18)]"
              >
                <div className="flex items-center justify-between">
                  <div>
                    <div className="text-sm font-semibold text-white">
                      {IMAGE_MODELS.find((model) => model.id === render.modelId)
                        ?.label ?? render.modelId}
                    </div>
                    <div className="text-xs text-slate-500">
                      {new Date(render.createdAt).toLocaleTimeString()}
                    </div>
                  </div>
                  <div className="flex gap-2">
                    <button
                      type="button"
                      onClick={() => recreate(render)}
                      className="rounded-full border border-white/10 bg-white/5 px-3 py-1 text-xs font-semibold text-slate-200 transition hover:border-sky-400 hover:text-sky-200"
                    >
                      Recreate
                    </button>
                    {render.assets.length > 0 ? (
                      <button
                        type="button"
                        onClick={() => handleAssetDownload(render.assets[0])}
                        className="rounded-full border border-white/10 bg-white/5 px-3 py-1 text-xs font-semibold text-slate-200 transition hover:border-sky-400 hover:text-sky-200"
                      >
                        Download
                      </button>
                    ) : null}
                  </div>
                </div>
                <div className="grid gap-1.5 md:grid-cols-2">
                  {render.assets.slice(0, 4).map((asset, index) => (
                    <div
                      key={`${asset.fileName}-${index}`}
                      className="group relative overflow-hidden rounded-xl border border-white/10 bg-white/5"
                    >
                      <img
                        src={asset.previewUrl}
                        alt={`render-${asset.fileName}`}
                        className="h-full w-full object-cover"
                      />
                      <button
                        type="button"
                        onClick={(event) => {
                          event.stopPropagation();
                          handleAssetDownload(asset);
                        }}
                        className="absolute bottom-1 right-1 rounded-full bg-black/60 px-2 py-1 text-[10px] text-white opacity-0 transition group-hover:opacity-100"
                      >
                        Save
                      </button>
                    </div>
                  ))}
                  {render.assets.length === 0 ? (
                    <div className="rounded-xl border border-white/10 bg-white/5 p-3 text-sm text-slate-500">
                      No image returned.
                    </div>
                  ) : null}
                </div>
              </div>
            ))
          )}
        </div>
      </aside>
    </div>
  );
}
