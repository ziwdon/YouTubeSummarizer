# Gemini 3 Flash Upgrade — Implementation Plan

## Overview

This plan describes all changes required to upgrade the YouTube Summarizer app from **Gemini 2.0 Flash** (via the legacy `@google/generative-ai` SDK) to **Gemini 3 Flash** (via the new `@google/genai` SDK), using model `gemini-3-flash-preview` with thinking mode set to `LOW`.

The upgrade touches three areas:

1. **SDK migration** — Replace `@google/generative-ai` with `@google/genai`
2. **Model & configuration upgrade** — Switch model ID, add thinking config and system instruction via the new API shape
3. **Housekeeping** — Update documentation, remove unused dependencies, and verify the build

---

## Current State

| Item | Current Value |
|------|---------------|
| SDK package | `@google/generative-ai` `^0.21.0` (locked `0.21.0`) |
| Model | `gemini-2.0-flash` |
| Thinking mode | Not used (not supported by Gemini 2.0) |
| System instruction | Passed as the first `{ text: ... }` part in the `contents` array |
| API call style | `model.generateContent([...parts])` → `result.response.text()` |
| Streaming | Not used |
| Function calling / tools | Not used |
| Files affected | `netlify/functions/summarize.ts` (AI call), `package.json` (dependency) |

---

## Step-by-Step Implementation

### Step 1: Replace the SDK dependency

**File:** `package.json`

Remove the old package and install the new one:

```bash
npm uninstall @google/generative-ai
npm install @google/genai
```

This will:
- Remove `"@google/generative-ai": "^0.21.0"` from `dependencies`
- Add `"@google/genai": "^1.50.0"` (or latest) to `dependencies`
- Update `package-lock.json` accordingly

> **Note:** The `@google/genai` SDK requires **Node.js 20+**. Netlify Functions run Node 18 by default. You **must** ensure the Netlify build environment uses Node 20+. This can be configured by setting the `NODE_VERSION` environment variable in Netlify (or adding a `.node-version` / `.nvmrc` file). See Step 6.

### Step 2: Update the import in `summarize.ts`

**File:** `netlify/functions/summarize.ts`

**Before (line 2):**
```typescript
import { GoogleGenerativeAI } from "@google/generative-ai";
```

**After:**
```typescript
import { GoogleGenAI } from "@google/genai";
```

### Step 3: Rewrite the AI client initialization and `generateContent` call

**File:** `netlify/functions/summarize.ts`

The entire AI interaction block (currently lines 404–428) must be rewritten to use the new SDK's API shape.

**Before (lines 404–428):**
```typescript
const genAI = new GoogleGenerativeAI(geminiApiKey);
const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });
const systemInstruction = `You are an expert at creating concise, structured summaries of videos from transcripts.
Return a highly readable, well-structured summary containing:
- A one-paragraph overview of the video.
- A detailed summary of the video.
- 5-10 bullet key takeaways. Each takeaway must include a concise title (<=10 words), 1-2 sentence description, and the start timestamp from the transcript in [mm:ss] or [h:mm:ss] format (e.g. [02:15], [1:02:15]).

Guidelines:
- Use clear headings, formatting, and bullet points.
- Maintain the video's original terminology where helpful.
- If content is truncated, mention that the summary may be incomplete.
- Do not fabricate timestamps; use ones present in the transcript text provided.`;

const userInstruction = truncated
  ? "The transcript was truncated due to length. Summarize the provided portion faithfully."
  : "Summarize the transcript faithfully.";

const result = await model.generateContent([
  { text: systemInstruction },
  { text: userInstruction },
  { text: "\n\nTRANSCRIPT:\n" + transcriptForModel },
]);
const response = await result.response;
const summary = response.text();
```

**After:**
```typescript
const ai = new GoogleGenAI({ apiKey: geminiApiKey });

const systemInstruction = `You are an expert at creating concise, structured summaries of videos from transcripts.
Return a highly readable, well-structured summary containing:
- A one-paragraph overview of the video.
- A detailed summary of the video.
- 5-10 bullet key takeaways. Each takeaway must include a concise title (<=10 words), 1-2 sentence description, and the start timestamp from the transcript in [mm:ss] or [h:mm:ss] format (e.g. [02:15], [1:02:15]).

Guidelines:
- Use clear headings, formatting, and bullet points.
- Maintain the video's original terminology where helpful.
- If content is truncated, mention that the summary may be incomplete.
- Do not fabricate timestamps; use ones present in the transcript text provided.`;

const userInstruction = truncated
  ? "The transcript was truncated due to length. Summarize the provided portion faithfully."
  : "Summarize the transcript faithfully.";

const response = await ai.models.generateContent({
  model: "gemini-3-flash-preview",
  contents: userInstruction + "\n\nTRANSCRIPT:\n" + transcriptForModel,
  config: {
    systemInstruction: systemInstruction,
    thinkingConfig: {
      thinkingLevel: "LOW",
    },
  },
});

const summary = response.text;
```

