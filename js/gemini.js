// Talks to the Gemini API directly from your phone using your Google AI Studio key.
import { settings, DEFAULT_MODEL } from './settings.js';
import { blobToBase64 } from './image.js';

const BASE = 'https://generativelanguage.googleapis.com/v1beta/models/';
const modelName = () => (settings.model || DEFAULT_MODEL).replace(/^models\//, '');

export const hasKey = () => Boolean(settings.apiKey);

/** fetch() with a time limit, so a stuck request shows an error instead of spinning forever. */
async function call(url, init, seconds) {
  if (!settings.apiKey) throw new Error('Add your Gemini API key in Settings first.');
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), seconds * 1000);
  let res;
  try {
    res = await fetch(url, { ...init, headers: { ...(init.headers || {}), 'x-goog-api-key': settings.apiKey }, signal: ctrl.signal });
  } catch (e) {
    if (e.name === 'AbortError') throw new Error(`Gemini didn't answer within ${seconds} seconds. Try again, or try a different model in Settings.`);
    throw new Error("Couldn't reach Gemini. Check your internet connection.");
  } finally {
    clearTimeout(timer);
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = data.error?.message || `Gemini returned an error (${res.status}).`;
    if (/api key not valid/i.test(msg)) throw new Error('Google says this API key is not valid. Copy it again from aistudio.google.com/apikey.');
    if (res.status === 404) throw Object.assign(new Error(`Gemini doesn't recognise the model "${modelName()}". Clear the Model box in Settings to use the default.`), { status: 404 });
    throw Object.assign(new Error(msg), { status: res.status, busy: res.status === 503 || res.status === 429 || /high demand|overloaded|unavailable/i.test(msg) });
  }
  return data;
}

// Used when the chosen model is too busy.
const FALLBACK_MODEL = 'gemini-flash-lite-latest';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Asks Gemini, waiting and retrying when it's busy, then trying the lighter model. */
async function generate(body, seconds = 90) {
  const send = (model) =>
    call(`${BASE}${encodeURIComponent(model)}:generateContent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }, seconds);
  let data;
  let lastErr;
  const attempts = [[modelName(), 0], [modelName(), 2000], [modelName(), 5000]];
  if (modelName() !== FALLBACK_MODEL) attempts.push([FALLBACK_MODEL, 0]);
  for (const [model, wait] of attempts) {
    if (wait) await sleep(wait);
    try {
      data = await send(model);
      break;
    } catch (e) {
      lastErr = e;
      const fallbackMissing = model === FALLBACK_MODEL && e.status === 404;
      if (!e.busy && !fallbackMissing) throw e;
    }
  }
  if (!data) {
    if (lastErr?.status === 429) throw new Error("You've hit Gemini's free usage limit for now. Wait a minute (or until tomorrow if it keeps happening) and try again.");
    throw new Error('Gemini is very busy right now. Please try again in a few minutes.');
  }
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

/** Checks the key and model with Google without generating anything (quick and free). */
export async function testKey() {
  const info = await call(`${BASE}${encodeURIComponent(modelName())}`, { method: 'GET' }, 20);
  return info.displayName || modelName();
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
