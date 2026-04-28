# YouTube Summarizer

<p align="center"><img width="547" height="215" alt="image" src="https://github.com/user-attachments/assets/a69cde07-ccfe-41a8-af6a-7c7655029e73" /></p>

React + TypeScript app that fetches a video's transcript (YouTube, TikTok, Instagram) using Supadata and summarizes it with Gemini (model: `gemini-3-flash-preview`). Built with Vite and a Netlify Function.

## Features
- Paste a YouTube/TikTok/Instagram link, validation included
- Handles missing transcripts and invalid links gracefully
- Summaries with readable structure and timestamps
- Copy buttons for summary and full transcript
- Serverless: API keys are not exposed to the browser

## Setup
> **Requires Node.js 20+** (set via `.node-version` or `NODE_VERSION` env var on Netlify).

1. Install dependencies:
```bash
npm install
```
2. Configure environment:
   - Set `GEMINI_API_KEY` (Netlify env var), or create `netlify/functions/config.local.json` from `netlify/functions/config.example.json`.
   - Set `SUPADATA_API_KEY` (Netlify env var) for transcript retrieval via Supadata.
   - Optionally set `VITE_API_BASE` (defaults to `/api`).
3. Run locally with Netlify dev (proxies functions):
```bash
npm run netlify:dev
```
Or run client only:
```bash
npm run dev
```

## Deploy to Netlify
- Build command: `npm run build`
- Publish directory: `dist`
- Set environment variables in Netlify dashboard:
  - `GEMINI_API_KEY`
  - `SUPADATA_API_KEY`

## Notes
- Some videos have no transcripts; the app informs the user.
- Very long transcripts are truncated before summarization for responsiveness.
- Transcripts are fetched from Supadata (`mode=auto`) and will be in the video's default language, preferring English when available.

## Troubleshooting 502/504 on "Summarize"

The summarize path is synchronous (`/api/summarize`) and can time out if transcript retrieval or model inference is slow.

This function now supports tuning env vars:

- `SUMMARIZE_DEADLINE_MS` (default `26000`): overall internal deadline before returning a controlled timeout.
- `GEMINI_TIMEOUT_MS` (default `18000`): max time spent waiting for Gemini response.
- `MAX_TRANSCRIPT_MODEL_CHARS` (default `60000`): transcript size sent to Gemini.
- `MAX_TRANSCRIPT_RESPONSE_CHARS` (default `120000`): transcript size returned to the browser.
- `PLATFORM_HARD_TIMEOUT_MS` (default `30000`): hard platform timeout (Netlify sync function wall-clock limit on free tier).
- `PLATFORM_TIMEOUT_SAFETY_MS` (default `2500`): safety margin subtracted from hard timeout.
- `SUPADATA_ASYNC_HANDOFF` (default `true`): when true, return `202 { pending: true, jobId }` and let the client poll.
- `SUPADATA_POLL_TIMEOUT_MS` (default `60000`): used only when async handoff is disabled.

If you still see 502/504:
- Check function logs for `summarize request started`, `summarize transcript ready`, and `summarize timeout` entries.
- Try shorter videos first to confirm behavior.
- Temporarily send `{ "debug": true }` in request body to include transcript-attempt diagnostics in JSON responses.
- Verify `SUPADATA_API_KEY` and `GEMINI_API_KEY` are present and valid in Netlify environment variables.

### Recommended Netlify values

Netlify synchronous functions on free tier can be terminated around 30s wall-clock. To avoid platform-killed 504s, keep app-level deadlines comfortably below this:

- `SUMMARIZE_DEADLINE_MS=26000`
- `GEMINI_TIMEOUT_MS=18000`
- `MAX_TRANSCRIPT_MODEL_CHARS=60000` (raise to `90000` only if needed)
- `PLATFORM_HARD_TIMEOUT_MS=30000`
- `PLATFORM_TIMEOUT_SAFETY_MS=2500`
- `SUPADATA_ASYNC_HANDOFF=true`

For videos where Supadata returns async jobs (common with long videos or AI-generated transcripts), the UI now polls using `jobId` until ready, so transcript processing can continue across multiple short Netlify requests.
