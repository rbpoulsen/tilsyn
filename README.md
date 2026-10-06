# Tilsyn – veje og pladser · Aabenraa Kommune

Webapp (PWA) til fotoregistrering ved tilsyn. Kører helt i browseren, uden server-backend.

## Funktioner
- **Tag billede** åbner telefonens kamera. GPS-position, dato og tid kommer automatisk på.
- **Galleri**: hent et eksisterende billede. Position og tidspunkt læses fra billedets EXIF-data, hvis de findes.
- Positionen vises på et lille OSM-kort i formularen. Du kan trække markøren eller trykke på kortet for at rette den.
- Hver registrering knyttes til et **projekt** og får kategori, prioritet (lav/middel/høj), status og en beskrivende tekst.
- **Kort**: alle registreringer på OpenStreetMap, farvet efter prioritet og nummereret som i Excel. Du kan filtrere på projekt.
- **Adresse** slås op automatisk via OSM Nominatim, når der er netforbindelse.
- **Eksportér til Excel** pr. projekt: nr., dato, tid, billede (indlejret), adresse, koordinater, nøjagtighed, link til OSM, kategori, prioritet, status og beskrivelse.
- Virker offline efter første besøg. Kan installeres på hjemmeskærmen ("Føj til hjemmeskærm").
- Sikkerhedskopi: alle data og billeder kan gemmes som én JSON-fil og indlæses på en anden enhed.

## Design
Appen og Excel-eksporten følger Aabenraa Kommunes designsystem, spor 1 (sags- og myndighedskommunikation):
- Kun den primære palet: blå `#095aa6` (og dens opacitetstrin), grå, sort og hvid. Prioritet vises med tekst og blåtonens styrke (lav 20 %, middel 60 %, høj 100 %), aldrig med farve alene.
- Montserrat (Black til rubrikker, Light til underrubrikker) i appen, ligger lokalt i `fonts/`. Verdana i Excel, som er Office-standarden.
- Logo (1. prioritet) øverst til højre på hvid med respektafstand. Buen ligger fra kant til kant i bunden af appen og under tabellen i Excel (blå 20 %, som på brevpapir).
- Skarpe hjørner, ingen skygger eller forløb, al tekst venstrestillet.
- Excel-sidefod: Aabenraa Kommune · Skelbækvej 2 · 6200 Aabenraa · aabenraa.dk
- Logo, byvåben og bue i `brand/` er de originale filer fra designsystemet. App-ikonet er byvåbnet på hvid.

## Data
Alt gemmes lokalt i browserens database (IndexedDB) på den enkelte enhed. Ingen data sendes til en server,
bortset fra koordinater til adresseopslaget hos Nominatim. Eksportér og tag sikkerhedskopi jævnligt.

## Drift
Appen består kun af statiske filer. **Den skal serveres over https**, ellers spærrer browseren for GPS.
Eksempler:
- GitHub Pages / Netlify / Azure Static Web Apps: upload mappens indhold.
- Lokal test: `python3 -m http.server 8000` og åbn http://localhost:8000 (localhost tæller som sikker).

## Filer
- `index.html`, `style.css`, `app.js`: selve appen
- `sw.js`, `manifest.webmanifest`, `icons/`: offline og installation
- `brand/`, `fonts/`: Aabenraa Kommunes logo, byvåben, bue og Montserrat
- `vendor/`: Leaflet 1.9.4 (kort), ExcelJS 4.4.0 (Excel), exifr 7.1.3 (EXIF)

Kortdata © OpenStreetMap-bidragydere. Ved stort forbrug bør du bruge en egen tile-server eller udbyder, jf. OSM's tile usage policy.
