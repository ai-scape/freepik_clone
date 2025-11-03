import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { ReactElement } from "react";
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
import { arrayBufferToBase64 } from "../lib/file-utils";
import { formatCompactTimestamp } from "../lib/time";
import { getModelPricingLabel } from "../lib/pricing";
import ImageTab from "../components/ImageTab";
import { Spinner } from "../components/ui/Spinner";

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
  localUrl?: string;
  saving?: boolean;
  saved?: boolean;
  saveError?: string;
};

const MAX_CONCURRENT_JOBS = 2;

const STATUS_META: Record<
  JobStatus,
  {
    label: string;
    chip: string;
  }
> = {
  uploading: {
    label: "Uploading assets",
    chip: "bg-sky-500/20 text-sky-200 animate-pulse",
  },
  queued: {
    label: "Queued",
    chip: "bg-white/10 text-slate-300",
  },
  running: {
    label: "Rendering",
    chip: "bg-blue-500/20 text-blue-200 animate-pulse",
  },
  success: {
    label: "Ready",
    chip: "bg-emerald-500/20 text-emerald-200",
  },
  error: {
    label: "Failed",
    chip: "bg-rose-500/20 text-rose-200",
  },
};

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

const VIDEO_JOBS_STORAGE_KEY = "video-job-history";

type StoredJobRecord = {
  id?: string;
  modelId?: string;
  prompt?: string;
  createdAt?: number;
  preview?: string | null;
  events?: unknown[];
  localKey?: string;
  localUrl?: string;
  storagePath?: string;
};

function sanitizeFileSegment(value: string) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

function buildVideoFileName(job: Pick<Job, "id" | "modelId" | "createdAt" | "storagePath">) {
  const baseSegment =
    sanitizeFileSegment(job.storagePath || "downloads") || "downloads";
  const modelSegment = sanitizeFileSegment(job.modelId) || "model";
  const stamp = formatCompactTimestamp(new Date(job.createdAt));
  const idSegment =
    sanitizeFileSegment(job.id).slice(-6) || job.id.slice(-6);
  return `${baseSegment}-${modelSegment}-${stamp}-${idSegment}.mp4`;
}

function loadStoredJobs(): Job[] {
  if (typeof window === "undefined") return [];
  const raw = window.localStorage.getItem(VIDEO_JOBS_STORAGE_KEY);
  if (!raw) return [];
  try {
    const data = JSON.parse(raw) as StoredJobRecord[];
    if (!Array.isArray(data)) return [];
    return data
      .map((entry) => {
        if (!entry || typeof entry !== "object") return null;
        const localUrl =
          typeof entry.localUrl === "string" ? entry.localUrl : undefined;
        const localKey =
          typeof entry.localKey === "string" ? entry.localKey : undefined;
        if (!localUrl || !localKey) return null;
        const id =
          typeof entry.id === "string" ? entry.id : createId("job");
        const createdAt =
          typeof entry.createdAt === "number"
            ? entry.createdAt
            : Date.now();
        const modelId =
          typeof entry.modelId === "string"
            ? entry.modelId
            : DEFAULT_MODEL_ID;
        const prompt =
          typeof entry.prompt === "string" ? entry.prompt : "";
        const preview =
          typeof entry.preview === "string" ? entry.preview : null;
        const events = Array.isArray(entry.events)
          ? entry.events
              .map((event) =>
                typeof event === "string" ? event : JSON.stringify(event)
              )
              .slice(-10)
          : [];
        const storagePath =
          typeof entry.storagePath === "string"
            ? entry.storagePath
            : "downloads";
        return {
          id,
          modelId,
          prompt,
          status: "success" as JobStatus,
          createdAt,
          attempts: 1,
          payload: undefined,
          videoUrl: localUrl,
          raw: undefined,
          preview,
          events,
          storagePath,
          localKey,
          localUrl,
          saving: false,
          saved: true,
          saveError: undefined,
        };
      })
      .filter((job): job is Job => Boolean(job));
  } catch {
    return [];
  }
}