#### Key changes explained

| Aspect | Old SDK | New SDK |
|--------|---------|---------|
| Client creation | `new GoogleGenerativeAI(apiKey)` | `new GoogleGenAI({ apiKey })` |
| Model selection | `genAI.getGenerativeModel({ model: "..." })` | Passed per-call in `ai.models.generateContent({ model: "..." })` |
| System instruction | Passed as the first `{ text: ... }` part in `contents` | Passed via `config.systemInstruction` (proper dedicated field) |
| Contents | Array of `{ text: string }` part objects | A plain string (or `Content[]` for multi-turn) |
| Thinking mode | Not available | `config.thinkingConfig.thinkingLevel: "LOW"` |
| Accessing the text | `(await result.response).text()` — `text()` is a method | `response.text` — `text` is a property (no parentheses) |
| Model ID | `"gemini-2.0-flash"` | `"gemini-3-flash-preview"` |

### Step 4: Remove the `declare const process: any` workaround (optional cleanup)

**File:** `netlify/functions/summarize.ts`, line 38

```typescript
declare const process: any;
```

This line exists because the old setup didn't include Node types in the Netlify Functions tsconfig. Since `tsconfig.node.json` already has `"types": ["node"]` and includes `netlify/functions/**/*.ts`, this line is unnecessary and should be removed. Confirm that the TypeScript build compiles without it (it should, since `@types/node` is already a dev dependency).

### Step 5: Remove unused dependencies (optional cleanup)

**File:** `package.json`

The following packages are listed as dependencies but are **not imported anywhere** in the current source code:

- `youtube-transcript` — Transcripts are fetched via Supadata, not this library
- `ytdl-core` — Not used in any source file
- `dotenv` — Not imported; Netlify handles env vars natively

```bash
npm uninstall youtube-transcript ytdl-core dotenv
```

This reduces install size and avoids confusion about what the app actually depends on.

### Step 6: Ensure Node.js 20+ for Netlify

**File (new):** `.node-version` (at repo root)

```
20
```

The `@google/genai` SDK requires Node.js 20 or later. Netlify respects `.node-version` (or the `NODE_VERSION` env var) to select the build/runtime Node version.

**Alternative:** Set `NODE_VERSION=20` in the Netlify dashboard under Build & Deploy → Environment variables.

### Step 7: Update `README.md`

**File:** `README.md`

Update the model reference and add any new setup notes:

1. Change the model mention from `gemini-2.0-flash` to `gemini-3-flash-preview`:
   > React + TypeScript app that fetches a video's transcript (YouTube, TikTok, Instagram) using Supadata and summarizes it with Gemini (model: `gemini-3-flash-preview`). Built with Vite and a Netlify Function.

2. Add a note about the Node.js version requirement:
   > **Requires Node.js 20+** (set via `.node-version` or `NODE_VERSION` env var on Netlify).

### Step 8: Update `config.example.json` (no change needed)

The example config file only contains `GEMINI_API_KEY` and `SUPADATA_API_KEY`. The same API key works for both Gemini 2.0 and Gemini 3 models — **no change is needed** for this file.

---

## Summary of Files Changed

| File | Action | Description |
|------|--------|-------------|
| `package.json` | Modify | Replace `@google/generative-ai` with `@google/genai`; optionally remove unused deps |
| `package-lock.json` | Auto-updated | By npm install/uninstall commands |
| `netlify/functions/summarize.ts` | Modify | New import, new client init, new `generateContent` call shape, thinking config |
| `README.md` | Modify | Update model name reference and Node version note |
| `.node-version` | Create | Set Node 20+ for Netlify runtime |

---

## What Does NOT Change

These items are unaffected and should remain as-is:

- **Frontend** (`src/App.tsx`, `src/App.css`, etc.) — The API contract between frontend and backend is unchanged. The same JSON payload is sent (`{ url }`) and the same JSON response is returned (`{ videoId, summary, transcript, truncated }`).
- **Supadata transcript fetching** — All Supadata logic in `summarize.ts` is independent of the AI SDK.
- **URL validation & video ID extraction** — Pure utility functions, no AI dependency.
- **Netlify routing** (`netlify.toml`) — No changes needed.
- **Edge function** (`netlify/edge-functions/basic-auth.ts`) — Independent of AI.
- **TypeScript config** — Already compatible. `tsconfig.node.json` targets ES2023 and includes `netlify/functions/**/*.ts`.
- **ESLint config** — No AI-specific rules.
- **Prompt content** — The system instruction and user instruction text stay the same. The summarization quality should improve with Gemini 3 Flash's better reasoning, especially with thinking enabled.
- **Transcript truncation** — The `MAX_CHARS = 180_000` limit remains valid. Gemini 3 Flash supports large context windows, so this is still a safe limit.

