// Phone cameras often save photos sideways or upside down, plus an EXIF "orientation" note saying
// how to turn them. Most browsers apply that note when drawing the photo; some don't. We check once
// which kind this browser is, and turn the photo ourselves when the browser won't.

/** Reads the EXIF orientation (1-8) from a JPEG; 1 means "already the right way up". */
export async function exifOrientation(blob) {
  try {
    const v = new DataView(await blob.slice(0, 256 * 1024).arrayBuffer());
    if (v.getUint16(0) !== 0xffd8) return 1;
    let off = 2;
    while (off + 4 <= v.byteLength) {
      const marker = v.getUint16(off);
      if ((marker & 0xff00) !== 0xff00) break;
      const len = v.getUint16(off + 2);
      if (marker === 0xffe1 && v.getUint32(off + 4) === 0x45786966) {
        const tiff = off + 10;
        const little = v.getUint16(tiff) === 0x4949;
        const ifd = tiff + v.getUint32(tiff + 4, little);
        const count = v.getUint16(ifd, little);
        for (let i = 0; i < count; i++) {
          const e = ifd + 2 + i * 12;
          if (v.getUint16(e, little) === 0x0112) {
            const o = v.getUint16(e + 8, little);
            return o >= 1 && o <= 8 ? o : 1;
          }
        }
        return 1;
      }
      if (marker === 0xffda) break; // image data starts; no EXIF
      off += 2 + len;
    }
  } catch {
    /* not a JPEG we can read */
  }
  return 1;
}

// A tiny 16x8 JPEG marked "turn 90 degrees". A browser that applies EXIF reports it as 8x16.
const PROBE =
  'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/4QAiRXhpZgAATU0AKgAAAAgAAQESAAMAAAABAAYAAAAAAAD/2wBDAAMCAgMCAgMDAwMEAwMEBQgFBQQEBQoHBwYIDAoMDAsKCwsNDhIQDQ4RDgsLEBYQERMUFRUVDA8XGBYUGBIUFRT/2wBDAQMEBAUEBQkFBQkUDQsNFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBT/wAARCAAIABADASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwD50rwKiiv3D6Mv/M4/7gf+5j+jfpDf8yr/ALjf+4j/2Q==';
let browserTurnsPhotos;
async function browserAppliesOrientation() {
  if (browserTurnsPhotos === undefined) {
    try {
      const img = new Image();
      img.src = PROBE;
      await img.decode();
      browserTurnsPhotos = img.naturalWidth === 8;
    } catch {
      browserTurnsPhotos = true; // can't tell: assume a modern browser
    }
  }
  return browserTurnsPhotos;
}

/**
 * Draws an image scaled to at most `max` px, applying EXIF orientation `o` (1-8) and then
 * `turn` extra quarter turns clockwise. `srcW`/`srcH` are the image's pixel size as decoded.
 */
export function orientedCanvas(img, srcW, srcH, o, max, turn = 0, mirror = false) {
  const scale = Math.min(1, max / Math.max(srcW, srcH));
  const w = Math.round(srcW * scale);
  const h = Math.round(srcH * scale);
  // Extra quarter turns clockwise requested by the user (the Rotate button).
  const quarter = ((turn % 4) + 4) % 4;
  const sideways = (o >= 5) !== (quarter % 2 === 1);
  const canvas = document.createElement('canvas');
  canvas.width = sideways ? h : w;
  canvas.height = sideways ? w : h;
  const ctx = canvas.getContext('2d');
  // Outermost first: the user's left-right flip, then the user's turn, then the EXIF fix.
  if (mirror) {
    ctx.translate(canvas.width, 0);
    ctx.scale(-1, 1);
  }
  if (quarter) {
    ctx.translate(canvas.width / 2, canvas.height / 2);
    ctx.rotate((quarter * Math.PI) / 2);
    const [ew, eh] = o >= 5 ? [h, w] : [w, h]; // size after the EXIF fix
    ctx.translate(-ew / 2, -eh / 2);
  }
  switch (o) {
    case 2: ctx.transform(-1, 0, 0, 1, w, 0); break;
    case 3: ctx.transform(-1, 0, 0, -1, w, h); break;
    case 4: ctx.transform(1, 0, 0, -1, 0, h); break;
    case 5: ctx.transform(0, 1, 1, 0, 0, 0); break;
    case 6: ctx.transform(0, 1, -1, 0, h, 0); break;
    case 7: ctx.transform(0, -1, -1, 0, h, w); break;
    case 8: ctx.transform(0, -1, 1, 0, 0, w); break;
  }
  ctx.drawImage(img, 0, 0, w, h);
  return canvas;
}

/** Shrinks a photo to at most `max` pixels on its long side, the right way up, as a JPEG Blob. */
export async function resizeImage(file, max, quality = 0.82, { turn = 0, mirror = false } = {}) {
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    // EXIF orientation we still have to apply ourselves (1 = nothing to do).
    const o = (await browserAppliesOrientation()) ? 1 : await exifOrientation(file);
    const canvas = orientedCanvas(img, img.naturalWidth, img.naturalHeight, o, max, turn, mirror);
    return await new Promise((resolve, reject) =>
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Could not process that image.'))), 'image/jpeg', quality),
    );
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** What this phone does with a photo — shown in Settings so problems can be diagnosed. */
export async function photoDiagnostics(file) {
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    return {
      browserTurnsPhotos: await browserAppliesOrientation(),
      exifOrientation: await exifOrientation(file),
      decoded: `${img.naturalWidth}x${img.naturalHeight}`,
      type: file.type || 'unknown',
      sizeKB: Math.round(file.size / 1024),
      userAgent: navigator.userAgent,
    };
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** Testing hook: pretend this browser does / doesn't apply EXIF orientation. */
export function _setBrowserTurnsPhotos(v) {
  browserTurnsPhotos = v;
}

export function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1]);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}
