const appElement = document.querySelector("#app");
const themeToggle = document.querySelector("#theme-toggle");
const weekdayLabels = ["Mo", "Di", "Mi", "Do", "Fr", "Sa", "So"];
const statusLabels = {
  yes: "Ja",
  maybe: "Vielleicht",
  no: "Nein",
};

const state = {
  selectedDates: new Set(),
  currentMonth: startOfMonth(new Date()),
  participantSelectedDates: new Set(),
  participantCurrentMonth: startOfMonth(new Date()),
  pollData: null,
  responseDraft: {},
  createMode: "fixed",
};

initializeApp().catch((error) => {
  console.error(error);
  appElement.innerHTML =
    '<section class="panel"><h1>Fehler</h1><p>Die Ansicht konnte nicht geladen werden.</p></section>';
});

themeToggle.addEventListener("click", toggleTheme);
applyStoredTheme();

async function initializeApp() {
  const pollId = getPollIdFromPath();
  if (pollId) {
    await renderPollPage(pollId);
    return;
  }

  renderHomePage();
}

function applyStoredTheme() {
  const storedTheme = localStorage.getItem("termin-theme");
  if (storedTheme === "light") {
    document.body.dataset.theme = "light";
    themeToggle.innerHTML = '<i class="fa-regular fa-sun"></i>';
  }
}

function toggleTheme() {
  const nextTheme = document.body.dataset.theme === "light" ? "dark" : "light";
  if (nextTheme === "light") {
    document.body.dataset.theme = "light";
    localStorage.setItem("termin-theme", "light");
    themeToggle.innerHTML = '<i class="fa-regular fa-sun"></i>';
    return;
  }

  delete document.body.dataset.theme;
  localStorage.setItem("termin-theme", "dark");
  themeToggle.innerHTML = '<i class="fa-regular fa-moon"></i>';
}

function getPollIdFromPath() {
  const match = window.location.pathname.match(/^\/poll\/([a-z0-9]+)$/i);
  return match ? match[1] : null;
}

function renderHomePage() {
  const template = document.querySelector("#home-template");
  appElement.innerHTML = "";
  appElement.appendChild(template.content.cloneNode(true));

  renderCalendar();
  renderSelectedDates();
  syncCreateModeUi();

  document.querySelector("#prev-month").addEventListener("click", () => {
    state.currentMonth = addMonths(state.currentMonth, -1);
    renderCalendar();
  });

  document.querySelector("#next-month").addEventListener("click", () => {
    state.currentMonth = addMonths(state.currentMonth, 1);
    renderCalendar();
  });

  document.querySelector("#clear-dates").addEventListener("click", () => {
    state.selectedDates.clear();
    renderCalendar();
    renderSelectedDates();
  });

  document.querySelectorAll('input[name="mode"]').forEach((input) => {
    input.addEventListener("change", () => {
      state.createMode = input.value;
      syncCreateModeUi();
    });
  });

  document.querySelector("#create-poll-form").addEventListener("submit", handleCreatePoll);
}

function syncCreateModeUi() {
  const fixedFields = document.querySelector("#fixed-mode-fields");
  const freeFields = document.querySelector("#free-mode-fields");
  if (!fixedFields || !freeFields) {
    return;
  }

  const isFixed = state.createMode === "fixed";
  fixedFields.classList.toggle("is-hidden", !isFixed);
  freeFields.classList.toggle("is-hidden", isFixed);
}

