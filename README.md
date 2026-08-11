# FamShots — setup guide

A small installable web app that connects to your family's Dropbox, syncs your
photos, and does face grouping/search **entirely on-device** — no photos or
face data ever leave your phone except to talk to Dropbox itself.

## 1. Create a Dropbox app (one-time, ~2 minutes)

1. Go to https://www.dropbox.com/developers/apps and click **Create app**.
2. Choose **Scoped access**.
3. Choose **App folder** access (recommended — the app only sees a dedicated
   `Apps/FamShots` folder in Dropbox, not your whole account). Full Dropbox
   access also works if you'd rather point it at an existing folder — just
   change the app's permission type.
4. Name it something like `FamShots` (must be globally unique on Dropbox,
   so add your surname if it's taken) and click **Create app**.
5. On the app's **Permissions** tab, enable `files.metadata.read` and
   `files.content.read`, then click **Submit** at the bottom.
6. On the **Settings** tab, copy the **App key** — you'll paste this into the
   app on each phone.
7. Still on Settings, under **OAuth 2 > Redirect URIs**, add the exact URL
   you'll be hosting this app at (see step 2), e.g.
   `https://yourname.github.io/famshots/`. You can add more than one, so add
   a redirect URI for every place you might open the app from.

Note: with **App folder** access, put the family photos you want indexed
into the `Apps/FamShots` folder that Dropbox creates once you connect —
or move/symlink your existing camera-upload folder's contents there.

## 2. Host the files

These files need to be served over `https://` (a phone opening a local
`.html` file directly won't be able to complete Dropbox sign-in). Two free,
no-fuss options:

**GitHub Pages**
1. Create a new GitHub repo, e.g. `famshots`.
2. Upload every file in this folder to the repo (drag-and-drop on
   github.com works fine).
3. Repo → Settings → Pages → Source → Deploy from branch → `main` → `/root`.
4. Your app is live at `https://<username>.github.io/<repo>/` within a
   minute or two.

**Netlify (drag-and-drop, no account required for a quick test)**
1. Go to https://app.netlify.com/drop
2. Drag this whole folder onto the page.
3. You get an instant `https://random-name.netlify.app` URL.
4. (Optional) claim/rename it from the Netlify dashboard if you want a
   stable URL long-term — free accounts can rename sites.

Either way — **make sure the live URL matches exactly what you added as a
Redirect URI in step 1.7**, including the trailing slash.

## 3. Install on each phone

1. Open the live URL in Chrome on the phone.
2. Chrome menu (⋮) → **Add to Home screen**.
3. Open the new FamShots icon.
4. Paste the **App key** from step 1.6, tap **Sign in with Dropbox**, and
   log in with that phone's own Dropbox account/credentials.
5. Repeat on each family phone — same App key every time, each person signs
   in with their own Dropbox login. (One app registration serves everyone;
   Dropbox's OAuth model is designed for exactly this.)

The first sign-in kicks off a background sync: it downloads photo
thumbnails, runs on-device face detection, and groups matching faces into
"People." This can take a while the first time on a big library — it's all
running locally, so it depends on the phone and photo count. Progress shows
in the banner at the top. Re-opening the app later only processes new
photos.

## Notes & limits

- **Face matching quality**: this uses a lightweight, free, on-device model
  (`face-api.js` / TinyFaceDetector). It's good for grouping "same person,
  clear frontal-ish face" but won't match Google Photos' accuracy on
  profile angles, poor lighting, or very old/low-res scans. Expect to do
  some manual cleanup (tap a person to name them; near-duplicate clusters
  can happen and there's no merge UI yet).
- **Storage**: photo thumbnails and face data are cached in the phone's
  browser storage (IndexedDB), not re-downloaded every time. Clearing
  Chrome's site data for the app will wipe the local index (safe — it
  just re-syncs from Dropbox, faces just need re-matching).
- **Not itself a backup tool**: this app only *reads* from Dropbox. Keep
  using Dropbox's own Camera Upload feature (or your existing setup) to get
  new phone photos into Dropbox in the first place.
- **Full-resolution originals**: to keep things fast, the grid and viewer
  use Dropbox-generated thumbnails, not full-resolution downloads.
