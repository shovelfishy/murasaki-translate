import OpenAI, { toFile } from "openai";
import fs from "node:fs/promises";
import path from "node:path";

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

function sanitizeMimeType(input: string): string {
  const normalized = input.toLowerCase();
  if (normalized.includes("ogg")) {
    return "audio/ogg";
  }
  if (normalized.includes("wav")) {
    return "audio/wav";
  }
  if (normalized.includes("mpeg") || normalized.includes("mp3")) {
    return "audio/mpeg";
  }
  return "audio/webm";
}

function extFromMime(mimeType: string): string {
  const normalized = mimeType.toLowerCase();
  if (normalized.includes("ogg")) {
    return "ogg";
  }
  if (normalized.includes("wav")) {
    return "wav";
  }
  if (normalized.includes("mpeg") || normalized.includes("mp3")) {
    return "mp3";
  }
  return "webm";
}

async function saveDebugAudio(params: {
  audio: Buffer;
  mimeType: string;
  segmentId: number;
}) {
  const dir = path.join(process.cwd(), "tmp-audio");
  await fs.mkdir(dir, { recursive: true });

  const safeMimeType = sanitizeMimeType(params.mimeType);
  const ext = extFromMime(safeMimeType);
  const filePath = path.join(
    dir,
    `segment_${String(params.segmentId).padStart(4, "0")}.${ext}`,
  );

  await fs.writeFile(filePath, params.audio);
  return filePath;
}

export async function transcribeAndTranslate(params: {
  audio: Buffer;
  mimeType: string;
  languageA: string;
  languageB: string;
  segmentId: number;
}) {
  const transcriptionModel = process.env.OPENAI_STT_MODEL ?? "gpt-4o-mini-transcribe";
  const translationModel = process.env.OPENAI_TRANSLATION_MODEL ?? "gpt-4o-mini";
  const safeMimeType = sanitizeMimeType(params.mimeType);
  if (process.env.DEBUG_SAVE_AUDIO === "true") {
    const savedPath = await saveDebugAudio({
      audio: params.audio,
      mimeType: safeMimeType,
      segmentId: params.segmentId,
    });
    // console.log("[ai] saved debug audio:", savedPath);
  }

  const sourceText = await transcribeAudio({
    audio: params.audio,
    mimeType: safeMimeType,
    segmentId: params.segmentId,
    model: transcriptionModel,
  });

  if (!sourceText.trim()) {
    return {
      sourceText: "",
      translatedText: "",
    };
  }

  return {
    sourceText,
    translatedText: await translateText({
      sourceText,
      languageA: params.languageA,
      languageB: params.languageB,
      model: translationModel,
    }),
  };
}

export async function transcribeAudio(params: {
  audio: Buffer;
  mimeType: string;
  segmentId: number;
  model?: string;
}) {
  const model = params.model ?? (process.env.OPENAI_STT_MODEL ?? "gpt-4o-mini-transcribe");
  const safeMimeType = sanitizeMimeType(params.mimeType);

  const file = await toFile(
    params.audio,
    `segment_${String(params.segmentId).padStart(4, "0")}.${extFromMime(safeMimeType)}`,
    {
      type: safeMimeType,
    },
  );

  const transcription = await openai.audio.transcriptions.create({
    model,
    file,
  });

  return typeof transcription === "string" ? transcription : transcription.text;
}

export async function translateText(params: {
  sourceText: string;
  languageA: string;
  languageB: string;
  model?: string;
}) {
  if (!params.sourceText.trim()) {
    return "";
  }

  const model = params.model ?? (process.env.OPENAI_TRANSLATION_MODEL ?? "gpt-4o-mini");
  const translation = await openai.responses.create({
    model,
    instructions: `You are an interpreter between ${params.languageA} and ${params.languageB}. Detect which of the two languages the input is in, then translate it into the other language. Return only the translated text with no commentary.`,
    input: params.sourceText,
  });

  return translation.output_text.trim();
}
