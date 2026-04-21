# Termin-Abstimmung

Eine moderne Webanwendung zur einfachen Terminfindung mit mehreren Abstimmungsmodi.

## 🚀 Features

### Vier Abstimmungsmodi

| Modus | Beschreibung |
|-------|-------------|
| **Feste Termine** | Ersteller definiert feste Zeitpunkte, Teilnehmer stimmen ab |
| **Freie Wahl** | Teilnehmer schlagen eigene Tage vor |
| **Zeitslots** | Ersteller definiert Zeitbereiche (z.B. 14:00-16:00) |
| **Zeitslots Freie Wahl** | Teilnehmer schlagen eigene Zeitbereiche vor |

### Zeitmanagement

- ✅ **Optionale Zeitslots** – Pro Tag können feste Zeiten oder Zeitbereiche definiert werden
- ✅ **Ganze Tage möglich** – Tage ohne Zeitslots gelten als "Ganzer Tag"
- ✅ **Mehrere Slots pro Tag** – Flexible Planung mit mehreren Zeitfenstern

### Ergebnisdarstellung

- 📊 **Matrix-Ansicht** – Übersichtliche Tabellenansicht aller Teilnehmer
- 📅 **Kalenderansicht** – Intuitive Darstellung mit Tag/Woche/Monat/Jahr
- 🎨 **Farbige Teilnehmer** – Jeder Teilnehmer hat eine eindeutige Farbe
- 📈 **Live-Ergebnisse** – Sofortige Aktualisierung bei neuen Antworten

## 🛠️ Tech Stack

- **Backend:** Node.js, Express, SQLite (better-sqlite3)
- **Frontend:** Vanilla JavaScript, CSS Grid/Flexbox
- **Auth:** Session-based mit bcrypt
- **Security:** CSRF-Schutz, Rate Limiting

## 🚀 Schnellstart

```bash
# Repository klonen
git clone https://github.com/Streuselshyper/termin-abstimmung.git

# Abhängigkeiten installieren
npm install

# Server starten
PORT=18793 npm start
```

Die Anwendung läuft dann unter `http://localhost:18793`

## 📁 Projektstruktur

```
termin-abstimmung/
├── server.js           # Express Server & API
├── public/
│   ├── index.html      # HTML Templates
│   ├── app.js          # Frontend Logik
│   └── style.css       # Styling & Layout
├── package.json
└── README.md
```

## 🔧 Konfiguration

Umgebungsvariablen:
- `PORT` – Server-Port (default: 3000)
- `HOST` – Bind-Adresse (default: 0.0.0.0)

## 📱 Screenshots

*Coming soon...*

## 📝 Lizenz

Private Project – Alle Rechte vorbehalten.

## 👤 Autor

Yannik Strauß – [GitHub](https://github.com/Streuselshyper)
