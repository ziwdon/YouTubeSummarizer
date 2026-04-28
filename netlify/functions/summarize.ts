import type { Handler } from "@netlify/functions";
import { GoogleGenAI, ThinkingLevel } from "@google/genai";
import fetch from "node-fetch";

type SupadataChunk = {
  text: string;
  offset: number; // milliseconds
  duration: number; // milliseconds
  lang: string;
};

type SupadataImmediate = {
  content: SupadataChunk[] | string;
  lang: string;
  availableLangs?: string[];
};

type SupadataJobStatus = {
  status: "queued" | "active" | "completed" | "failed";
  content?: SupadataChunk[] | string;
  lang?: string;
  availableLangs?: string[];
  error?: unknown;
};

type SupadataResponsePayload = {
  content?: unknown;
  lang?: string;
  availableLangs?: string[];
};

class StageTimeoutError extends Error {
  stage: string;
  timeoutMs: number;

  constructor(stage: string, timeoutMs: number) {
    super(`${stage} timed out after ${timeoutMs}ms`);
    this.name = "StageTimeoutError";
    this.stage = stage;
    this.timeoutMs = timeoutMs;
  }
}

class DeadlineExceededError extends Error {
  stage: string;
  remainingMs: number;

  constructor(stage: string, remainingMs: number) {
    super(`${stage} skipped because request deadline was exceeded (${remainingMs}ms remaining)`);
    this.name = "DeadlineExceededError";
    this.stage = stage;
    this.remainingMs = remainingMs;
  }
}

function isTimeoutLikeError(error: unknown): error is StageTimeoutError | DeadlineExceededError {
  return error instanceof StageTimeoutError || error instanceof DeadlineExceededError;
}

function getEnvPositiveInt(name: string, fallback: number): number {
  const raw = process?.env?.[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.floor(parsed);
}

function getEffectiveTimeoutMs(preferredMs: number, stage: string, deadlineAt?: number): number {
  if (!deadlineAt) return preferredMs;
  const remaining = deadlineAt - Date.now();
  if (remaining <= 500) {
    throw new DeadlineExceededError(stage, remaining);
  }
  return Math.max(750, Math.min(preferredMs, remaining - 250));
}

async function fetchWithTimeout(url: string, init: Parameters<typeof fetch>[1], timeoutMs: number, stage: string) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...(init || {}), signal: controller.signal });
  } catch (error: unknown) {
    if (
      (error as { name?: string })?.name === "AbortError" ||
      (error as { code?: string })?.code === "ABORT_ERR"
    ) {
      throw new StageTimeoutError(stage, timeoutMs);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function promiseWithTimeout<T>(promise: Promise<T>, timeoutMs: number, stage: string): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeoutPromise = new Promise<T>((_, reject) => {
      timeout = setTimeout(() => reject(new StageTimeoutError(stage, timeoutMs)), timeoutMs);
    });
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function getErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message) {
    return error.message;
  }
  if (typeof error === "string" && error) {
    return error;
  }
  return fallback;
}