function renderCalendar() {
  const calendarGrid = document.querySelector("#calendar-grid");
  const calendarLabel = document.querySelector("#calendar-label");
  if (!calendarGrid || !calendarLabel) {
    return;
  }

  const year = state.currentMonth.getFullYear();
  const month = state.currentMonth.getMonth();
  calendarLabel.textContent = formatMonthYear(state.currentMonth);
  calendarGrid.innerHTML = "";

  for (const weekday of weekdayLabels) {
    const cell = document.createElement("div");
    cell.className = "calendar-weekday";
    cell.textContent = weekday;
    calendarGrid.appendChild(cell);
  }

  const days = buildCalendarDays(year, month);
  for (const day of days) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "calendar-day";
    if (!day.inCurrentMonth) {
      button.classList.add("muted");
    }
    if (state.selectedDates.has(day.isoDate)) {
      button.classList.add("selected");
    }

    button.innerHTML = `<span>${day.date.getDate()}</span>`;
    button.addEventListener("click", () => {
      if (state.selectedDates.has(day.isoDate)) {
        state.selectedDates.delete(day.isoDate);
      } else {
        state.selectedDates.add(day.isoDate);
      }
      renderCalendar();
      renderSelectedDates();
    });

    calendarGrid.appendChild(button);
  }
}

function renderSelectedDates() {
  const container = document.querySelector("#selected-dates");
  if (!container) {
    return;
  }

  const dates = Array.from(state.selectedDates).sort();
  if (dates.length === 0) {
    container.innerHTML = '<p class="description">Noch keine Termine ausgewählt.</p>';
    return;
  }

  container.innerHTML = "";
  for (const date of dates) {
    const pill = document.createElement("div");
    pill.className = "selected-date-pill";
    pill.innerHTML = `
      <span>${formatDateLong(date)}</span>
      <button type="button" aria-label="Datum entfernen">
        <i class="fa-solid fa-xmark"></i>
      </button>
    `;
    pill.querySelector("button").addEventListener("click", () => {
      state.selectedDates.delete(date);
      renderCalendar();
      renderSelectedDates();
    });
    container.appendChild(pill);
  }
}

async function handleCreatePoll(event) {
  event.preventDefault();

  const feedback = document.querySelector("#form-feedback");
  const title = document.querySelector("#poll-title").value.trim();
  const description = document.querySelector("#poll-description").value.trim();
  const dates = Array.from(state.selectedDates).sort();

  if (state.createMode === "fixed" && dates.length === 0) {
    setFeedback(feedback, "Bitte wähle mindestens ein Datum aus.", "error");
    return;
  }

  try {
    setFeedback(feedback, "Poll wird erstellt ...");
    const response = await fetch("/api/polls", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title,
        description,
        mode: state.createMode,
        dates,
      }),
    });

    const data = await response.json();
    if (!response.ok) {
      throw new Error(data.error || "Der Poll konnte nicht erstellt werden.");
    }

    window.location.href = data.poll.shareUrl;
  } catch (error) {
    setFeedback(feedback, error.message, "error");
  }
}

async function renderPollPage(pollId) {
  const template = document.querySelector("#poll-template");
  appElement.innerHTML =
    '<section class="panel"><p class="description">Poll wird geladen ...</p></section>';

  const response = await fetch(`/api/polls/${pollId}`);
  const data = await response.json();
  if (!response.ok) {
    appElement.innerHTML = `<section class="panel"><h1>Nicht gefunden</h1><p>${escapeHtml(
      data.error || "Der Poll existiert nicht."
    )}</p></section>`;
    return;
  }

  state.pollData = data;
  appElement.innerHTML = "";
  appElement.appendChild(template.content.cloneNode(true));

  initializeDraftFromPoll(data.poll);
  fillPollSummary();
  renderAvailabilityForm();
  renderHeatmap();
  renderResultsTable();

  document.querySelector("#response-form").addEventListener("submit", handleResponseSubmit);
  document.querySelector("#share-button").addEventListener("click", sharePollLink);
}

function initializeDraftFromPoll(poll) {
  if (poll.mode === "free") {
    state.responseDraft = {};
    state.participantSelectedDates = new Set();
    state.participantCurrentMonth = startOfMonth(new Date());
    return;
  }

  const defaultDraft = {};
  for (const date of poll.dates) {
    defaultDraft[date] = "maybe";
  }

  state.responseDraft = defaultDraft;
  state.participantSelectedDates = new Set();
  state.participantCurrentMonth = startOfMonth(new Date());
}

