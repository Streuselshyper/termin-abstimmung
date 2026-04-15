# Termin-Abstimmung

Moderne Termin-Abstimmungs-Webseite mit `Node.js`, `Express`, `better-sqlite3` und Vanilla JavaScript.

## Features

- Polls mit Titel, Beschreibung und beliebig vielen Datumsauswahlen
- Eindeutiger Share-Link pro Poll
- Verfügbarkeiten mit `Ja`, `Vielleicht`, `Nein`
- Automatische Berechnung der besten Termine
- Heatmap-artige Auswertung und Teilnehmermatrix
- Dark/Light-Mode, responsive Layout, mobile nutzbar
- Keine Anmeldung, nur Name erforderlich

## Setup

```bash
npm install
npm start
```

Die Anwendung läuft standardmäßig auf `http://localhost:3000`.

## Projektstruktur

```text
termin-abstimmung/
├── data/
├── public/
│   ├── app.js
│   ├── index.html
│   └── style.css
├── package.json
├── server.js
└── README.md
```

## API-Endpunkte

- `POST /api/polls` erstellt einen Poll
- `GET /api/polls/:pollId` lädt Poll, Antworten und Auswertung
- `POST /api/polls/:pollId/responses` speichert oder aktualisiert eine Antwort

## Hinweise

- Die SQLite-Datenbank wird automatisch unter `data/terminabstimmung.db` angelegt.
- Antworten werden pro Poll und Name aktualisiert, statt doppelt angelegt zu werden.
- Für Produktion kann der Port über `PORT` gesetzt werden.