function persistStoredJobs(jobs: Job[]) {
  if (typeof window === "undefined") return;
  try {
    const completed = jobs.filter(
      (job) => job.status === "success" && job.localKey && job.localUrl
    );
    if (!completed.length) {
      window.localStorage.removeItem(VIDEO_JOBS_STORAGE_KEY);
      return;
    }
    const payload = completed.map((job) => ({
      id: job.id,
      modelId: job.modelId,
      prompt: job.prompt,
      createdAt: job.createdAt,
      preview: job.preview ?? null,
      events: job.events.slice(-10),
      localKey: job.localKey,
      localUrl: job.localUrl,
      storagePath: job.storagePath,
    }));
    window.localStorage.setItem(
      VIDEO_JOBS_STORAGE_KEY,
      JSON.stringify(payload)
    );
  } catch {
    // Ignore persistence errors
  }
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
  "group relative flex h-28 w-full flex-col items-center justify-center gap-1 rounded-lg border border-white/10 bg-white/5 px-3 text-center transition duration-300 hover:border-sky-400/60 hover:bg-white/10";

const primaryActionButton =
  "w-full rounded-xl bg-gradient-to-r from-sky-500 via-blue-500 to-indigo-500 py-2 text-sm font-semibold text-white shadow-lg shadow-sky-500/25 transition duration-200 hover:-translate-y-0.5 hover:shadow-[0_24px_80px_rgba(59,130,246,0.35)]";

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
      <span className="pointer-events-none absolute inset-0 rounded-lg bg-gradient-to-br from-white/8 via-transparent to-transparent opacity-0 transition duration-300 group-hover:opacity-100" />
      <span className="pointer-events-none absolute inset-0 overflow-hidden rounded-lg opacity-0 transition duration-300 group-hover:opacity-100">
        <span className="absolute inset-0 -translate-x-full bg-gradient-to-r from-transparent via-white/35 to-transparent animate-shimmer" />
      </span>
      <div className="flex h-full w-full flex-col items-center gap-2">
        <div className="text-sm font-semibold uppercase tracking-wide text-slate-200">
          {label}
          {required ? " *" : ""}
        </div>
        {previewUrl ? (
          <div className="relative h-full w-full overflow-hidden rounded-md border border-white/10 bg-black/40">
            <img
              src={previewUrl}
              alt={`${label} preview`}
              className="absolute inset-0 h-full w-full object-cover"
            />
          </div>
        ) : (
          <div className="flex h-full w-full items-center justify-center px-2 text-[11px] text-slate-400">
            Drag & drop or click to upload
          </div>
        )}
        {fileName ? (
          <div className="max-w-full truncate text-[11px] text-slate-500">
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
  const [pendingUploads, setPendingUploads] = useState(0);
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
  const jobsInitializedRef = useRef(false);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    initFalFromLocalStorage();
    if (typeof window !== "undefined") {
      setFalKeyInput(localStorage.getItem("FAL_KEY") ?? "");
      setDownloadPath(localStorage.getItem("FREEFLOW_SAVE_PATH") ?? "downloads");
      const storedJobs = loadStoredJobs();
      if (storedJobs.length) {
        setJobs(storedJobs);
      }
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

  const selectedModelPricing = useMemo(
    () => getModelPricingLabel(selectedModelId),
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

  useEffect(() => {
    if (!jobsInitializedRef.current) {
      jobsInitializedRef.current = true;
      return;
    }
    persistStoredJobs(jobs);
  }, [jobs]);

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
    async (jobId: string, fileName: string, videoUrl: string) => {
      try {
        const response = await fetch(videoUrl);
        if (!response.ok) {
          throw new Error(`Failed to fetch video (${response.status})`);
        }
        const blob = await response.blob();
        const arrayBuffer = await blob.arrayBuffer();
        const base64 = arrayBufferToBase64(arrayBuffer);
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
          throw new Error("Failed to persist video locally.");
        }
        const localUrl = `/assets/${encodeURIComponent(fileName)}`;
        notifyJobUpdate(jobId, {
          saving: false,
          saved: true,
          localKey: fileName,
          localUrl,
          videoUrl: localUrl,
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

        const fileName = buildVideoFileName({
          id: job.id,
          modelId: job.modelId,
          createdAt: job.createdAt,
          storagePath: job.storagePath,
        });

        notifyJobUpdate(job.id, {
          status: "success",
          videoUrl: result.url,
          raw: result.raw,
          saving: true,
          saved: false,
          localKey: fileName,
          localUrl: undefined,
          saveError: undefined,
        });

        await persistVideoAsset(job.id, fileName, result.url);
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

    setPendingUploads((count) => count + 1);
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
    } finally {
      setPendingUploads((count) => Math.max(0, count - 1));
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
      const sourceUrl = job.localUrl ?? job.videoUrl;
      if (!sourceUrl) return;
      try {
        const response = await fetch(sourceUrl);
        if (!response.ok) {
          throw new Error(`Failed to fetch video (${response.status})`);
        }
        const blob = await response.blob();
        const url = URL.createObjectURL(blob);
        const anchor = document.createElement("a");
        const fallbackName = `${sanitizeFileSegment(job.modelId) || "video"}-${formatCompactTimestamp(new Date(job.createdAt))}.mp4`;
        const filename = job.localKey ?? fallbackName;
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

  const renderControl = useCallback(
    (key: string, def?: ParamDefinition) => {
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
        <div
          key={key}
          className="flex flex-col gap-1 rounded-lg border border-white/10 bg-white/5 px-2 py-2 text-xs"
        >
          <span className="text-[11px] font-semibold uppercase tracking-wide text-slate-300">
            {key.replace(/_/g, " ")}
          </span>
          <select
            value={currentValue !== undefined ? String(currentValue) : ""}
            onChange={(event) => handleChange(event.target.value)}
            className="h-8 w-full rounded-md border border-white/10 bg-black/30 px-2 text-xs text-white outline-none transition focus:border-sky-400 focus:ring-1 focus:ring-sky-400"
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
        <div
          key={key}
          className="flex flex-col gap-1 rounded-lg border border-white/10 bg-white/5 px-2 py-2 text-xs"
        >
          <span className="text-[11px] font-semibold uppercase tracking-wide text-slate-300">
            Negative prompt
          </span>
          <input
            type="text"
            value={negativePrompt}
            onChange={(event) => setNegativePrompt(event.target.value)}
            className="h-8 w-full rounded-md border border-white/10 bg-black/30 px-2 text-xs text-white outline-none transition focus:border-sky-400 focus:ring-1 focus:ring-sky-400"
          />
        </div>
      );
    }

    if (key === "cfg_scale") {
      return (
        <div
          key={key}
          className="flex flex-col gap-1 rounded-lg border border-white/10 bg-white/5 px-2 py-2 text-xs"
        >
          <span className="text-[11px] font-semibold uppercase tracking-wide text-slate-300">
            CFG scale
          </span>
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
            className="h-8 w-full rounded-md border border-white/10 bg-black/30 px-2 text-xs text-white outline-none transition focus:border-sky-400 focus:ring-1 focus:ring-sky-400"
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
          className="flex items-center justify-between rounded-lg border border-white/10 bg-white/5 px-2.5 py-2 text-xs"
        >
          <div className="flex flex-col gap-0.5">
            <span className="text-[11px] font-semibold uppercase tracking-wide text-slate-300">
              Generate audio
            </span>
            <span className="text-[10px] text-slate-500">
              Auto soundtrack where supported
            </span>
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
          className="flex items-center justify-between rounded-lg border border-white/10 bg-white/5 px-2.5 py-2 text-xs"
        >
          <div className="flex flex-col gap-0.5">
            <span className="text-[11px] font-semibold uppercase tracking-wide text-slate-300">
              Prompt optimizer
            </span>
            <span className="text-[10px] text-slate-500">
              Let the model enhance prompts automatically
            </span>
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
    },
    [
      selectedModel,
      duration,
      aspectRatio,
      resolution,
      fps,
      negativePrompt,
      cfgScale,
      generateAudio,
      promptOptimizer,
    ]
  );

  const controlMap = useMemo(
    () => Object.fromEntries(controlSections),
    [controlSections]
  );

  const primaryKeys: Array<keyof UnifiedPayload> = useMemo(
    () => ["duration", "resolution", "aspect_ratio"],
    []
  );

  const primaryControls = useMemo(
    () =>
      primaryKeys
        .map((key) => renderControl(key as string, controlMap[key as string]))
        .filter((control): control is ReactElement => Boolean(control)),
    [primaryKeys, controlMap, renderControl]
  );

  const secondaryControls = useMemo(
    () =>
      controlSections
        .filter(([key]) => !primaryKeys.includes(key as keyof UnifiedPayload))
        .map(([key, def]) => renderControl(key, def))
        .filter((control): control is ReactElement => Boolean(control)),
    [controlSections, primaryKeys, renderControl]
  );

  return (
    <div className="relative min-h-screen overflow-hidden">
      <div className="pointer-events-none absolute inset-0 opacity-80">
        <div className="absolute -left-24 top-24 h-80 w-80 rounded-full bg-sky-500/25 blur-[160px]" />
        <div className="absolute right-[-160px] top-32 h-[420px] w-[420px] rounded-full bg-indigo-500/25 blur-[190px]" />
        <div className="absolute left-1/3 bottom-[-200px] h-[480px] w-[480px] rounded-full bg-emerald-400/15 blur-[220px]" />
      </div>
      <div className="relative z-10 flex min-h-screen flex-col">
        <header className="mx-auto w-full max-w-5xl px-3 pt-4">
          <div className="glass-surface flex flex-col gap-2 rounded-2xl border border-white/10 bg-black/30 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-center gap-3">
              <span className="text-base font-semibold text-white">Generator</span>
              <span className="rounded-full border border-white/10 bg-white/5 px-2 py-0.5 text-[11px] text-slate-300">
                {jobs.length} jobs
              </span>
            </div>
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
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
                  className="w-full rounded-xl border border-white/10 bg-white/5 px-4 py-2 text-sm text-white outline-none transition focus:border-sky-400 focus:ring-1 focus:ring-sky-400 sm:w-64"
                />
                <button
                  type="button"
                  onClick={() => handleFalKeyChange(falKeyInput)}
                  className="rounded-xl bg-sky-500 px-4 py-1.5 text-sm font-semibold text-white shadow-md shadow-sky-500/30 transition duration-200 hover:-translate-y-0.5 hover:bg-sky-400"
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

        <main className="mx-auto w-full max-w-5xl flex-1 px-3 pb-6">
          {activeTab === "video" ? (
            <div className="flex flex-1 flex-col gap-4 lg:flex-row lg:items-start">
              <section className="glass-surface relative flex w-full max-w-xs flex-shrink-0 flex-col overflow-hidden px-3.5 py-3.5">
                <div className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-white/40 to-transparent" />
                <div className="flex h-full flex-col gap-3">
                  <div className="flex items-center justify-between rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-xs text-slate-200">
                    <span className="font-semibold uppercase tracking-wide">Mode</span>
                    <select
                      value={selectedModelId}
                      onChange={(event) => setSelectedModelId(event.target.value)}
                      className="h-8 rounded-md border border-white/10 bg-black/30 px-2 text-xs text-white outline-none transition focus:border-sky-400 focus:ring-1 focus:ring-sky-400"
                    >
                      {MODEL_SPECS.map((model) => (
                        <option key={model.id} value={model.id}>
                          {model.label ?? model.id}
                        </option>
                      ))}
                    </select>
                  </div>

                  <div className="grid grid-cols-2 gap-2">
                    <DropZone
                      label="Start"
                      required={Boolean(startParam?.[1]?.required)}
                      fileName={startFile?.name}
                      previewUrl={startPreview}
                      onFileSelected={setStartFile}
                    />
                    {isSupportEnabled(selectedModel?.supports.endFrame ?? false) ? (
                      <DropZone
                        label="End"
                        required={Boolean(endParam?.[1]?.required)}
                        fileName={endFile?.name}
                        previewUrl={endPreview}
                        onFileSelected={setEndFile}
                      />
                    ) : (
                      <div className="flex h-28 items-center justify-center rounded-lg border border-dashed border-white/10 bg-white/5 px-2 text-center text-[11px] text-slate-400">
                        End frame off
                      </div>
                    )}
                  </div>

                  <div className="rounded-lg border border-white/10 bg-white/5 px-3 py-3">
                    <textarea
                      value={prompt}
                      onChange={(event) => setPrompt(event.target.value)}
                      rows={3}
                      placeholder="Describe or upload frames"
                      className="w-full resize-none rounded-md border border-white/10 bg-black/30 px-2 py-2 text-sm text-white outline-none transition focus:border-sky-400 focus:ring-1 focus:ring-sky-400"
                    />
                  </div>

                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={handleGenerate}
                      className={`${primaryActionButton} flex-1 ${
                        pendingUploads > 0 ? "opacity-60" : ""
                      }`}
                      disabled={pendingUploads > 0}
                    >
                      <span className="flex items-center justify-center gap-2">
                        {pendingUploads > 0 && <Spinner size="sm" />}
                        {pendingUploads > 0 ? "Uploading…" : "Generate"}
                      </span>
                    </button>
                    {selectedModelPricing ? (
                      <span className="whitespace-nowrap rounded-full border border-white/10 bg-white/5 px-3 py-1 text-[11px] font-semibold text-slate-200">
                        {selectedModelPricing}
                      </span>
                    ) : null}
                  </div>

                  <div className="flex-1 overflow-y-auto pr-1">
                    {primaryControls.length > 0 ? (
                      <div className="grid grid-cols-3 gap-2">
                        {primaryControls.map((control) => control)}
                      </div>
                    ) : null}

                    {secondaryControls.length > 0 ? (
                      <div className="mt-2 grid grid-cols-1 gap-2">
                        {secondaryControls.map((control) => control)}
                      </div>
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
                      Active queue
                    </div>
                  </div>
                  <div className="rounded-full bg-white/5 px-3 py-1 text-[11px] font-semibold text-slate-300 sm:text-xs">
                    {jobs.length} total
                  </div>
                </div>
                <div className="fade-mask flex max-h-[calc(100vh-200px)] flex-col gap-2.5 overflow-y-auto pr-2">
                  {jobs.length === 0 ? (
                    <div className="rounded-xl border border-white/5 bg-white/5 px-3.5 py-4 text-sm text-slate-400">
                      Your renders will appear here with live queue events and downloadable assets.
                    </div>
                  ) : (
                    jobs.map((job) => (
                      <div
                        key={job.id}
                        className="relative flex flex-col gap-2.5 rounded-xl border border-white/5 bg-white/10 px-3.5 py-3 backdrop-blur-xl transition duration-200 hover:-translate-y-1 hover:shadow-[0_24px_80px_rgba(30,64,175,0.18)]"
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
                        className={`rounded-full px-3 py-1 text-xs font-semibold ${STATUS_META[job.status].chip}`}
                      >
                        {STATUS_META[job.status].label}
                      </span>
                        </div>
                        <div className="rounded-xl border border-white/5 bg-white/5 px-3 py-2 text-xs text-slate-300">
                          {job.prompt}
                        </div>
                    {job.localUrl || job.videoUrl ? (
                      <video
                        src={job.localUrl ?? job.videoUrl ?? undefined}
                        controls
                        className="w-full rounded-xl border border-white/5"
                      />
                    ) : (
                      <div className="relative overflow-hidden rounded-xl border border-white/5 bg-white/5">
                        {job.preview ? (
                          <img
                            src={job.preview}
                            alt="Start preview"
                            className="h-full w-full object-cover"
                          />
                        ) : (
                          <div className="flex h-28 items-center justify-center text-sm text-slate-500">
                            Awaiting render…
                          </div>
                        )}
                        {job.status !== "error" && job.status !== "success" ? (
                          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-black/60 text-xs text-slate-100 backdrop-blur-sm">
                            <Spinner size="sm" />
                            <span>{STATUS_META[job.status].label}</span>
                          </div>
                        ) : null}
                      </div>
                    )}

                        {job.status === "error" ? (
                          <div className="rounded-xl border border-rose-400/30 bg-rose-500/10 px-3 py-2 text-sm text-rose-200">
                            {job.error ?? "Something went wrong."}
                          </div>
                        ) : null}

                        {job.events.length > 0 ? (
                          <div className="space-y-1.5 rounded-xl border border-white/5 bg-white/5 px-3 py-2">
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

                        {job.status === "success" && (job.localUrl || job.videoUrl) ? (
                          <div className="flex flex-col gap-1.5">
                            <button
                              type="button"
                              onClick={() => handleDownload(job)}
                              className="self-start rounded-full border border-white/10 bg-white/5 px-3 py-1 text-xs font-semibold text-slate-200 transition hover:border-sky-400 hover:text-sky-200"
                            >
                              Download
                            </button>
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