---

## Detailed Before/After for `summarize.ts`

For clarity, here is the complete diff of the file:

### Import section (top of file)

```diff
 import type { Handler } from "@netlify/functions";
-import { GoogleGenerativeAI } from "@google/generative-ai";
+import { GoogleGenAI } from "@google/genai";
 import fetch from "node-fetch";
```

### Remove process declaration (line 38)

```diff
-// Lightweight env accessor without Node types
-declare const process: any;
```

### AI call block (inside the handler, after transcript assembly)

```diff
-    const genAI = new GoogleGenerativeAI(geminiApiKey);
-    const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });
-    const systemInstruction = `You are an expert at creating concise, structured summaries of videos from transcripts.
+    const ai = new GoogleGenAI({ apiKey: geminiApiKey });
+
+    const systemInstruction = `You are an expert at creating concise, structured summaries of videos from transcripts.
 Return a highly readable, well-structured summary containing:
 - A one-paragraph overview of the video.
 - A detailed summary of the video.
 - 5-10 bullet key takeaways. Each takeaway must include a concise title (<=10 words), 1-2 sentence description, and the start timestamp from the transcript in [mm:ss] or [h:mm:ss] format (e.g. [02:15], [1:02:15]).

 Guidelines:
 - Use clear headings, formatting, and bullet points.
 - Maintain the video's original terminology where helpful.
 - If content is truncated, mention that the summary may be incomplete.
 - Do not fabricate timestamps; use ones present in the transcript text provided.`;

     const userInstruction = truncated
       ? "The transcript was truncated due to length. Summarize the provided portion faithfully."
       : "Summarize the transcript faithfully.";

