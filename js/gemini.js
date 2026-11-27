// Talks to the Gemini API directly from your phone using your Google AI Studio key.
import { settings, DEFAULT_MODEL } from './settings.js';
import { blobToBase64, resizeImage } from './image.js';

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
    if (e.name === 'AbortError')
      throw Object.assign(new Error(`Gemini didn't answer within ${seconds} seconds. Try again, or try a different model in Settings.`), { timeout: true });
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

// Used when the chosen model is too busy or too slow.
const FALLBACK_MODEL = 'gemini-flash-lite-latest';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Listing items in a photo doesn't need long "thinking", which is what makes newer models slow.
// Different model generations take different settings, so try them in turn and remember what works.
const THINKING_OPTIONS = [{ thinkingBudget: 0 }, { thinkingLevel: 'minimal' }, { thinkingLevel: 'low' }, null];
const thinkingChoice = new Map(); // model -> index into THINKING_OPTIONS

async function sendWithLightThinking(model, body, seconds) {
  for (let i = thinkingChoice.get(model) ?? 0; i < THINKING_OPTIONS.length; i++) {
    const opt = THINKING_OPTIONS[i];
    const withThinking = opt ? { ...body, generationConfig: { ...(body.generationConfig || {}), thinkingConfig: opt } } : body;
    try {
      const data = await call(`${BASE}${encodeURIComponent(model)}:generateContent`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(withThinking),
      }, seconds);
      thinkingChoice.set(model, i);
      return data;
    } catch (e) {
      // Google rejected the request while we were sending a thinking setting. Some models reject it
      // with a generic "invalid argument" message, so try the next setting (and finally none at all).
      if (e.status === 400 && opt && i < THINKING_OPTIONS.length - 1) continue;
      throw e;
    }
  }
}

