# 🛠️ Coding-Richtlinien für Codex (Yanniks Projekte)

_Letzte Aktualisierung: 2026-04-10 – Git Workflow & Branch-Regeln hinzugefügt_

## 1. Rollenverteilung
- **Haupt-Agent (Santa Claw):** Architekt & Planer. Schreibt KEINEN Code direkt.
- **Sub-Agent (Codex via ACP):** Einziger Code-Editor für alle Coding-Tasks.

## 2. Arbeitsweise & Qualität
- **Sprache:** Deutsch für Kommentare und Commits.
- **Struktur:** Eigene Unterordner für jedes Projekt in `~/meine-projekte`.
- **Sicherheit:** Commits vor großen Änderungen.

## 3. GitHub-Integration
- **Repos immer als PRIVATE erstellen** (`gh repo create <name> --private`). Keine Ausnahmen.
- Automatischer Push via SSH-Key bei stabilen Ständen.

## 4. Coding-Task Ausführung – STANDARD-WORKFLOW

### ✅ ACP (Agent Control Protocol) – IMMER verwenden
**Wann:** Alle Coding-Tasks – von einfachen Scripts bis komplexen Projekten.

**Wie:**
```javascript
sessions_spawn({
  runtime: "acp",
  agentId: "codex",
  mode: "run",           // oder "session" für persistente Arbeit
  task: "Beschreibung der Aufgabe",
  streamTo: "parent",    // WICHTIG: Echtzeit-Updates sehen
  // Optional: cwd: "~/meine-projekte/projektname"
})
```

**Danach IMMER:**
1. `sessions_yield()` – Warte auf Sub-Agent Ergebnis
2. Stream-Logs überwachen
3. Bei Fehlern: Debugging versuchen
4. Ergebnis verifizieren (Dateien prüfen)
5. Statusbericht an Yannik

**Vorteile:**
- Vollständiges Session-Management
- Echtzeit-Updates via `--streamTo: "parent"`
- Fehler-Diagnose im Stream möglich
- `/acp` Kommandos für Steuerung

## 5. Fehlerbehandlung

### Häufige ACP-Probleme & Lösungen

| Problem | Ursache | Lösung |
|---------|---------|--------|
| "Permission denied by ACP runtime" | `permissionMode` blockiert Schreibzugriffe | Bereits gefixt: `approve-all` ist gesetzt |
| Keine Dateien erstellt | Task zu vage oder Pfad falsch | Klare Pfade angeben: `~/meine-projekte/...` |
| Stream nicht sichtbar | `streamTo` vergessen | IMMER `streamTo: "parent"` setzen |

### Modell-Konfiguration & Wechsel in Codex

**ERZWUNGEN: Nur diese beiden Modelle verwenden!**

| Modell | Verwendung |
|--------|------------|
| `gpt-5.4` | Maximum Performance, komplexe Architektur-Entscheidungen |
| `gpt-5.3-codex` | Standard für Coding-Tasks (optimiert für Code) |

**NIE ohne Modell-Flag starten!** Immer explizit `-m` angeben.

**Globale Config:**
```bash
# ~/.codex/config.json
{
  "model": "gpt-5.3-codex",
  "model_provider": "openai"
}
```

**CLI-Befehle (IMMER Modell angeben!):**

```bash
# Standard für Coding (empfohlen)
codex exec -m gpt-5.3-codex --full-auto "task"

# Für komplexe Aufgaben
ncodex exec -m gpt-5.4 --full-auto "task"
```

**Slash-Commands im interaktiven Modus (immer als einzelne Nachricht senden):**

| Befehl | Beschreibung | Beispiel |
|--------|--------------|----------|
| `/model <name>` | Modell wechseln | `/model gpt-5.4` oder `/model gpt-5.3-codex` |
| `/context` | Aktuellen Kontext anzeigen | `/context` |
| `/reset` | Session zurücksetzen | `/reset` |
| `/run <cmd>` | Befehl/Code ausführen | `/run python main.py` |
| `/approval <mode>` | Berechtigungen einstellen | `/approval auto` |
| `/files` | Geladene Dateien anzeigen | `/files` |
| `/diff` | Code-Änderungen anzeigen | `/diff` |
| `/save [name]` | Session speichern (optional) | `/save session1` |
| `/load <name>` | Session laden (optional) | `/load session1` |
| `/help` | Alle Commands anzeigen | `/help` |
| `/exit` | Codex beenden | `/exit` |