-    const result = await model.generateContent([
-      { text: systemInstruction },
-      { text: userInstruction },
-      { text: "\n\nTRANSCRIPT:\n" + transcriptForModel },
-    ]);
-    const response = await result.response;
-    const summary = response.text();
+    const response = await ai.models.generateContent({
+      model: "gemini-3-flash-preview",
+      contents: userInstruction + "\n\nTRANSCRIPT:\n" + transcriptForModel,
+      config: {
+        systemInstruction: systemInstruction,
+        thinkingConfig: {
+          thinkingLevel: "LOW",
+        },
+      },
+    });
+
+    const summary = response.text;
```

> **Critical:** Note that `response.text` in the new SDK is a **property**, not a method call. Using `response.text()` will throw a runtime error.

---

## Potential Risks & Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| Node.js version mismatch on Netlify | SDK crashes at import time | Add `.node-version` file; verify in Netlify deploy logs |
| `response.text` returns `undefined` or `null` on safety block | 500 error with empty summary | Add a null check: `const summary = response.text ?? "";` and optionally check `response.candidates?.[0]?.finishReason` |
| Gemini 3 Flash is in preview; may be rate-limited differently | 429 errors | Monitor error rates; consider retry logic or fallback to `gemini-2.5-flash` |
| Thinking tokens increase latency | Slower responses than Gemini 2.0 Flash | Using `LOW` thinking level minimizes this; monitor p95 latency |
| Thinking tokens increase cost | Higher per-request cost | `LOW` level uses minimal thinking tokens; monitor usage via `response.usageMetadata?.thoughtsTokenCount` |
| New SDK has different error types | Unhandled error types in catch block | The existing `catch (e: any)` with `e?.message` fallback handles this generically |
| `@google/genai` package size is larger (~13.6 MB unpacked) | Slower cold starts for Netlify Functions | Acceptable for serverless; most of the size is type definitions |

---

## Post-Implementation Review Checklist

After implementing all changes, perform the following checks:

### Build & Deploy Verification

- [ ] `npm install` completes without errors
- [ ] `npm run build` (TypeScript compilation + Vite build) succeeds with zero errors
- [ ] `npm run lint` passes with no new warnings or errors
- [ ] `package.json` no longer contains `@google/generative-ai`
- [ ] `package.json` contains `@google/genai` with a recent version (≥1.50.0)
- [ ] `package-lock.json` is committed and consistent
- [ ] `.node-version` file exists at repo root and contains `20` (or higher)
- [ ] Netlify deploy succeeds (check deploy logs for Node version and function bundling)

### Functional Testing

- [ ] **Happy path — YouTube URL:** Submit a valid YouTube URL → receive a well-structured summary with timestamps
- [ ] **Happy path — YouTube video ID:** Submit a bare 11-character video ID → works correctly
- [ ] **Happy path — TikTok URL:** Submit a valid TikTok URL → works correctly
- [ ] **Happy path — Instagram URL:** Submit a valid Instagram URL → works correctly
- [ ] **Truncated transcript:** Submit a video with a very long transcript → response includes `truncated: true` and the summary mentions it may be incomplete
- [ ] **No transcript available:** Submit a video with no transcript → returns 404 with clear error message
- [ ] **Invalid URL:** Submit an unsupported URL → returns 400 with descriptive error
- [ ] **Empty/missing URL:** Submit with no URL → returns 400

### Response Quality

- [ ] Summary contains a one-paragraph overview section
- [ ] Summary contains a detailed summary section
- [ ] Summary contains 5-10 key takeaways with timestamps
- [ ] Timestamps in takeaways reference actual transcript times (not fabricated)
- [ ] Summary formatting renders correctly in the frontend (headings, bullets, bold, italics, timestamp badges)
- [ ] Summary quality is comparable to or better than Gemini 2.0 Flash output

### API Response Contract

- [ ] Response JSON shape is unchanged: `{ videoId, summary, transcript, truncated }`
- [ ] `summary` field is a non-empty string
- [ ] `transcript` field contains the full raw transcript text
- [ ] `videoId` is correctly extracted for YouTube URLs
- [ ] `debug` field is included when `debug: true` is sent in request body
- [ ] HTTP status codes are unchanged: 200 (success), 400 (bad input), 404 (no transcript), 405 (wrong method), 500 (server error)

### Error Handling

- [ ] Missing `GEMINI_API_KEY` → returns 500 with clear message about the missing key
- [ ] Missing `SUPADATA_API_KEY` → returns 500 with clear message
- [ ] Invalid `GEMINI_API_KEY` → returns 500 with an error message (not a crash/timeout)
- [ ] Gemini API rate limit (429) → error is caught and returned as 500 with message
- [ ] Gemini safety block (empty response) → handled gracefully, not a crash

### Frontend Verification

- [ ] Page loads without console errors
- [ ] Form submits and loading states display correctly
- [ ] Summary renders with proper formatting (headings, bold, lists, timestamps)
- [ ] "Copy Summary" button works
- [ ] "Copy Transcript" button works
- [ ] "Share with AI" button works (on supported devices)
- [ ] Brand/logo click resets the form
- [ ] Error messages display in the alert box

### Performance

- [ ] End-to-end latency for a typical YouTube video (5-15 min) is acceptable (< 30 seconds)
- [ ] No Netlify Function timeout (default 10s for free tier, 26s for paid) — if hitting limits, consider increasing the function timeout in `netlify.toml`
- [ ] Cold start performance is acceptable

### Documentation

- [ ] `README.md` references `gemini-3-flash-preview` (not `gemini-2.0-flash`)
- [ ] `README.md` mentions Node.js 20+ requirement
- [ ] No stale references to `@google/generative-ai` anywhere in the codebase

---

## Optional Enhancements (Out of Scope but Recommended)

These are not required for the upgrade but would improve the app:

1. **Add retry logic for Gemini API calls** — Wrap the `generateContent` call in a retry with exponential backoff for transient errors (429, 503).

2. **Add response validation** — Check `response.text` is non-empty and `response.candidates?.[0]?.finishReason` is `"STOP"` before returning. Return a descriptive error if the model was blocked by safety filters.

3. **Log thinking token usage** — After the call, log `response.usageMetadata` to monitor thinking token consumption and cost:
   ```typescript
   console.log("Usage:", {
     promptTokens: response.usageMetadata?.promptTokenCount,
     responseTokens: response.usageMetadata?.candidatesTokenCount,
     thinkingTokens: response.usageMetadata?.thoughtsTokenCount,
   });
   ```

4. **Consider streaming** — The new SDK supports `ai.models.generateContentStream()` which could reduce time-to-first-byte for the user if the frontend is updated to consume an SSE/streaming response.

5. **Add Netlify Function timeout configuration** — In `netlify.toml`, set a higher function timeout if Gemini 3's thinking causes the function to exceed the default limit:
   ```toml
   [functions]
     external_node_modules = ["@google/genai"]
     node_bundler = "esbuild"
   ```

6. **Remove unused dependencies** — As noted in Step 5, `youtube-transcript`, `ytdl-core`, and `dotenv` are unused and can be cleaned up.
