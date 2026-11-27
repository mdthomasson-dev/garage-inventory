# 📦 Garage Inventory

A phone app (installable website) for knowing what's in every box in your garage.

- **QR labels** – print labels, stick them on boxes, scan one to open that box.
- **Photos** – snap what's inside each box.
- **Sections** – photograph each area of the garage (shelves, wall, workbench…) and assign boxes to it.
- **AI** – Gemini looks at your photos and lists the items for you, and answers questions like *"where are the jumper cables?"*
- **Search** – find any item across all boxes instantly.
- **Shared household** – everyone signs in on their own phone and sees the same boxes and photos, with changes showing up live.
- **Works offline** – a copy is kept on each phone, so you can browse and search with no signal (changes need internet).
- **Private** – data is stored in your own Supabase project and only the email addresses you list can see it.

No server to run and no build step. It's plain HTML/CSS/JavaScript, with [Supabase](https://supabase.com) (free plan) for the shared database and photo storage.

## 1. Set up Supabase (once)

1. In Supabase, create a project (or use an existing one).
2. Open `supabase/setup.sql`, change the two email addresses at the bottom to the people in your household.
3. Supabase dashboard → **SQL Editor** → **New query** → paste the whole file → **Run**.
   This creates the tables, the private `garage-photos` storage bucket, and the security rules.
   (Set up before these features existed? Run `supabase/002_sections.sql` and `supabase/003_label_numbers.sql` the same way.)
4. **Authentication → URL Configuration**: set **Site URL** to your app's address (from step 2 below,
   e.g. `https://<your-username>.github.io/garage-inventory/`). This is where confirmation and password-reset emails send people.
5. **Project Settings → API**: copy the **Project URL** and the **anon** (or **publishable**) key into `js/config.js`.
   These are meant to be public; the security rules are what protect your data. **Never** use the `service_role`/secret key here.
   (If you leave `config.js` empty, the app asks for them on first launch instead.)

To add someone later, add their email in **Table Editor → garage_members**.

## 2. Put it online (GitHub Pages, free)

The camera and "install to home screen" need HTTPS, which GitHub Pages provides.

1. Push this folder to a GitHub repository (e.g. `garage-inventory`).
2. In the repo on GitHub: **Settings → Pages → Build and deployment → Source: Deploy from a branch**, branch **`main`**, folder **`/ (root)`** → **Save**.
3. After a minute your app is at `https://<your-username>.github.io/garage-inventory/`.

> GitHub Pages on a free account needs the repo to be **public**. That's fine — the code is public, but your inventory, photos and Gemini key live in Supabase behind sign-in.

## 3. Install it on each phone

- **iPhone:** open the link in **Safari** → Share button → **Add to Home Screen**.
- **Android:** open in **Chrome** → ⋮ menu → **Install app**.

Then tap **Continue with Google**. (Google sign-in is set up under Supabase **Authentication → Sign In / Providers → Google**. Each person's Gmail must be under **Authentication → Users** and in `garage_members`.)

## 4. Turn on the AI (Gemini)

1. Go to <https://aistudio.google.com/apikey> and create a free API key.
2. In the app: **Settings → API key**, paste it, tap **Test key**.

The key is shared with your household (stored in Supabase, readable only by members), so only one person needs to enter it. The default model is `gemini-flash-latest`; you can change it in Settings.

## How to use it

1. On the **Boxes** tab, tap **Add section** and photograph each area of the garage. Gemini suggests a name.
2. **Labels → Blank labels**: choose how many and the starting number → **Make labels** → Print. Stick one on each box.
   (Or create boxes first with **+ New box** and print their labels.)
3. Scan a label (with the app's **Scan** tab or your normal camera app). A new label asks you to set the box up.
4. Add a **name**, pick its **section** and spot, then **Take photo** of the contents. Gemini suggests the items — untick anything wrong and tap **Add to box**.
5. Later: search on the **Boxes** tab, or ask on the **Ask** tab.

**Sticker sheets:** choose **Avery 8163 / 5163 (2×4)** as the label size to print straight onto those 10-per-sheet stickers, no cutting. Use **Skip first N stickers** for a part-used sheet, and **Fine-tune position** if your printer is a millimetre or two off.

**Printing tips:** use 100% scale and turn off headers/footers. Plain paper under clear packing tape works well, or use full-sheet sticker paper. Three sizes are available (1.5", 2", 3").

## Backups

Everything is stored in Supabase. **Settings → Export backup** downloads a file with all boxes and photos as extra insurance; **Import backup** uploads one.

> Supabase pauses free projects after a week with no activity. Just open the dashboard and click **Restore** if that happens — nothing is lost.

## Project layout

```
index.html            app shell
css/app.css           styles (light/dark, print layout for labels)
js/app.js             screens: boxes, box detail, scan, labels, ask, settings
js/config.js          your Supabase URL + anon key
js/db.js              Supabase data/auth/storage + offline copy (IndexedDB) + backup
supabase/setup.sql    one-time database setup (tables, storage bucket, security rules)
js/gemini.js          Gemini API calls (photo → items, questions)
js/qr.js              QR label generation and parsing
js/image.js           photo resizing
sw.js                 offline cache
vendor/               qrcode-generator (MIT), jsQR (Apache-2.0), supabase-js (MIT)
```

When you change files, bump `CACHE` in `sw.js` so installed phones pick up the new version.