function formatTimestamp(totalSeconds: number): string {
  const seconds = Math.max(0, Math.floor(totalSeconds));
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0) {
    return `${h}:${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
  }
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function isSupportedVideoUrl(input: string): boolean {
  const supported = /^(?:https?:\/\/)?(?:www\.)?(?:youtube\.com|youtu\.be|tiktok\.com|instagram\.com)\//i;
  if (supported.test(input)) return true;
  // Allow bare YouTube IDs
  return /^[a-zA-Z0-9_-]{11}$/.test(input);
}

async function requestSupadata(
  videoUrl: string,
  apiKey: string,
  opts?: {
    lang?: string;
    text?: boolean;
    mode?: "auto" | "native" | "generate";
    requestTimeoutMs?: number;
    deadlineAt?: number;
  }
): Promise<SupadataImmediate | { jobId: string }> {
  let url = `https://api.supadata.ai/v1/transcript?url=${encodeURIComponent(videoUrl)}&text=${String(opts?.text ?? false)}&mode=${encodeURIComponent(opts?.mode ?? "auto")}`;
  if (opts?.lang) url += `&lang=${encodeURIComponent(opts.lang)}`;

  const timeoutMs = getEffectiveTimeoutMs(opts?.requestTimeoutMs ?? 12_000, "Supadata transcript request", opts?.deadlineAt);
  const res = await fetchWithTimeout(url, { headers: { "x-api-key": apiKey } }, timeoutMs, "Supadata transcript request");
  if (res.status === 200) {
    const payload = (await res.json()) as SupadataResponsePayload;
    // Normalize: Supadata may occasionally return a string content even when text=false.
    if (typeof payload.content === "string") {
      return {
        content: payload.content,
        lang: payload.lang || "en",
        availableLangs: payload.availableLangs || [],
      } as SupadataImmediate;
    }
    if (Array.isArray(payload.content)) {
      return {
        content: payload.content as SupadataChunk[],
        lang: payload.lang || "en",
        availableLangs: payload.availableLangs || [],
      } as SupadataImmediate;
    }
    return {
      content: [],
      lang: payload.lang || "en",
      availableLangs: payload.availableLangs || [],
    } as SupadataImmediate;
  }
  if (res.status === 202) {
    const json = (await res.json()) as { jobId: string };
    return json;
  }
  const errText = await res.text();
  throw new Error(`Supadata transcript request failed (${res.status}): ${errText}`);
}