**Wichtig:** Funktioniert nur mit Netzwerkzugriff (nicht in strikter Sandbox)

### ⚠️ WAS NICHT KLAPPT (Fehler vermeiden!)

| Falsch | Richtig |
|--------|---------|
| `runtime: "subagent"` + `agentId: "codex"` ❌ | `runtime: "acp"` + `agentId: "codex"` ✅ |
| `agents_list` zeigt Codex ❌ | ACP-Harness ist separat, nutze direkt `runtime: "acp"` ✅ |

**Merksatz:** `subagent`-Runtime hat keine erlaubten Agents. Für Codex IMMER `runtime: "acp"` verwenden.

### Debugging-Prozess
1. Stream-Log lesen (`tail -50 ...acp-stream.jsonl`)
2. Fehler identifizieren
3. Prompt anpassen oder Config prüfen
4. Session neu starten
5. Nach 5 Versuchen: Yannik melden

## 6. Git & GitHub Workflow

### ⚠️ BRANCH-REGELN (WICHTIG!)

**NIE Feature-Branches oder `master` verwenden!**

| Falsch | Richtig |
|--------|---------|
| Auf `feature/...` Branch committen ❌ | Immer auf `main` arbeiten ✅ |
| `master` statt `main` nutzen ❌ | `main` ist Default ✅ |
| Existierende Branches ignorieren ❌ | Erst `git branch -a` prüfen ✅ |

**Workflow vor jedem Commit:**
1. `git status` – Wo bin ich?
2. `git branch -a` – Alle Branches anzeigen
3. Falls auf falschem Branch: `git checkout main`
4. Falls alter Branch existiert: `git branch -D <alter-branch>`
5. Dann erst: `git add`, `git commit`, `git push`

### GitHub Repo Management

**Neues Projekt sichern:**
```bash
cd ~/meine-projekte/<projekt>
git init
git config user.email "yannik.strauss@gmx.de"
git config user.name "Yannik Strauß"
git add .
git commit -m "Initial commit"
gh repo create <name> --private --source=. --push
```

**Bestehende Repos aktualisieren:**
```bash
cd ~/meine-projekte/<projekt>
git checkout main 2>/dev/null || git checkout -b main
git branch -D <alter-branch> 2>/dev/null || true
git add .
git commit -m "Update: ..." || true
git push -u origin main
```

**Default Branch ändern (GitHub):**
1. GitHub → Repo → Settings → Branches
2. Default branch auf `main` umstellen
3. Alten Branch löschen: `gh api -X DELETE repos/Streuselshyper/<repo>/git/refs/heads/master`

## 7. Checkliste vor Coding-Task

- [ ] Ordner in `~/meine-projekte/` vorhanden?
- [ ] Task ist klar und spezifisch formuliert?
- [ ] `sessions_spawn` mit `runtime: "acp"`?
- [ ] `streamTo: "parent"` gesetzt?
- [ ] Nach `sessions_yield` Stream überwacht?
- [ ] Ergebnis verifiziert (Dateien existieren, Inhalt geprüft)?
- [ ] **Statusbericht SOFORT nach Abschluss senden** – nicht auf Rückfrage warten!

## 7. Erinnerung
- **KEIN Code selbst schreiben** – immer Codex via ACP nutzen.
- **Vorher `coding-rules.md` lesen** – in jeder Session.
- **Repos PRIVATE** – immer.
- **Melden bei 5 Fehlversuchen** – nicht endlos probieren.
- **SOFORT reporten nach Abschluss** – passive Wartezeit = Fehler!

## 8. Codex Timeout & Wartezeit Regeln (NEU)

**WICHTIG:**
1. **AUF ANNOUNCE-NACHRICHT WARTEN** – Kein vorzeitiges Polling per `ls` oder `git status`!
2. **Standard-Timeout:** 120 Sekunden für komplexe Tasks (Canvas, Animationen)
3. **Erst nach 10 MINUTEN ohne Announce eingreifen**
4. Dann Fallback: Task wiederholen oder selbst fixen

**Warum:** Codex schreibt oft erfolgreich, aber die Rückmeldung verzögert sich. Vorzeitiges Polling zeigt falsche "Timeout"-Ergebnisse.

---

**Test-Status:** ✅ ACP-Workflow validiert am 2026-04-10 mit finger-roulette Projekt (kimi-k2.5).
