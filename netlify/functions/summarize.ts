import type { Handler } from "@netlify/functions";
import { GoogleGenerativeAI } from "@google/generative-ai";
import fetch from "node-fetch";

type SupadataChunk = {
  text: string;
  offset: number; // milliseconds
  duration: number; // milliseconds
  lang: string;
};

type SupadataImmediate = {
  content: SupadataChunk[];
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

// Lightweight env accessor without Node types
declare const process: any;

function isSupportedVideoUrl(input: string): boolean {
  const supported = /^(?:https?:\/\/)?(?:www\.)?(?:youtube\.com|youtu\.be|tiktok\.com|instagram\.com)\//i;
  if (supported.test(input)) return true;
  // Allow bare YouTube IDs
  return /^[a-zA-Z0-9_-]{11}$/.test(input);
}

async function requestSupadata(
  videoUrl: string,
  apiKey: string,
  opts?: { lang?: string; text?: boolean; mode?: "auto" | "native" | "generate" }
): Promise<SupadataImmediate | { jobId: string }> {
  let url = `https://api.supadata.ai/v1/transcript?url=${encodeURIComponent(videoUrl)}&text=${String(opts?.text ?? false)}&mode=${encodeURIComponent(opts?.mode ?? "auto")}`;
  if (opts?.lang) url += `&lang=${encodeURIComponent(opts.lang)}`;

  const res = await fetch(url, { headers: { "x-api-key": apiKey } });
  if (res.status === 200) {
    const json = (await res.json()) as any;
    // Normalize: Supadata may occasionally return a string content even when text=false
    if (json && typeof json === "object" && json.content && !Array.isArray(json.content) && typeof json.content === "string") {
      return {
        content: [
          { text: String(json.content), offset: 0, duration: 0, lang: json.lang || "en" },
        ],
        lang: json.lang || "en",
        availableLangs: json.availableLangs || [],
      } as SupadataImmediate;
    }
    return json as SupadataImmediate;
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
  intervalMs = 1_500
): Promise<SupadataImmediate> {
  const endpoint = `https://api.supadata.ai/v1/transcript/${jobId}`;
  const started = Date.now();
  let lastStatus = "";
  while (Date.now() - started < timeoutMs) {
    const res = await fetch(endpoint, { headers: { "x-api-key": apiKey } });
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
    await new Promise((r) => (globalThis as any).setTimeout(r, intervalMs));
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
  opts?: { preferEnglish?: boolean; forceMode?: "auto" | "native" | "generate"; debugAttempts?: TranscriptAttemptRecord[] }
): Promise<{ items: SupadataChunk[]; lang: string; availableLangs: string[] }> {
  const preferEnglish = opts?.preferEnglish !== false;
  const attempts = opts?.debugAttempts;

  async function perform(mode: "auto" | "native" | "generate", lang?: string) {
    try {
      const first = await requestSupadata(videoUrl, apiKey, { text: false, mode, lang });
      let immediate: SupadataImmediate;
      if ("jobId" in first) {
        attempts?.push({ mode, lang, outcome: "job" });
        immediate = await pollSupadataJob(first.jobId, apiKey);
      } else {
        immediate = first as SupadataImmediate;
      }
      const contentKind: "chunks" | "text" = Array.isArray(immediate.content) ? "chunks" : "text";
      const items = Array.isArray(immediate.content)
        ? (immediate.content as SupadataChunk[])
        : ([{ text: String((immediate as any).content || ""), offset: 0, duration: 0, lang: immediate.lang || "en" }] as SupadataChunk[]);
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
    } catch (e: any) {
      attempts?.push({ mode, lang, outcome: "error", errorMessage: e?.message || String(e) });
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
    } catch {}
  }
  if (!result.items.length && initialMode !== "generate") {
    try {
      const genRes = await perform("generate");
      if (genRes.items.length) result = genRes;
    } catch {}
  }

  return result;
}

function extractYouTubeVideoIdOptional(input: string): string | null {
  // youtu.be/VIDEOID or youtube.com/watch?v=VIDEOID or /embed/VIDEOID or /shorts/VIDEOID
  const directId = input.match(/^[a-zA-Z0-9_-]{11}$/)?.[0];
  if (directId) return directId;
  const idFromUrl = input.match(/(?:v=|\/embed\/|\/shorts\/|youtu\.be\/)([a-zA-Z0-9_-]{11})/);
  return idFromUrl ? idFromUrl[1] : null;
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
    let requestUrl = srcUrl;
    if (/^[a-zA-Z0-9_-]{11}$/.test(srcUrl)) {
      requestUrl = `https://youtu.be/${srcUrl}`;
    }
    const debugAttempts: TranscriptAttemptRecord[] = [];
    const { items, lang, availableLangs } = await getTranscriptWithFallbacks(requestUrl, supadataApiKey, {
      preferEnglish: true,
      forceMode,
      debugAttempts,
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

    const MAX_CHARS = 180_000;
    const truncated = transcriptText.length > MAX_CHARS;
    const transcriptForModel = truncated ? transcriptText.slice(0, MAX_CHARS) : transcriptText;

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

    const maybeVideoId = extractYouTubeVideoIdOptional(srcUrl) || "";

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        videoId: maybeVideoId,
        summary,
        transcript: transcriptText,
        truncated,
        ...(debugFlag ? { debug: { attempts: debugAttempts, finalLang: lang, availableLangs } } : {}),
      }),
    };
  } catch (e: any) {
    const message = e?.message || "Failed to process transcript";
    console.error("summarize error", { url: srcUrl, message, error: e });
    return {
      statusCode: 500,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ error: message }),
    };
  }
};

export { handler };