async function pollSupadataJob(
  jobId: string,
  apiKey: string,
  timeoutMs = 60_000,
  intervalMs = 1_500,
  opts?: { requestTimeoutMs?: number; deadlineAt?: number }
): Promise<SupadataImmediate> {
  const endpoint = `https://api.supadata.ai/v1/transcript/${jobId}`;
  const started = Date.now();
  let lastStatus = "";
  while (Date.now() - started < timeoutMs) {
    const requestTimeoutMs = getEffectiveTimeoutMs(
      opts?.requestTimeoutMs ?? 10_000,
      "Supadata transcript polling",
      opts?.deadlineAt
    );
    const res = await fetchWithTimeout(
      endpoint,
      { headers: { "x-api-key": apiKey } },
      requestTimeoutMs,
      "Supadata transcript polling"
    );
    if (!res.ok) {
      const t = await res.text();
      console.error("Supadata job polling HTTP error", { jobId, status: res.status, text: t });
      throw new Error(`Supadata job polling failed (${res.status}): ${t}`);
    }
    const json = (await res.json()) as SupadataJobStatus;
    lastStatus = json.status;
    if (json.status === "completed") {
      if (Array.isArray(json.content)) {
        return { content: json.content as SupadataChunk[], lang: json.lang || "en", availableLangs: json.availableLangs };
      } else {
        const textContent = typeof json.content === "string" ? json.content : "";
        return { content: [{ text: textContent, offset: 0, duration: 0, lang: json.lang || "en" }], lang: json.lang || "en", availableLangs: json.availableLangs };
      }
    }
    if (json.status === "failed") {
      console.error("Supadata job failed", { jobId, error: json.error });
      throw new Error(`Supadata job failed: ${JSON.stringify(json.error || {})}`);
    }
    if (opts?.deadlineAt) {
      const remaining = opts.deadlineAt - Date.now();
      if (remaining <= 500) {
        throw new DeadlineExceededError("Supadata transcript polling", remaining);
      }
      await new Promise((resolve) => setTimeout(resolve, Math.min(intervalMs, Math.max(250, remaining - 250))));
      continue;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  console.error("Supadata job polling timed out", { jobId, lastStatus: lastStatus || "unknown" });
  throw new Error(`Supadata job polling timed out (last status: ${lastStatus || "unknown"})`);
}

type TranscriptAttemptRecord = {
  mode: "auto" | "native" | "generate";
  lang?: string;
  outcome: "ok" | "job" | "empty" | "error";
  itemCount?: number;
  returnedLang?: string;
  availableLangs?: string[];
  contentKind?: "chunks" | "text";
  errorMessage?: string;
};

async function getTranscriptWithFallbacks(
  videoUrl: string,
  apiKey: string,
  opts?: {
    preferEnglish?: boolean;
    forceMode?: "auto" | "native" | "generate";
    debugAttempts?: TranscriptAttemptRecord[];
    deadlineAt?: number;
  }
): Promise<{ items: SupadataChunk[]; lang: string; availableLangs: string[] }> {
  const preferEnglish = opts?.preferEnglish !== false;
  const attempts = opts?.debugAttempts;

  async function perform(mode: "auto" | "native" | "generate", lang?: string) {
    try {
      const first = await requestSupadata(videoUrl, apiKey, {
        text: false,
        mode,
        lang,
        requestTimeoutMs: 12_000,
        deadlineAt: opts?.deadlineAt,
      });
      let immediate: SupadataImmediate;
      if ("jobId" in first) {
        attempts?.push({ mode, lang, outcome: "job" });
        immediate = await pollSupadataJob(first.jobId, apiKey, 60_000, 1_500, {
          requestTimeoutMs: 10_000,
          deadlineAt: opts?.deadlineAt,
        });
      } else {
        immediate = first as SupadataImmediate;
      }
      const contentKind: "chunks" | "text" = Array.isArray(immediate.content) ? "chunks" : "text";
      const items = Array.isArray(immediate.content)
        ? immediate.content
        : [{ text: String(immediate.content || ""), offset: 0, duration: 0, lang: immediate.lang || "en" }];
      attempts?.push({
        mode,
        lang,
        outcome: items.length ? "ok" : "empty",
        itemCount: items.length,
        returnedLang: immediate.lang,
        availableLangs: immediate.availableLangs,
        contentKind,
      });
      return { items, lang: immediate.lang, availableLangs: immediate.availableLangs || [] };
    } catch (e: unknown) {
      attempts?.push({ mode, lang, outcome: "error", errorMessage: getErrorMessage(e, "Transcript request failed") });
      throw e;
    }
  }

  // Start with preferred or forced mode
  const initialMode = opts?.forceMode || "auto";
  let result = await perform(initialMode);

  // If not English but English available and preferred, try English explicitly
  if (preferEnglish && result.lang !== "en" && (result.availableLangs || []).includes("en")) {
    const enRes = await perform(initialMode, "en");
    if (enRes.items.length) {
      result = enRes;
    }
  }

  // If still empty, try native then generate
  if (!result.items.length && initialMode !== "native") {
    try {
      const nativeRes = await perform("native");
      if (nativeRes.items.length) result = nativeRes;
    } catch {
      // Best-effort fallback: continue to "generate" mode.
    }
  }
  if (!result.items.length && initialMode !== "generate") {
    try {
      const genRes = await perform("generate");
      if (genRes.items.length) result = genRes;
    } catch {
      // Best-effort fallback: preserve prior result.
    }
  }

  return result;
}

function extractYouTubeVideoIdOptional(input: string): string | null {
  if (!input) return null;

  const trimmed = input.trim();
  if (!trimmed) return null;

  const idPattern = /^[a-zA-Z0-9_-]{11}$/;

  if (idPattern.test(trimmed)) {
    return trimmed;
  }

  const candidates = new Set<string>();

  const addCandidate = (value: string | null | undefined) => {
    if (value && idPattern.test(value)) {
      candidates.add(value);
    }
  };

  const visited = new Set<string>();

  const normalizeForUrl = (raw: string) => {
    const value = raw.trim();
    if (!value) return value;

    if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(value)) {
      return value;
    }
    if (value.startsWith("//")) {
      return `https:${value}`;
    }
    if (value.startsWith("/")) {
      return `https://youtube.com${value}`;
    }
    return `https://${value}`;
  };

  const parseUrl = (raw: string, depth = 0) => {
    if (!raw || depth > 3 || visited.has(raw)) return;
    visited.add(raw);

    let url: URL;
    try {
      url = new URL(normalizeForUrl(raw));
    } catch {
      return;
    }

    const host = url.hostname.toLowerCase();
    const isYouTubeHost =
      host === "youtu.be" ||
      host === "www.youtu.be" ||
      host === "youtube.com" ||
      host === "www.youtube.com" ||
      host.endsWith(".youtube.com") ||
      host === "youtube-nocookie.com" ||
      host.endsWith(".youtube-nocookie.com");

    const pathSegments = url.pathname.split("/").filter(Boolean);

    if (host.includes("youtu.be")) {
      addCandidate(pathSegments[0]);
    }

    if (isYouTubeHost) {
      if (pathSegments.length >= 2) {
        const [first, second] = pathSegments;
        if (["embed", "shorts", "live", "v"].includes(first)) {
          addCandidate(second);
        }
      } else if (pathSegments.length === 1 && host !== "youtube.com") {
        addCandidate(pathSegments[0]);
      }

      ["v", "vi", "video_id"].forEach((key) => addCandidate(url.searchParams.get(key)));
    }

    ["url", "u", "q"].forEach((key) => {
      const nested = url.searchParams.get(key);
      if (nested) {
        parseUrl(decodeURIComponent(nested), depth + 1);
      }
    });

    const combined = `${url.pathname}${url.search}${url.hash}`;
    const pattern = /(?:v=|vi=|video_id=|\/videos\/|\/embed\/|\/shorts\/|\/v\/|\/live\/|\/watch\/|youtu\.be\/)([a-zA-Z0-9_-]{11})/g;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(combined))) {
      addCandidate(match[1]);
    }
  };

  parseUrl(trimmed);

  if (candidates.size) {
    return candidates.values().next().value ?? null;
  }

  if (/youtu/i.test(trimmed)) {
    const fallbackMatch = trimmed.match(/([a-zA-Z0-9_-]{11})/);
    if (fallbackMatch) {
      const [candidate] = fallbackMatch;
      if (idPattern.test(candidate)) {
        return candidate;
      }
    }
  }

  return null;
}

