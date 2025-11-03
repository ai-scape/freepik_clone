# Freepik Clone — AI Asset Studio

Freepik Clone is a web studio for generating cinematic video loops and reference-aligned imagery from a single dashboard. The app fronts multiple FAL.ai pipelines so creatives can upload keyframes, queue renders, download finished clips, and keep shot settings together—mirroring the curated asset flow of Freepik or Envato.

## Highlights
- Generate videos from stills with first/last-frame interpolation, audio synthesis options, and automatic local downloads of completed jobs.
- Edit stills with prompt-driven reference uploads, temporal stabilization, and seed control to reproduce variations reliably.
- Store the FAL API key in-browser, reuse previous renders, and manage concurrent jobs with status updates in real time.
- Persist every rendered asset to the local `out/` directory and stream it back into the UI so previews survive refreshes and downloads always use timestamped filenames.
- Built with React 19 + TypeScript, Vite, and TailwindCSS for fast local iteration and clean design primitives.

## Getting Started
1. Install dependencies:
   ```bash
   npm install
   ```
2. Run the dev server:
   ```bash
   npm run dev
   ```
3. Open the app, paste your FAL API key into the “FAL API Key” input (stored in `localStorage`), and begin uploading reference frames or prompts.
4. Render assets: generated files are stored under `out/` via a local `/api/assets` endpoint, and rehydrated in the gallery from `/assets/<file>`.

## Model Catalog

### Video Pipelines
- `kling-2.5-pro` — high-speed image-to-video with automatic negative prompt and CFG tuning.
- `kling-2.1-pro` — supports end-frame constraints for shot-to-shot transitions.
- `veo-3.1-fast-flf2v` — Google Veo 3.1 first/last-frame with optional audio, resolution, and aspect ratio controls.
- `ltx-2-pro` — Lightricks LTX V2 Pro for 1080p–4K clips with FPS selection and audio generation.
- `ltx-2-fast` — Lightricks LTX V2 Fast variant for lower-latency runs with a slightly constrained resolution set.
- `hailuo-2.3-pro` — Minimax Hailuo I2V with prompt optimizer for stylized takes.
- `seedance-pro-fast` / `seedance-pro` — ByteDance Seedance accelerators, with optional end frame.
- `hailuo-02-pro` — Minimax Hailuo 0.2 for two-frame interpolations.
- `wan-2.2-turbo` / `wan-2.5-i2v` — Wán diffusion pipelines with safety guardrails and prompt expansion knobs.

### Image Pipelines
- `flux-kontext-pro` — Flux Kontext image edit with multi-reference support and automatic aspect-ratio mapping.
- `nano-banana-edit` — fast multi-reference edit pipeline.
- `nano-banana` — prompt-only generation.
- `imagen-4-fast` — Google Imagen 4 fast tier for rapid text-to-image iterations.
- `imagen-4` — Google Imagen 4 high-quality tier for production-grade stills.
- `qwen-image-edit-plus` — Alibaba Qwen image edit with inference-step control.
- `seedream-v4-edit` — ByteDance Seedream v4 for high-fidelity edits.
- `chrono-edit` — Chrono temporal edit for sequential consistency.
_Model specs live in `src/lib/models.json`, `src/lib/models-extra.ts`, and `src/lib/image-models.ts` if you need to extend or disable a pipeline._

### Pricing Labels
- Per-model pricing metadata lives in `src/lib/pricing.ts`. Each entry surfaces as a badge beside the “Generate” button in the UI. Update those numbers when fal.ai releases new rate cards to keep operators informed before triggering jobs.

## Deployment Guidelines

### Build for the Web
- Run `npm run build` to generate a static bundle in `dist/`.
- Deploy the `dist` folder to any static host (Vercel, Netlify, Cloudflare Pages, GitHub Pages, etc.).
- Platform presets:
  - **Vercel:** Framework preset “Vite”; output directory `dist`.
  - **Netlify:** Build command `npm run build`, publish directory `dist`.
  - **Cloudflare Pages:** Build command `npm run build`, output directory `dist`.

### Environment & Secrets
- The application is client-side only; the FAL key is entered by each user at runtime and cached in `localStorage` as `FAL_KEY`.
- When embedding inside an authenticated portal, inject the key via a startup script (for example `localStorage.setItem("FAL_KEY", "<token>")`) before loading the bundle.
- Avoid hardcoding private FAL keys in the repository—proxy requests through your backend if you need stricter usage controls.

### Production Checklist
- Serve over HTTPS to keep API tokens and uploads secure.
- Set a Content Security Policy to restrict `connect-src` to `https://fal.run` and `https://uploads.fal.run` (plus any regional endpoints you rely on).
- Ensure your hosting plan supports the upload sizes you expect for reference frames; FAL storage handles the downstream transfer once accepted.
- Persisted assets are written to `out/` by the Vite middleware. In production you should swap the middleware for a proper API route or scheduled clean-up routine to avoid unbounded disk growth.

## Project Structure
- `src/app/page.tsx` — main dashboard with job orchestration and queue management.
- `src/components` — UI modules such as the image editing tab and spinners.
- `src/lib` — model specifications, FAL client wrappers, and storage utilities.
- `src/styles` — Tailwind layer customizations.

Customize `src/lib/models.json` and related configs to add or swap models as new releases land.

Additional notes for automation agents live in [`docs/AGENT_GUIDE.md`](docs/AGENT_GUIDE.md).