function fillPollSummary() {
  const { poll, responses, results } = state.pollData;
  const isFixed = poll.mode === "fixed";
  document.querySelector("#poll-title-view").textContent = poll.title;
  document.querySelector("#poll-description-view").textContent = poll.description;
  document.querySelector("#poll-mode-pill").textContent = isFixed ? "Festgelegte Termine" : "Freie Wahl";
  document.querySelector("#poll-date-count").textContent = isFixed
    ? `${poll.dates.length} Termine`
    : "Beliebige Tage";
  document.querySelector("#poll-response-count").textContent = `${responses.length} Antworten`;
  document.querySelector("#poll-mode-description").textContent = isFixed
    ? "Teilnehmende stimmen pro festem Termin mit Ja, Vielleicht oder Nein ab."
    : "Teilnehmende wählen selbst beliebige Kalendertage. Das Ergebnis zeigt die am häufigsten gewählten Termine.";

  const bestDateEyebrow = document.querySelector("#best-date-eyebrow");
  const bestDateLabel = document.querySelector("#best-date-label");
  const bestDateMeta = document.querySelector("#best-date-meta");
  const resultsPanelEyebrow = document.querySelector("#results-panel-eyebrow");
  const resultsPanelTitle = document.querySelector("#results-panel-title");
  bestDateMeta.innerHTML = "";

  if (!isFixed) {
    bestDateEyebrow.textContent = "Am häufigsten genannt";
    resultsPanelEyebrow.textContent = "Ranking";
    resultsPanelTitle.textContent = "Beliebteste Tage";

    if (results.bestDates.length === 0) {
      bestDateLabel.textContent = "Noch keine Antworten";
      bestDateMeta.innerHTML = '<span class="pill">Noch keine Vorschläge eingegangen</span>';
      return;
    }

    bestDateLabel.textContent = results.bestDates.map((entry) => formatDateLong(entry.date)).join(" · ");
    for (const entry of results.bestDates) {
      const meta = document.createElement("span");
      meta.className = "pill";
      meta.textContent = `${entry.count} Personen`;
      bestDateMeta.appendChild(meta);
    }
    return;
  }

  bestDateEyebrow.textContent = "Beste Termine";
  resultsPanelEyebrow.textContent = "Heatmap";
  resultsPanelTitle.textContent = "Beste Überschneidungen";

  if (results.bestDates.length === 0 || responses.length === 0) {
    bestDateLabel.textContent = "Noch keine Antworten";
    bestDateMeta.textContent = "Sobald Teilnehmende antworten, erscheint hier die beste Option.";
    return;
  }

  bestDateLabel.textContent = results.bestDates.map((entry) => formatDateShort(entry.date)).join(" · ");
  for (const entry of results.bestDates) {
    const meta = document.createElement("span");
    meta.className = "pill";
    meta.textContent = `${entry.yes} Ja · ${entry.maybe} Vielleicht · Score ${entry.score}`;
    bestDateMeta.appendChild(meta);
  }
}

function renderAvailabilityForm() {
  const grid = document.querySelector("#availability-grid");
  const legend = document.querySelector("#availability-legend");
  grid.innerHTML = "";

  if (state.pollData.poll.mode === "free") {
    legend.classList.add("is-hidden");
    renderFreeChoiceForm(grid);
    return;
  }

  legend.classList.remove("is-hidden");

  for (const date of state.pollData.poll.dates) {
    const card = document.createElement("div");
    card.className = "availability-card";
    card.innerHTML = `<strong>${formatDateLong(date)}</strong>`;

    const row = document.createElement("div");
    row.className = "status-row";

    for (const status of ["yes", "maybe", "no"]) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "status-chip";
      button.dataset.date = date;
      button.dataset.status = status;
      button.textContent = statusLabels[status];
      if (state.responseDraft[date] === status) {
        button.classList.add("active");
      }
      button.addEventListener("click", () => {
        state.responseDraft[date] = status;
        renderAvailabilityForm();
      });
      row.appendChild(button);
    }

    card.appendChild(row);
    grid.appendChild(card);
  }
}

