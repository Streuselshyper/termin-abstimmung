# Termin-Abstimmung

Moderne Web-App zur Terminfindung mit 8 verschiedenen Abstimmungsmodi.

## Features

### Abstimmungsmodi

1. **Feste Termine** - Konkrete Tage vorgeben, Teilnehmer sagen Ja/Vielleicht/Nein
2. **Blocktage** - Mehrere zusammenhängende Tage, Teilnehmer bewerten jeden möglichen Block
3. **Zeitfenster** - Feste Uhrzeiten pro Tag (z.B. 14:00-16:00)
4. **Sterne-Bewertung** - Termine mit 1-5 Sternen bewerten
5. **Freie Wahl** - Teilnehmer schlagen eigene Tage vor
6. **Freier Block** - Teilnehmer markieren verfügbare Tage, System findet den besten Block
7. **Freie Zeitslots** - Teilnehmer schlagen Tage mit Uhrzeiten vor
8. **Wochen-Rhythmus** - Wiederkehrender Wochentag + Uhrzeit

### Weitere Features

- Benutzer-Registrierung mit E-Mail-Verifikation
- Passwort-Reset per E-Mail
- Responsive Design (Desktop & Mobile)
- Dark/Light Mode
- Kalender-Export (ICS)
- Teilen-Funktion
- Admin-Tools pro Umfrage

## Technologien

- **Frontend**: Vanilla JavaScript, CSS Grid/Flexbox
- **Backend**: Node.js, Express
- **Datenbank**: SQLite (better-sqlite3)
- **E-Mail**: SMTP (z.B. SendGrid)
- **Auth**: Session-basiert mit bcrypt

## Installation

### Voraussetzungen

- Node.js 18+
- npm
- Git

### Schritte

```bash
# 1. Repository klonen
git clone https://github.com/Streuselshyper/termin-abstimmung.git
cd termin-abstimmung

# 2. Abhängigkeiten installieren
npm install

# 3. Umgebungsvariablen konfigurieren
cp .env.example .env
# .env editieren und eigene Werte eintragen

# 4. Server starten
node server.js
```

Die App läuft dann unter `http://localhost:18793`

## Konfiguration

### .env Beispiel

```env
# Server
PORT=18793
NODE_ENV=production

# Session
SESSION_SECRET=dein-geheimes-passwort-mindestens-32-zeichen

# Datenbank
DATABASE_PATH=./data/termin-abstimmung.db

# SMTP (z.B. SendGrid)
SMTP_HOST=smtp.sendgrid.net
SMTP_PORT=587
SMTP_USER=apikey
SMTP_PASS=dein-sendgrid-api-key
SMTP_FROM=noreply@deine-domain.de

# Optional: E-Mail-Benachrichtigungen
ENABLE_EMAIL_NOTIFICATIONS=true
DAILY_SUMMARY=true
```

### SMTP-Einrichtung (SendGrid)

1. Account erstellen bei [sendgrid.com](https://sendgrid.com)
2. API Key generieren unter Settings > API Keys
3. Sender-Adresse verifizieren unter Settings > Sender Authentication
4. API Key in `.env` eintragen

## Deployment

### Mit Systemd (Linux)

```bash
# Service-Datei erstellen
sudo nano /etc/systemd/system/termin-abstimmung.service
```

```ini
[Unit]
Description=Termin-Abstimmung
After=network.target

[Service]
Type=simple
User=www-data
WorkingDirectory=/var/www/termin-abstimmung
ExecStart=/usr/bin/node server.js
Restart=always
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
```

```bash
# Aktivieren und starten
sudo systemctl enable termin-abstimmung
sudo systemctl start termin-abstimmung
```

### Mit Reverse Proxy (Nginx)

```nginx
server {
    listen 80;
    server_name termin.deine-domain.de;
    
    location / {
        proxy_pass http://localhost:18793;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_cache_bypass $http_upgrade;
    }
}
```

### SSL (Let's Encrypt)

```bash
sudo certbot --nginx -d termin.deine-domain.de
```

## Entwicklung

```bash
# Im Entwicklungsmodus starten
NODE_ENV=development node server.js

# Code-Check
node --check public/app.js
node --check server.js
```

## Datenbank-Schema

Die SQLite-Datenbank enthält folgende Tabellen:

- **users** - Benutzerkonten
- **polls** - Umfragen
- **responses** - Antworten
- **time_slots** - Zeitfenster
- **sessions** - Session-Daten

## API-Endpunkte

### Auth
- `POST /api/auth/register` - Registrierung
- `POST /api/auth/login` - Login
- `POST /api/auth/logout` - Logout
- `POST /api/auth/forgot-password` - Passwort-Reset anfordern
- `POST /api/auth/reset-password` - Passwort zurücksetzen

### Umfragen
- `GET /api/polls` - Alle Umfragen
- `POST /api/polls` - Umfrage erstellen
- `GET /api/polls/:id` - Umfrage anzeigen
- `POST /api/polls/:id/responses` - Antwort abgeben
- `GET /api/polls/:id/results` - Ergebnisse

## Lizenz

MIT

## Autor

Yannik Strauß
