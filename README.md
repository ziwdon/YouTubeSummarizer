# YouTube Summarizer

<p align="center"><img width="547" height="215" alt="image" src="https://github.com/user-attachments/assets/a69cde07-ccfe-41a8-af6a-7c7655029e73" /></p>

React + TypeScript app that fetches a video's transcript (YouTube, TikTok, Instagram) using Supadata and summarizes it with Gemini (model: `gemini-2.0-flash`). Built with Vite and a Netlify Function.

## Features
- Paste a YouTube/TikTok/Instagram link, validation included
- Handles missing transcripts and invalid links gracefully
- Summaries with readable structure and timestamps
- Copy buttons for summary and full transcript
- Serverless: API keys are not exposed to the browser

## Setup
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