function renderFreeChoiceForm(grid) {
  const intro = document.createElement("div");
  intro.className = "free-mode-intro";
  intro.innerHTML = `
    <strong>Wähle alle Tage, an denen du kannst</strong>
    <p class="description">Du kannst beliebige Tage im Kalender markieren, auch in anderen Monaten oder Jahren.</p>
  `;

  const calendarSection = document.createElement("div");
  calendarSection.className = "calendar-section";
  calendarSection.innerHTML = `
    <div class="calendar-header">
      <div>
        <h3>Kalender</h3>
        <p id="participant-calendar-label" class="calendar-meta"></p>
      </div>
      <div class="calendar-actions">
        <button id="participant-prev-month" class="ghost-button compact-button" type="button" aria-label="Vorheriger Monat">
          <i class="fa-solid fa-chevron-left"></i>
        </button>
        <button id="participant-next-month" class="ghost-button compact-button" type="button" aria-label="Nächster Monat">
          <i class="fa-solid fa-chevron-right"></i>
        </button>
      </div>
    </div>
    <div id="participant-calendar-grid" class="calendar-grid" aria-live="polite"></div>
    <div class="selected-dates-box">
      <div class="selected-header">
        <span>Deine gewählten Tage</span>
        <button id="participant-clear-dates" class="text-button" type="button">Leeren</button>
      </div>
      <div id="participant-selected-dates" class="selected-dates"></div>
    </div>
  `;

  grid.appendChild(intro);
  grid.appendChild(calendarSection);

  document.querySelector("#participant-prev-month").addEventListener("click", () => {
    state.participantCurrentMonth = addMonths(state.participantCurrentMonth, -1);
    renderAvailabilityForm();
  });

  document.querySelector("#participant-next-month").addEventListener("click", () => {
    state.participantCurrentMonth = addMonths(state.participantCurrentMonth, 1);
    renderAvailabilityForm();
  });

  document.querySelector("#participant-clear-dates").addEventListener("click", () => {
    state.participantSelectedDates.clear();
    renderAvailabilityForm();
  });

  renderParticipantCalendar();
  renderParticipantSelectedDates();
}

function renderParticipantCalendar() {
  const calendarGrid = document.querySelector("#participant-calendar-grid");
  const calendarLabel = document.querySelector("#participant-calendar-label");
  if (!calendarGrid || !calendarLabel) {
    return;
  }

  const year = state.participantCurrentMonth.getFullYear();
  const month = state.participantCurrentMonth.getMonth();
  calendarLabel.textContent = formatMonthYear(state.participantCurrentMonth);
  calendarGrid.innerHTML = "";

  for (const weekday of weekdayLabels) {
    const cell = document.createElement("div");
    cell.className = "calendar-weekday";
    cell.textContent = weekday;
    calendarGrid.appendChild(cell);
  }

  const days = buildCalendarDays(year, month);
  for (const day of days) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "calendar-day";
    if (!day.inCurrentMonth) {
      button.classList.add("muted");
    }
    if (state.participantSelectedDates.has(day.isoDate)) {
      button.classList.add("selected");
    }

    button.innerHTML = `<span>${day.date.getDate()}</span>`;
    button.addEventListener("click", () => {
      if (state.participantSelectedDates.has(day.isoDate)) {
        state.participantSelectedDates.delete(day.isoDate);
      } else {
        state.participantSelectedDates.add(day.isoDate);
      }
      renderAvailabilityForm();
    });

    calendarGrid.appendChild(button);
  }
}

