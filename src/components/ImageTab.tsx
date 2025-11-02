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
import { Spinner } from "./ui/Spinner";

type Render = {
  id: string;
  modelId: string;
  prompt: string;
  urls: string[];
  refs: string[];
  size?: ImageSizePreset;
  seed?: number;
  temporal?: boolean;
  createdAt: number;
  raw: unknown;
};

const dropZoneBase =
  "group relative flex h-24 w-full flex-col items-center justify-center gap-1 rounded-lg border border-white/10 bg-white/5 px-3 text-center transition duration-300 hover:border-sky-400/60 hover:bg-white/10";

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

  const spec: ImageModelSpec = useMemo(
    () => IMAGE_MODELS.find((model) => model.id === modelId)!,
    [modelId]
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
      const files = Array.from(event.dataTransfer.files).filter((file) =>
        file.type.startsWith("image")
      );
      uploadFiles(files);
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
      setRenders((prev) => [
        {
          id: requestId,
          modelId,
          prompt: job.prompt,
          urls,
          refs: imageUrls,
          size,
          seed,
          temporal: spec.id === "chrono-edit" ? temporal : undefined,
          createdAt: Date.now(),
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

  const handleImageDownload = useCallback(
    async (render: Render, url: string, index: number) => {
      try {
        const response = await fetch(url);
        if (!response.ok) {
          throw new Error(`Failed to fetch image (${response.status})`);
        }
        const blob = await response.blob();
        const objectUrl = URL.createObjectURL(blob);
        const anchor = document.createElement("a");
        anchor.href = objectUrl;
        anchor.download = `${render.id}-image-${index + 1}.jpg`;
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
              onDragOver={(event) => {
                if (!canAddMore) return;
                event.preventDefault();
              }}
              onDrop={handleDrop}
              className={`${dropZoneBase} ${
                !canAddMore ? "opacity-60" : ""
              }`}
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
              <span className="pointer-events-none absolute inset-0 rounded-lg bg-gradient-to-br from-white/8 via-transparent to-transparent opacity-0 transition duration-300 group-hover:opacity-100" />
              <span className="pointer-events-none absolute inset-0 overflow-hidden rounded-lg opacity-0 transition duration-300 group-hover:opacity-100">
                <span className="absolute inset-0 -translate-x-full bg-gradient-to-r from-transparent via-white/35 to-transparent animate-shimmer" />
              </span>
              {imageUrls.length > 0 ? (
                <div className="flex w-full flex-col gap-2">
                  <div className="grid w-full grid-cols-3 gap-1.5">
                    {imageUrls.map((url, index) => (
                      <div
                        key={`${url}-${index}`}
                        className="group relative overflow-hidden rounded-lg border border-white/10 pb-[100%]"
                      >
                        <img
                          src={url}
                          alt={`reference-${index + 1}`}
                          className="absolute inset-0 h-full w-full object-cover"
                        />
                        <button
                          type="button"
                          onClick={() => removeReference(index)}
                          className="absolute right-1 top-1 rounded-full bg-black/60 px-1 text-[10px] text-white opacity-0 transition group-hover:opacity-100"
                        >
                          ✕
                        </button>
                      </div>
                    ))}
                  </div>
                  <span className="text-[11px] text-slate-500">
                    Drop more images or paste them into the prompt field.
                  </span>
                </div>
              ) : (
                <div className="flex h-full w-full flex-col items-center justify-center gap-2 text-[11px] text-slate-400">
                  <span>Drop images or click to upload</span>
                  <button
                    type="button"
                    onClick={() => fileInputRef.current?.click()}
                    className="rounded-full border border-white/10 bg-white/5 px-3 py-1 text-xs text-slate-300 hover:border-sky-400 hover:text-sky-300"
                    disabled={!canAddMore}
                  >
                    Browse files
                  </button>
                </div>
              )}
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

          <button
            type="button"
            onClick={generate}
            disabled={busy}
            className={`${primaryActionButton} ${busy ? "opacity-60" : ""}`}
          >
            <span className="flex items-center justify-center gap-2">
              {busy && <Spinner size="sm" />}
              {busy ? "Generating…" : "Generate"}
            </span>
          </button>
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
                    {render.urls[0] ? (
                      <button
                        type="button"
                        onClick={() => handleImageDownload(render, render.urls[0], 0)}
                        className="rounded-full border border-white/10 bg-white/5 px-3 py-1 text-xs font-semibold text-slate-200 transition hover:border-sky-400 hover:text-sky-200"
                      >
                        Download
                      </button>
                    ) : null}
                  </div>
                </div>
                <div className="grid gap-1.5 md:grid-cols-2">
                  {render.urls.slice(0, 4).map((url, index) => (
                    <div
                      key={`${url}-${index}`}
                      className="group relative overflow-hidden rounded-xl border border-white/10 bg-white/5"
                    >
                      <img
                        src={url}
                        alt={`render-${index + 1}`}
                        className="h-full w-full object-cover"
                      />
                      <button
                        type="button"
                        onClick={(event) => {
                          event.stopPropagation();
                          handleImageDownload(render, url, index);
                        }}
                        className="absolute bottom-1 right-1 rounded-full bg-black/60 px-2 py-1 text-[10px] text-white opacity-0 transition group-hover:opacity-100"
                      >
                        Save
                      </button>
                    </div>
                  ))}
                  {render.urls.length === 0 ? (
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