const handler: Handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return {
      statusCode: 405,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ error: "Method Not Allowed" }),
    };
  }

  let srcUrl: string | undefined;
  let debugFlag = false;
  let forceMode: "auto" | "native" | "generate" | undefined;
  const requestId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const overallDeadlineMs = getEnvPositiveInt("SUMMARIZE_DEADLINE_MS", 52_000);
  const deadlineAt = Date.now() + overallDeadlineMs;
  try {
    const body = event.body ? JSON.parse(event.body) : {};
    srcUrl = body.url;
    debugFlag = Boolean(body.debug);
    if (body.mode === "auto" || body.mode === "native" || body.mode === "generate") {
      forceMode = body.mode;
    }
  } catch {
    return {
      statusCode: 400,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ error: "Invalid JSON body" }),
    };
  }

  if (!srcUrl || typeof srcUrl !== "string") {
    return {
      statusCode: 400,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ error: "Missing 'url' in request body" }),
    };
  }

  if (!isSupportedVideoUrl(srcUrl)) {
    return {
      statusCode: 400,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ error: "Please provide a supported video URL (YouTube, TikTok, Instagram)" }),
    };
  }

  const supadataApiKey = process?.env?.SUPADATA_API_KEY;
  if (!supadataApiKey) {
    return {
      statusCode: 500,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        error:
          "Missing SUPADATA_API_KEY. Set it as a Netlify environment variable or in netlify/functions/config.local.json",
      }),
    };
  }
  const geminiApiKey = process?.env?.GEMINI_API_KEY;
  if (!geminiApiKey) {
    return {
      statusCode: 500,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        error:
          "Missing GEMINI_API_KEY. Set it as a Netlify environment variable or in netlify/functions/config.local.json",
      }),
    };
  }

  try {
    console.info("summarize request started", { requestId, url: srcUrl, forceMode, overallDeadlineMs, debug: debugFlag });
    let requestUrl = srcUrl;
    if (/^[a-zA-Z0-9_-]{11}$/.test(srcUrl)) {
      requestUrl = `https://youtu.be/${srcUrl}`;
    }
    const debugAttempts: TranscriptAttemptRecord[] = [];
    const { items, lang, availableLangs } = await getTranscriptWithFallbacks(requestUrl, supadataApiKey, {
      preferEnglish: true,
      forceMode,
      debugAttempts,
      deadlineAt,
    });
    if (!items?.length) {
      console.warn("No transcript found", { url: requestUrl, debugAttempts, lang, availableLangs });
      return {
        statusCode: 404,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          error: "No transcript found for this video.",
          ...(debugFlag ? { debug: { attempts: debugAttempts, finalLang: lang, availableLangs } } : {}),
        }),
      };
    }

    const transcriptText = items
      .map((it) => {
        const seconds = Math.floor((Number(it.offset) || 0) / 1000);
        return `[${formatTimestamp(seconds)}] ${it.text}`;
      })
      .join("\n");

    const maxModelChars = getEnvPositiveInt("MAX_TRANSCRIPT_MODEL_CHARS", 60_000);
    const maxResponseChars = getEnvPositiveInt("MAX_TRANSCRIPT_RESPONSE_CHARS", 120_000);
    const truncated = transcriptText.length > maxModelChars;
    const transcriptForModel = truncated ? transcriptText.slice(0, maxModelChars) : transcriptText;
    const responseTranscriptTruncated = transcriptText.length > maxResponseChars;
    const transcriptForResponse = responseTranscriptTruncated
      ? transcriptText.slice(0, maxResponseChars)
      : transcriptText;

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

    const geminiTimeoutMs = getEffectiveTimeoutMs(
      getEnvPositiveInt("GEMINI_TIMEOUT_MS", 35_000),
      "Gemini summarization",
      deadlineAt
    );
    console.info("summarize transcript ready", {
      requestId,
      itemCount: items.length,
      transcriptLength: transcriptText.length,
      modelTranscriptLength: transcriptForModel.length,
      geminiTimeoutMs,
      responseTranscriptTruncated,
    });
    const response = await promiseWithTimeout(
      ai.models.generateContent({
        model: "gemini-3-flash-preview",
        contents: userInstruction + "\n\nTRANSCRIPT:\n" + transcriptForModel,
        config: {
          systemInstruction,
          thinkingConfig: {
            thinkingLevel: ThinkingLevel.LOW,
          },
        },
      }),
      geminiTimeoutMs,
      "Gemini summarization"
    );
    const summary = response.text ?? "";

    const maybeVideoId = extractYouTubeVideoIdOptional(srcUrl) || "";

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        videoId: maybeVideoId,
        summary,
        transcript: transcriptForResponse,
        truncated,
        responseTranscriptTruncated,
        ...(debugFlag ? { debug: { attempts: debugAttempts, finalLang: lang, availableLangs } } : {}),
      }),
    };
  } catch (e: unknown) {
    const message = getErrorMessage(e, "Failed to process transcript");
    if (isTimeoutLikeError(e)) {
      console.error("summarize timeout", { requestId, url: srcUrl, message, error: e });
      return {
        statusCode: 504,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          error: "Summarization timed out before completion. Try a shorter video or try again in a moment.",
          ...(debugFlag ? { detail: message } : {}),
        }),
      };
    }
    console.error("summarize error", { requestId, url: srcUrl, message, error: e });
    return {
      statusCode: 500,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ error: message }),
    };
  }
};

export { handler };