function renderParticipantSelectedDates() {
  const container = document.querySelector("#participant-selected-dates");
  if (!container) {
    return;
  }

  const dates = Array.from(state.participantSelectedDates).sort();
  if (dates.length === 0) {
    container.innerHTML = '<p class="description">Noch keine Tage ausgewählt.</p>';
    return;
  }

  container.innerHTML = "";
  for (const date of dates) {
    const pill = document.createElement("div");
    pill.className = "selected-date-pill";
    pill.innerHTML = `
      <span>${formatDateLong(date)}</span>
      <button type="button" aria-label="Datum entfernen">
        <i class="fa-solid fa-xmark"></i>
      </button>
    `;
    pill.querySelector("button").addEventListener("click", () => {
      state.participantSelectedDates.delete(date);
      renderAvailabilityForm();
    });
    container.appendChild(pill);
  }
}

function renderHeatmap() {
  const grid = document.querySelector("#heatmap-grid");
  const { poll, responses, results } = state.pollData;
  grid.innerHTML = "";

  if (poll.mode === "free") {
    if (results.summary.length === 0) {
      grid.innerHTML = '<p class="description">Noch keine Tagesvorschläge vorhanden.</p>';
      return;
    }

    for (const entry of results.summary) {
      const card = document.createElement("article");
      card.className = "heatmap-cell high free-ranking-card";
      const participantLabel =
        entry.count === 1 ? "1 Person" : `${entry.count} Personen`;
      card.innerHTML = `
        <strong>${formatDateLong(entry.date)}</strong>
        <span>${participantLabel}</span>
      `;
      grid.appendChild(card);
    }
    return;
  }

  const summary = results.summary;
  if (summary.length === 0) {
    grid.innerHTML = '<p class="description">Noch keine Daten vorhanden.</p>';
    return;
  }

  const maxScore = Math.max(...summary.map((entry) => entry.score), 1);
  for (const entry of summary) {
    const cell = document.createElement("article");
    const ratio = entry.score / maxScore;
    const level = ratio > 0.66 ? "high" : ratio > 0.33 ? "mid" : "low";
    cell.className = `heatmap-cell ${level}`;
    cell.innerHTML = `
      <strong>${formatDateShort(entry.date)}</strong>
      <span>${entry.yes} Ja</span>
      <span>${entry.maybe} Vielleicht</span>
      <span>${entry.no} Nein</span>
      <strong>Score ${entry.score}</strong>
    `;
    grid.appendChild(cell);
  }
}

function renderResultsTable() {
  const { poll, responses } = state.pollData;
  const head = document.querySelector("#results-head");
  const body = document.querySelector("#results-body");

  if (poll.mode === "free") {
    head.innerHTML = `
      <tr>
        <th>Name</th>
        <th>Vorgeschlagene Tage</th>
      </tr>
    `;

    if (responses.length === 0) {
      body.innerHTML = `
        <tr>
          <td colspan="2" class="description">Noch keine Antworten eingetragen.</td>
        </tr>
      `;
      return;
    }

    body.innerHTML = responses
      .map((response) => {
        const items = response.suggestedDates
          .map((entry) => `<li>${escapeHtml(formatDateLong(entry))}</li>`)
          .join("");

        return `
          <tr>
            <td>${escapeHtml(response.name)}</td>
            <td><ul class="result-list">${items || "<li>Keine Tage eingetragen</li>"}</ul></td>
          </tr>
        `;
      })
      .join("");
    return;
  }

  head.innerHTML = `
    <tr>
      <th>Name</th>
      ${poll.dates.map((date) => `<th>${formatDateShort(date)}</th>`).join("")}
    </tr>
  `;

  if (responses.length === 0) {
    body.innerHTML = `
      <tr>
        <td colspan="${poll.dates.length + 1}" class="description">Noch keine Antworten eingetragen.</td>
      </tr>
    `;
    return;
  }

  body.innerHTML = responses
    .map((response) => {
      const cells = poll.dates
        .map((date) => {
          const status = response.availabilities[date];
          return `<td><span class="result-badge ${status}">${statusLabels[status]}</span></td>`;
        })
        .join("");

      return `<tr><td>${escapeHtml(response.name)}</td>${cells}</tr>`;
    })
    .join("");
}

