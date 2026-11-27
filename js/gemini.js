// Talks to the Gemini API directly from your phone using your Google AI Studio key.
import { settings, DEFAULT_MODEL } from './settings.js';
import { blobToBase64 } from './image.js';

const endpoint = (model) =>
  `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;

export const hasKey = () => Boolean(settings.apiKey);

async function generate(body) {
  if (!settings.apiKey) throw new Error('Add your Gemini API key in Settings first.');
  let res;
  try {
    res = await fetch(endpoint(settings.model || DEFAULT_MODEL), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': settings.apiKey },
      body: JSON.stringify(body),
    });
  } catch {
    throw new Error("Couldn't reach Gemini. Check your internet connection.");
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error?.message || `Gemini returned an error (${res.status}).`);
  const cand = data.candidates?.[0];
  const text = (cand?.content?.parts || []).map((p) => p.text || '').join('');
  if (!text) {
    const why = data.promptFeedback?.blockReason || cand?.finishReason || 'no answer';
    throw new Error(`Gemini didn't return anything (${why}).`);
  }
  return text;
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    const m = text.match(/\{[\s\S]*\}/);
    if (m) return JSON.parse(m[0]);
    throw new Error("Gemini's answer wasn't in the expected format. Try again.");
  }
}

export async function testKey() {
  return generate({ contents: [{ parts: [{ text: 'Reply with the single word OK.' }] }] });
}

/** Looks at a photo of a box's contents and lists the items it can see. */
export async function identifyItems(blob, existingItems = []) {
  const data = await blobToBase64(blob);
  const already = existingItems.length
    ? `The box is already known to contain: ${existingItems.map((i) => i.name).join(', ')}. Do not repeat those unless you can see more of them.`
    : '';
  const prompt = `This is a photo of the contents of a storage box in a home garage.
List each distinct physical item you can see so it can be added to a home inventory.
Use short, plain, searchable names (e.g. "Cordless drill", "Extension cord, orange", "Christmas lights").
Group identical items and give a quantity. Give each item a simple category (Tools, Electrical, Holiday, Camping, Sports, Automotive, Kitchen, Garden, Paint, Hardware, Toys, Clothing, Documents, Other).
Also suggest a short name for the box based on what's in it. ${already}`;
  const text = await generate({
    contents: [{ parts: [{ inlineData: { mimeType: blob.type || 'image/jpeg', data } }, { text: prompt }] }],
    generationConfig: {
      responseMimeType: 'application/json',
      responseSchema: {
        type: 'OBJECT',
        properties: {
          boxName: { type: 'STRING' },
          items: {
            type: 'ARRAY',
            items: {
              type: 'OBJECT',
              properties: {
                name: { type: 'STRING' },
                quantity: { type: 'INTEGER' },
                category: { type: 'STRING' },
              },
              required: ['name', 'quantity'],
            },
          },
        },
        required: ['items'],
      },
    },
  });
  const out = parseJson(text);
  return {
    boxName: String(out.boxName || '').trim(),
    items: (out.items || [])
      .filter((i) => i && i.name)
      .map((i) => ({ name: String(i.name).trim(), qty: Math.max(1, Number(i.quantity) || 1), category: String(i.category || '').trim() })),
  };
}

/** Answers a question like "where is my drill?" using the whole inventory as context. */
export async function askInventory(question, boxes) {
  const lines = boxes.map((b) => {
    const items = (b.items || []).map((i) => `${i.name}${i.qty > 1 ? ` (x${i.qty})` : ''}`).join('; ');
    return `[${b.code}] name: ${b.name || '(unnamed)'} | location: ${b.location || '(unknown)'} | items: ${items || '(none listed)'}${b.notes ? ` | notes: ${b.notes}` : ''}`;
  });
  const prompt = `You help someone find things in the storage boxes in their garage. Here is their full inventory, one box per line:

${lines.join('\n') || '(no boxes yet)'}

Question: ${question}

Answer briefly and practically, naming box codes and locations. If something isn't in the inventory, say so and suggest the most likely box if there is one. Put every box code you mention in "boxCodes".`;
  const text = await generate({
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: {
      responseMimeType: 'application/json',
      responseSchema: {
        type: 'OBJECT',
        properties: { answer: { type: 'STRING' }, boxCodes: { type: 'ARRAY', items: { type: 'STRING' } } },
        required: ['answer'],
      },
    },
  });
  const out = parseJson(text);
  return { answer: String(out.answer || ''), boxCodes: Array.isArray(out.boxCodes) ? out.boxCodes : [] };
}
