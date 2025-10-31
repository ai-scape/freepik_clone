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
  "group relative flex flex-col items-center justify-center gap-3 rounded-2xl border border-white/10 bg-white/5 px-6 py-8 text-center transition duration-300 hover:border-sky-400/60 hover:bg-white/10";

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
  const [urlInput, setUrlInput] = useState("");
  const [renders, setRenders] = useState<Render[]>([]);
  const [busy, setBusy] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const spec: ImageModelSpec = useMemo(
    () => IMAGE_MODELS.find((model) => model.id === modelId)!,
    [modelId]
  );

  useEffect(() => {
    if (spec.maxRefs > 0 && imageUrls.length > spec.maxRefs) {
      setImageUrls((prev) => prev.slice(0, spec.maxRefs));
    }
    if (spec.id !== "chrono-edit") {
      setTemporal(true);
    }
  }, [spec, imageUrls.length]);

  const canAddMore = imageUrls.length < spec.maxRefs;

  const uploadFiles = useCallback(
    async (files: File[]) => {
      if (!files.length) return;
      const client = initFalFromLocalStorage();
      const uploads = await Promise.all(
        files.map(async (file) => {
          const result = await client.storage.upload(file);
          return extractUploadUrl(result);
        })
      );
      setImageUrls((prev) =>
        [...prev, ...uploads.filter(Boolean) as string[]].slice(
          0,
          spec.maxRefs
        )
      );
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

  const addReferenceUrl = useCallback(() => {
    if (!urlInput.trim()) return;
    setImageUrls((prev) =>
      [...prev, urlInput.trim()].slice(0, spec.maxRefs)
    );
    setUrlInput("");
  }, [spec.maxRefs, urlInput]);

  const removeReference = useCallback((index: number) => {
    setImageUrls((prev) => prev.filter((_, idx) => idx !== index));
  }, []);

  const generate = useCallback(async () => {
    if (!prompt.trim()) {
      window.alert("Please provide a prompt.");
      return;
    }
    if (!imageUrls.length) {
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
  }, [imageUrls, modelId, prompt, seed, size, spec, temporal]);

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

  return (
    <div className="flex flex-1 flex-col gap-8 lg:flex-row lg:items-start">
      <section className="glass-surface relative w-full max-w-md flex-shrink-0 overflow-hidden px-6 py-8">
        <div className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-white/40 to-transparent" />
        <div className="pointer-events-none absolute right-6 top-6 h-36 w-36 rounded-full bg-sky-500/15 blur-3xl" />
        <div className="space-y-3">
          <div className="text-xs font-semibold uppercase tracking-widest text-slate-400">
            Image lab
          </div>
          <h2 className="text-2xl font-semibold text-white">
            Prompt-based edits
          </h2>
          <p className="text-sm text-slate-400">
            Upload one or more references and describe the transformation.
          </p>
        </div>

        <div className="mt-6 space-y-3">
          <label className="text-xs font-semibold uppercase tracking-wide text-slate-400">
            Model
          </label>
          <select
            value={modelId}
            onChange={(event) => setModelId(event.target.value)}
            className="w-full rounded-2xl border border-white/10 bg-white/5 px-3 py-2 text-sm text-white outline-none transition focus:border-sky-400 focus:ring-1 focus:ring-sky-400"
          >
            {IMAGE_MODELS.map((model) => (
              <option key={model.id} value={model.id}>
                {model.label}
              </option>
            ))}
          </select>
        </div>

        <div className="mt-6 space-y-3">
          <label className="text-xs font-semibold uppercase tracking-wide text-slate-400">
            Prompt
          </label>
          <textarea
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
            rows={4}
            onPaste={handlePaste}
            placeholder="Describe the edit, mood, or changes…"
            className="w-full rounded-2xl border border-white/10 bg-white/5 px-4 py-3 text-sm text-white outline-none transition focus:border-sky-400 focus:ring-1 focus:ring-sky-400"
          />
        </div>

        <div className="mt-6 space-y-3">
          <label className="text-xs font-semibold uppercase tracking-wide text-slate-400">
            Reference images (max {spec.maxRefs})
          </label>
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
            <span className="pointer-events-none absolute inset-0 rounded-2xl bg-gradient-to-br from-white/8 via-transparent to-transparent opacity-0 transition duration-300 group-hover:opacity-100" />
            <span className="pointer-events-none absolute inset-0 overflow-hidden rounded-2xl opacity-0 transition duration-300 group-hover:opacity-100">
              <span className="absolute inset-0 -translate-x-full bg-gradient-to-r from-transparent via-white/35 to-transparent animate-shimmer" />
            </span>
            <div className="flex flex-col items-center gap-2">
              <div className="text-sm font-semibold uppercase tracking-wide text-slate-200">
                Drag & drop or click to upload
              </div>
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                className="rounded-full border border-white/10 bg-white/5 px-3 py-1 text-xs text-slate-300 hover:border-sky-400 hover:text-sky-300"
                disabled={!canAddMore}
              >
                Browse files
              </button>
              <div className="text-[11px] text-slate-500">
                You can also paste images directly into the prompt field.
              </div>
            </div>
          </div>
          <div className="flex gap-2">
            <input
              type="url"
              value={urlInput}
              onChange={(event) => setUrlInput(event.target.value)}
              placeholder="https://example.com/reference.png"
              className="flex-1 rounded-2xl border border-white/10 bg-white/5 px-3 py-2 text-sm text-white outline-none transition focus:border-sky-400 focus:ring-1 focus:ring-sky-400"
            />
            <button
              type="button"
              onClick={addReferenceUrl}
              className="rounded-2xl border border-white/10 bg-white/5 px-3 py-2 text-sm text-slate-200 hover:border-sky-400 hover:text-sky-200"
              disabled={!urlInput.trim() || !canAddMore}
            >
              Add URL
            </button>
          </div>
          {imageUrls.length > 0 ? (
            <div className="flex flex-wrap gap-2">
              {imageUrls.map((url, index) => (
                <div
                  key={`${url}-${index}`}
                  className="relative h-16 w-16 overflow-hidden rounded-xl border border-white/10"
                >
                  <img
                    src={url}
                    alt={`reference-${index + 1}`}
                    className="h-full w-full object-cover"
                  />
                  <button
                    type="button"
                    onClick={() => removeReference(index)}
                    className="absolute right-1 top-1 rounded-full bg-black/60 px-1 text-[10px] text-white"
                  >
                    ✕
                  </button>
                </div>
              ))}
            </div>
          ) : null}
        </div>

        <div className="mt-6 flex flex-col gap-3">
          <div className="flex gap-2">
            <select
              value={size}
              onChange={(event) =>
                setSize(event.target.value as ImageSizePreset)
              }
              className="flex-1 rounded-2xl border border-white/10 bg-white/5 px-3 py-2 text-sm text-white outline-none transition focus:border-sky-400 focus:ring-1 focus:ring-sky-400"
            >
              {SIZE_OPTIONS.map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </select>
            <input
              type="number"
              placeholder="seed"
              className="w-28 rounded-2xl border border-white/10 bg-white/5 px-3 py-2 text-sm text-white outline-none transition focus:border-sky-400 focus:ring-1 focus:ring-sky-400"
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
          {spec.id === "chrono-edit" ? (
            <label className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-slate-400">
              <input
                type="checkbox"
                checked={temporal}
                onChange={(event) => setTemporal(event.target.checked)}
              />
              Temporal reasoning
            </label>
          ) : null}
        </div>

        <button
          type="button"
          onClick={generate}
          disabled={busy}
          className="mt-8 w-full rounded-2xl bg-gradient-to-r from-sky-500 via-blue-500 to-indigo-500 py-3 text-sm font-semibold text-white shadow-lg shadow-sky-500/25 transition duration-200 hover:-translate-y-0.5 hover:shadow-[0_24px_80px_rgba(59,130,246,0.35)] disabled:opacity-60"
        >
          {busy ? "Generating…" : "Generate"}
        </button>
      </section>

      <aside className="glass-surface relative flex w-full flex-1 flex-col gap-5 overflow-hidden px-6 py-6">
        <div className="pointer-events-none absolute inset-x-4 top-0 h-px bg-gradient-to-r from-transparent via-white/30 to-transparent" />
        <div className="flex items-center justify-between">
          <div>
            <div className="text-xs font-semibold uppercase tracking-wide text-slate-400">
              Renders
            </div>
            <div className="mt-1 text-lg font-semibold text-white">
              Latest edits
            </div>
          </div>
          <div className="rounded-full bg-white/5 px-3 py-1 text-xs font-semibold text-slate-300">
            {renders.length} total
          </div>
        </div>
        <div className="fade-mask flex max-h-[calc(100vh-240px)] flex-col gap-4 overflow-y-auto pr-2">
          {renders.length === 0 ? (
            <div className="rounded-2xl border border-white/5 bg-white/5 px-5 py-6 text-sm text-slate-400">
              Your generated edits will appear here. Use “Recreate” to resend with tweaks.
            </div>
          ) : (
            renders.map((render) => (
              <div
                key={render.id}
                className="space-y-3 rounded-2xl border border-white/5 bg-white/10/5 px-4 py-4 backdrop-blur-xl transition duration-200 hover:-translate-y-1 hover:shadow-[0_24px_80px_rgba(17,94,163,0.18)]"
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
                      <a
                        href={render.urls[0]}
                        download
                        className="rounded-full border border-white/10 bg-white/5 px-3 py-1 text-xs font-semibold text-slate-200 transition hover:border-sky-400 hover:text-sky-200"
                      >
                        Download
                      </a>
                    ) : null}
                  </div>
                </div>
                <div className="grid gap-2 md:grid-cols-2">
                  {render.urls.slice(0, 4).map((url, index) => (
                    <div
                      key={`${url}-${index}`}
                      className="relative overflow-hidden rounded-xl border border-white/10 bg-white/5"
                    >
                      <img
                        src={url}
                        alt={`render-${index + 1}`}
                        className="h-full w-full object-cover"
                      />
                    </div>
                  ))}
                  {render.urls.length === 0 ? (
                    <div className="rounded-xl border border-white/10 bg-white/5 p-4 text-sm text-slate-500">
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
