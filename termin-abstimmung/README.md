# Termin-Abstimmung

Moderne Termin-Abstimmungs-Webseite mit `Node.js`, `Express`, `better-sqlite3` und Vanilla JavaScript.

## Features

- Polls mit Titel, Beschreibung und beliebig vielen Datumsauswahlen
- Eindeutiger Share-Link pro Poll
- Verfügbarkeiten mit `Ja`, `Vielleicht`, `Nein`
- Automatische Berechnung der besten Termine
- Heatmap-artige Auswertung und Teilnehmermatrix
- Dark/Light-Mode, responsive Layout, mobile nutzbar
- Login mit E-Mail/Passwort, Dashboard und Account-Verwaltung
- Teilnahme an Umfragen weiterhin ohne Login per Namen möglich

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

- `POST /api/polls` erstellt einen Poll (eingeloggt)
- `GET /api/polls/:pollId` lädt Poll, Antworten und Auswertung
- `POST /api/polls/:pollId/responses` speichert oder aktualisiert eine Antwort
- `DELETE /api/polls/:pollId` löscht einen eigenen Poll (eingeloggt + CSRF)

## Hinweise

- Die SQLite-Datenbank wird automatisch unter `data/terminabstimmung.db` angelegt.
- Antworten werden pro Poll und Name aktualisiert, statt doppelt angelegt zu werden.
- Für Produktion kann der Port über `PORT` gesetzt werden.
- Der Host kann über `HOST` gesetzt werden (Default: `0.0.0.0`).
- Optional kann `APP_BASE_URL` gesetzt werden, um stabile absolute Links (z. B. für Passwort-Reset) zu erzeugen.
