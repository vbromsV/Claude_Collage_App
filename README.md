# Collage

En mobilapp (PWA) för att göra kollage av 2–3 bilder (JPG, PNG, WEBP, GIF) med text, och spara som JPEG eller animerad GIF. Allt sker i telefonen – inga bilder laddas upp.

## Publicera med GitHub Pages

1. Gå till repot på GitHub → **Settings** → **Pages**.
2. Under **Build and deployment**: Source = **Deploy from a branch**.
3. Välj branchen med appen (t.ex. `main`) och mappen **/ (root)** → **Save**.
4. Efter någon minut visas adressen, t.ex. `https://<ditt-namn>.github.io/Claude_Collage_App/`.

## Installera på telefonen

- **Android (Chrome):** öppna adressen → menyn ⋮ → **Installera app** (eller knappen *Install app* under fliken Help). Chrome skapar då automatiskt en riktig Android-app av sidan.
- **iPhone (Safari):** öppna adressen → Dela-knappen → **Lägg till på hemskärmen**.

Öppna appen en gång med internet. Efter det fungerar den offline.

## Uppdateringar

När filerna ändras: höj `VERSION` i `sw.js` (t.ex. `collage-v1.0.1`). Telefonen hämtar den nya versionen nästa gång appen öppnas med internet (ibland krävs att appen öppnas två gånger).

## Filer

- `index.html`, `css/app.css`, `js/app.js` – själva appen
- `js/gif.js` – läsa/skapa GIF
- `lib/` – GIF-bibliotek (gifenc, omggif – MIT-licens)
- `sw.js`, `manifest.webmanifest`, `icons/` – gör appen installerbar och offline
