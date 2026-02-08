# PlayMetrics Calendar — Chrome Extension

## Tech Stack

- TypeScript, Chrome Extension Manifest V3
- Webpack (bundler), ts-loader
- ESLint with typescript-eslint

## Commands

| Command | What it does |
|---|---|
| `npm run build` | Lint + typecheck + webpack production build. Output goes to `dist/`. |
| `npm run lint` | Validates `manifest.json` is valid JSON, then runs ESLint on `src/`. |
| `npm run typecheck` | Runs `tsc --noEmit` against `src/`. |
| `npm run test` | Runs vitest (unit tests in `src/__tests__/`). |
| `npm run watch` | Webpack dev build in watch mode (no lint/typecheck gate). |

## Build Pipeline

`npm run build` runs these steps in order and fails fast:

1. `npm run lint` — manifest JSON validation + ESLint
2. `npm run typecheck` — TypeScript compiler check
3. `webpack --mode production` — bundle to `dist/`

Always run `npm run build` after changes to verify everything passes before loading the extension.

## Project Structure

- `src/` — TypeScript source files
- `src/__tests__/` — vitest unit tests
- `src/__mocks__/` — test mocks (chrome APIs)
- `dist/` — build output (load this as unpacked extension in Chrome)
- `manifest.json` — Chrome extension manifest (gitignored, contains OAuth client ID)
- `src/secrets.ts` — gitignored, contains player/calendar mappings and client ID
- `eslint.config.mjs` — ESLint flat config
- `vitest.config.ts` — test config
- `plan.md` — implementation plan, dev log, and investigation notes

## Extension Architecture

- `xhr_interceptor.ts` — injected into page context, monkey-patches fetch/XHR to capture PlayMetrics API traffic
- `content.ts` — content script, bridges page events to background via chrome.runtime
- `background.ts` — service worker, orchestrates sync, periodic alarms, message handling
- `sync.ts` — full sync and targeted sync logic, event mapping
- `google-calendar.ts` — Google Calendar REST API wrapper with retry/backoff
- `types.ts` — shared TypeScript interfaces
- `config.ts` — player/calendar mappings (imports from gitignored secrets.ts)
- `popup.ts` / `popup.html` — extension popup UI

## Sensitive Files

These files are gitignored and must not be committed:
- `manifest.json` — contains Google OAuth client ID
- `src/secrets.ts` — contains player IDs, calendar IDs, client ID

## Code Conventions

- No comments in code unless explicitly requested
- No trailing newlines at end of files
- No `any` types — use `WeakMap` or proper typing for metadata on patched objects
- `manifest.json` must be valid JSON (no trailing commas) — enforced by lint