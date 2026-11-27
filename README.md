# 📦 Garage Inventory

A phone app (installable website) for knowing what's in every box in your garage.

- **QR labels** – print labels, stick them on boxes, scan one to open that box.
- **Photos** – snap what's inside each box.
- **AI** – Gemini looks at your photos and lists the items for you, and answers questions like *"where are the jumper cables?"*
- **Search** – find any item across all boxes instantly.
- **Works offline** – everything except the AI works without internet.
- **Private** – your inventory and photos stay on your phone. Nothing goes anywhere except the photos/questions you send to Gemini.

No server, no build step, no account. It's plain HTML/CSS/JavaScript.

## Put it online (GitHub Pages, free)

The camera and "install to home screen" need HTTPS, which GitHub Pages provides.

1. Push this folder to a GitHub repository (e.g. `garage-inventory`).
2. In the repo on GitHub: **Settings → Pages → Build and deployment → Source: Deploy from a branch**, branch **`main`**, folder **`/ (root)`** → **Save**.
3. After a minute your app is at `https://<your-username>.github.io/garage-inventory/`.

> GitHub Pages on a free account needs the repo to be **public**. That's fine — the code is public, but your inventory data and API key are never stored in the repo.

## Install it on your phone

- **iPhone:** open the link in **Safari** → Share button → **Add to Home Screen**.
- **Android:** open in **Chrome** → ⋮ menu → **Install app**.

## Turn on the AI (Gemini)

1. Go to <https://aistudio.google.com/apikey> and create a free API key.
2. In the app: **Settings → API key**, paste it, tap **Test key**.

The key is saved only on your phone and sent only to Google. The default model is `gemini-flash-latest`; you can change it in Settings.

## How to use it

1. **Labels → + Add blank labels** → Print. Stick one on each box.
   (Or create boxes first with **+ New box** and print their labels.)
2. Scan a label (with the app's **Scan** tab or your normal camera app). A new label asks you to set the box up.
3. Add a **name** and **location**, then **Take photo** of the contents. Gemini suggests the items — untick anything wrong and tap **Add to box**.
4. Later: search on the **Boxes** tab, or ask on the **Ask** tab.

**Printing tips:** use 100% scale and turn off headers/footers. Plain paper under clear packing tape works well, or use full-sheet sticker paper. Three sizes are available (1.5", 2", 3").

## Backups

Data lives in your phone's browser storage. Use **Settings → Export backup** now and then (it includes photos). **Import backup** restores it or moves it to another device.

> On iPhone, delete the home-screen app only if you've exported a backup — removing it can clear its data.

## Project layout

```
index.html            app shell
css/app.css           styles (light/dark, print layout for labels)
js/app.js             screens: boxes, box detail, scan, labels, ask, settings
js/db.js              on-device database (IndexedDB) + backup/restore
js/gemini.js          Gemini API calls (photo → items, questions)
js/qr.js              QR label generation and parsing
js/image.js           photo resizing
sw.js                 offline cache
vendor/               qrcode-generator (MIT), jsQR (Apache-2.0)
```

When you change files, bump `CACHE` in `sw.js` so installed phones pick up the new version.
