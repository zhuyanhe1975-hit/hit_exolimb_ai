const GEMINI_ENDPOINT =
  "https://generativelanguage.googleapis.com/v1beta/models/gemini-robotics-er-1.6-preview:generateContent";

export interface SpatialPoint {
  point: [number, number];
  label: string;
}

export interface GeminiSpatialResult {
  rawText: string;
  points: SpatialPoint[];
}

const extractJson = (text: string): SpatialPoint[] => {
  const match = text.match(/\[[\s\S]*\]/);
  if (!match) {
    return [];
  }

  try {
    const parsed = JSON.parse(match[0]) as Array<{ point?: [number, number]; label?: string }>;
    return parsed
      .filter((item) => Array.isArray(item.point) && item.point.length === 2 && typeof item.label === "string")
      .map((item) => ({
        point: [Number(item.point?.[0] ?? 0), Number(item.point?.[1] ?? 0)],
        label: item.label ?? "unknown",
      }));
  } catch {
    return [];
  }
};

export const analyzeSceneWithGemini = async (
  image: Blob,
  taskPrompt: string,
): Promise<GeminiSpatialResult> => {
  const apiKey = import.meta.env.VITE_GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error("Missing VITE_GEMINI_API_KEY for Gemini Spatial Understanding.");
  }

  const buffer = await image.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  let binary = "";
  bytes.forEach((value) => {
    binary += String.fromCharCode(value);
  });
  const base64 = btoa(binary);

  const prompt = [
    "Analyze this robotics simulation scene for task planning.",
    `User task: ${taskPrompt}`,
    "Return a JSON array only.",
    'Format: [{"point": [y, x], "label": "<object>"}].',
    "Use normalized [y, x] coordinates from 0 to 1000.",
    "Prefer work objects, target regions, fixtures, and reachable interaction points.",
  ].join("\n");

  const response = await fetch(`${GEMINI_ENDPOINT}?key=${apiKey}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      contents: [
        {
          parts: [
            {
              inlineData: {
                mimeType: image.type || "image/png",
                data: base64,
              },
            },
            {
              text: prompt,
            },
          ],
        },
      ],
      generationConfig: {
        temperature: 0.2,
        thinkingConfig: {
          thinkingBudget: 0,
        },
      },
    }),
  });

  if (!response.ok) {
    throw new Error(`Gemini request failed with status ${response.status}.`);
  }

  const payload = (await response.json()) as {
    candidates?: Array<{
      content?: {
        parts?: Array<{ text?: string }>;
      };
    }>;
  };

  const rawText =
    payload.candidates?.[0]?.content?.parts
      ?.map((part) => part.text ?? "")
      .join("\n") ?? "[]";

  return {
    rawText,
    points: extractJson(rawText),
  };
};
