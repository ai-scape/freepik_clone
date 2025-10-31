import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  DEFAULT_MODEL_ID,
  MODEL_SPECS,
  MODEL_SPEC_MAP,
  type ModelSpec,
  type ParamDefinition,
  type UnifiedPayload,
} from "../lib/models";
import {
  initFalFromLocalStorage,
  runFal,
  setFalKey,
} from "../lib/fal";
import { getVideo, saveVideo } from "../lib/storage";
import ImageTab from "../components/ImageTab";

type JobStatus = "uploading" | "queued" | "running" | "success" | "error";

type Job = {
  id: string;
  modelId: string;
  prompt: string;
  status: JobStatus;
  createdAt: number;
  attempts: number;
  payload?: UnifiedPayload;
  videoUrl?: string;
  error?: string;
  raw?: unknown;
  preview?: string | null;
  events: string[];
  storagePath: string;
  localKey?: string;
  saving?: boolean;
  saved?: boolean;
  saveError?: string;
};

const MAX_CONCURRENT_JOBS = 2;

function createId(prefix: string) {
  return `${prefix}_${Date.now()}_${Math.random()
    .toString(36)
    .slice(2, 8)}`;
}

async function readFilePreview(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      resolve(typeof reader.result === "string" ? reader.result : "");
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

type UploadResponseRecord = {
  url?: string;
  signedUrl?: string;
  signed_url?: string;
  data?: {
    url?: string;
    signed_url?: string;
    signedUrl?: string;
  };
};

function extractUploadUrl(uploadResult: unknown): string | undefined {
  if (!uploadResult) return undefined;
  if (typeof uploadResult === "string") {
    return uploadResult;
  }
  if (typeof uploadResult === "object") {
    const record = uploadResult as UploadResponseRecord;
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

type DropZoneProps = {
  label: string;
  required?: boolean;
  disabled?: boolean;
  fileName?: string;
  previewUrl?: string | null;
  onFileSelected(file: File | null): void;
};

const dropZoneBase =
  "group relative flex flex-col items-center justify-center gap-3 rounded-2xl border border-white/10 bg-white/5 px-6 py-8 text-center transition duration-300 hover:border-sky-400/60 hover:bg-white/10";

const DropZone = ({
  label,
  required,
  disabled,
  fileName,
  previewUrl,
  onFileSelected,
}: DropZoneProps) => {
  const inputId = useMemo(() => createId("dropzone"), []);

  const handleFiles = useCallback(
    (files: FileList | null) => {
      if (!files || files.length === 0) {
        onFileSelected(null);
        return;
      }
      onFileSelected(files[0]);
    },
    [onFileSelected]
  );

  return (
    <label
      htmlFor={inputId}
      className={`${dropZoneBase} ${
        disabled ? "cursor-not-allowed opacity-50" : "cursor-pointer"
      }`}
      onDragOver={(event) => {
        if (disabled) return;
        event.preventDefault();
      }}
      onDrop={(event) => {
        if (disabled) return;
        event.preventDefault();
        handleFiles(event.dataTransfer.files);
      }}
    >
      <input
        id={inputId}
        type="file"
        accept="image/*"
        className="hidden"
        disabled={disabled}
        onChange={(event) => handleFiles(event.currentTarget.files)}
      />
      <span className="pointer-events-none absolute inset-0 rounded-2xl bg-gradient-to-br from-white/8 via-transparent to-transparent opacity-0 transition duration-300 group-hover:opacity-100" />
      <span className="pointer-events-none absolute inset-0 overflow-hidden rounded-2xl opacity-0 transition duration-300 group-hover:opacity-100">
        <span className="absolute inset-0 -translate-x-full bg-gradient-to-r from-transparent via-white/35 to-transparent animate-shimmer" />
      </span>
      <div className="flex flex-col items-center gap-3">
        <div className="text-sm font-semibold uppercase tracking-wide text-slate-200">
          {label}
          {required ? " *" : ""}
        </div>
        {previewUrl ? (
          <img
            src={previewUrl}
            alt={`${label} preview`}
            className="h-32 w-full rounded-xl border border-white/10 object-cover"
          />
        ) : (
          <div className="text-xs text-slate-400">
            Drag & drop or click to upload
          </div>
        )}
        {fileName ? (
          <div className="max-w-full truncate text-xs text-slate-500">
            {fileName}
          </div>
        ) : null}
      </div>
    </label>
  );
};

export default function Page() {
  const [falKeyInput, setFalKeyInput] = useState("");
  const [keySaved, setKeySaved] = useState(false);
  const keySaveTimeout = useRef<number | null>(null);
  const [selectedModelId, setSelectedModelId] = useState(DEFAULT_MODEL_ID);
  const [activeTab, setActiveTab] = useState<"video" | "image">("video");
  const [prompt, setPrompt] = useState("");
  const [duration, setDuration] = useState<string | number | undefined>();
  const [resolution, setResolution] = useState<string | undefined>();
  const [aspectRatio, setAspectRatio] = useState<string | undefined>();
  const [fps, setFps] = useState<number | undefined>();
  const [generateAudio, setGenerateAudio] = useState<boolean | undefined>(
    undefined
  );
  const [negativePrompt, setNegativePrompt] = useState<string>("");
  const [cfgScale, setCfgScale] = useState<number | undefined>(undefined);
  const [promptOptimizer, setPromptOptimizer] = useState<boolean | undefined>(
    undefined
  );
  const [startFile, setStartFile] = useState<File | null>(null);
  const [startPreview, setStartPreview] = useState<string | null>(null);
  const [endFile, setEndFile] = useState<File | null>(null);
  const [endPreview, setEndPreview] = useState<string | null>(null);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [downloadPath, setDownloadPath] = useState("downloads");
  const runningJobs = useRef(new Set<string>());
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    initFalFromLocalStorage();
    if (typeof window !== "undefined") {
      setFalKeyInput(localStorage.getItem("FAL_KEY") ?? "");
      setDownloadPath(localStorage.getItem("FREEFLOW_SAVE_PATH") ?? "downloads");
    }
    return () => {
      mountedRef.current = false;
      if (keySaveTimeout.current) {
        window.clearTimeout(keySaveTimeout.current);
      }
    };
  }, []);

  const selectedModel: ModelSpec | undefined = useMemo(
    () => MODEL_SPEC_MAP[selectedModelId],
    [selectedModelId]
  );

  const startParam = useMemo(() => {
    if (!selectedModel) return undefined;
    return Object.entries(selectedModel.params).find(
      ([, def]) => def?.uiKey === "start_frame_url"
    );
  }, [selectedModel]);

  const endParam = useMemo(() => {
    if (!selectedModel) return undefined;
    return Object.entries(selectedModel.params).find(
      ([, def]) => def?.uiKey === "end_frame_url"
    );
  }, [selectedModel]);

  useEffect(() => {
    if (!selectedModel) {
      return;
    }

    const durationDefault = selectedModel.params["duration"]?.default;
    if (
      typeof durationDefault === "string" ||
      typeof durationDefault === "number"
    ) {
      setDuration(durationDefault);
    } else {
      setDuration(undefined);
    }

    const resolutionDefault = selectedModel.params["resolution"]?.default;
    setResolution(
      typeof resolutionDefault === "string" ? resolutionDefault : undefined
    );

    const aspectDefault = selectedModel.params["aspect_ratio"]?.default;
    setAspectRatio(
      typeof aspectDefault === "string" ? aspectDefault : undefined
    );

    const fpsDefault = selectedModel.params["fps"]?.default;
    setFps(typeof fpsDefault === "number" ? fpsDefault : undefined);

    const audioDefault = selectedModel.params["generate_audio"]?.default;
    setGenerateAudio(
      typeof audioDefault === "boolean"
        ? audioDefault
        : isSupportEnabled(selectedModel.supports.audio)
          ? false
          : undefined
    );

    const negativeDefault = selectedModel.params["negative_prompt"]?.default;
    setNegativePrompt(
      typeof negativeDefault === "string" ? negativeDefault : ""
    );

    const cfgDefault = selectedModel.params["cfg_scale"]?.default;
    setCfgScale(typeof cfgDefault === "number" ? cfgDefault : undefined);

    const optimizerDefault = selectedModel.params["prompt_optimizer"]?.default;
    setPromptOptimizer(
      typeof optimizerDefault === "boolean" ? optimizerDefault : undefined
    );
  }, [selectedModel]);

  useEffect(() => {
    if (!startFile) {
      setStartPreview(null);
      return;
    }
    let isActive = true;
    readFilePreview(startFile)
      .then((preview) => {
        if (isActive) {
          setStartPreview(preview);
        }
      })
      .catch(() => {
        if (isActive) {
          setStartPreview(null);
        }
      });
    return () => {
      isActive = false;
    };
  }, [startFile]);

  useEffect(() => {
    if (!endFile) {
      setEndPreview(null);
      return;
    }
    let isActive = true;
    readFilePreview(endFile)
      .then((preview) => {
        if (isActive) {
          setEndPreview(preview);
        }
      })
      .catch(() => {
        if (isActive) {
          setEndPreview(null);
        }
      });
    return () => {
      isActive = false;
    };
  }, [endFile]);

  const handleFalKeyChange = (value: string) => {
    setFalKeyInput(value);
    if (typeof window === "undefined") return;
    if (keySaveTimeout.current) {
      window.clearTimeout(keySaveTimeout.current);
    }
    if (!value.trim()) {
      localStorage.removeItem("FAL_KEY");
      setKeySaved(false);
      return;
    }
    setFalKey(value);
    setKeySaved(true);
    keySaveTimeout.current = window.setTimeout(() => {
      setKeySaved(false);
    }, 2000);
  };

  const notifyJobUpdate = useCallback(
    (
      jobId: string,
      data: Partial<Job> | ((previous: Job) => Partial<Job>)
    ) => {
      setJobs((prev) =>
        prev.map((job) => {
          if (job.id !== jobId) return job;
          const patch =
            typeof data === "function" ? data(job) : data;
          return { ...job, ...patch };
        })
      );
    },
    []
  );

  const persistVideoAsset = useCallback(
    async (jobId: string, storageKey: string, videoUrl: string) => {
      try {
        const response = await fetch(videoUrl);
        if (!response.ok) {
          throw new Error(`Failed to fetch video (${response.status})`);
        }
        const blob = await response.blob();
        await saveVideo(storageKey, blob);
        notifyJobUpdate(jobId, {
          saving: false,
          saved: true,
          localKey: storageKey,
          saveError: undefined,
        });
      } catch (error) {
        notifyJobUpdate(jobId, {
          saving: false,
          saved: false,
          saveError:
            error instanceof Error
              ? error.message
              : "Unable to persist video locally.",
        });
      }
    },
    [notifyJobUpdate]
  );

  const startJobExecution = useCallback(
    async (job: Job) => {
      if (!job.payload) return;

      runningJobs.current.add(job.id);
      notifyJobUpdate(job.id, { status: "running", attempts: job.attempts + 1 });

      try {
        const result = await runFal(job.modelId, job.payload, (event) => {
          if (!event) return;
          const message =
            typeof event === "string"
              ? event
              : (event as { status?: string; message?: string }).status ??
                (event as { status?: string; message?: string }).message ??
                JSON.stringify(event);
          notifyJobUpdate(job.id, (prevJob) => ({
            events: [...prevJob.events, message],
          }));
        });

        const basePath = job.storagePath?.trim() || "downloads";
        const storageKey = `${
          basePath.replace(/\/+$/, "") || "downloads"
        }/${job.id}.mp4`;

        notifyJobUpdate(job.id, {
          status: "success",
          videoUrl: result.url,
          raw: result.raw,
          saving: true,
          localKey: storageKey,
        });

        persistVideoAsset(job.id, storageKey, result.url);
      } catch (error) {
        notifyJobUpdate(job.id, {
          status: "error",
          error:
            error instanceof Error ? error.message : "Generation failed.",
        });
      } finally {
        runningJobs.current.delete(job.id);
      }
    },
    [notifyJobUpdate, persistVideoAsset]
  );

  useEffect(() => {
    const running = runningJobs.current.size;
    if (running >= MAX_CONCURRENT_JOBS) {
      return;
    }

    const nextJob = jobs.find(
      (job) => job.status === "queued" && !runningJobs.current.has(job.id)
    );
    if (!nextJob) {
      return;
    }

    startJobExecution(nextJob);
  }, [jobs, startJobExecution]);

  const enqueueJob = useCallback(
    (jobId: string, payload: UnifiedPayload) => {
      setJobs((prev) =>
        prev.map((job) =>
          job.id === jobId
            ? {
                ...job,
                status: "queued",
                payload,
              }
            : job
        )
      );
    },
    []
  );

  const prepareJobPayload = useCallback(
    async (
      jobId: string,
      model: ModelSpec,
      basePayload: UnifiedPayload,
      start: File,
      end?: File | null
    ) => {
      const client = initFalFromLocalStorage();
      const startUpload = await client.storage.upload(start);
      const startUrl = extractUploadUrl(startUpload);
      if (!startUrl) {
        throw new Error("Unable to upload start frame.");
      }

      const payload: UnifiedPayload = {
        ...basePayload,
        start_frame_url: startUrl,
      };

      if (end && isSupportEnabled(model.supports.endFrame)) {
        const endUpload = await client.storage.upload(end);
        const endUrl = extractUploadUrl(endUpload);
        if (!endUrl) {
          throw new Error("Unable to upload end frame.");
        }
        payload.end_frame_url = endUrl;
      }

      enqueueJob(jobId, payload);
    },
    [enqueueJob]
  );

  const handleGenerate = async () => {
    const model = selectedModel;
    if (!model) {
      window.alert("Please select a model.");
      return;
    }
    if (!falKeyInput.trim()) {
      window.alert("Please provide your FAL API key.");
      return;
    }
    if (!prompt.trim()) {
      window.alert("Please describe your video prompt.");
      return;
    }
    if (!startFile) {
      window.alert("Start frame is required.");
      return;
    }
    if (isSupportEnabled(model.supports.endFrame)) {
      if (endParam?.[1]?.required && !endFile) {
        window.alert("This model requires an end frame.");
        return;
      }
    }

    const jobId = createId("job");
    const basePayload: UnifiedPayload = {
      modelId: model.id,
      prompt: prompt.trim(),
      start_frame_url: "",
      end_frame_url: undefined,
      duration,
      aspect_ratio: aspectRatio,
      resolution,
      fps,
      generate_audio: isSupportEnabled(model.supports.audio)
        ? generateAudio
        : undefined,
      negative_prompt: negativePrompt || undefined,
      cfg_scale: cfgScale,
      prompt_optimizer: promptOptimizer,
    };

    setJobs((prev) => [
      {
        id: jobId,
        modelId: model.id,
        prompt: basePayload.prompt,
        status: "uploading",
        createdAt: Date.now(),
        attempts: 0,
        preview: startPreview,
        payload: undefined,
        events: [],
        storagePath: downloadPath.trim() || "downloads",
        saving: false,
        saved: false,
      },
      ...prev,
    ]);

    try {
      await prepareJobPayload(jobId, model, basePayload, startFile, endFile);
    } catch (error) {
      notifyJobUpdate(jobId, {
        status: "error",
        error: error instanceof Error ? error.message : "Upload failed.",
      });
    }
  };

  const handleRetry = (job: Job) => {
    if (!job.payload) return;
    notifyJobUpdate(job.id, { status: "queued", error: undefined });
  };

  const controlSections = useMemo(() => {
    if (!selectedModel) return [];
    const entries = Object.entries(selectedModel.params);
    const skipKeys = new Set([
      "prompt",
      startParam?.[0],
      endParam?.[0],
    ]);
    return entries.filter(
      ([key, definition]) => !skipKeys.has(key) && Boolean(definition)
    );
  }, [selectedModel, startParam, endParam]);

  const handleDownload = useCallback(
    async (job: Job) => {
      if (!job.videoUrl) return;
      try {
        let blob: Blob | undefined;
        if (job.localKey) {
          blob = await getVideo(job.localKey);
        }
        if (!blob) {
          const response = await fetch(job.videoUrl);
          if (!response.ok) {
            throw new Error(`Failed to fetch video (${response.status})`);
          }
          blob = await response.blob();
        }
        const url = URL.createObjectURL(blob);
        const anchor = document.createElement("a");
        const filename =
          job.localKey?.split("/").pop() ??
          `${job.modelId}-${job.id}.mp4`;
        anchor.href = url;
        anchor.download = filename;
        document.body.appendChild(anchor);
        anchor.click();
        document.body.removeChild(anchor);
        URL.revokeObjectURL(url);
      } catch (error) {
        window.alert(
          error instanceof Error
            ? error.message
            : "Unable to download video."
        );
      }
    },
    []
  );

  const renderControl = (key: string, def?: ParamDefinition) => {
    if (!def) return null;
    if (!selectedModel) return null;
    const uiKey = def.uiKey ?? (key as keyof UnifiedPayload);

    if (def.type === "enum" && def.values) {
      const handleChange = (value: string) => {
        if (uiKey === "duration") {
          const parsed =
            def.values?.[0] && typeof def.values[0] === "number"
              ? Number(value)
              : value;
          setDuration(parsed as string | number | undefined);
        }
        if (uiKey === "aspect_ratio") setAspectRatio(value);
        if (uiKey === "resolution") setResolution(value);
        if (uiKey === "fps") setFps(Number(value));
      };

      const currentValue =
        uiKey === "duration"
          ? duration
          : uiKey === "aspect_ratio"
            ? aspectRatio
            : uiKey === "resolution"
              ? resolution
              : uiKey === "fps"
                ? fps
                : undefined;

      return (
        <div key={key} className="flex flex-col gap-1.5">
          <label className="text-xs font-semibold uppercase tracking-wide text-slate-400">
            {key.replace(/_/g, " ")}
          </label>
          <select
            value={currentValue !== undefined ? String(currentValue) : ""}
            onChange={(event) => handleChange(event.target.value)}
            className="rounded-2xl border border-white/10 bg-white/5 px-3 py-2 text-sm text-white outline-none transition focus:border-sky-400 focus:ring-1 focus:ring-sky-400"
          >
            <option value="" disabled>
              Select
            </option>
            {def.values.map((value) => (
              <option key={String(value)} value={String(value)}>
                {String(value)}
              </option>
            ))}
          </select>
        </div>
      );
    }

    if (key === "negative_prompt") {
      return (
        <div key={key} className="flex flex-col gap-1.5">
          <label className="text-xs font-semibold uppercase tracking-wide text-slate-400">
            Negative Prompt
          </label>
          <input
            type="text"
            value={negativePrompt}
            onChange={(event) => setNegativePrompt(event.target.value)}
            className="rounded-2xl border border-white/10 bg-white/5 px-3 py-2 text-sm text-white outline-none transition focus:border-sky-400 focus:ring-1 focus:ring-sky-400"
          />
        </div>
      );
    }

    if (key === "cfg_scale") {
      return (
        <div key={key} className="flex flex-col gap-1.5">
          <label className="text-xs font-semibold uppercase tracking-wide text-slate-400">
            CFG Scale
          </label>
          <input
            type="number"
            step="0.1"
            value={cfgScale ?? ""}
            onChange={(event) =>
              setCfgScale(
                event.target.value === ""
                  ? undefined
                  : Number.parseFloat(event.target.value)
              )
            }
            className="rounded-2xl border border-white/10 bg-white/5 px-3 py-2 text-sm text-white outline-none transition focus:border-sky-400 focus:ring-1 focus:ring-sky-400"
          />
        </div>
      );
    }

    if (
      key === "generate_audio" &&
      isSupportEnabled(selectedModel?.supports.audio ?? false)
    ) {
      return (
        <div
          key={key}
          className="flex items-center justify-between rounded-2xl border border-white/10 bg-white/5 px-4 py-3"
        >
          <div>
            <div className="text-sm font-semibold text-slate-200">
              Generate audio
            </div>
            <div className="text-xs text-slate-500">
              Auto soundtrack where supported
            </div>
          </div>
          <button
            type="button"
            onClick={() => setGenerateAudio((prev) => !prev)}
            className={`relative inline-flex h-6 w-11 items-center rounded-full transition ${
              generateAudio ? "bg-sky-500" : "bg-slate-700"
            }`}
          >
            <span
              className={`inline-block h-4 w-4 transform rounded-full bg-white transition ${
                generateAudio ? "translate-x-5" : "translate-x-1"
              }`}
            />
          </button>
        </div>
      );
    }

    if (key === "prompt_optimizer") {
      return (
        <div
          key={key}
          className="flex items-center justify-between rounded-2xl border border-white/10 bg-white/5 px-4 py-3"
        >
          <div>
            <div className="text-sm font-semibold text-slate-200">
              Prompt optimizer
            </div>
            <div className="text-xs text-slate-500">
              Let the model enhance prompts automatically
            </div>
          </div>
          <button
            type="button"
            onClick={() => setPromptOptimizer((prev) => !prev)}
            className={`relative inline-flex h-6 w-11 items-center rounded-full transition ${
              promptOptimizer ? "bg-sky-500" : "bg-slate-700"
            }`}
          >
            <span
              className={`inline-block h-4 w-4 transform rounded-full bg-white transition ${
                promptOptimizer ? "translate-x-5" : "translate-x-1"
              }`}
            />
          </button>
        </div>
      );
    }

    return null;
  };

  return (
    <div className="relative min-h-screen overflow-hidden">
      <div className="pointer-events-none absolute inset-0 opacity-80">
        <div className="absolute -left-24 top-24 h-80 w-80 rounded-full bg-sky-500/25 blur-[160px]" />
        <div className="absolute right-[-160px] top-32 h-[420px] w-[420px] rounded-full bg-indigo-500/25 blur-[190px]" />
        <div className="absolute left-1/3 bottom-[-200px] h-[480px] w-[480px] rounded-full bg-emerald-400/15 blur-[220px]" />
      </div>
      <div className="relative z-10 flex min-h-screen flex-col">
        <header className="mx-auto w-full max-w-7xl px-6 pt-12">
          <div className="glass-surface divider-gradient flex flex-col gap-4 px-6 py-6 transition duration-300 hover:shadow-[0_22px_120px_rgba(56,189,248,0.18)] sm:flex-row sm:items-center sm:justify-between">
            <div>
              <span className="inline-flex items-center gap-2 rounded-full bg-sky-500/10 px-3 py-1 text-xs font-semibold text-sky-300">
                <span className="h-2 w-2 rounded-full bg-sky-300 animate-pulse" />
                Live render queue
              </span>
              <h1 className="mt-3 text-2xl font-semibold text-white sm:text-3xl">
                Freeflow Creative Studio
              </h1>
              <p className="mt-1 text-sm text-slate-400">
                Craft cinematic motion or refined edits with instant FAL pipelines.
              </p>
            </div>
            <div className="flex flex-col gap-4 sm:flex-row sm:items-center">
              <div className="flex items-center gap-2 rounded-full border border-white/10 bg-white/5 p-1">
                <button
                  type="button"
                  onClick={() => setActiveTab("video")}
                  className={`rounded-full px-4 py-1 text-sm font-medium transition ${
                    activeTab === "video"
                      ? "bg-sky-500 text-white shadow-md shadow-sky-500/40"
                      : "text-slate-300 hover:text-white"
                  }`}
                >
                  Video
                </button>
                <button
                  type="button"
                  onClick={() => setActiveTab("image")}
                  className={`rounded-full px-4 py-1 text-sm font-medium transition ${
                    activeTab === "image"
                      ? "bg-sky-500 text-white shadow-md shadow-sky-500/40"
                      : "text-slate-300 hover:text-white"
                  }`}
                >
                  Image
                </button>
              </div>
              <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                <input
                  type="password"
                  value={falKeyInput}
                  onChange={(event) => handleFalKeyChange(event.target.value)}
                  placeholder="FAL API Key"
                  className="w-full rounded-2xl border border-white/10 bg-white/5 px-4 py-2 text-sm text-white outline-none transition focus:border-sky-400 focus:ring-1 focus:ring-sky-400 sm:w-64"
                />
                <button
                  type="button"
                  onClick={() => handleFalKeyChange(falKeyInput)}
                  className="rounded-2xl bg-sky-500 px-5 py-2 text-sm font-semibold text-white shadow-md shadow-sky-500/30 transition duration-200 hover:-translate-y-0.5 hover:bg-sky-400"
                >
                  Save
                </button>
                {keySaved ? (
                  <span className="text-xs font-medium text-emerald-400">
                    Saved
                  </span>
                ) : null}
              </div>
            </div>
          </div>
        </header>

        <main className="mx-auto w-full max-w-7xl flex-1 px-6 pb-16">
          {activeTab === "video" ? (
            <div className="flex flex-1 flex-col gap-8 lg:flex-row lg:items-start">
              <section className="glass-surface relative w-full max-w-md flex-shrink-0 overflow-hidden px-6 py-8">
                <div className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-white/40 to-transparent" />
                <div className="pointer-events-none absolute right-6 top-6 h-36 w-36 rounded-full bg-sky-500/15 blur-3xl" />
                <div className="space-y-3">
                  <div className="text-xs font-semibold uppercase tracking-widest text-slate-400">
                    Generator
                  </div>
                  <h2 className="text-2xl font-semibold text-white">
                    Compose your clip
                  </h2>
                  <p className="text-sm text-slate-400">
                    Prompt, reference frames, and parameters unify across all supported video endpoints.
                  </p>
                </div>

                <div className="mt-6 space-y-3">
                  <label className="text-xs font-semibold uppercase tracking-wide text-slate-400">
                    Model
                  </label>
                  <select
                    value={selectedModelId}
                    onChange={(event) => setSelectedModelId(event.target.value)}
                    className="w-full rounded-2xl border border-white/10 bg-white/5 px-3 py-2 text-sm text-white outline-none transition focus:border-sky-400 focus:ring-1 focus:ring-sky-400"
                  >
                    {MODEL_SPECS.map((model) => (
                      <option key={model.id} value={model.id}>
                        {model.label ?? model.id}
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
                    placeholder="Describe motion, subject, camera, lighting…"
                    className="w-full rounded-2xl border border-white/10 bg-white/5 px-4 py-3 text-sm text-white outline-none transition focus:border-sky-400 focus:ring-1 focus:ring-sky-400"
                  />
                </div>

                <div className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-2">
                  <DropZone
                    label="Start frame"
                    required={Boolean(startParam?.[1]?.required)}
                    fileName={startFile?.name}
                    previewUrl={startPreview}
                    onFileSelected={setStartFile}
                  />
                  {isSupportEnabled(selectedModel?.supports.endFrame ?? false) ? (
                    <DropZone
                      label="End frame"
                      required={Boolean(endParam?.[1]?.required)}
                      fileName={endFile?.name}
                      previewUrl={endPreview}
                      onFileSelected={setEndFile}
                    />
                  ) : (
                    <div className="flex h-full items-center justify-center rounded-2xl border border-dashed border-white/10 bg-white/5 px-4 text-center text-xs text-slate-500">
                      End frame not supported
                    </div>
                  )}
                </div>

                <div className="mt-6 grid grid-cols-1 gap-4 md:grid-cols-2">
                  {controlSections.map(([key, definition]) =>
                    renderControl(key, definition)
                  )}
                </div>

                <div className="mt-6 flex flex-col gap-2">
                  <label className="text-xs font-semibold uppercase tracking-wide text-slate-400">
                    Internal save path
                  </label>
                  <input
                    type="text"
                    value={downloadPath}
                    onChange={(event) => {
                      const nextValue = event.target.value;
                      setDownloadPath(nextValue);
                      if (typeof window !== "undefined") {
                        localStorage.setItem(
                          "FREEFLOW_SAVE_PATH",
                          nextValue || "downloads"
                        );
                      }
                    }}
                    placeholder="downloads"
                    className="rounded-2xl border border-white/10 bg-white/5 px-3 py-2 text-sm text-white outline-none transition focus:border-sky-400 focus:ring-1 focus:ring-sky-400"
                  />
                  <p className="text-xs text-slate-500">
                    Stored locally within browser IndexedDB under this virtual folder.
                  </p>
                </div>

                <button
                  type="button"
                  onClick={handleGenerate}
                  className="mt-8 w-full rounded-2xl bg-gradient-to-r from-sky-500 via-blue-500 to-indigo-500 py-3 text-sm font-semibold text-white shadow-lg shadow-sky-500/25 transition duration-200 hover:-translate-y-0.5 hover:shadow-[0_24px_80px_rgba(59,130,246,0.35)]"
                >
                  Generate
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
                      Active queue
                    </div>
                  </div>
                  <div className="rounded-full bg-white/5 px-3 py-1 text-xs font-semibold text-slate-300">
                    {jobs.length} total
                  </div>
                </div>
                <div className="fade-mask flex max-h-[calc(100vh-240px)] flex-col gap-4 overflow-y-auto pr-2">
                  {jobs.length === 0 ? (
                    <div className="rounded-2xl border border-white/5 bg-white/5 px-5 py-6 text-sm text-slate-400">
                      Your renders will appear here with live queue events and downloadable assets.
                    </div>
                  ) : (
                    jobs.map((job) => (
                      <div
                        key={job.id}
                        className="relative flex flex-col gap-4 rounded-2xl border border-white/5 bg-white/10/5 px-4 py-4 backdrop-blur-xl transition duration-200 hover:-translate-y-1 hover:shadow-[0_24px_80px_rgba(30,64,175,0.18)]"
                      >
                        <div className="flex items-center justify-between">
                          <div>
                            <div className="text-sm font-semibold text-white">
                              {job.modelId}
                            </div>
                            <div className="text-xs text-slate-500">
                              {new Date(job.createdAt).toLocaleTimeString()}
                            </div>
                          </div>
                          <span
                            className={`rounded-full px-3 py-1 text-xs font-semibold ${
                              job.status === "success"
                                ? "bg-emerald-500/20 text-emerald-300"
                                : job.status === "error"
                                  ? "bg-rose-500/20 text-rose-300"
                                  : job.status === "running"
                                    ? "bg-sky-500/20 text-sky-200"
                                    : "bg-white/10 text-slate-300"
                            }`}
                          >
                            {job.status}
                          </span>
                        </div>
                        <div className="rounded-2xl border border-white/5 bg-white/5 px-4 py-3 text-xs text-slate-300">
                          {job.prompt}
                        </div>
                        {job.videoUrl ? (
                          <video
                            src={job.videoUrl}
                            controls
                            className="w-full rounded-2xl border border-white/5"
                          />
                        ) : job.preview ? (
                          <img
                            src={job.preview}
                            alt="Start preview"
                            className="w-full rounded-2xl border border-white/5 object-cover"
                          />
                        ) : null}

                        {job.status === "error" ? (
                          <div className="rounded-2xl border border-rose-400/30 bg-rose-500/10 px-4 py-3 text-sm text-rose-200">
                            {job.error ?? "Something went wrong."}
                          </div>
                        ) : null}

                        {job.events.length > 0 ? (
                          <div className="space-y-2 rounded-2xl border border-white/5 bg-white/5 px-3 py-3">
                            <div className="text-xs font-semibold uppercase tracking-wide text-slate-400">
                              Queue events
                            </div>
                            <ul className="space-y-1 text-xs text-slate-400">
                              {job.events.slice(-4).map((event, index) => (
                                <li key={`${job.id}-event-${index}`}>
                                  {event}
                                </li>
                              ))}
                            </ul>
                          </div>
                        ) : null}

                        {job.status === "success" && job.videoUrl ? (
                          <div className="flex flex-col gap-2">
                            <div className="flex flex-wrap items-center gap-3">
                              <a
                                href={job.videoUrl}
                                target="_blank"
                                rel="noreferrer"
                                className="text-sm font-semibold text-sky-300 transition hover:text-sky-200"
                              >
                                Open in new tab
                              </a>
                              <button
                                type="button"
                                onClick={() => handleDownload(job)}
                                className="rounded-full border border-white/10 bg-white/5 px-3 py-1 text-xs font-semibold text-slate-200 transition hover:border-sky-400 hover:text-sky-200"
                              >
                                Download
                              </button>
                            </div>
                            <div className="text-xs text-slate-500">
                              {job.saving
                                ? "Saving to internal storage…"
                                : job.saved && job.localKey
                                  ? `Stored at: ${job.localKey}`
                                  : job.saveError
                                    ? `Save failed: ${job.saveError}`
                                    : job.localKey
                                      ? `Saving scheduled for: ${job.localKey}`
                                      : null}
                            </div>
                          </div>
                        ) : null}

                        {job.status === "error" && job.payload ? (
                          <button
                            type="button"
                            onClick={() => handleRetry(job)}
                            className="text-sm font-semibold text-sky-300 transition hover:text-sky-200"
                          >
                            Retry
                          </button>
                        ) : null}
                      </div>
                    ))
                  )}
                </div>
              </aside>
            </div>
          ) : (
            <ImageTab />
          )}
        </main>
      </div>
    </div>
  );
}

function isSupportEnabled(
  flag: boolean | "unstable" | "unspecified" | undefined
) {
  return flag === true;
}
