import type { Handler } from "@netlify/functions";
import { YoutubeTranscript } from "youtube-transcript";
import { GoogleGenerativeAI } from "@google/generative-ai";
import fs from "node:fs";
import path from "node:path";

type TranscriptItem = {
  text: string;
  duration: number; // seconds
  offset: number; // seconds from start
};

function extractYouTubeVideoId(input: string): string | null {
  try {
    const url = new URL(input);
    if (url.hostname.includes("youtube.com")) {
      if (url.pathname.startsWith("/watch")) {
        return url.searchParams.get("v");
      }
      const embedMatch = url.pathname.match(/\/embed\/([a-zA-Z0-9_-]{11})/);
      if (embedMatch) return embedMatch[1];
      const shortsMatch = url.pathname.match(/\/shorts\/([a-zA-Z0-9_-]{11})/);
      if (shortsMatch) return shortsMatch[1];
    }
    if (url.hostname === "youtu.be") {
      const id = url.pathname.split("/").filter(Boolean)[0];
      if (id && /^[a-zA-Z0-9_-]{11}$/.test(id)) return id;
    }
  } catch {
    // not a URL
    const directIdMatch = input.match(/^[a-zA-Z0-9_-]{11}$/);
    if (directIdMatch) return directIdMatch[0];
  }
  return null;
}

function formatTimestamp(totalSeconds: number): string {
  const seconds = Math.max(0, Math.floor(totalSeconds));
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0) {
    return `${h}:${m.toString().padStart(2, "0")}:${s
      .toString()
      .padStart(2, "0")}`;
  }
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function readLocalFunctionConfig(): Record<string, string> | null {
  try {
    const localPath = path.join(__dirname, "config.local.json");
    if (fs.existsSync(localPath)) {
      const raw = fs.readFileSync(localPath, "utf-8");
      return JSON.parse(raw);
    }
  } catch {
    // ignore
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

  let url: string | undefined;
  try {
    const body = event.body ? JSON.parse(event.body) : {};
    url = body.url;
  } catch {
    return {
      statusCode: 400,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ error: "Invalid JSON body" }),
    };
  }

  if (!url || typeof url !== "string") {
    return {
      statusCode: 400,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ error: "Missing 'url' in request body" }),
    };
  }

  const videoId = extractYouTubeVideoId(url);
  if (!videoId) {
    return {
      statusCode: 400,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ error: "Please provide a valid YouTube URL" }),
    };
  }

  // Load API keys from env or local function config
  const localConfig = readLocalFunctionConfig();
  const geminiApiKey = process.env.GEMINI_API_KEY || localConfig?.GEMINI_API_KEY;
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

  let transcript: TranscriptItem[] = [];
  try {
    // This library usually works without API key; it scrapes transcript
    const items = await YoutubeTranscript.fetchTranscript(videoId);
    transcript = items.map((i) => ({
      text: i.text,
      duration: Number(i.duration) || 0,
      offset: Number(i.offset) || 0,
    }));
  } catch (e: any) {
    const message =
      e && typeof e.message === "string" ? e.message : "Failed to fetch transcript";
    const notFound = /transcript/i.test(message) || /not found/i.test(message);
    return {
      statusCode: notFound ? 404 : 500,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        error:
          notFound
            ? "No transcript available for this video. It may be disabled or unavailable."
            : `Error fetching transcript: ${message}`,
      }),
    };
  }

  if (!transcript.length) {
    return {
      statusCode: 404,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        error: "No transcript found for this video.",
      }),
    };
  }

  const transcriptText = transcript
    .map((t) => `[${formatTimestamp(t.offset)}] ${t.text}`)
    .join("\n");

  // Prevent excessive prompt size; Gemini 2.0 Flash handles long contexts but keep conservative
  const MAX_CHARS = 180_000;
  const truncated = transcriptText.length > MAX_CHARS;
  const transcriptForModel = truncated
    ? transcriptText.slice(0, MAX_CHARS)
    : transcriptText;

  const genAI = new GoogleGenerativeAI(geminiApiKey);
  const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });

  const systemInstruction = `You are an expert at creating concise, structured summaries of YouTube videos from transcripts.
Return a highly readable, well-structured summary containing:
- A one-paragraph overview of the video.
- 5-10 bullet key takeaways. Each takeaway must include one or more timestamps in [mm:ss] or [h:mm:ss] format referencing the transcript moments.
- A short timeline section highlighting 6-12 notable moments with their timestamps.

Guidelines:
- Use clear headings and bullet points.
- Maintain the video's original terminology where helpful.
- If content is truncated, mention that the summary may be incomplete.
- Do not fabricate timestamps; use ones present in the transcript text provided.`;

  const userInstruction = truncated
    ? "The transcript was truncated due to length. Summarize the provided portion faithfully."
    : "Summarize the transcript faithfully.";

  try {
    const result = await model.generateContent([
      { text: systemInstruction },
      { text: userInstruction },
      { text: "\n\nTRANSCRIPT:\n" + transcriptForModel },
    ]);
    const response = await result.response;
    const summary = response.text();

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        videoId,
        summary,
        transcript: transcriptText,
        truncated,
      }),
    };
  } catch (e: any) {
    const message = e?.message || "Failed to generate summary";
    return {
      statusCode: 500,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ error: `Gemini summarization error: ${message}` }),
    };
  }
};

export { handler };


