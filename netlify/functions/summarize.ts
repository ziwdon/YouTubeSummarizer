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
    const json = (await res.json()) as SupadataImmediate;
    return json;
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
      throw new Error(`Supadata job failed: ${JSON.stringify(json.error || {})}`);
    }
    await new Promise((r) => (globalThis as any).setTimeout(r, intervalMs));
  }
  throw new Error(`Supadata job polling timed out (last status: ${lastStatus || "unknown"})`);
}

async function getTranscriptPreferringEnglish(
  videoUrl: string,
  apiKey: string
): Promise<{ items: SupadataChunk[]; lang: string; availableLangs: string[] }> {
  const first = await requestSupadata(videoUrl, apiKey, { text: false, mode: "auto" });
  let immediate: SupadataImmediate;
  if ("jobId" in first) {
    immediate = await pollSupadataJob(first.jobId, apiKey);
  } else {
    immediate = first as SupadataImmediate;
  }

  if (immediate.lang !== "en" && (immediate.availableLangs || []).includes("en")) {
    const enReq = await requestSupadata(videoUrl, apiKey, { lang: "en", text: false, mode: "auto" });
    immediate = "jobId" in enReq ? await pollSupadataJob((enReq as any).jobId, apiKey) : (enReq as SupadataImmediate);
  }

  return { items: immediate.content, lang: immediate.lang, availableLangs: immediate.availableLangs || [] };
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
  try {
    const body = event.body ? JSON.parse(event.body) : {};
    srcUrl = body.url;
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
    const { items } = await getTranscriptPreferringEnglish(requestUrl, supadataApiKey);
    if (!items?.length) {
      return {
        statusCode: 404,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ error: "No transcript found for this video." }),
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
- 5-10 bullet key takeaways. Each takeaway should include one or more timestamps in [mm:ss] or [h:mm:ss] format referencing the transcript moments.
- A short timeline section highlighting 6-12 notable moments with their timestamps.

Guidelines:
- Use clear headings and bullet points.
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
      }),
    };
  } catch (e: any) {
    const message = e?.message || "Failed to process transcript";
    return {
      statusCode: 500,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ error: message }),
    };
  }
};

export { handler };
