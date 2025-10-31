# Freeflow Creative Studio

Freeflow Creative Studio is a polished React + TypeScript front end that lets you generate **AI videos** and **image edits** directly against the FAL.ai APIs. The experience mirrors modern tools like Freepik’s suites with responsive glassmorphism styling, drag & drop uploads, live queues, and model-specific adapters.

## Features

- **Video Tab**
  - Start / end frame drag & drop with automatic uploads to FAL storage.
  - Prompt editing, model-specific controls (duration, aspect, resolution, seed, audio).
  - Live render queue with inline playback, retry, and local IndexedDB persistence.

- **Image Tab**
  - Supports multi-image editors (Nano Banana, Qwen Edit Plus, Seedream v4, Gemini Flash Edit Multi) and single-frame edits (Chrono Edit).
  - Clipboard paste, drag & drop, and direct URL entry for reference images.
  - Prompt reuse, recreate, and download actions for each resulting image.

- **Model Registry**
  - JSON + adapter-based registry for video models.
  - Dedicated `image-models.ts` for image endpoints with per-model `mapInput` and `getUrls`.

- **UI**
  - Glass panel layout, animated gradients, shimmer hover micro-interactions.
  - Dark mode, responsive cards, per-tab layout switching.

## Getting Started

```bash
# install dependencies
npm install

# run the dev server
npm run dev

# lint + typecheck
npm run lint
npm run build
```

Set your FAL API key in the UI (stored in `localStorage`) or wire `fal.config` to an env variable.

## Project Structure

```
src/
  app/page.tsx           # main layout with Video/Image tabs
  components/ImageTab.tsx
  lib/
    fal.ts               # fal config + subscriptions
    image-models.ts      # image model registry
    models.ts            # video model registry
    models-extra.ts      # additional video adapters
    storage.ts           # IndexedDB helpers for saved video blobs
```

## Notes

- Video results persist in browser IndexedDB under the “Internal save path” you configure.
- Image results fetch via model-specific `getUrls` to accommodate heterogeneous payload shapes.
- Drag & drop relies on `fal.storage.upload` so you don’t need external storage services.

Feel free to fork, adjust model registries, and push directly to GitHub. Happy generating!