async function handleResponseSubmit(event) {
  event.preventDefault();

  const feedback = document.querySelector("#response-feedback");
  const name = document.querySelector("#participant-name").value.trim();
  const isFixed = state.pollData.poll.mode === "fixed";
  const payload = { name };

  if (isFixed) {
    payload.availabilities = state.responseDraft;
  } else {
    payload.suggestedDates = Array.from(state.participantSelectedDates).sort();
  }

  try {
    setFeedback(feedback, "Antwort wird gespeichert ...");
    const response = await fetch(`/api/polls/${state.pollData.poll.id}/responses`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    const data = await response.json();
    if (!response.ok) {
      throw new Error(data.error || "Die Antwort konnte nicht gespeichert werden.");
    }

    state.pollData = data;
    if (!isFixed) {
      state.participantSelectedDates = new Set();
      state.participantCurrentMonth = startOfMonth(new Date());
    }
    fillPollSummary();
    renderAvailabilityForm();
    renderHeatmap();
    renderResultsTable();
    setFeedback(feedback, "Antwort gespeichert.", "success");
  } catch (error) {
    setFeedback(feedback, error.message, "error");
  }
}

async function sharePollLink() {
  const shareUrl = window.location.href;
  if (navigator.share) {
    try {
      await navigator.share({
        title: state.pollData.poll.title,
        text: "Trag dich in diese Termin-Abstimmung ein.",
        url: shareUrl,
      });
      return;
    } catch (error) {
      if (error.name === "AbortError") {
        return;
      }
    }
  }

  await navigator.clipboard.writeText(shareUrl);
  const feedback = document.querySelector("#response-feedback");
  setFeedback(feedback, "Link wurde in die Zwischenablage kopiert.", "success");
}

function setFeedback(element, message, type = "") {
  element.textContent = message;
  element.className = `feedback ${type}`.trim();
}

function buildCalendarDays(year, month) {
  const firstDay = new Date(year, month, 1);
  const lastDay = new Date(year, month + 1, 0);
  const prefix = (firstDay.getDay() + 6) % 7;
  const suffix = 6 - ((lastDay.getDay() + 6) % 7);
  const days = [];

  for (let index = prefix; index > 0; index -= 1) {
    const date = new Date(year, month, 1 - index);
    days.push({ date, isoDate: toIsoDate(date), inCurrentMonth: false });
  }

  for (let day = 1; day <= lastDay.getDate(); day += 1) {
    const date = new Date(year, month, day);
    days.push({ date, isoDate: toIsoDate(date), inCurrentMonth: true });
  }

  for (let day = 1; day <= suffix; day += 1) {
    const date = new Date(year, month + 1, day);
    days.push({ date, isoDate: toIsoDate(date), inCurrentMonth: false });
  }

  return days;
}

function startOfMonth(date) {
  return new Date(date.getFullYear(), date.getMonth(), 1);
}

function addMonths(date, delta) {
  return new Date(date.getFullYear(), date.getMonth() + delta, 1);
}

function toIsoDate(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function formatMonthYear(date) {
  return new Intl.DateTimeFormat("de-DE", {
    month: "long",
    year: "numeric",
  }).format(date);
}

function formatDateLong(date) {
  return new Intl.DateTimeFormat("de-DE", {
    weekday: "short",
    day: "2-digit",
    month: "short",
    year: "numeric",
  }).format(new Date(`${date}T00:00:00`));
}

function formatDateShort(date) {
  return new Intl.DateTimeFormat("de-DE", {
    day: "2-digit",
    month: "2-digit",
  }).format(new Date(`${date}T00:00:00`));
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
