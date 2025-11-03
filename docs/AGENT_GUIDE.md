# Agent Guide

This repository powers a single-page “Freepik Clone” studio that orchestrates fal.ai image and video pipelines. When extending the project through an automation agent, keep these guardrails and workflows in mind.

## Key Runtime Behaviours

- **Local asset persistence:** Both images and videos are fetched from fal.ai, converted to Base64, then POSTed to `/api/assets`. The custom Vite middleware (see `vite.config.ts`) writes each payload to `out/<timestamped-name>`, and serves it back via `/assets/<file>`. Stored entries survive reloads because render history rehydrates from `localStorage`.
- **Pricing badges:** `src/lib/pricing.ts` defines per-model pricing. The UI renders a badge beside the “Generate” button for the selected model. Update this map whenever fal.ai pricing changes; tests do not cover it automatically.
- **Model catalogs:** Video specs live in `src/lib/models.json` (plus `models-extra.ts` adapters). Image specs live in `src/lib/image-models.ts`. Adding or removing models requires updating both the spec file and `src/lib/pricing.ts`.

## Dev Tooling

- **Linting:** Run `npm run lint` before committing. There are no automated formatters configured.
- **Tests:** There is no automated test suite; manual verification is required after modifying networking, storage, or UI flows.
- **Local asset clean-up:** The middleware never deletes files. Agents that generate many assets should remove `out/*` before finishing to prevent disk growth.

## Safe Editing Tips

- Avoid mutating `localStorage` keys outside the existing helpers to keep render rehydration stable.
- When touching `storeAssetsOnDisk` or the video persistence logic in `src/app/page.tsx`, confirm that downloads still produce timestamped filenames and that the gallery pulls from `/assets/...`.
- Pricing values should use the `amount` field (not `note`) so badges display formatted currency; leave `note` for free-form clarifications.

Use this guide as a checklist whenever you introduce new models, tweak pricing, or refactor storage behaviour.