/** Asks Gemini quickly: retries when it's busy, and switches to the lighter model when it's busy or slow. */
async function generate(body, seconds = 60) {
  let data;
  let lastErr;
  const main = modelName();
  const attempts = [[main, 0], [main, 2000], [main, 5000]];
  if (main !== FALLBACK_MODEL) attempts.push([FALLBACK_MODEL, 0]);
  for (let i = 0; i < attempts.length; i++) {
    const [model, wait] = attempts[i];
    if (wait) await sleep(wait);
    try {
      data = await sendWithLightThinking(model, body, seconds);
      break;
    } catch (e) {
      lastErr = e;
      const fallbackMissing = model === FALLBACK_MODEL && e.status === 404;
      if (e.timeout) {
        // Too slow: don't wait for it again, go straight to the lighter model.
        while (i + 1 < attempts.length && attempts[i + 1][0] === model) i++;
        continue;
      }
      if (!e.busy && !fallbackMissing) throw e;
    }
  }
  if (!data) {
    if (lastErr?.status === 429) throw new Error("You've hit Gemini's free usage limit for now. Wait a minute (or until tomorrow if it keeps happening) and try again.");
    if (lastErr?.timeout) throw new Error('Gemini is taking too long right now. Tap Try again in a few minutes.');
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

/** Lists the Gemini models this key can use for text + photos, best everyday picks first. */
export async function listModels() {
  const data = await call(`${BASE.replace(/\/$/, '')}?pageSize=1000`, { method: 'GET' }, 20);
  const skip = /embed|tts|audio|live|image-generation|imagen|veo|aqa|learnlm|robotics|computer-use|native|-image\b|-image-/i;
  const models = (data.models || [])
    .filter((m) => /gemini/i.test(m.name) && (m.supportedGenerationMethods || []).includes('generateContent') && !skip.test(m.name))
    .map((m) => ({ id: m.name.replace(/^models\//, ''), label: m.displayName || m.name }));
  const rank = (id) =>
    (/-latest$/.test(id) ? 0 : 2) + (/flash-lite/.test(id) ? 1 : /flash/.test(id) ? 0 : 3) + (/preview|exp/.test(id) ? 4 : 0);
  return models.sort((a, b) => rank(a.id) - rank(b.id) || b.id.localeCompare(a.id, undefined, { numeric: true }));
}

/** Checks the key and model with Google without generating anything (quick and free). */
export async function testKey() {
  const info = await call(`${BASE}${encodeURIComponent(modelName())}`, { method: 'GET' }, 20);
  return info.displayName || modelName();
}

/** Looks at a photo of a box's contents and lists the items it can see. */
export async function identifyItems(blob, existingItems = []) {
  // A 1024px copy is plenty to recognise things and is much quicker to upload and process.
  let small = blob;
  try {
    small = await resizeImage(blob, 1024, 0.8);
  } catch {
    /* use the original */
  }
  const data = await blobToBase64(small);
  const already = existingItems.length
    ? `The box is already known to contain: ${existingItems.map((i) => i.name).join(', ')}. Do not repeat those unless you can see more of them.`
    : '';
  const categories = 'Tools, Electrical, Holiday, Camping, Sports, Automotive, Kitchen, Garden, Paint, Hardware, Toys, Clothing, Documents, Crafts, Other';
  const prompt =
    settings.aiDetail === 'detailed'
      ? `This is a photo of the contents of a storage box in a home garage.
List each distinct physical item you can see so it can be added to a home inventory.
Use short, plain, searchable names (e.g. "Cordless drill", "Extension cord, orange", "Christmas lights").
Group identical items and give a quantity. Give each item a simple category (${categories}).
Also suggest a short name for the box based on what's in it. ${already}`
      : `This is a photo of the contents of a storage box in a home garage.
Give a quick overview of what's in it: at most 8 entries, each a broad group of similar things described in a few plain, searchable words
(e.g. "School papers and binders", "Art supplies", "Christmas ornaments", "Power tool batteries"). Don't list every small item.
Use quantity 1 unless there are clearly several separate big things of one kind. Give each entry a simple category (${categories}).
Also suggest a short name for the box based on what's in it. ${already}`;
  const text = await generate({
    contents: [{ parts: [{ inlineData: { mimeType: small.type || 'image/jpeg', data } }, { text: prompt }] }],
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

/** Suggests a short name for an area of the garage from a photo of it. */
export async function suggestSectionName(blob) {
  let small = blob;
  try {
    small = await resizeImage(blob, 768, 0.8);
  } catch {
    /* use the original */
  }
  const data = await blobToBase64(small);
  const text = await generate(
    {
      contents: [
        {
          parts: [
            { inlineData: { mimeType: small.type || 'image/jpeg', data } },
            {
              text: 'This is a photo of one area of a home garage (for example a shelving unit, a wall, a corner, a workbench or overhead storage). Suggest a short, practical name of 2 to 4 words that a family would use to refer to this area, like "Metal shelves by door" or "Workbench". Describe the storage, not the items.',
            },
          ],
        },
      ],
      generationConfig: {
        responseMimeType: 'application/json',
        responseSchema: { type: 'OBJECT', properties: { name: { type: 'STRING' } }, required: ['name'] },
      },
    },
    45,
  );
  return String(parseJson(text).name || '').trim();
}

/** Answers a question like "where is my drill?" using the whole inventory as context. */
export async function askInventory(question, boxes, sections = []) {
  const sectionName = new Map(sections.map((s) => [s.id, s.name]));
  const lines = boxes.map((b) => {
    const items = (b.items || []).map((i) => `${i.name}${i.qty > 1 ? ` (x${i.qty})` : ''}`).join('; ');
    const where = [sectionName.get(b.sectionId), b.location].filter(Boolean).join(', ');
    return `[${b.code}] name: ${b.name || '(unnamed)'} | where in the garage: ${where || '(unknown)'} | items: ${items || '(none listed)'}${b.notes ? ` | notes: ${b.notes}` : ''}`;
  });
  const prompt = `You help someone find things in the storage boxes in their garage. Here is their full inventory, one box per line:

${lines.join('\n') || '(no boxes yet)'}

Question: ${question}

Answer briefly and practically, naming box codes and where in the garage they are (section and spot). If something isn't in the inventory, say so and suggest the most likely box if there is one. Put every box code you mention in "boxCodes".`;
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
