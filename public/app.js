const navElement = document.querySelector("#topbar-nav");
const topbarPrimaryElement = document.querySelector("#topbar-primary");
const themeToggle = document.querySelector("#theme-toggle");
const dynamicViewElement = document.querySelector("#dynamic-view");
const toastElement = document.querySelector("#toast");
const staticViewIds = ["landing-view", "login-view", "register-view", "forgot-password-view", "dynamic-view"];
const firstDayOfWeek = 1;
const weekdayLabelsByDayIndex = ["So", "Mo", "Di", "Mi", "Do", "Fr", "Sa"];
const weeklyWeekdayOrder = Array.from({ length: 7 }, (_, index) => (firstDayOfWeek + index) % 7);
const weekdayLabels = weeklyWeekdayOrder.map((weekday) => weekdayLabelsByDayIndex[weekday]);
const weeklyWeekdayLabels = weekdayLabelsByDayIndex;
const statusLabels = {
  yes: "Ja",
  maybe: "Vielleicht",
  no: "Nein",
};
const CREATE_POLL_MODES = new Set(["fixed", "block_fixed", "timeslots", "star_rating", "free", "block_free", "timeslots_free", "weekly"]);
const mobileMediaQuery = window.matchMedia("(max-width: 720px)");

const state = {
  auth: {
    user: null,
    csrfToken: "",
    sessionTimeoutMinutes: 30,
  },
  dashboardStats: null,
  dashboardPolls: [],
  participatedPolls: [],
  selectedDates: new Set(),
  createTimeSlotsEnabled: false,
  createTimeSlots: {},
  createWeeklySlots: [],
  createBlockConfig: getDefaultCreateBlockConfig(),
  currentMonth: startOfMonth(new Date()),
  participantSelectedDates: new Set(),
  participantSuggestedTimes: {},
  participantCurrentMonth: startOfMonth(new Date()),
  participantCalendarExpanded: !mobileMediaQuery.matches,
  pollData: null,
  responseDraft: {},
  pollDrawerOpen: false,
  createMode: "fixed",
  resultsCalendarView: "month",
  resultsCalendarDate: new Date(),
};

let toastTimeoutId = 0;

initializeRouting();
bindStaticEventHandlers();
document.addEventListener("keydown", handleGlobalKeydown);
window.addEventListener("resize", handleViewportResize);

initializeApp().catch(handleRenderError);

themeToggle.addEventListener("click", toggleTheme);
applyStoredTheme();
registerServiceWorker();

async function initializeApp() {
  await refreshAuthState();
  renderTopbarNav();
  await renderCurrentRoute();
}

async function renderCurrentRoute() {
  const route = getRoute();
  if (state.auth.user && ["login", "register", "forgot-password"].includes(route.type)) {
    await navigateTo("/dashboard", { replace: true });
    return;
  }

  if (route.type === "poll") {
    await renderPollPage(route.pollId);
    return;
  }

  if (route.type === "login") {
    renderLoginPage();
    return;
  }

  if (route.type === "register") {
    renderRegisterPage();
    return;
  }

  if (route.type === "forgot-password") {
    renderForgotPasswordPage();
    return;
  }

  if (route.type === "account") {
    await renderAccountPage();
    return;
  }

  if (route.type === "my-polls") {
    await renderMyPollsPage();
    return;
  }

  if (route.type === "participated") {
    await renderParticipatedPage();
    return;
  }

  if (route.type === "reset-password") {
    await renderResetPasswordPage(route.token);
    return;
  }

  if (["dashboard", "create", "my-polls", "participated"].includes(route.type) && !state.auth.user) {
    await navigateTo("/login", { replace: true });
    return;
  }

  if (route.type === "create") {
    await renderCreatePage(route.mode, route.pollId);
    return;
  }

  if (!state.auth.user) {
    renderLandingPage();
    return;
  }

  await renderDashboardPage();
}

function initializeRouting() {
  window.addEventListener("popstate", () => {
    renderCurrentRoute().catch(handleRenderError);
  });

  document.addEventListener("click", (event) => {
    const link = event.target.closest("a[href]");
    if (!link || event.defaultPrevented || (link.target && link.target !== "_self") || link.hasAttribute("download")) {
      return;
    }

    const url = new URL(link.href, window.location.origin);
    if (url.origin !== window.location.origin || !isSpaPath(url.pathname)) {
      return;
    }

    event.preventDefault();
    navigateTo(`${url.pathname}${url.search}${url.hash}`).catch(handleRenderError);
  });
}

function bindStaticEventHandlers() {
  document.querySelector("#login-form").addEventListener("submit", handleLogin);
  document.querySelector("#register-form").addEventListener("submit", handleRegister);
  document.querySelector("#forgot-password-form").addEventListener("submit", handleForgotPassword);
}

function handleViewportResize() {
  syncPollResponsePanelState();
}

function registerServiceWorker() {
  if (!("serviceWorker" in navigator) || !window.isSecureContext) {
    return;
  }

  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/service-worker.js").catch((error) => {
      console.debug("Service Worker konnte nicht registriert werden.", error);
    });
  });
}

function isSpaPath(pathname) {
  return (
    pathname === "/" ||
    pathname === "/login" ||
    pathname === "/register" ||
    pathname === "/forgot-password" ||
    pathname === "/account" ||
    pathname === "/create" ||
    pathname === "/reset-password" ||
    pathname === "/dashboard" ||
    pathname === "/my-polls" ||
    pathname === "/participated" ||
    /^\/poll\/[a-z0-9]+$/i.test(pathname)
  );
}

async function navigateTo(path, options = {}) {
  const nextUrl = new URL(path, window.location.origin);
  const nextPath = `${nextUrl.pathname}${nextUrl.search}${nextUrl.hash}`;
  const currentPath = `${window.location.pathname}${window.location.search}${window.location.hash}`;

  if (nextPath !== currentPath) {
    const method = options.replace ? "replaceState" : "pushState";
    window.history[method]({}, "", nextPath);
  }

  await renderCurrentRoute();
}

function hideAllViews() {
  for (const viewId of staticViewIds) {
    document.querySelector(`#${viewId}`)?.classList.add("is-hidden");
  }
}

function showStaticView(viewId) {
  hideAllViews();
  document.querySelector(`#${viewId}`)?.classList.remove("is-hidden");
}

function showDynamicView() {
  hideAllViews();
  dynamicViewElement.classList.remove("is-hidden");
  dynamicViewElement.innerHTML = "";
}

function handleRenderError(error) {
  console.error(error);
  showDynamicView();
  dynamicViewElement.innerHTML = `<section class="panel"><h1>Fehler</h1><p>${escapeHtml(
    error?.message || "Die Ansicht konnte nicht geladen werden."
  )}</p></section>`;
}

async function refreshAuthState() {
  const response = await fetch("/api/auth/me", { credentials: "same-origin" });
  const data = await response.json();
  state.auth.user = data.user;
  state.auth.csrfToken = data.csrfToken;
  state.auth.sessionTimeoutMinutes = data.sessionTimeoutMinutes;
}

async function apiFetch(url, options = {}) {
  const method = (options.method || "GET").toUpperCase();
  const headers = new Headers(options.headers || {});

  if (method !== "GET" && method !== "HEAD") {
    headers.set("x-csrf-token", state.auth.csrfToken);
  }

  if (options.body && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }

  const response = await fetch(url, {
    credentials: "same-origin",
    ...options,
    method,
    headers,
  });

  const contentType = response.headers.get("content-type") || "";
  const data = contentType.includes("application/json") ? await response.json() : null;
  if (!response.ok) {
    const error = new Error(data?.error || "Die Anfrage ist fehlgeschlagen.");
    error.status = response.status;
    error.data = data;
    throw error;
  }

  return data;
}

function renderTopbarNav() {
  navElement.innerHTML = "";
  topbarPrimaryElement.innerHTML = "";

  if (!state.auth.user) {
    navElement.innerHTML = `
      <a class="ghost-link" href="/register">Registrieren</a>
      <a class="primary-link" href="/login">Login</a>
    `;
    return;
  }

  topbarPrimaryElement.innerHTML = `
    <a class="primary-link" href="/create">
      <i class="fa-solid fa-plus"></i>
      Neue Umfrage
    </a>
  `;

  navElement.innerHTML = `
    <div class="dropdown">
      <a class="ghost-link" href="/account"><i class="fa-regular fa-user"></i> Konto</a>
      <div class="dropdown-menu">
        <a class="dropdown-item" href="/account">Profil</a>
        <a class="dropdown-item" href="/my-polls">Meine Umfragen</a>
        <a class="dropdown-item" href="/participated">Fremde Umfragen</a>
        <hr class="dropdown-divider" />
        <a id="logout-link" class="dropdown-item" href="/">Logout</a>
      </div>
    </div>
  `;

  document.querySelector("#logout-link").addEventListener("click", handleLogout);
}

function getRoute() {
  const pathname = window.location.pathname;
  const params = new URLSearchParams(window.location.search);
  const pollMatch = pathname.match(/^\/poll\/([a-z0-9]+)$/i);

  if (pollMatch) {
    return { type: "poll", pollId: pollMatch[1] };
  }
  if (pathname === "/login") {
    return { type: "login" };
  }
  if (pathname === "/register") {
    return { type: "register" };
  }
  if (pathname === "/forgot-password") {
    return { type: "forgot-password" };
  }
  if (pathname === "/account") {
    return { type: "account" };
  }
  if (pathname === "/my-polls") {
    return { type: "my-polls" };
  }
  if (pathname === "/participated") {
    return { type: "participated" };
  }
  if (pathname === "/create") {
    const mode = normalizeCreateMode(params.get("mode"));
    return { type: "create", mode, pollId: params.get("edit") || "" };
  }
  if (pathname === "/reset-password") {
    return { type: "reset-password", token: params.get("token") || "" };
  }
  if (pathname === "/dashboard") {
    return { type: "dashboard" };
  }

  return { type: "home" };
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

function renderLandingPage() {
  showStaticView("landing-view");
}

function renderLoginPage() {
  showStaticView("login-view");
  setFeedback(document.querySelector("#login-feedback"), "");
}

function renderRegisterPage() {
  showStaticView("register-view");
  setFeedback(document.querySelector("#register-feedback"), "");
}

function renderForgotPasswordPage() {
  showStaticView("forgot-password-view");
  setFeedback(document.querySelector("#forgot-password-feedback"), "");
  document.querySelector("#forgot-password-link").innerHTML = "";
}

async function renderResetPasswordPage(token) {
  const template = document.querySelector("#reset-password-template");
  showDynamicView();
  dynamicViewElement.appendChild(template.content.cloneNode(true));

  const feedback = document.querySelector("#reset-password-feedback");
  const details = document.querySelector("#reset-password-details");
  const tokenField = document.querySelector("#reset-password-token");

  tokenField.value = token;

  if (!token) {
    setFeedback(feedback, "Es fehlt ein gültiger Reset-Token.", "error");
    details.innerHTML = '<p class="description">Fordere zuerst einen neuen Link an.</p>';
    return;
  }

  setFeedback(feedback, "Reset-Link wird geprüft ...");

  try {
    const data = await apiFetch(`/api/auth/reset-password/${encodeURIComponent(token)}`);
    details.innerHTML = `
      <p class="description">Konto: <strong>${escapeHtml(data.email)}</strong></p>
      <p class="description">Gültig bis ${escapeHtml(formatDateTime(data.expiresAt))}</p>
    `;
    setFeedback(feedback, "Link ist gültig. Du kannst jetzt ein neues Passwort setzen.", "success");
    document.querySelector("#reset-password-form").addEventListener("submit", handleResetPassword);
  } catch (error) {
    details.innerHTML = '<p class="description">Der Link muss neu angefordert werden.</p>';
    setFeedback(feedback, error.message, "error");
  }
}

async function renderDashboardPage() {
  const template = document.querySelector("#dashboard-template");
  showDynamicView();
  dynamicViewElement.appendChild(template.content.cloneNode(true));

  await loadDashboardPolls();
}

async function renderAccountPage() {
  showDynamicView();
  dynamicViewElement.innerHTML = '<section class="panel"><p class="description">Profil wird geladen ...</p></section>';

  try {
    const profile = await apiFetch("/api/user/profile");

    dynamicViewElement.innerHTML = `
      <section class="hero-card dashboard-hero">
        <div class="hero-copy">
          <p class="eyebrow">Konto</p>
          <h1>Profil und Sicherheit</h1>
          <p class="hero-text">
            Verwalte hier deinen Namen, dein Passwort und auf Wunsch dein gesamtes Konto.
          </p>
        </div>
        <div class="hero-stats auth-stats">
          <article class="hero-stat">
            <strong>${escapeHtml(profile.email)}</strong>
            <span>E-Mail-Adresse bleibt unveränderlich</span>
          </article>
          <article class="hero-stat">
            <strong id="account-display-name">${escapeHtml(profile.name || "Kein Name gesetzt")}</strong>
            <span>Aktueller Anzeigename</span>
          </article>
          <article class="hero-stat">
            <strong>${escapeHtml(formatDateTime(profile.createdAt))}</strong>
            <span>Konto erstellt</span>
          </article>
        </div>
      </section>

      <section class="dashboard-layout">
        <article class="panel">
          <div class="panel-header">
            <div>
              <p class="eyebrow">Profil</p>
              <h2>Persönliche Daten</h2>
            </div>
          </div>

          <form id="account-profile-form" class="stack-form">
            <label>
              <span>E-Mail</span>
              <input value="${escapeHtml(profile.email)}" type="email" readonly disabled />
            </label>

            <label>
              <span>Name</span>
              <input
                id="account-name"
                name="name"
                maxlength="120"
                required
                placeholder="Dein Name"
                value="${escapeHtml(profile.name || "")}"
              />
            </label>

            <div id="account-profile-feedback" class="feedback" role="status" aria-live="polite"></div>

            <button class="primary-button" type="submit">
              <i class="fa-regular fa-floppy-disk"></i>
              Speichern
            </button>
          </form>
        </article>

        <article class="panel">
          <div class="panel-header">
            <div>
              <p class="eyebrow">Sicherheit</p>
              <h2>Passwort ändern</h2>
            </div>
          </div>

          <div class="stack-form">
            <p class="description">
              Ändere dein Passwort in einem separaten Dialog, ohne die restlichen Kontodaten zu unterbrechen.
            </p>
            <button id="open-password-modal" class="primary-button wide-button" type="button">
              <i class="fa-solid fa-key"></i>
              Passwort ändern
            </button>
          </div>
        </article>

        <article class="panel">
          <div class="panel-header">
            <div>
              <p class="eyebrow">Übersichten</p>
              <h2>Schnellzugriff</h2>
            </div>
          </div>

          <div class="overview-link-grid">
            <a class="ghost-link" href="/my-polls">
              <i class="fa-regular fa-rectangle-list"></i>
              Meine Umfragen
            </a>
            <a class="ghost-link" href="/participated">
              <i class="fa-regular fa-handshake"></i>
              Fremde Umfragen
            </a>
          </div>
        </article>

        <article class="panel">
          <div class="panel-header">
            <div>
              <p class="eyebrow">Gefahrenzone</p>
              <h2>Konto löschen</h2>
            </div>
          </div>

          <div class="stack-form">
            <p class="description">
              Beim Löschen werden dein Konto, deine Antworten und alle von dir erstellten Umfragen dauerhaft entfernt.
            </p>
            <div id="account-delete-feedback" class="feedback" role="status" aria-live="polite"></div>
            <button id="account-delete-button" class="ghost-button wide-button" type="button">
              <i class="fa-regular fa-trash-can"></i>
              Konto löschen
            </button>
          </div>
        </article>
      </section>

      <div id="account-password-modal" class="modal" aria-hidden="true">
        <div class="modal-content" role="dialog" aria-modal="true" aria-labelledby="account-password-modal-title">
          <div class="panel-header">
            <div>
              <p class="eyebrow">Sicherheit</p>
              <h2 id="account-password-modal-title">Passwort ändern</h2>
            </div>
          </div>

          <form id="account-password-form" class="stack-form">
            <label>
              <span>Aktuelles Passwort</span>
              <input
                id="account-current-password"
                type="password"
                name="currentPassword"
                autocomplete="current-password"
                required
                placeholder="Aktuelles Passwort"
              />
            </label>

            <label>
              <span>Neues Passwort</span>
              <input
                id="account-new-password"
                type="password"
                name="newPassword"
                autocomplete="new-password"
                required
                minlength="8"
                placeholder="Mindestens 8 Zeichen"
              />
            </label>

            <label>
              <span>Neues Passwort bestätigen</span>
              <input
                id="account-confirm-password"
                type="password"
                name="confirmPassword"
                autocomplete="new-password"
                required
                minlength="8"
                placeholder="Neues Passwort bestätigen"
              />
            </label>

            <div id="account-password-feedback" class="feedback" role="status" aria-live="polite"></div>

            <div class="modal-actions">
              <button id="close-password-modal" class="ghost-button wide-button" type="button">
                Abbrechen
              </button>
              <button class="primary-button wide-button" type="submit">
                <i class="fa-solid fa-key"></i>
                Speichern
              </button>
            </div>
          </form>
        </div>
      </div>
    `;

    document.querySelector("#open-password-modal").addEventListener("click", openPasswordModal);
    document.querySelector("#close-password-modal").addEventListener("click", closePasswordModal);
    document.querySelector("#account-password-modal").addEventListener("click", (event) => {
      if (event.target === event.currentTarget) {
        closePasswordModal();
      }
    });
    document.querySelector("#account-profile-form").addEventListener("submit", handleProfileSave);
    document.querySelector("#account-password-form").addEventListener("submit", handlePasswordChange);
    document.querySelector("#account-delete-button").addEventListener("click", handleAccountDelete);
  } catch (error) {
    if (error.status === 401) {
      await navigateTo("/login", { replace: true });
      return;
    }

    dynamicViewElement.innerHTML = `<section class="panel"><h1>Fehler</h1><p>${escapeHtml(error.message)}</p></section>`;
  }
}

async function renderCreatePage(mode = "fixed", pollId = "") {
  const template = document.querySelector("#create-template");
  showDynamicView();
  dynamicViewElement.innerHTML = '<section class="panel"><p class="description">Editor wird geladen ...</p></section>';

  state.createMode = normalizeCreateMode(mode);
  state.selectedDates = new Set();
  state.createTimeSlotsEnabled = false;
  state.createTimeSlots = {};
  state.createWeeklySlots = [];
  state.createBlockConfig = getDefaultCreateBlockConfig();
  state.currentMonth = startOfMonth(new Date());

  let existingPoll = null;
  if (pollId) {
    const data = await apiFetch(`/api/polls/${pollId}`);
    if (!data.permissions?.canManage) {
      throw new Error("Diese Umfrage kann nicht bearbeitet werden.");
    }
    existingPoll = data.poll;
    const isLegacyFixedWithTimeSlots =
      existingPoll.mode === "fixed" && Boolean(existingPoll.allowTimeSlots || existingPoll.has_time_slots);
    state.createMode = normalizeCreateMode(isLegacyFixedWithTimeSlots ? "timeslots" : existingPoll.mode);
    if (createModeUsesCalendar(state.createMode)) {
      state.selectedDates = new Set(existingPoll.dates || []);
      state.createTimeSlotsEnabled = state.createMode === "timeslots";
      state.createTimeSlots = cloneCreateTimeSlots(
        existingPoll.timeSlots || existingPoll.time_slots || {},
        state.createMode
      );
      state.currentMonth = startOfMonth(getFirstSelectedCreateDate(existingPoll.dates));
    }
    if (createModeUsesWeeklySlots(state.createMode)) {
      state.createWeeklySlots = getWeeklySlotsFromPoll(existingPoll).map((entry) => ({
        weekdays: [entry.weekday],
        start: entry.time.split("-")[0] || "",
        end: entry.time.split("-")[1] || "",
      }));
    }
    if (createModeUsesBlockConfig(state.createMode)) {
      const blockConfig = normalizePollBlockConfig(existingPoll);
      state.createBlockConfig = {
        length: blockConfig.length || getDefaultCreateBlockConfig().length,
        startDate: blockConfig.startDate,
        endDate: blockConfig.endDate,
        weekdays: blockConfig.weekdays,
      };
    }
  }

  dynamicViewElement.innerHTML = "";
  dynamicViewElement.appendChild(template.content.cloneNode(true));

  fillCreateForm(existingPoll);
  bindCreateForm(existingPoll);
}

function fillCreateForm(existingPoll) {
  const isEditing = Boolean(existingPoll);
  const pageTitle = document.querySelector("#create-page-title");
  const pageBadge = document.querySelector("#create-page-badge");
  const submitButton = document.querySelector("#create-submit-button");

  document.querySelector("#create-title").value = existingPoll?.title || "";
  document.querySelector("#create-description").value = existingPoll?.description || "";
  pageBadge?.classList.toggle("is-hidden", true);
  pageTitle.textContent = isEditing ? "Umfrage bearbeiten" : "Termin-Abstimmung erstellen";
  submitButton.innerHTML = isEditing
    ? '<i class="fa-regular fa-floppy-disk"></i> Änderungen speichern'
    : '<i class="fa-regular fa-floppy-disk"></i> Umfrage speichern';

  document.querySelectorAll('.create-mode-card[href^="/create?mode="]').forEach((card) => {
    const url = new URL(card.href, window.location.origin);
    card.classList.toggle("is-active", url.searchParams.get("mode") === state.createMode);
  });

  ensureCreateTimeSlotControls();
  ensureCreateWeeklyControls();
  fillCreateBlockFields();
  updateCreateModeLayout();
}

function bindCreateForm(existingPoll) {
  document.querySelector("#create-prev-month").addEventListener("click", () => {
    state.currentMonth = addMonths(state.currentMonth, -1);
    renderCreateCalendar();
  });

  document.querySelector("#create-next-month").addEventListener("click", () => {
    state.currentMonth = addMonths(state.currentMonth, 1);
    renderCreateCalendar();
  });

  document.querySelector("#create-clear-dates").addEventListener("click", () => {
    state.selectedDates.clear();
    state.createTimeSlots = {};
    renderCreateCalendar();
    renderCreateSelectedDates();
    renderCreateTimeSlots();
    renderCreateBlockPreview();
  });

  document.querySelector("#create-form").addEventListener("submit", (event) => handleCreateSubmit(event, existingPoll?.id || ""));
  bindCreateBlockFields();
  if (createModeUsesWeeklySlots()) {
    renderCreateWeeklySlots();
  }
}

function renderCreateCalendar() {
  const grid = document.querySelector("#create-calendar-grid");
  const label = document.querySelector("#create-calendar-label");
  if (!grid || !label) {
    return;
  }

  label.textContent = formatMonthYear(state.currentMonth);
  grid.innerHTML = "";

  for (const weekday of weekdayLabels) {
    const cell = document.createElement("div");
    cell.className = "calendar-weekday";
    cell.textContent = weekday;
    grid.appendChild(cell);
  }

  const days = buildCalendarDays(state.currentMonth.getFullYear(), state.currentMonth.getMonth());
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
      syncCreateTimeSlotsWithSelectedDates();
      renderCreateCalendar();
      renderCreateSelectedDates();
      renderCreateTimeSlots();
      renderCreateBlockPreview();
    });
    grid.appendChild(button);
  }

  bindCalendarSwipe(
    grid,
    () => {
      state.currentMonth = addMonths(state.currentMonth, -1);
      renderCreateCalendar();
    },
    () => {
      state.currentMonth = addMonths(state.currentMonth, 1);
      renderCreateCalendar();
    }
  );
}

function renderCreateSelectedDates() {
  const container = document.querySelector("#create-selected-dates");
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
      syncCreateTimeSlotsWithSelectedDates();
      renderCreateCalendar();
      renderCreateSelectedDates();
      renderCreateTimeSlots();
      renderCreateBlockPreview();
    });
    container.appendChild(pill);
  }
}

function normalizeCreateMode(mode) {
  return CREATE_POLL_MODES.has(mode) ? mode : "fixed";
}

function getDefaultCreateBlockConfig() {
  return {
    length: 5,
    startDate: "",
    endDate: "",
    weekdays: [],
  };
}

function createModeUsesCalendar(mode = state.createMode) {
  return mode === "fixed" || mode === "timeslots" || mode === "block_fixed" || mode === "star_rating";
}

function createModeUsesParticipantSuggestions(mode = state.createMode) {
  return mode === "free" || mode === "timeslots_free";
}

function createModeUsesWeeklySlots(mode = state.createMode) {
  return mode === "weekly";
}

function createModeUsesBlockConfig(mode = state.createMode) {
  return mode === "block_fixed" || mode === "block_free";
}

function createModeUsesBlockWindow(mode = state.createMode) {
  return false;
}

function createModeRequiresTimeSlots(mode = state.createMode) {
  return mode === "timeslots";
}

function createModeUsesRangeSlots(mode = state.createMode) {
  return mode === "timeslots";
}

function pollUsesParticipantSuggestions(mode = state.pollData?.poll?.mode) {
  return mode === "free" || mode === "timeslots_free";
}

function pollUsesBlockFixed(poll = state.pollData?.poll) {
  return poll?.mode === "block_fixed";
}

function pollUsesBlockFree(poll = state.pollData?.poll) {
  return poll?.mode === "block_free";
}

function pollUsesBlockMode(poll = state.pollData?.poll) {
  return pollUsesBlockFixed(poll) || pollUsesBlockFree(poll);
}

function pollUsesWeeklySlots(poll = state.pollData?.poll) {
  return poll?.mode === "weekly";
}

function pollUsesStarRating(poll = state.pollData?.poll) {
  return poll?.mode === "star_rating";
}

function suggestionModeUsesRangeSlots(mode = state.pollData?.poll?.mode) {
  return mode === "timeslots_free";
}

function normalizePollBlockLength(value) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isInteger(parsed) || parsed < 2 || parsed > 31) {
    return 0;
  }

  return parsed;
}

function normalizePollWeekdays(entries) {
  const source = Array.isArray(entries) ? entries : [];
  const selected = new Set();

  source.forEach((entry) => {
    const weekday = Number(entry);
    if (Number.isInteger(weekday) && weekday >= 0 && weekday <= 6) {
      selected.add(weekday);
    }
  });

  return weeklyWeekdayOrder.filter((weekday) => selected.has(weekday));
}

function normalizePollStartWeekdays(entries, fallbackValue = null) {
  const normalizedEntries = normalizePollWeekdays(entries);
  if (normalizedEntries.length > 0) {
    return normalizedEntries;
  }

  if (fallbackValue === null || fallbackValue === undefined || fallbackValue === "") {
    return [];
  }

  const fallbackWeekday = Number(fallbackValue);
  if (Number.isInteger(fallbackWeekday) && fallbackWeekday >= 0 && fallbackWeekday <= 6) {
    return [fallbackWeekday];
  }

  // Legacy block polls may not have stored any weekday restriction at all.
  return [];
}

function formatAllowedBlockStartDays(weekdays) {
  const normalized = normalizePollWeekdays(weekdays);
  if (normalized.length === 0) {
    return "Alle Tage erlaubt";
  }

  return normalized.map((weekday) => formatWeeklyWeekday(weekday)).join(", ");
}

function logBlockCreateDebug(scope, payload) {
  console.log(`[block-create-debug] ${scope}`, payload);
}

function normalizePollBlockConfig(poll = state.pollData?.poll) {
  const source = poll?.blockConfig || poll?.block_config || poll || {};
  return {
    length: normalizePollBlockLength(source.length),
    startDate: isIsoDateValue(source.startDate) ? source.startDate : "",
    endDate: isIsoDateValue(source.endDate) ? source.endDate : "",
    weekdays: normalizePollStartWeekdays(source.weekdays, source.startWeekday),
  };
}

function getBlockEndDateValue(startDate, length) {
  if (!isIsoDateValue(startDate) || !Number.isInteger(length) || length < 1) {
    return "";
  }

  return addDaysToIsoDateValue(startDate, length - 1);
}

function listBlockEntriesFromDates(dates, length, weekdays = []) {
  const normalizedDates = Array.isArray(dates) ? [...new Set(dates.filter(isIsoDateValue))].sort() : [];
  const allowedWeekdays = normalizePollWeekdays(weekdays);
  const allowedWeekdaySet = allowedWeekdays.length > 0 ? new Set(allowedWeekdays) : null;
  if (!Number.isInteger(length) || length < 2 || normalizedDates.length < length) {
    logBlockCreateDebug("listBlockEntriesFromDates", {
      dates,
      normalizedDates,
      length,
      weekdays,
      allowedWeekdays,
      allowedWeekdaySet: null,
      resultCount: 0,
    });
    return [];
  }

  const entries = [];
  for (let index = 0; index <= normalizedDates.length - length; index += 1) {
    const blockDates = [normalizedDates[index]];
    let isContiguous = true;

    for (let offset = 1; offset < length; offset += 1) {
      const expectedDate = addDaysToIsoDateValue(blockDates[offset - 1], 1);
      const nextDate = normalizedDates[index + offset];
      if (!expectedDate || nextDate !== expectedDate) {
        isContiguous = false;
        break;
      }
      blockDates.push(nextDate);
    }

    if (!isContiguous) {
      continue;
    }
    if (allowedWeekdaySet && !allowedWeekdaySet.has(getIsoDateWeekdayValue(blockDates[0]))) {
      continue;
    }

    entries.push({
      start: blockDates[0],
      end: blockDates[blockDates.length - 1],
      date: blockDates[0],
      endDate: blockDates[blockDates.length - 1],
      length,
      dates: blockDates,
    });
  }

  logBlockCreateDebug("listBlockEntriesFromDates", {
    dates,
    normalizedDates,
    length,
    weekdays,
    allowedWeekdays,
    allowedWeekdaySet: allowedWeekdaySet ? Array.from(allowedWeekdaySet) : null,
    resultCount: entries.length,
    entries: entries.map((entry) => ({ start: entry.start, end: entry.end })),
  });
  return entries;
}

function listBlockStartDatesFromConfig(blockConfig) {
  const normalized = normalizePollBlockConfig(blockConfig);
  if (!normalized.length || !normalized.startDate || !normalized.endDate || normalized.startDate > normalized.endDate) {
    return [];
  }

  const allowedWeekdays = normalized.weekdays.length > 0 ? new Set(normalized.weekdays) : null;
  const starts = [];
  let currentDate = normalized.startDate;

  while (currentDate && currentDate <= normalized.endDate) {
    const blockEndDate = getBlockEndDateValue(currentDate, normalized.length);
    if (!blockEndDate || blockEndDate > normalized.endDate) {
      break;
    }

    const isAllowedStartDay = !allowedWeekdays || allowedWeekdays.has(getIsoDateWeekdayValue(currentDate));
    if (isAllowedStartDay) {
      starts.push(currentDate);
    }

    currentDate = addDaysToIsoDateValue(currentDate, 1);
  }

  return starts;
}

function getPollBlockStartDates(poll = state.pollData?.poll) {
  if (pollUsesBlockMode(poll)) {
    return getPollBlockEntries(poll).map((entry) => entry.start);
  }

  return [];
}

function getPollBlockEntries(poll = state.pollData?.poll) {
  if (!pollUsesBlockMode(poll)) {
    return [];
  }

  const blockConfig = normalizePollBlockConfig(poll);
  return listBlockEntriesFromDates(poll?.dates, blockConfig.length, blockConfig.weekdays);
}

function listDatesCoveredByBlockStarts(startDates, length) {
  const dates = new Set();
  if (!Number.isInteger(length) || length < 1) {
    return [];
  }

  startDates.forEach((startDate) => {
    for (let offset = 0; offset < length; offset += 1) {
      const date = addDaysToIsoDateValue(startDate, offset);
      if (date) {
        dates.add(date);
      }
    }
  });

  return Array.from(dates).sort();
}

function getPollBlockSelectableDates(poll = state.pollData?.poll) {
  if (!pollUsesBlockMode(poll)) {
    return [];
  }
  if (pollUsesBlockFree(poll)) {
    return [];
  }

  return Array.isArray(poll?.dates) ? [...new Set(poll.dates.filter(isIsoDateValue))].sort() : [];
}

function isPollBlockDateSelectable(poll, date) {
  if (!isIsoDateValue(date)) {
    return false;
  }
  if (pollUsesBlockFree(poll)) {
    return true;
  }
  return getPollBlockSelectableDates(poll).includes(date);
}

function isValidResponseStatus(status) {
  return status === "yes" || status === "maybe" || status === "no";
}

function getResponseBlockRange(response) {
  const source = response?.blockRange || response?.availabilities || {};
  const start = isIsoDateValue(source.start) ? source.start : "";
  const end = isIsoDateValue(source.end) ? source.end : "";
  return { start, end };
}

function canDateRangeFitBlock(startDate, endDate, length) {
  return Boolean(
    isIsoDateValue(startDate)
      && isIsoDateValue(endDate)
      && Number.isInteger(length)
      && length > 0
      && startDate <= endDate
      && getInclusiveDateSpan(startDate, endDate) >= length
  );
}

function dateRangeContainsBlock(startDate, endDate, blockStartDate, length) {
  const blockEndDate = getBlockEndDateValue(blockStartDate, length);
  return Boolean(
    blockEndDate
      && canDateRangeFitBlock(startDate, endDate, length)
      && isIsoDateValue(blockStartDate)
      && blockStartDate >= startDate
      && blockEndDate <= endDate
  );
}

function buildBlockFixedDailyDraft(poll, response) {
  const selectableDates = getPollBlockSelectableDates(poll);
  const draft = Object.fromEntries(selectableDates.map((date) => [date, response?.availabilities?.[date] || "maybe"]));
  const availabilities = response?.availabilities || {};
  const blockLength = normalizePollBlockConfig(poll).length;

  const hasDailySelections = selectableDates.some((date) => isValidResponseStatus(availabilities[date]));
  if (hasDailySelections) {
    return draft;
  }

  getPollBlockStartDates(poll).forEach((startDate) => {
    const status = availabilities[startDate];
    if (status !== "yes" && status !== "maybe") {
      return;
    }

    for (let offset = 0; offset < blockLength; offset += 1) {
      const date = addDaysToIsoDateValue(startDate, offset);
      if (!date || !(date in draft)) {
        continue;
      }

      if (status === "yes" || draft[date] !== "yes") {
        draft[date] = status;
      }
    }
  });

  return draft;
}

function buildBlockFreeDailyDraft(poll, response) {
  const draft = {};

  Object.entries(response?.availabilities || {}).forEach(([date, status]) => {
    if (isPollBlockDateSelectable(poll, date) && status === "yes") {
      draft[date] = "yes";
    }
  });

  if (Object.keys(draft).length > 0) {
    return draft;
  }

  const range = getResponseBlockRange(response);
  if (!range.start || !range.end || range.end < range.start) {
    return draft;
  }

  let currentDate = range.start;
  while (currentDate && currentDate <= range.end) {
    if (isPollBlockDateSelectable(poll, currentDate)) {
      draft[currentDate] = "yes";
    }
    currentDate = addDaysToIsoDateValue(currentDate, 1);
  }

  return draft;
}

function getSelectedBlockFreeDates(draft = state.responseDraft, poll = state.pollData?.poll) {
  return Object.entries(draft || {})
    .filter(([date, status]) => isPollBlockDateSelectable(poll, date) && status === "yes")
    .map(([date]) => date)
    .sort();
}

function buildBlockFixedAvailabilityPayload(poll, draft = state.responseDraft) {
  const blockLength = normalizePollBlockConfig(poll).length;
  const payload = {};

  getPollBlockStartDates(poll).forEach((startDate) => {
    let status = "yes";

    for (let offset = 0; offset < blockLength; offset += 1) {
      const date = addDaysToIsoDateValue(startDate, offset);
      const dayStatus = isValidResponseStatus(draft?.[date]) ? draft[date] : "maybe";
      if (dayStatus === "no") {
        status = "no";
        break;
      }
      if (dayStatus === "maybe") {
        status = "maybe";
      }
    }

    payload[startDate] = status;
  });

  return payload;
}

function buildBlockFreeAvailabilityPayload(poll, draft = state.responseDraft) {
  const selectedDates = getSelectedBlockFreeDates(draft, poll);
  if (selectedDates.length === 0) {
    return { ok: false, message: "Bitte markiere im Kalender mindestens einen Tag." };
  }

  return {
    ok: true,
    value: Object.fromEntries(selectedDates.map((date) => [date, "yes"])),
  };
}

function buildStarRatingAvailabilityPayload(poll, draft = state.responseDraft) {
  const payload = {};

  for (const date of poll?.dates || []) {
    const rating = Number(draft?.[date]);
    if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
      return { ok: false, message: `Bitte bewerte ${formatDateLong(date)} mit 1 bis 5 Sternen.` };
    }
    payload[date] = rating;
  }

  return { ok: true, value: payload };
}

function getBlockFixedStatusForEntry(response, entry) {
  let hasMaybe = false;
  const entryDates =
    Array.isArray(entry?.dates) && entry.dates.length > 0
      ? entry.dates
      : Array.from(
          { length: Number.isInteger(entry?.length) ? entry.length : 0 },
          (_, index) => addDaysToIsoDateValue(entry?.start || entry?.date || "", index)
        ).filter(Boolean);

  for (const date of entryDates) {
    const status = response?.availabilities?.[date] || "no";
    if (status === "no") {
      return "no";
    }
    if (status === "maybe") {
      hasMaybe = true;
    }
  }

  return hasMaybe ? "maybe" : "yes";
}

function formatBlockRangeShort(startDate, endDate) {
  if (!startDate || !endDate) {
    return "";
  }

  return `${formatDateShort(startDate)}-${formatDateShort(endDate)}`;
}

function formatBlockRangeLong(startDate, endDate) {
  if (!startDate || !endDate) {
    return "";
  }

  return `${formatDateLong(startDate)} bis ${formatDateLong(endDate)}`;
}

function formatBlockLengthLabel(length) {
  return Number.isInteger(length) && length > 0 ? `${length} ${length === 1 ? "Tag" : "Tage"}` : "";
}

function formatBlockWeekdaySpan(startDate, endDate) {
  if (!startDate || !endDate) {
    return "";
  }

  const startWeekday = formatWeeklyWeekday(getIsoDateWeekdayValue(startDate));
  const endWeekday = formatWeeklyWeekday(getIsoDateWeekdayValue(endDate));
  if (!startWeekday || !endWeekday) {
    return "";
  }

  return startWeekday === endWeekday ? startWeekday : `${startWeekday}-${endWeekday}`;
}

function formatBlockPeriodMeta(startDate, endDate, length = getInclusiveDateSpan(startDate, endDate)) {
  const parts = [];
  const lengthLabel = formatBlockLengthLabel(length);
  const weekdaySpan = formatBlockWeekdaySpan(startDate, endDate);

  if (lengthLabel) {
    parts.push(lengthLabel);
  }
  if (weekdaySpan) {
    parts.push(weekdaySpan);
  }

  return parts.join(" · ");
}

function getWeeklySlotsFromPoll(poll = state.pollData?.poll) {
  const rawSlots = Array.isArray(poll?.weeklyConfig?.slots) ? poll.weeklyConfig.slots : [];
  const normalized = rawSlots
    .map((entry) => ({
      weekday: Number(entry?.weekday),
      time: normalizePollSlotValue(entry?.time),
    }))
    .filter((entry) => Number.isInteger(entry.weekday) && entry.weekday >= 0 && entry.weekday <= 6 && entry.time)
    .sort((left, right) => {
      const leftOrder = weeklyWeekdayOrder.indexOf(left.weekday);
      const rightOrder = weeklyWeekdayOrder.indexOf(right.weekday);
      if (leftOrder !== rightOrder) {
        return leftOrder - rightOrder;
      }
      return left.time.localeCompare(right.time);
    });

  return normalized;
}

function buildWeeklySlotKey(weekday, time) {
  return `${weekday}_${time}`;
}

function formatWeeklyWeekday(weekday) {
  return weeklyWeekdayLabels[weekday] || "?";
}

function formatWeeklySlotLabel(slot) {
  return `${formatWeeklyWeekday(slot.weekday)} ${slot.time}`;
}

function getWeeklySortIndex(weekday) {
  const index = weeklyWeekdayOrder.indexOf(weekday);
  return index === -1 ? weeklyWeekdayOrder.length : index;
}

function compareResultEntries(left, right) {
  const leftDate = typeof left?.start === "string" ? left.start : typeof left?.date === "string" ? left.date : "";
  const rightDate = typeof right?.start === "string" ? right.start : typeof right?.date === "string" ? right.date : "";
  if (leftDate || rightDate) {
    return leftDate.localeCompare(rightDate);
  }

  const leftWeekday = Number.isInteger(left?.weekday) ? left.weekday : null;
  const rightWeekday = Number.isInteger(right?.weekday) ? right.weekday : null;
  if (leftWeekday !== null || rightWeekday !== null) {
    const weekdayDiff = getWeeklySortIndex(leftWeekday) - getWeeklySortIndex(rightWeekday);
    if (weekdayDiff !== 0) {
      return weekdayDiff;
    }
    return String(left?.time || "").localeCompare(String(right?.time || ""));
  }

  return 0;
}

function updateCreateModeLayout() {
  const isFreeChoice = createModeUsesParticipantSuggestions();
  const isWeekly = createModeUsesWeeklySlots();
  const isBlockMode = createModeUsesBlockConfig();
  const isBlockFixed = state.createMode === "block_fixed";
  const isBlockFree = state.createMode === "block_free";
  const isStarRating = state.createMode === "star_rating";
  const isFixed = state.createMode === "fixed";
  const isTimeslots = state.createMode === "timeslots";
  const isFreeSlots = state.createMode === "timeslots_free";
  const pageDescription = document.querySelector("#create-page-description");
  const formTitle = document.querySelector("#create-form-title");
  const fixedFields = document.querySelector("#create-fixed-fields");
  const freeFields = document.querySelector("#create-free-fields");
  const weeklyFields = document.querySelector("#create-weekly-fields");
  const blockFields = document.querySelector("#create-block-fields");
  const blockTitle = document.querySelector("#create-block-title");
  const blockDescription = document.querySelector("#create-block-description");
  const blockWindow = document.querySelector("#create-block-window");
  const blockWeekdays = document.querySelector("#create-block-weekdays");
  const freeModeTitle = document.querySelector("#create-free-mode-title");
  const freeModeDescription = document.querySelector("#create-free-mode-description");
  const timeSlotControls = document.querySelector("#create-time-slots-controls");
  const timeSlotTitle = document.querySelector("#create-time-slots-title");
  const timeSlotDescription = document.querySelector("#create-time-slots-description");
  const timeSlotToggleShell = document.querySelector("#create-time-slots-toggle-shell");

  if (isFreeChoice || isWeekly || isFixed || isBlockMode || isStarRating) {
    state.createTimeSlotsEnabled = false;
  } else if (isTimeslots) {
    state.createTimeSlotsEnabled = true;
  }

  if (pageDescription) {
    if (isFixed) {
      pageDescription.textContent = "Gib mehrere konkrete Tage vor und lass Teilnehmende pro Termin mit Ja, Vielleicht oder Nein abstimmen.";
    } else if (isStarRating) {
      pageDescription.textContent = "Gib feste Termine vor und sammle eine Sternebewertung, wenn nicht nur Verfügbarkeit, sondern Präferenz zählt.";
    } else if (isTimeslots) {
      pageDescription.textContent = "Plane Tage mit konkreten Zeitfenstern und lass jede Option einzeln bewerten.";
    } else if (state.createMode === "block_fixed") {
      pageDescription.textContent = "Markiere mögliche Tage für einen zusammenhängenden Block; die Auswertung findet den besten Start.";
    } else if (isBlockFree) {
      pageDescription.textContent = "Lege nur fest, wie lang der Block sein muss; Teilnehmende markieren passende Tage frei im Kalender.";
    } else if (isFreeSlots) {
      pageDescription.textContent =
        "Lass Teilnehmende eigene Tage mit passenden Uhrzeiten vorschlagen, statt Optionen vorzugeben.";
    } else if (isWeekly) {
      pageDescription.textContent = "Stimme wiederkehrende Wochenzeiten ab, zum Beispiel für regelmäßige Meetings oder Kurse.";
    } else {
      pageDescription.textContent = "Lass Teilnehmende selbst passende Tage eintragen, wenn du den Zeitraum bewusst offen halten willst.";
    }
  }

  if (formTitle) {
    if (isFixed) {
      formTitle.textContent = "Termine zur Abstimmung";
    } else if (isStarRating) {
      formTitle.textContent = "Termine für Sternebewertung";
    } else if (isTimeslots) {
      formTitle.textContent = "Tage und Zeitfenster";
    } else if (state.createMode === "block_fixed") {
      formTitle.textContent = "Tage für festen Block";
    } else if (isBlockFree) {
      formTitle.textContent = "Freien Block vorbereiten";
    } else if (isFreeSlots) {
      formTitle.textContent = "Freie Zeitslots vorbereiten";
    } else if (isWeekly) {
      formTitle.textContent = "Wiederkehrende Wochenzeiten";
    } else {
      formTitle.textContent = "Freie Terminvorschläge";
    }
  }

  fixedFields?.classList.toggle("is-hidden", isFreeChoice || isWeekly || isBlockFree);
  freeFields?.classList.toggle("is-hidden", !isFreeChoice);
  weeklyFields?.classList.toggle("is-hidden", !isWeekly);
  blockFields?.classList.toggle("is-hidden", !isBlockMode);
  blockWindow?.classList.toggle("is-hidden", true);
  blockWeekdays?.classList.toggle("is-hidden", !isBlockMode);
  timeSlotControls?.classList.toggle("is-hidden", isFreeChoice || isWeekly || isFixed || isBlockMode || isStarRating);

  if (blockTitle) {
    blockTitle.textContent = state.createMode === "block_fixed" ? "Block mit Tagesabstimmung" : "Freier Block";
  }

  if (blockDescription) {
    blockDescription.textContent = state.createMode === "block_fixed"
      ? "Wähle die möglichen Tage aus. Optional: Blöcke müssen an diesen Wochentagen starten."
      : "Lege die Block-Länge fest. Optional: Blöcke müssen an diesen Wochentagen starten.";
  }

  if (freeModeTitle) {
    freeModeTitle.textContent = isFreeSlots ? "Freie Zeitfenster" : "Freie Terminvorschläge";
  }

  if (freeModeDescription) {
    freeModeDescription.textContent = isFreeSlots
      ? "Teilnehmende schlagen eigene Tage vor und tragen passende Uhrzeiten direkt dazu ein."
      : "Teilnehmende markieren passende Tage selbst im Kalender.";
  }

  if (timeSlotTitle) {
    timeSlotTitle.textContent = isTimeslots ? "Slots festlegen" : "Uhrzeiten erlauben";
  }

  if (timeSlotDescription) {
    timeSlotDescription.textContent = isTimeslots
      ? "Lege pro Datum mindestens einen Zeitraum mit Start- und Endzeit fest."
      : "Optionale feste Uhrzeiten pro Datum definieren.";
  }

  timeSlotToggleShell?.classList.toggle("is-hidden", isTimeslots);
  fillCreateBlockFields();

  if (createModeUsesCalendar()) {
    syncCreateTimeSlotsWithSelectedDates();
    renderCreateCalendar();
    renderCreateSelectedDates();
  }

  if (isWeekly) {
    renderCreateWeeklySlots();
  }

  if (isBlockMode) {
    renderCreateBlockPreview();
  }

  renderCreateTimeSlots();
}

function ensureCreateTimeSlotControls() {
  const host = document.querySelector("#create-time-slot-settings");
  if (!host || document.querySelector("#create-time-slots-controls")) {
    return;
  }

  const controls = document.createElement("div");
  controls.id = "create-time-slots-controls";
  controls.className = "selected-dates-box create-time-slots-panel";
  controls.innerHTML = `
    <div class="selected-header create-toggle-row">
      <div>
        <span id="create-time-slots-title">Uhrzeiten erlauben</span>
        <p id="create-time-slots-description" class="description">Optionale feste Uhrzeiten pro Datum definieren</p>
      </div>
      <label id="create-time-slots-toggle-shell" class="toggle-switch" for="create-time-slots-toggle">
        <input id="create-time-slots-toggle" type="checkbox" ${state.createTimeSlotsEnabled ? "checked" : ""} />
        <span class="toggle-track" aria-hidden="true"></span>
      </label>
    </div>
    <div id="create-time-slots-editor" class="create-time-slots-editor"></div>
  `;

  host.appendChild(controls);
}

function ensureCreateWeeklyControls() {
  const host = document.querySelector("#create-weekly-editor");
  if (!host) {
    return;
  }

  renderCreateWeeklySlots();
}

function renderCreateWeeklySlots() {
  const host = document.querySelector("#create-weekly-editor");
  if (!host) {
    return;
  }

  const rows = Array.isArray(state.createWeeklySlots) ? state.createWeeklySlots : [];
  host.innerHTML = `
    <div class="selected-header">
      <span>Wochen-Slots</span>
      <button id="create-weekly-add" class="ghost-button compact-button" type="button">
        <i class="fa-solid fa-plus"></i>
        Slot
      </button>
    </div>
    <div class="weekly-slot-list"></div>
  `;

  const list = host.querySelector(".weekly-slot-list");
  if (rows.length === 0) {
    list.innerHTML = '<p class="description">Noch keine Wochen-Slots hinterlegt.</p>';
  } else {
    rows.forEach((entry, index) => {
      const row = document.createElement("div");
      row.className = "weekly-slot-row";
      const activeDays = new Set(Array.isArray(entry.weekdays) ? entry.weekdays : []);
      row.innerHTML = `
        <div class="weekly-weekday-group">
          ${weeklyWeekdayOrder
            .map((weekday) => `
              <button
                class="weekly-weekday-button${activeDays.has(weekday) ? " is-active" : ""}"
                type="button"
                data-weekly-weekday="${weekday}"
                data-index="${index}"
              >
                ${escapeHtml(formatWeeklyWeekday(weekday))}
              </button>
            `)
            .join("")}
        </div>
        <div class="weekly-time-range-fields">
          <input
            class="time-slot-input weekly-time-input"
            type="text"
            inputmode="numeric"
            autocomplete="off"
            spellcheck="false"
            maxlength="5"
            placeholder="09:45"
            value="${escapeHtml(entry.start || "")}"
            data-index="${index}"
            data-part="start"
          />
          <span class="time-slot-range-separator">bis</span>
          <input
            class="time-slot-input weekly-time-input"
            type="text"
            inputmode="numeric"
            autocomplete="off"
            spellcheck="false"
            maxlength="5"
            placeholder="11:15"
            value="${escapeHtml(entry.end || "")}"
            data-index="${index}"
            data-part="end"
          />
        </div>
        <button class="text-button danger-text-button" type="button" data-weekly-remove="${index}">Entfernen</button>
      `;
      list.appendChild(row);
    });
  }

  host.querySelector("#create-weekly-add")?.addEventListener("click", () => {
    state.createWeeklySlots.push({ weekdays: [1], start: "", end: "" });
    renderCreateWeeklySlots();
  });

  host.querySelectorAll("[data-weekly-weekday]").forEach((button) => {
    button.addEventListener("click", () => {
      const index = Number(button.dataset.index);
      const weekday = Number(button.dataset.weeklyWeekday);
      const row = state.createWeeklySlots[index];
      if (!row || !Number.isInteger(weekday)) {
        return;
      }

      const current = new Set(Array.isArray(row.weekdays) ? row.weekdays : []);
      if (current.has(weekday)) {
        current.delete(weekday);
      } else {
        current.add(weekday);
      }
      row.weekdays = weeklyWeekdayOrder.filter((value) => current.has(value));
      renderCreateWeeklySlots();
    });
  });

  host.querySelectorAll(".weekly-time-input").forEach((input) => {
    input.addEventListener("input", () => {
      const index = Number(input.dataset.index);
      const part = input.dataset.part === "end" ? "end" : "start";
      const row = state.createWeeklySlots[index];
      if (!row) {
        return;
      }
      const filteredValue = filterTimeSlotInput(input.value);
      if (filteredValue !== input.value) {
        input.value = filteredValue;
      }
      row[part] = filteredValue;
    });

    input.addEventListener("blur", () => {
      const index = Number(input.dataset.index);
      const part = input.dataset.part === "end" ? "end" : "start";
      const row = state.createWeeklySlots[index];
      if (!row) {
        return;
      }
      const normalizedValue = normalizeTimeSlotValue(input.value);
      if (normalizedValue) {
        row[part] = normalizedValue;
        input.value = normalizedValue;
      }
    });
  });

  host.querySelectorAll("[data-weekly-remove]").forEach((button) => {
    button.addEventListener("click", () => {
      const index = Number(button.dataset.weeklyRemove);
      state.createWeeklySlots.splice(index, 1);
      renderCreateWeeklySlots();
    });
  });
}

function normalizeCreateWeeklySlotsForSubmit() {
  const normalized = [];

  for (const entry of state.createWeeklySlots || []) {
    const weekdays = Array.from(new Set((entry.weekdays || []).map((value) => Number(value)).filter((value) => Number.isInteger(value) && value >= 0 && value <= 6)));
    const start = normalizeTimeSlotValue(entry.start || "");
    const end = normalizeTimeSlotValue(entry.end || "");
    if (weekdays.length === 0 && !start && !end) {
      continue;
    }
    if (weekdays.length === 0) {
      return { ok: false, message: "Bitte wähle für jeden Wochen-Slot mindestens einen Wochentag." };
    }
    if (!start || !end || start >= end) {
      return { ok: false, message: "Bitte nutze für Wochen-Slots gültige Zeiten im Format HH:MM-HH:MM." };
    }

    weekdays.forEach((weekday) => {
      normalized.push({ weekday, time: `${start}-${end}` });
    });
  }

  const deduped = new Map();
  normalized.forEach((entry) => {
    deduped.set(buildWeeklySlotKey(entry.weekday, entry.time), entry);
  });

  const slots = Array.from(deduped.values()).sort((left, right) => {
    const leftOrder = weeklyWeekdayOrder.indexOf(left.weekday);
    const rightOrder = weeklyWeekdayOrder.indexOf(right.weekday);
    if (leftOrder !== rightOrder) {
      return leftOrder - rightOrder;
    }
    return left.time.localeCompare(right.time);
  });

  if (slots.length === 0) {
    return { ok: false, message: "Bitte hinterlege mindestens einen Wochen-Slot." };
  }

  return { ok: true, value: { slots } };
}

function fillCreateBlockFields() {
  const lengthInput = document.querySelector("#create-block-length");
  const startInput = document.querySelector("#create-block-start");
  const endInput = document.querySelector("#create-block-end");
  const weekdaySummary = document.querySelector("#create-block-weekday-summary");
  const weekdayButtons = document.querySelector("#create-block-weekday-buttons");

  if (lengthInput) {
    lengthInput.value = state.createBlockConfig.length ? String(state.createBlockConfig.length) : "";
  }
  if (startInput) {
    startInput.value = state.createBlockConfig.startDate || "";
  }
  if (endInput) {
    endInput.value = state.createBlockConfig.endDate || "";
  }
  if (weekdaySummary) {
    weekdaySummary.textContent = formatAllowedBlockStartDays(state.createBlockConfig.weekdays);
  }

  if (weekdayButtons) {
    const activeDays = new Set(normalizePollWeekdays(state.createBlockConfig.weekdays));
    weekdayButtons.innerHTML = weeklyWeekdayOrder
      .map(
        (weekday) => `
          <button
            class="weekly-weekday-button${activeDays.has(weekday) ? " is-active" : ""}"
            type="button"
            data-block-weekday="${weekday}"
          >
            ${escapeHtml(formatWeeklyWeekday(weekday))}
          </button>
        `
      )
      .join("");

    weekdayButtons.querySelectorAll("[data-block-weekday]").forEach((button) => {
      button.addEventListener("click", () => {
        const weekday = Number(button.dataset.blockWeekday);
        if (!Number.isInteger(weekday)) {
          return;
        }

        const selected = new Set(normalizePollWeekdays(state.createBlockConfig.weekdays));
        if (selected.has(weekday)) {
          selected.delete(weekday);
        } else {
          selected.add(weekday);
        }

        state.createBlockConfig.weekdays = weeklyWeekdayOrder.filter((value) => selected.has(value));
        logBlockCreateDebug("toggleWeekday", {
          clickedWeekday: weekday,
          selectedWeekdays: state.createBlockConfig.weekdays,
        });
        fillCreateBlockFields();
      });
    });
  }

  renderCreateBlockPreview();
}

function bindCreateBlockFields() {
  const lengthInput = document.querySelector("#create-block-length");
  const startInput = document.querySelector("#create-block-start");
  const endInput = document.querySelector("#create-block-end");
  const updateBlockDate = (input, key) => {
    const nextValue = typeof input?.value === "string" ? input.value.trim() : "";
    if (!nextValue) {
      state.createBlockConfig[key] = "";
      renderCreateBlockPreview();
      return;
    }

    if (!isIsoDateValue(nextValue)) {
      renderCreateBlockPreview();
      return;
    }

    const parsed = parseIsoDateValue(nextValue);
    if (!parsed || toIsoDate(parsed) !== nextValue) {
      renderCreateBlockPreview();
      return;
    }

    state.createBlockConfig[key] = nextValue;
    renderCreateBlockPreview();
  };

  lengthInput?.addEventListener("input", () => {
    state.createBlockConfig.length = Number.parseInt(lengthInput.value || "", 10) || 0;
    renderCreateBlockPreview();
  });

  ["input", "change"].forEach((eventName) => {
    startInput?.addEventListener(eventName, () => {
      updateBlockDate(startInput, "startDate");
    });

    endInput?.addEventListener(eventName, () => {
      updateBlockDate(endInput, "endDate");
    });
  });

  fillCreateBlockFields();
}

function renderCreateBlockPreview() {
  const preview = document.querySelector("#create-block-preview");
  if (!preview) {
    return;
  }

  const length = normalizePollBlockLength(state.createBlockConfig.length);
  const startWeekdays = normalizePollWeekdays(state.createBlockConfig.weekdays);
  if (!createModeUsesBlockConfig()) {
    preview.innerHTML = "";
    return;
  }

  if (!length) {
    preview.innerHTML = '<p class="description">Bitte hinterlege eine Block-Länge zwischen 2 und 31 Tagen.</p>';
    return;
  }
  if (state.createMode === "block_free") {
    preview.innerHTML = `
      <div class="block-preview-card">
        <div class="selected-header">
          <span>Freier Block</span>
          <span class="pill">${escapeHtml(`${length} Tage`)}</span>
        </div>
        <p class="description">Teilnehmende können später beliebige Tage markieren. Die Auswertung sucht daraus automatisch zusammenhängende Blöcke.</p>
        <p class="description">Erlaubte Starttage: ${escapeHtml(formatAllowedBlockStartDays(startWeekdays))}</p>
      </div>
    `;
    return;
  }

  const entries = listBlockEntriesFromDates(Array.from(state.selectedDates).sort(), length, startWeekdays);
  if (state.selectedDates.size === 0) {
    preview.innerHTML = '<p class="description">Wähle zuerst mögliche Tage im Kalender aus.</p>';
    return;
  }
  if (entries.length === 0) {
    preview.innerHTML = `<p class="feedback error">Die ausgewählten Tage enthalten noch keinen zusammenhängenden Block mit ${length} Tagen.</p>`;
    return;
  }

  preview.innerHTML = `
    <div class="block-preview-card">
      <div class="selected-header">
        <span>${escapeHtml(`${entries.length} mögliche Blöcke`)}</span>
        <span class="pill">${escapeHtml(`${length} Tage`)}</span>
      </div>
      <p class="description">Die Auswertung durchsucht später genau diese zusammenhängenden Block-Zeiträume.</p>
      <p class="description">Erlaubte Starttage: ${escapeHtml(formatAllowedBlockStartDays(startWeekdays))}</p>
      <div class="selected-dates">
        ${entries
          .slice(0, 12)
          .map((entry) => {
            return `<div class="selected-date-pill"><span>${escapeHtml(formatBlockRangeShort(entry.start, entry.end))}</span></div>`;
          })
          .join("")}
      </div>
      ${
        entries.length > 12
          ? `<p class="description">+${escapeHtml(String(entries.length - 12))} weitere Blöcke</p>`
          : ""
      }
    </div>
  `;
}

function normalizeCreateBlockConfigForSubmit() {
  const length = normalizePollBlockLength(state.createBlockConfig.length);
  const weekdays = normalizePollWeekdays(state.createBlockConfig.weekdays);
  const selectedDates = Array.from(state.selectedDates).sort();
  const entries = listBlockEntriesFromDates(selectedDates, length, weekdays);
  logBlockCreateDebug("normalizeCreateBlockConfigForSubmit", {
    rawWeekdays: state.createBlockConfig.weekdays,
    weekdays,
    selectedDates,
    length,
    entries: entries.map((entry) => ({ start: entry.start, end: entry.end })),
  });
  if (!length) {
    return { ok: false, message: "Bitte hinterlege eine gültige Block-Länge zwischen 2 und 31 Tagen." };
  }
  if (state.createMode === "block_free") {
    return {
      ok: true,
      value: {
        length,
        startDate: "",
        endDate: "",
        weekdays,
      },
    };
  }
  if (entries.length === 0) {
    return { ok: false, message: `Die ausgewählten Tage enthalten keinen zusammenhängenden Block mit ${length} Tagen.` };
  }

  return {
    ok: true,
    value: {
      length,
      startDate: "",
      endDate: "",
      weekdays,
    },
  };
}

function renderCreateTimeSlots() {
  const editor = document.querySelector("#create-time-slots-editor");
  const toggle = document.querySelector("#create-time-slots-toggle");
  if (!editor || !toggle) {
    return;
  }

  const usesRangeSlots = createModeUsesRangeSlots();
  toggle.checked = state.createTimeSlotsEnabled;

  if (!state.createTimeSlotsEnabled) {
    editor.innerHTML = '<p class="description">Aktiviere den Schalter, um pro Datum Uhrzeiten zu erfassen.</p>';
    return;
  }

  const dates = Array.from(state.selectedDates).sort();
  if (dates.length === 0) {
    editor.innerHTML = '<p class="description">Wähle zuerst mindestens ein Datum aus.</p>';
    return;
  }

  editor.innerHTML = "";
  for (const date of dates) {
    const card = document.createElement("div");
    card.className = "time-slot-date-card";
    const slots = Array.isArray(state.createTimeSlots[date]) ? state.createTimeSlots[date] : [];
    card.innerHTML = `
      <div class="time-slot-date-head">
        <strong>${escapeHtml(formatDateLong(date))}</strong>
        <button class="ghost-button compact-button" type="button" data-action="add-slot" data-date="${date}">
          <i class="fa-solid fa-plus"></i>
          ${usesRangeSlots ? "Slot" : "Zeit"}
        </button>
      </div>
      ${
        slots.length === 0
          ? `<p class="description">${
              usesRangeSlots ? "Noch keine Zeitslots definiert." : "Ganzer Tag verfügbar."
            }</p>`
          : ""
      }
      <div class="time-slot-list"></div>
    `;

    const list = card.querySelector(".time-slot-list");
    slots.forEach((slotValue, index) => {
      const row = document.createElement("div");
      row.className = `time-slot-row${usesRangeSlots ? " is-range" : ""}`;
      if (usesRangeSlots) {
        const draftRange = parseTimeRangeDraftValue(slotValue);
        row.innerHTML = `
          <div class="time-slot-range-fields">
            <input
              class="time-slot-input time-slot-range-input"
              type="text"
              inputmode="numeric"
              autocomplete="off"
              spellcheck="false"
              maxlength="5"
              value="${escapeHtml(draftRange.start)}"
              placeholder="14:00"
              data-date="${date}"
              data-index="${index}"
              data-part="start"
            />
            <span class="time-slot-range-separator">bis</span>
            <input
              class="time-slot-input time-slot-range-input"
              type="text"
              inputmode="numeric"
              autocomplete="off"
              spellcheck="false"
              maxlength="5"
              value="${escapeHtml(draftRange.end)}"
              placeholder="16:00"
              data-date="${date}"
              data-index="${index}"
              data-part="end"
            />
          </div>
          <button class="text-button danger-text-button" type="button" data-action="remove-slot" data-date="${date}" data-index="${index}">
            Entfernen
          </button>
        `;
      } else {
        row.innerHTML = `
          <input
            class="time-slot-input"
            type="text"
            inputmode="numeric"
            autocomplete="off"
            spellcheck="false"
            maxlength="5"
            value="${escapeHtml(slotValue || "")}"
            placeholder="14:00"
            data-date="${date}"
            data-index="${index}"
          />
          <button class="text-button danger-text-button" type="button" data-action="remove-slot" data-date="${date}" data-index="${index}">
            Entfernen
          </button>
        `;
      }
      list.appendChild(row);
    });

    editor.appendChild(card);
  }

  editor.querySelectorAll('[data-action="add-slot"]').forEach((button) => {
    button.addEventListener("click", () => {
      const { date } = button.dataset;
      if (!date) {
        return;
      }
      if (!Array.isArray(state.createTimeSlots[date])) {
        state.createTimeSlots[date] = [];
      }
      state.createTimeSlots[date].push("");
      renderCreateTimeSlots();
    });
  });

  editor.querySelectorAll(".time-slot-input").forEach((input) => {
    input.addEventListener("input", () => {
      const { date, index } = input.dataset;
      if (!date || index === undefined) {
        return;
      }
      if (!Array.isArray(state.createTimeSlots[date])) {
        state.createTimeSlots[date] = [];
      }
      const filteredValue = filterTimeSlotInput(input.value);
      if (filteredValue !== input.value) {
        input.value = filteredValue;
      }
      if (usesRangeSlots) {
        const row = input.closest(".time-slot-row");
        const startInput = row?.querySelector('[data-part="start"]');
        const endInput = row?.querySelector('[data-part="end"]');
        state.createTimeSlots[date][Number(index)] = buildTimeRangeDraftValue(startInput?.value, endInput?.value);
        return;
      }

      state.createTimeSlots[date][Number(index)] = filteredValue;
    });

    input.addEventListener("blur", () => {
      const { date, index } = input.dataset;
      if (!date || index === undefined || !Array.isArray(state.createTimeSlots[date])) {
        return;
      }

      if (usesRangeSlots) {
        const row = input.closest(".time-slot-row");
        const startInput = row?.querySelector('[data-part="start"]');
        const endInput = row?.querySelector('[data-part="end"]');
        const normalizedRange = normalizeTimeRangeValue(startInput?.value, endInput?.value);
        if (normalizedRange) {
          const parts = parseTimeRangeDraftValue(normalizedRange);
          if (startInput) {
            startInput.value = parts.start;
          }
          if (endInput) {
            endInput.value = parts.end;
          }
          state.createTimeSlots[date][Number(index)] = normalizedRange;
        } else {
          state.createTimeSlots[date][Number(index)] = buildTimeRangeDraftValue(startInput?.value, endInput?.value);
        }
        return;
      }

      const normalizedValue = normalizeTimeSlotValue(input.value);
      if (normalizedValue) {
        input.value = normalizedValue;
        state.createTimeSlots[date][Number(index)] = normalizedValue;
      }
    });
  });

  editor.querySelectorAll('[data-action="remove-slot"]').forEach((button) => {
    button.addEventListener("click", () => {
      const { date, index } = button.dataset;
      if (!date || index === undefined || !Array.isArray(state.createTimeSlots[date])) {
        return;
      }
      state.createTimeSlots[date].splice(Number(index), 1);
      renderCreateTimeSlots();
    });
  });
}

async function handleCreateSubmit(event, pollId) {
  event.preventDefault();
  const feedback = document.querySelector("#create-feedback");
  const title = document.querySelector("#create-title").value.trim();
  const description = document.querySelector("#create-description").value.trim();
  syncCreateTimeSlotsFromEditor();
  const isWeekly = createModeUsesWeeklySlots();
  const isBlockMode = createModeUsesBlockConfig();
  const usesTimeSlots = createModeRequiresTimeSlots();
  const timeSlotValidation = usesTimeSlots ? normalizeCreateTimeSlotsForSubmit() : { ok: true, value: {} };
  const weeklyValidation = isWeekly ? normalizeCreateWeeklySlotsForSubmit() : { ok: true, value: { slots: [] } };
  const blockValidation = isBlockMode ? normalizeCreateBlockConfigForSubmit() : { ok: true, value: getDefaultCreateBlockConfig() };

  if (!timeSlotValidation.ok) {
    setFeedback(feedback, timeSlotValidation.message, "error");
    return;
  }
  if (!weeklyValidation.ok) {
    setFeedback(feedback, weeklyValidation.message, "error");
    return;
  }
  if (!blockValidation.ok) {
    setFeedback(feedback, blockValidation.message, "error");
    return;
  }

  const payload = {
    title,
    description,
    mode: state.createMode,
    dates: createModeUsesCalendar() ? Array.from(state.selectedDates).sort() : [],
    allowTimeSlots: state.createMode === "timeslots" ? true : false,
    timeSlots: usesTimeSlots ? timeSlotValidation.value : {},
    weeklyConfig: weeklyValidation.value,
    blockConfig: blockValidation.value,
  };

  try {
    setFeedback(feedback, pollId ? "Umfrage wird aktualisiert ..." : "Umfrage wird erstellt ...");
    const data = await apiFetch(pollId ? `/api/polls/${pollId}` : "/api/polls", {
      method: pollId ? "PUT" : "POST",
      body: JSON.stringify(payload),
    });
    await navigateTo(`/poll/${data.poll.id}`, { replace: true });
  } catch (error) {
    setFeedback(feedback, error.message, "error");
  }
}

function getFirstSelectedCreateDate(dates) {
  const firstDate = [...(dates || [])].sort()[0];
  if (!firstDate) {
    return new Date();
  }

  const parsed = new Date(`${firstDate}T00:00:00`);
  return Number.isNaN(parsed.getTime()) ? new Date() : parsed;
}

function filterTimeSlotInput(value) {
  if (typeof value !== "string") {
    return "";
  }

  return value.replace(/[^\d:.]/g, "").slice(0, 5);
}

function parseTimeRangeDraftValue(value) {
  const rawValue = typeof value === "string" ? value.trim() : "";
  if (!rawValue) {
    return { start: "", end: "" };
  }

  const separatorIndex = rawValue.indexOf("-");
  if (separatorIndex === -1) {
    return { start: filterTimeSlotInput(rawValue), end: "" };
  }

  return {
    start: filterTimeSlotInput(rawValue.slice(0, separatorIndex)),
    end: filterTimeSlotInput(rawValue.slice(separatorIndex + 1)),
  };
}

function buildTimeRangeDraftValue(startValue, endValue) {
  const start = filterTimeSlotInput(typeof startValue === "string" ? startValue : "");
  const end = filterTimeSlotInput(typeof endValue === "string" ? endValue : "");
  if (!start && !end) {
    return "";
  }

  return `${start}-${end}`;
}

function syncCreateTimeSlotsFromEditor() {
  if (createModeUsesRangeSlots()) {
    const inputs = document.querySelectorAll(".time-slot-range-input");
    if (!inputs.length) {
      return;
    }

    const nextSlots = {};
    inputs.forEach((input) => {
      const date = input.dataset.date;
      const index = Number(input.dataset.index);
      const part = input.dataset.part === "end" ? "end" : "start";
      if (!date || Number.isNaN(index)) {
        return;
      }

      if (!Array.isArray(nextSlots[date])) {
        nextSlots[date] = [];
      }
      if (!nextSlots[date][index]) {
        nextSlots[date][index] = { start: "", end: "" };
      }

      nextSlots[date][index][part] = filterTimeSlotInput(input.value);
    });

    for (const [date, slots] of Object.entries(nextSlots)) {
      state.createTimeSlots[date] = slots.map((slot) => buildTimeRangeDraftValue(slot?.start, slot?.end));
    }
    return;
  }

  const inputs = document.querySelectorAll(".time-slot-input");
  if (!inputs.length) {
    return;
  }

  const nextSlots = {};
  inputs.forEach((input) => {
    const date = input.dataset.date;
    const index = Number(input.dataset.index);
    if (!date || Number.isNaN(index)) {
      return;
    }

    if (!Array.isArray(nextSlots[date])) {
      nextSlots[date] = [];
    }

    nextSlots[date][index] = filterTimeSlotInput(input.value);
  });

  for (const [date, slots] of Object.entries(nextSlots)) {
    state.createTimeSlots[date] = slots.map((slot) => (typeof slot === "string" ? slot : ""));
  }
}

function normalizeTimeSlotValue(value) {
  const filteredValue = filterTimeSlotInput(typeof value === "string" ? value.trim() : "");
  if (!filteredValue) {
    return "";
  }

  let hours = "";
  let minutes = "";
  const separatedMatch = filteredValue.match(/^(\d{1,2})[:.](\d{2})$/);
  if (separatedMatch) {
    hours = separatedMatch[1];
    minutes = separatedMatch[2];
  } else if (/^\d{4}$/.test(filteredValue)) {
    hours = filteredValue.slice(0, 2);
    minutes = filteredValue.slice(2);
  } else {
    return "";
  }

  const hourValue = Number(hours);
  const minuteValue = Number(minutes);
  if (
    !Number.isInteger(hourValue) ||
    !Number.isInteger(minuteValue) ||
    hourValue < 0 ||
    hourValue > 23 ||
    minuteValue < 0 ||
    minuteValue > 59
  ) {
    return "";
  }

  return `${String(hourValue).padStart(2, "0")}:${String(minuteValue).padStart(2, "0")}`;
}

function normalizeTimeRangeValue(value, endValue = null) {
  const rangeParts =
    endValue === null ? parseTimeRangeDraftValue(value) : { start: filterTimeSlotInput(value), end: filterTimeSlotInput(endValue) };
  const start = normalizeTimeSlotValue(rangeParts.start);
  const end = normalizeTimeSlotValue(rangeParts.end);
  if (!start || !end || start >= end) {
    return "";
  }

  return `${start}-${end}`;
}

function normalizePollSlotValue(value) {
  return normalizeTimeRangeValue(value) || normalizeTimeSlotValue(value);
}

function cloneCreateTimeSlots(entries, mode = state.createMode) {
  const clone = {};
  for (const [date, slots] of Object.entries(entries || {})) {
    clone[date] = Array.isArray(slots)
      ? slots
          .map((slot) => (createModeUsesRangeSlots(mode) ? normalizeTimeRangeValue(slot) : normalizeTimeSlotValue(slot)))
          .filter(Boolean)
      : [];
  }
  return clone;
}

function syncCreateTimeSlotsWithSelectedDates() {
  if (!state.createTimeSlotsEnabled) {
    return;
  }

  const nextSlots = {};
  for (const date of Array.from(state.selectedDates).sort()) {
    const existingSlots = Array.isArray(state.createTimeSlots[date]) ? state.createTimeSlots[date] : [];
    nextSlots[date] = existingSlots;
  }
  state.createTimeSlots = nextSlots;
}

function normalizeCreateTimeSlotsForSubmit() {
  const normalized = {};
  const dates = Array.from(state.selectedDates).sort();

  if (dates.length === 0) {
    return { ok: false, message: "Bitte wähle mindestens ein Datum aus." };
  }

  for (const date of dates) {
    const rawSlots = Array.isArray(state.createTimeSlots[date]) ? state.createTimeSlots[date] : [];
    const normalizedSlots = [];

    for (const slot of rawSlots) {
      const rawValue = typeof slot === "string" ? slot.trim() : "";
      if (!rawValue) {
        continue;
      }

      const normalizedValue = createModeUsesRangeSlots()
        ? normalizeTimeRangeValue(rawValue)
        : normalizeTimeSlotValue(filterTimeSlotInput(rawValue));
      if (!normalizedValue) {
        return {
          ok: false,
          message: createModeUsesRangeSlots()
            ? "Bitte nutze für Zeitslots Start- und Endzeiten im Format HH:MM bis HH:MM."
            : "Bitte nutze für optionale Uhrzeiten das Format HH:MM.",
        };
      }

      normalizedSlots.push(normalizedValue);
    }

    normalized[date] = Array.from(new Set(normalizedSlots)).sort();

    if (createModeRequiresTimeSlots() && normalized[date].length === 0) {
      return {
        ok: false,
        message: "Bitte hinterlege für jedes ausgewählte Datum mindestens einen Zeitslot.",
      };
    }
  }

  return { ok: true, value: normalized };
}

function getSuggestedDateEntries(entries) {
  if (!Array.isArray(entries)) {
    return [];
  }

  const byDate = new Map();

  for (const entry of entries) {
    let date = "";
    let rawTimes = [];

    if (typeof entry === "string") {
      date = entry.trim();
    } else if (entry && typeof entry === "object" && !Array.isArray(entry)) {
      date = typeof entry.date === "string" ? entry.date.trim() : "";
      rawTimes = Array.isArray(entry.times)
        ? entry.times
        : Array.isArray(entry.timeSlots)
          ? entry.timeSlots
          : [];
    } else {
      continue;
    }

    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      continue;
    }

    if (!byDate.has(date)) {
      byDate.set(date, new Set());
    }

    const timeSet = byDate.get(date);
    for (const rawTime of rawTimes) {
      const normalizedTime = normalizePollSlotValue(rawTime);
      if (normalizedTime) {
        timeSet.add(normalizedTime);
      }
    }
  }

  return Array.from(byDate.entries())
    .sort(([leftDate], [rightDate]) => leftDate.localeCompare(rightDate))
    .map(([date, timeSet]) => ({
      date,
      times: Array.from(timeSet).sort(),
    }));
}

function syncParticipantSuggestedTimesWithSelectedDates() {
  const nextSlots = {};

  for (const date of Array.from(state.participantSelectedDates).sort()) {
    nextSlots[date] = Array.isArray(state.participantSuggestedTimes[date])
      ? state.participantSuggestedTimes[date].map((slot) => (typeof slot === "string" ? slot : ""))
      : [];
  }

  state.participantSuggestedTimes = nextSlots;
}

function syncParticipantSuggestedTimesFromEditor() {
  if (suggestionModeUsesRangeSlots()) {
    const inputs = document.querySelectorAll(".participant-time-slot-range-input");
    if (!inputs.length) {
      return;
    }

    const nextSlots = {};
    inputs.forEach((input) => {
      const date = input.dataset.date;
      const index = Number(input.dataset.index);
      const part = input.dataset.part === "end" ? "end" : "start";
      if (!date || Number.isNaN(index)) {
        return;
      }

      if (!Array.isArray(nextSlots[date])) {
        nextSlots[date] = [];
      }
      if (!nextSlots[date][index]) {
        nextSlots[date][index] = { start: "", end: "" };
      }

      nextSlots[date][index][part] = filterTimeSlotInput(input.value);
    });

    for (const [date, slots] of Object.entries(nextSlots)) {
      state.participantSuggestedTimes[date] = slots.map((slot) => buildTimeRangeDraftValue(slot?.start, slot?.end));
    }
    return;
  }

  const inputs = document.querySelectorAll(".participant-time-slot-input");
  if (!inputs.length) {
    return;
  }

  const nextSlots = {};
  inputs.forEach((input) => {
    const date = input.dataset.date;
    const index = Number(input.dataset.index);
    if (!date || Number.isNaN(index)) {
      return;
    }

    if (!Array.isArray(nextSlots[date])) {
      nextSlots[date] = [];
    }

    nextSlots[date][index] = filterTimeSlotInput(input.value);
  });

  for (const [date, slots] of Object.entries(nextSlots)) {
    state.participantSuggestedTimes[date] = slots.map((slot) => (typeof slot === "string" ? slot : ""));
  }
}

function normalizeParticipantSuggestionsForSubmit() {
  const usesRangeSlots = suggestionModeUsesRangeSlots();
  const dates = Array.from(state.participantSelectedDates).sort();
  if (dates.length === 0) {
    return [];
  }

  const normalized = [];
  for (const date of dates) {
    const rawSlots = Array.isArray(state.participantSuggestedTimes[date]) ? state.participantSuggestedTimes[date] : [];
    const normalizedSlots = [];

    for (const slot of rawSlots) {
      const rawValue = typeof slot === "string" ? slot.trim() : "";
      if (!rawValue) {
        continue;
      }

      const normalizedValue = usesRangeSlots
        ? normalizeTimeRangeValue(rawValue)
        : normalizeTimeSlotValue(filterTimeSlotInput(rawValue));
      if (!normalizedValue) {
        return null;
      }

      normalizedSlots.push(normalizedValue);
    }

    normalized.push({
      date,
      times: Array.from(new Set(normalizedSlots)).sort(),
    });
  }

  return normalized;
}

function formatSuggestedTimeValues(values, maxItems = Infinity) {
  const normalizedValues = Array.isArray(values)
    ? Array.from(new Set(values.map((value) => normalizePollSlotValue(value)).filter(Boolean))).sort()
    : [];

  if (normalizedValues.length === 0) {
    return "";
  }

  if (!Number.isFinite(maxItems) || normalizedValues.length <= maxItems) {
    return normalizedValues.join(", ");
  }

  return `${normalizedValues.slice(0, maxItems).join(", ")} +${normalizedValues.length - maxItems}`;
}

function formatSuggestedTimeSlotSummary(entries, maxItems = 3) {
  if (!Array.isArray(entries) || entries.length === 0) {
    return "";
  }

  const labels = entries
    .map((entry) => {
      const time = normalizePollSlotValue(typeof entry === "string" ? entry : entry?.time);
      if (!time) {
        return "";
      }

      const count = Number.isFinite(entry?.count) ? Number(entry.count) : 0;
      return count > 0 ? `${time} (${count})` : time;
    })
    .filter(Boolean);

  if (labels.length === 0) {
    return "";
  }

  if (labels.length <= maxItems) {
    return labels.join(", ");
  }

  return `${labels.slice(0, maxItems).join(", ")} +${labels.length - maxItems}`;
}

async function loadDashboardPolls() {
  const list = document.querySelector("#dashboard-polls");
  const summary = document.querySelector("#dashboard-list-summary");
  const title = document.querySelector("#dashboard-list-title");
  const participatedList = document.querySelector("#dashboard-participated-polls");
  const participatedSummary = document.querySelector("#dashboard-participated-summary");
  list.innerHTML = '<p class="description">Deine Umfragen werden geladen ...</p>';
  participatedList.innerHTML = '<p class="description">Fremde Umfragen mit deiner Stimme werden geladen ...</p>';

  try {
    const [dashboardData, participatedData] = await Promise.all([
      apiFetch("/api/user/dashboard"),
      apiFetch("/api/user/participated-polls"),
    ]);

    state.dashboardPolls = dashboardData.polls;
    state.dashboardStats = dashboardData.stats;
    state.participatedPolls = participatedData.polls;

    summary.textContent = formatPollCountLabel(dashboardData.stats.totalPolls);
    if (title) {
      const activeCount = dashboardData.polls.filter((poll) => getDashboardPollStatus(poll).tone === "active").length;
      title.textContent = `${activeCount} aktive Umfragen`;
    }

    participatedSummary.textContent = formatParticipationCountLabel(participatedData.stats.totalPolls);

    renderDashboardPollList(list, dashboardData.polls.slice(0, 5), {
      emptyTitle: "Noch keine Umfragen",
      emptyDescription: "Erstelle oben deine erste Termin-Abstimmung.",
    });
    renderDashboardPollList(participatedList, participatedData.polls.slice(0, 5), {
      emptyTitle: "Noch keine Teilnahmen",
      emptyDescription: "Sobald du an Umfragen anderer Personen teilnimmst, erscheinen sie hier.",
      dateField: "votedAt",
    });
  } catch (error) {
    if (error.status === 401) {
      await navigateTo("/login", { replace: true });
      return;
    }

    list.innerHTML = `<p class="feedback error">${escapeHtml(error.message)}</p>`;
    participatedList.innerHTML = `<p class="feedback error">${escapeHtml(error.message)}</p>`;
  }
}

function renderDashboardPollList(container, polls, options = {}) {
  const emptyTitle = options.emptyTitle || "Keine Umfragen";
  const emptyDescription = options.emptyDescription || "";

  if (polls.length === 0) {
    container.innerHTML = `
      <article class="poll-card poll-empty-state">
        <strong>${escapeHtml(emptyTitle)}</strong>
        <p class="description">${escapeHtml(emptyDescription)}</p>
      </article>
    `;
    return;
  }

  container.innerHTML = polls.map((poll) => renderDashboardPollCard(poll, options)).join("");
  container.querySelectorAll("[data-poll-link]").forEach((row) => {
    row.addEventListener("click", (event) => handleDashboardRowOpen(event, row.dataset.pollLink || ""));
    row.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        handleDashboardRowOpen(event, row.dataset.pollLink || "");
      }
    });
  });
}

async function renderMyPollsPage() {
  const params = new URLSearchParams(window.location.search);
  const page = getPositiveInteger(params.get("page"), 1);
  const pageSize = 12;

  showDynamicView();
  const template = document.querySelector("#my-polls-template");
  dynamicViewElement.appendChild(template.content.cloneNode(true));
  document.querySelector("#my-polls-list").innerHTML = '<p class="description">Deine Umfragen werden geladen ...</p>';

  try {
    const data = await apiFetch(`/api/user/my-polls?page=${page}&pageSize=${pageSize}`);
    const totalPages = Math.max(1, Math.ceil(data.total / data.pageSize));
    const pagination = {
      page: data.page,
      pageSize: data.pageSize,
      totalItems: data.total,
      totalPages,
    };
    const pagePillElement = document.querySelector("#my-polls-page-pill");
    const paginationElement = document.querySelector("#my-polls-pagination");

    if (totalPages > 1) {
      pagePillElement.textContent = `Seite ${pagination.page} von ${pagination.totalPages}`;
      pagePillElement.classList.remove("is-hidden");
    } else {
      pagePillElement.classList.add("is-hidden");
      pagePillElement.textContent = "";
    }

    renderDashboardPollList(document.querySelector("#my-polls-list"), data.polls, {
      emptyTitle: "Noch keine Umfragen",
      emptyDescription: "Erstelle im Dashboard deine erste Termin-Abstimmung.",
    });
    paginationElement.innerHTML = renderPaginationControls(pagination, "/my-polls");
  } catch (error) {
    if (error.status === 401) {
      await navigateTo("/login", { replace: true });
      return;
    }

    dynamicViewElement.innerHTML = `<section class="panel"><h1>Fehler</h1><p>${escapeHtml(error.message)}</p></section>`;
  }
}

async function renderParticipatedPage() {
  showDynamicView();
  dynamicViewElement.innerHTML =
    '<section class="panel"><p class="description">Fremde Umfragen mit deiner Stimme werden geladen ...</p></section>';

  try {
    const data = await apiFetch("/api/user/all-participated");
    renderPollOverviewPage({
      eyebrow: "Fremde Umfragen",
      title: "Umfragen anderer mit deiner Stimme",
      description: "Diese Liste zeigt nur Umfragen anderer Personen, bei denen du bereits abgestimmt hast.",
      summaryLabel: formatParticipationCountLabel(data.stats.totalPolls),
      sectionTitle: "Fremde Umfragen mit deiner Stimme",
      sectionDescription:
        "Hier siehst du nur Umfragen anderer Personen, an denen du bereits mitgewirkt hast, mit der letzten Aktivität auf einen Blick.",
      containerId: "participated-polls-list",
      emptyTitle: "Noch keine Teilnahmen",
      emptyDescription: "Sobald du an Umfragen anderer Personen teilnimmst, erscheinen sie hier.",
      polls: data.polls,
      dateField: "votedAt",
    });
  } catch (error) {
    if (error.status === 401) {
      await navigateTo("/login", { replace: true });
      return;
    }

    dynamicViewElement.innerHTML = `<section class="panel"><h1>Fehler</h1><p>${escapeHtml(error.message)}</p></section>`;
  }
}

function renderPollOverviewPage(options) {
  const pagination = options.pagination || null;
  dynamicViewElement.innerHTML = `
    <section class="dashboard-shell overview-stack">
      <article class="hero-card dashboard-hero overview-hero">
        <div class="hero-copy">
          <div class="inline-action-row">
            <a class="ghost-link" href="/dashboard">
              <i class="fa-solid fa-arrow-left"></i>
              Zurück zum Dashboard
            </a>
          </div>
          <p class="eyebrow">${escapeHtml(options.eyebrow)}</p>
          <h1>${escapeHtml(options.title)}</h1>
          <p class="hero-text">${escapeHtml(options.description)}</p>
        </div>
      </article>

      <article class="panel overview-list-panel">
        <div class="overview-list-intro">
          <div class="overview-list-copy">
            <p class="eyebrow">Übersicht</p>
            <h2>${escapeHtml(options.sectionTitle || options.title)}</h2>
            <p class="description">${escapeHtml(options.sectionDescription || options.description)}</p>
          </div>
          <div class="overview-list-meta">
            ${pagination ? `<span class="pill">Seite ${pagination.page} von ${pagination.totalPages}</span>` : ""}
          </div>
        </div>
        <div id="${escapeHtml(options.containerId)}" class="poll-list"></div>
        ${renderPaginationControls(pagination, options.basePath || "")}
      </article>
    </section>
  `;

  renderDashboardPollList(document.querySelector(`#${options.containerId}`), options.polls, {
    emptyTitle: options.emptyTitle,
    emptyDescription: options.emptyDescription,
    dateField: options.dateField,
  });
}

function renderPaginationControls(pagination, basePath) {
  if (!pagination || pagination.totalPages <= 1) {
    return "";
  }

  const prevHref = `${basePath}?page=${pagination.page - 1}&pageSize=${pagination.pageSize}`;
  const nextHref = `${basePath}?page=${pagination.page + 1}&pageSize=${pagination.pageSize}`;

  return `
    <div class="pagination-row">
      ${pagination.page > 1
        ? `<a class="ghost-link" href="${prevHref}"><i class="fa-solid fa-arrow-left"></i> Vorherige Seite</a>`
        : '<span class="ghost-link is-disabled"><i class="fa-solid fa-arrow-left"></i> Vorherige Seite</span>'}
      ${pagination.page < pagination.totalPages
        ? `<a class="ghost-link" href="${nextHref}">Nächste Seite <i class="fa-solid fa-arrow-right"></i></a>`
        : '<span class="ghost-link is-disabled">Nächste Seite <i class="fa-solid fa-arrow-right"></i></span>'}
    </div>
  `;
}

function getPositiveInteger(value, fallback = 1) {
  const parsed = Number.parseInt(String(value || ""), 10);
  if (Number.isNaN(parsed) || parsed < 1) {
    return fallback;
  }

  return parsed;
}

function formatPollCountLabel(count) {
  return count === 1 ? "1 Umfrage" : `${count} Umfragen`;
}

function formatParticipationCountLabel(count) {
  return count === 1 ? "1 Teilnahme" : `${count} Teilnahmen`;
}

function handleDashboardRowOpen(event, href) {
  if (!href) {
    return;
  }

  if (event.target.closest("button, a")) {
    return;
  }

  navigateTo(href).catch(handleRenderError);
}

function renderDashboardPollCard(poll, options = {}) {
  const dateField = options.dateField || "createdAt";
  const activityDate = poll[dateField] || poll.updatedAt || poll.createdAt;
  const activityDay = typeof activityDate === "string" ? activityDate.slice(0, 10) : "";
  const status = getDashboardPollStatus(poll, options);
  const typeMeta = getDashboardPollTypeMeta(poll.mode);

  return `
    <article class="poll-list-row" data-poll-link="${poll.shareUrl}" tabindex="0">
      <div class="poll-list-main">
        <h3 class="poll-list-title">${escapeHtml(poll.title)}</h3>
      </div>
      <div class="poll-list-meta" aria-label="Datum und Status">
        <span class="poll-list-date">
          ${escapeHtml(activityDay ? formatDateShort(activityDay) : "-")}
        </span>
        <span class="dashboard-status-badge dashboard-status-${status.tone}">${escapeHtml(status.label)}</span>
        <span class="poll-type-pill">${escapeHtml(typeMeta.label)}</span>
      </div>
    </article>
  `;
}

function getDashboardPollStatus(poll, options = {}) {
  if (options.dateField === "votedAt") {
    return { label: "Teilgenommen", tone: "active" };
  }

  const rawStatus = String(poll.status || "").toLowerCase();
  const endsAt = poll.endsAt ? new Date(poll.endsAt) : null;
  const isEnded = Boolean(
    poll.isClosed ||
      poll.closedAt ||
      rawStatus === "closed" ||
      rawStatus === "ended" ||
      rawStatus === "finished" ||
      (endsAt instanceof Date && !Number.isNaN(endsAt.getTime()) && endsAt.getTime() < Date.now())
  );

  if (isEnded) {
    return { label: "Beendet", tone: "ended" };
  }

  if (poll.isDraft || rawStatus === "draft" || Number(poll.responseCount || 0) === 0) {
    return { label: "Entwurf", tone: "draft" };
  }

  return { label: "Aktiv", tone: "active" };
}

function getDashboardPollTypeMeta(mode) {
  if (mode === "fixed") {
    return { label: "Feste Termine", icon: "fa-regular fa-calendar" };
  }
  if (mode === "timeslots") {
    return { label: "Zeitfenster", icon: "fa-regular fa-clock" };
  }
  if (mode === "block_fixed") {
    return { label: "Mehrtägiger Block", icon: "fa-solid fa-calendar-week" };
  }
  if (mode === "block_free") {
    return { label: "Freier Block", icon: "fa-solid fa-calendar-days" };
  }
  if (mode === "star_rating") {
    return { label: "Sterne-Bewertung", icon: "fa-regular fa-star" };
  }
  if (mode === "timeslots_free") {
    return { label: "Freie Zeitfenster", icon: "fa-regular fa-calendar-plus" };
  }
  if (mode === "weekly") {
    return { label: "Wochenrhythmus", icon: "fa-regular fa-clock" };
  }

  return { label: "Freie Terminvorschläge", icon: "fa-regular fa-pen-to-square" };
}

async function handleRegister(event) {
  event.preventDefault();
  const feedback = document.querySelector("#register-feedback");
  const email = document.querySelector("#register-email").value.trim();
  const password = document.querySelector("#register-password").value;
  const passwordConfirm = document.querySelector("#register-password-confirm").value;

  if (password !== passwordConfirm) {
    setFeedback(feedback, "Die Passwörter stimmen nicht überein.", "error");
    return;
  }

  try {
    setFeedback(feedback, "Konto wird erstellt ...");
    await apiFetch("/api/auth/register", {
      method: "POST",
      body: JSON.stringify({ email, password }),
    });
    await refreshAuthState();
    renderTopbarNav();
    await navigateTo("/dashboard", { replace: true });
  } catch (error) {
    setFeedback(feedback, error.message, "error");
  }
}

async function handleLogin(event) {
  event.preventDefault();
  const feedback = document.querySelector("#login-feedback");
  const email = document.querySelector("#login-email").value.trim();
  const password = document.querySelector("#login-password").value;

  try {
    setFeedback(feedback, "Login wird geprüft ...");
    await apiFetch("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ email, password }),
    });
    await refreshAuthState();
    renderTopbarNav();
    await navigateTo("/dashboard", { replace: true });
  } catch (error) {
    setFeedback(feedback, error.message, "error");
  }
}

async function handleForgotPassword(event) {
  event.preventDefault();
  const feedback = document.querySelector("#forgot-password-feedback");
  const fallback = document.querySelector("#forgot-password-link");
  const email = document.querySelector("#forgot-password-email").value.trim();

  try {
    setFeedback(feedback, "Reset-Link wird erzeugt ...");
    const data = await apiFetch("/api/auth/forgot-password", {
      method: "POST",
      body: JSON.stringify({ email }),
    });

    setFeedback(feedback, data.message, "success");
    fallback.innerHTML = "";

    if (data.resetUrl) {
      const openButton = document.createElement("button");
      openButton.type = "button";
      openButton.className = "primary-button";
      openButton.textContent = "Reset-Seite öffnen";
      openButton.addEventListener("click", async () => {
        const resetUrl = new URL(data.resetUrl, window.location.origin);
        const token = resetUrl.searchParams.get("token") || "";

        if (resetUrl.pathname === "/forgot-password") {
          await navigateTo("/forgot-password");
          return;
        }

        await navigateTo(`/reset-password?token=${encodeURIComponent(token)}`);
      });

      const note = document.createElement("p");
      note.className = "description";
      note.textContent = "Lokale Entwicklungsumgebung: der Link wird direkt angezeigt.";

      fallback.append(openButton, note);
      return;
    }

    fallback.innerHTML = '<p class="description">Wenn die Adresse existiert, wurde ein Reset-Link erzeugt.</p>';
  } catch (error) {
    fallback.innerHTML = "";
    setFeedback(feedback, error.message, "error");
  }
}

async function handleResetPassword(event) {
  event.preventDefault();
  const feedback = document.querySelector("#reset-password-feedback");
  const password = document.querySelector("#reset-password-new").value;
  const passwordConfirm = document.querySelector("#reset-password-confirm").value;
  const token = document.querySelector("#reset-password-token").value;

  if (password !== passwordConfirm) {
    setFeedback(feedback, "Die Passwörter stimmen nicht überein.", "error");
    return;
  }

  try {
    setFeedback(feedback, "Passwort wird gespeichert ...");
    await apiFetch("/api/auth/reset-password", {
      method: "POST",
      body: JSON.stringify({ token, password }),
    });
    await refreshAuthState();
    renderTopbarNav();
    await navigateTo("/dashboard", { replace: true });
  } catch (error) {
    setFeedback(feedback, error.message, "error");
  }
}

async function handleLogout(event) {
  event?.preventDefault();

  try {
    await apiFetch("/api/auth/logout", { method: "POST" });
  } finally {
    await refreshAuthState();
    renderTopbarNav();
    await navigateTo("/login", { replace: true });
  }
}

async function handleProfileSave(event) {
  event.preventDefault();
  const feedback = document.querySelector("#account-profile-feedback");
  const name = document.querySelector("#account-name").value.trim();

  if (name.length < 2) {
    setFeedback(feedback, "Der Name muss mindestens 2 Zeichen lang sein.", "error");
    return;
  }

  try {
    setFeedback(feedback, "Profil wird gespeichert ...");
    const data = await apiFetch("/api/user/profile", {
      method: "PUT",
      body: JSON.stringify({ name }),
    });
    state.auth.user = { ...state.auth.user, name: data.name };
    const displayNameElement = document.querySelector("#account-display-name");
    if (displayNameElement) {
      displayNameElement.textContent = data.name;
    }
    renderTopbarNav();
    setFeedback(feedback, "Profil gespeichert.", "success");
  } catch (error) {
    setFeedback(feedback, error.message, "error");
  }
}

async function handlePasswordChange(event) {
  event.preventDefault();
  const feedback = document.querySelector("#account-password-feedback");
  const currentPassword = document.querySelector("#account-current-password").value;
  const newPassword = document.querySelector("#account-new-password").value;
  const confirmPassword = document.querySelector("#account-confirm-password").value;

  if (newPassword !== confirmPassword) {
    setFeedback(feedback, "Die neuen Passwörter stimmen nicht überein.", "error");
    return;
  }

  try {
    setFeedback(feedback, "Passwort wird geändert ...");
    await apiFetch("/api/user/password", {
      method: "PUT",
      body: JSON.stringify({ currentPassword, newPassword }),
    });
    document.querySelector("#account-password-form").reset();
    setFeedback(feedback, "Passwort erfolgreich geändert.", "success");
    closePasswordModal();
  } catch (error) {
    setFeedback(feedback, error.message, "error");
  }
}

function openPasswordModal() {
  const modal = document.querySelector("#account-password-modal");
  const currentPasswordField = document.querySelector("#account-current-password");
  if (!modal) {
    return;
  }

  modal.classList.add("is-open");
  modal.setAttribute("aria-hidden", "false");
  document.body.classList.add("modal-open");
  if (currentPasswordField) {
    currentPasswordField.focus();
  }
}

function closePasswordModal() {
  const modal = document.querySelector("#account-password-modal");
  const form = document.querySelector("#account-password-form");
  const feedback = document.querySelector("#account-password-feedback");
  if (!modal) {
    return;
  }

  modal.classList.remove("is-open");
  modal.setAttribute("aria-hidden", "true");
  document.body.classList.remove("modal-open");
  if (form) {
    form.reset();
  }
  if (feedback) {
    setFeedback(feedback, "");
  }
}

async function handleAccountDelete() {
  const feedback = document.querySelector("#account-delete-feedback");
  const confirmed = confirm("Willst du dein Konto wirklich dauerhaft löschen?");
  if (!confirmed) {
    return;
  }

  try {
    setFeedback(feedback, "Konto wird gelöscht ...");
    await apiFetch("/api/user/account", { method: "DELETE" });
    await refreshAuthState();
    renderTopbarNav();
    await navigateTo("/", { replace: true });
  } catch (error) {
    setFeedback(feedback, error.message, "error");
  }
}

async function renderPollPage(pollId) {
  if (!state.auth.user) {
    await navigateTo("/login", { replace: true });
    return;
  }

  const template = document.querySelector("#poll-template");
  showDynamicView();
  dynamicViewElement.innerHTML =
    '<section class="panel"><p class="description">Poll wird geladen ...</p></section>';

  try {
    const data = await apiFetch(`/api/polls/${pollId}`);
    state.pollData = data;
    state.pollDrawerOpen = false;
    initializeResultsCalendarState(data.poll, data.responses, data.results);
    dynamicViewElement.innerHTML = "";
    dynamicViewElement.appendChild(template.content.cloneNode(true));

    initializeDraftFromPoll(data.poll);
    fillPollSummary();
    renderAvailabilityForm();
    renderResultsTable();
    bindPollResponseEvents();
    syncPollResponsePanelState();

    document.querySelector("#response-form").addEventListener("submit", handleResponseSubmit);
    document.querySelector("#poll-share-button").addEventListener("click", () => {
      sharePollLink().catch((error) => {
        setFeedback(document.querySelector("#response-feedback"), error.message, "error");
      });
    });
  } catch (error) {
    dynamicViewElement.innerHTML = `<section class="panel"><h1>Nicht gefunden</h1><p>${escapeHtml(
      error.message
    )}</p></section>`;
  }
}

function initializeDraftFromPoll(poll) {
  const editableResponse = getEditableResponse();
  state.participantCalendarExpanded = !mobileMediaQuery.matches;
  const hasTimeSlots = pollHasTimeSlots(poll);

  if (pollUsesBlockFixed(poll)) {
    state.responseDraft = buildBlockFixedDailyDraft(poll, editableResponse);
    state.participantSelectedDates = new Set();
    state.participantSuggestedTimes = {};
    state.participantCurrentMonth = startOfMonth(getFirstSelectedCreateDate(poll.dates || []));
    return;
  }

  if (pollUsesBlockFree(poll)) {
    state.responseDraft = buildBlockFreeDailyDraft(poll, editableResponse);
    const selectedDates = getSelectedBlockFreeDates(state.responseDraft, poll);
    const firstRelevantDate = selectedDates[0] || getPollBlockSelectableDates(poll)[0] || toIsoDate(new Date());
    state.participantSelectedDates = new Set(selectedDates);
    state.participantSuggestedTimes = {};
    state.participantCurrentMonth = startOfMonth(
      new Date(`${firstRelevantDate}T00:00:00`)
    );
    return;
  }

  if (pollUsesWeeklySlots(poll)) {
    const defaultDraft = {};
    getWeeklySlotsFromPoll(poll).forEach((slot) => {
      const key = buildWeeklySlotKey(slot.weekday, slot.time);
      defaultDraft[key] = editableResponse?.weeklyAvailabilities?.[key] || "maybe";
    });
    state.responseDraft = defaultDraft;
    state.participantSelectedDates = new Set();
    state.participantSuggestedTimes = {};
    state.participantCurrentMonth = startOfMonth(new Date());
    return;
  }

  if (pollUsesStarRating(poll)) {
    const defaultDraft = {};
    for (const date of poll.dates || []) {
      const rating = Number(editableResponse?.availabilities?.[date] || 0);
      defaultDraft[date] = Number.isInteger(rating) && rating >= 1 && rating <= 5 ? rating : 0;
    }
    state.responseDraft = defaultDraft;
    state.participantSelectedDates = new Set();
    state.participantSuggestedTimes = {};
    state.participantCurrentMonth = startOfMonth(getFirstSelectedCreateDate(poll.dates || []));
    return;
  }

  if (pollUsesParticipantSuggestions(poll.mode) && !hasTimeSlots) {
    const suggestedEntries = getSuggestedDateEntries(
      editableResponse?.suggestedDateEntries || editableResponse?.suggestedDates
    );
    state.responseDraft = {};
    state.participantSelectedDates = new Set(suggestedEntries.map((entry) => entry.date));
    state.participantSuggestedTimes = Object.fromEntries(suggestedEntries.map((entry) => [entry.date, entry.times]));
    syncParticipantSuggestedTimesWithSelectedDates();
    state.participantCurrentMonth = startOfMonth(
      state.participantSelectedDates.size > 0 ? getFirstSelectedCreateDate(state.participantSelectedDates) : new Date()
    );
    return;
  }

  const defaultDraft = {};
  if (hasTimeSlots) {
    const timeSlotsByDate = getPollTimeSlotsByDate(poll);
    for (const date of [...(poll.dates || [])].sort()) {
      const slots = timeSlotsByDate[date] || [];
      if (slots.length === 0) {
        defaultDraft[date] = editableResponse?.availabilities?.[date] || "maybe";
        continue;
      }

      defaultDraft[date] = {};
      for (const slot of slots) {
        defaultDraft[date][slot] = editableResponse?.slotAvailabilities?.[date]?.[slot] || "maybe";
      }
    }
  } else {
    for (const date of poll.dates) {
      defaultDraft[date] = editableResponse?.availabilities?.[date] || "maybe";
    }
  }

  state.responseDraft = defaultDraft;
  state.participantSelectedDates = new Set();
  state.participantSuggestedTimes = {};
  state.participantCurrentMonth = startOfMonth(new Date());
}

function initializeResultsCalendarState(poll, responses, results) {
  if (pollUsesWeeklySlots(poll)) {
    state.resultsCalendarView = "month";
    state.resultsCalendarDate = new Date();
    return;
  }

  const anchorDate =
    collectResultsCalendarEvents(poll, responses, results)[0]?.date ||
    getTopMatrixDates(results?.summary || [])[0]?.date ||
    (Array.isArray(poll?.dates) ? [...poll.dates].sort()[0] : "") ||
    toIsoDate(new Date());

  state.resultsCalendarView = "month";
  state.resultsCalendarDate = new Date(`${anchorDate}T00:00:00`);
}

function getEditableResponse() {
  if (!state.pollData?.user?.id) {
    return null;
  }

  return state.pollData.responses.find((response) => response.userId === state.pollData.user.id) || null;
}

function hasEditableResponse() {
  return Boolean(getEditableResponse());
}

function isCompactPollLayout() {
  return mobileMediaQuery.matches;
}

function bindCalendarSwipe(element, onPrevious, onNext) {
  if (!element || element.dataset.swipeBound === "true" || !window.PointerEvent) {
    return;
  }

  element.dataset.swipeBound = "true";
  element.dataset.swipeHint = "true";

  let startX = 0;
  let startY = 0;
  let activePointerId = null;
  let isTracking = false;

  element.addEventListener("pointerdown", (event) => {
    if (!mobileMediaQuery.matches || event.pointerType === "mouse") {
      return;
    }

    activePointerId = event.pointerId;
    startX = event.clientX;
    startY = event.clientY;
    isTracking = true;
  });

  element.addEventListener("pointermove", (event) => {
    if (!isTracking || event.pointerId !== activePointerId) {
      return;
    }

    const deltaX = event.clientX - startX;
    const deltaY = event.clientY - startY;
    element.classList.toggle("is-swiping", Math.abs(deltaX) > 18 && Math.abs(deltaX) > Math.abs(deltaY));
  });

  element.addEventListener("pointerup", (event) => {
    if (!isTracking || event.pointerId !== activePointerId) {
      return;
    }

    const deltaX = event.clientX - startX;
    const deltaY = event.clientY - startY;
    activePointerId = null;
    isTracking = false;
    element.classList.remove("is-swiping");

    if (Math.abs(deltaX) < 54 || Math.abs(deltaX) < Math.abs(deltaY) * 1.4) {
      return;
    }

    if (deltaX < 0) {
      onNext();
    } else {
      onPrevious();
    }
  });

  element.addEventListener("pointercancel", () => {
    activePointerId = null;
    isTracking = false;
    element.classList.remove("is-swiping");
  });
}

function updatePollResponseCta() {
  const label = document.querySelector("#poll-open-response-label");
  const mobileLabel = document.querySelector("#poll-mobile-response-label");
  const currentParticipant = getCurrentParticipantState();
  if (!label && !mobileLabel) {
    return;
  }

  let nextLabel = "";
  if (currentParticipant.isBlocked) {
    nextLabel = "Gesperrt";
  } else if (!currentParticipant.canVote) {
    nextLabel = "Derzeit deaktiviert";
  } else {
    nextLabel = hasEditableResponse() ? "Verfügbarkeit ändern" : "Jetzt abstimmen";
  }

  if (label) {
    label.textContent = nextLabel;
  }
  if (mobileLabel) {
    mobileLabel.textContent = nextLabel;
  }
}

function getCurrentParticipantState() {
  return {
    canVote: state.pollData?.participant?.canVote !== false,
    hasVeto: Boolean(state.pollData?.participant?.hasVeto),
    isBlocked: Boolean(state.pollData?.participant?.isBlocked),
  };
}

function syncPollResponsePanelState() {
  const panel = document.querySelector("#poll-response-panel");
  const overlay = document.querySelector("#poll-response-overlay");
  if (!panel || !overlay) {
    return;
  }

  const drawerOpen = state.pollDrawerOpen;
  panel.classList.toggle("is-open", drawerOpen);
  overlay.classList.toggle("is-hidden", !drawerOpen);
  document.body.classList.toggle("poll-drawer-open", drawerOpen);
}

function openPollResponseDrawer(options = {}) {
  if (options.resetDraft) {
    initializeDraftFromPoll(state.pollData.poll);
    renderAvailabilityForm();
  }

  state.pollDrawerOpen = true;
  syncPollResponsePanelState();

  if (!isCompactPollLayout()) {
    return;
  }

  document.querySelector("#poll-response-card")?.scrollTo({ top: 0, behavior: "auto" });
}

function closePollResponseDrawer() {
  state.pollDrawerOpen = false;
  syncPollResponsePanelState();
}

function bindPollResponseEvents() {
  document.querySelector("#poll-open-response")?.addEventListener("click", () => {
    openPollResponseDrawer();
  });

  document.querySelector("#poll-mobile-response")?.addEventListener("click", () => {
    openPollResponseDrawer();
  });

  document.querySelector("#poll-mobile-results")?.addEventListener("click", () => {
    document.querySelector("#poll-results-panel")?.scrollIntoView({ behavior: "smooth", block: "start" });
  });

  document.querySelector("#poll-close-response")?.addEventListener("click", () => {
    closePollResponseDrawer();
  });

  document.querySelector("#poll-response-overlay")?.addEventListener("click", () => {
    closePollResponseDrawer();
  });
}

function handleGlobalKeydown(event) {
  if (event.key === "Escape" && state.pollDrawerOpen) {
    closePollResponseDrawer();
  }
}

function fillPollSummary() {
  const { poll, owner, responses, results } = state.pollData;
  const hasTimeSlots = pollHasTimeSlots(poll);
  const blockConfig = normalizePollBlockConfig(poll);
  const modeMeta = getDashboardPollTypeMeta(poll.mode);
  const meta = document.querySelector("#poll-context-meta");
  const summaryEmpty = document.querySelector("#poll-summary-empty");
  const favoriteSummary = document.querySelector("#poll-favorite-summary");
  const ownerLabel = owner ? owner.name || owner.email : "";
  const favorite = getPollFavorite(poll, responses, results);

  document.querySelector("#poll-title-view").textContent = poll.title;
  document.querySelector("#poll-description-view").textContent = poll.description || "";
  document.querySelector("#poll-description-view").classList.toggle("is-hidden", !poll.description);
  favoriteSummary.textContent =
    responses.length > 0 && favorite
      ? `🏆 Favorit: ${escapeFavoriteLabel(poll, favorite)} mit ${formatFavoriteMetricLabel(poll, favorite)}`
      : "";
  favoriteSummary.classList.toggle("is-hidden", !(responses.length > 0 && favorite));
  document.querySelector("#participant-form-title").textContent = hasEditableResponse()
    ? "Verfügbarkeit anpassen"
    : hasTimeSlots
      ? "Deine Zeitfenster"
      : poll.mode === "block_fixed"
        ? "Deine Verfügbarkeit"
      : poll.mode === "block_free"
        ? "Deine möglichen Tage"
      : poll.mode === "star_rating"
        ? "Deine Bewertung"
      : poll.mode === "timeslots_free"
        ? "Deine Zeitfenster"
      : poll.mode === "weekly"
        ? "Deine Wochen-Slots"
      : poll.mode === "fixed"
        ? "Deine Verfügbarkeit"
      : "Teilnehmen";
  document.querySelector("#poll-back-link").setAttribute("href", state.auth.user ? "/dashboard" : "/");
  document.querySelector("#poll-back-link").innerHTML = state.auth.user
    ? '<i class="fa-solid fa-arrow-left"></i> Zurück'
    : '<i class="fa-solid fa-arrow-left"></i> Start';

  meta.innerHTML = [
    `<span class="pill"><i class="${escapeHtml(modeMeta.icon)}"></i> ${escapeHtml(modeMeta.label)}</span>`,
    `<span class="pill"><i class="fa-regular fa-calendar"></i> ${escapeHtml(
      hasTimeSlots
        ? `${countPollScheduleEntries(poll)} Zeitslots`
        : pollUsesBlockFree(poll)
          ? `${results.summary.length || 0} Blöcke`
        : pollUsesBlockMode(poll)
          ? `${getPollBlockEntries(poll).length} Blöcke`
        : poll.mode === "star_rating"
          ? `${poll.dates.length} Termine`
        : poll.mode === "weekly"
          ? `${getWeeklySlotsFromPoll(poll).length} Wochen-Slots`
        : poll.mode === "fixed"
          ? `${poll.dates.length} Termine`
        : `${results.summary.length || 0} genannte Tage`
    )}</span>`,
    `<span class="pill"><i class="fa-regular fa-user"></i> ${escapeHtml(formatResponseCountLabel(responses.length))}</span>`,
    ownerLabel
      ? `<span class="pill"><i class="fa-regular fa-id-badge"></i> ${escapeHtml(ownerLabel)}</span>`
      : "",
  ].filter(Boolean).join("");

  const currentParticipant = getCurrentParticipantState();
  if (currentParticipant.hasVeto) {
    meta.innerHTML += `<span class="pill"><i class="fa-solid fa-crown"></i> Veto-Recht</span>`;
  }
  if (pollUsesBlockMode(poll) && blockConfig.length) {
    meta.innerHTML += `<span class="pill"><i class="fa-solid fa-arrow-right-long"></i> ${escapeHtml(`${blockConfig.length} Tage am Stück`)}</span>`;
  }
  if (pollUsesBlockMode(poll) && blockConfig.weekdays.length > 0) {
    meta.innerHTML += `<span class="pill"><i class="fa-solid fa-calendar-day"></i> ${escapeHtml(`Start: ${blockConfig.weekdays.map((weekday) => formatWeeklyWeekday(weekday)).join(", ")}`)}</span>`;
  }
  if (pollUsesBlockMode(poll) && Array.isArray(poll?.dates) && poll.dates.length > 0) {
    meta.innerHTML += `<span class="pill"><i class="fa-regular fa-calendar-check"></i> ${escapeHtml(`${formatDateShort([...poll.dates].sort()[0])}-${formatDateShort([...poll.dates].sort()[poll.dates.length - 1])}`)}</span>`;
  }

  summaryEmpty.classList.add("is-hidden");
  summaryEmpty.innerHTML = "";
  renderPollOwnerActions();
  updatePollResponseCta();

  if (pollUsesParticipantSuggestions(poll.mode) && !hasTimeSlots) {
    if ((results.bestDates || results.bestBlocks || []).length === 0) {
      summaryEmpty.innerHTML = renderEmptyStateMarkup(
        "fa-regular fa-calendar-plus",
        "Noch keine Vorschläge eingegangen",
        "Die Matrix bleibt bewusst schlank. Die ersten Einträge tauchen direkt in der Übersicht auf."
      );
      summaryEmpty.classList.remove("is-hidden");
    }
    return;
  }

  if (responses.length === 0) {
    summaryEmpty.innerHTML = renderEmptyStateMarkup(
      "fa-regular fa-comments",
      "Noch keine Antworten eingegangen",
      "Die Matrix füllt sich automatisch, sobald die ersten Personen abstimmen."
    );
    summaryEmpty.classList.remove("is-hidden");
  }
}

function escapeFavoriteLabel(poll, favorite) {
  if (pollUsesBlockMode(poll)) {
    return formatBlockRangeShort(favorite.date, favorite.endDate);
  }

  if (pollUsesWeeklySlots(poll)) {
    return `${favorite.date}${formatFavoriteSlotLabel(poll, favorite.slot)}`;
  }

  return `${formatDateShort(favorite.date)}${formatFavoriteSlotLabel(poll, favorite.slot)}`;
}

function formatResponseCountLabel(count) {
  return count === 1 ? "1 Antwort" : `${count} Antworten`;
}

function formatVoteCountLabel(count) {
  return count === 1 ? "1 Stimme" : `${count} Stimmen`;
}

function formatRatingCountLabel(count) {
  return count === 1 ? "1 Bewertung" : `${count} Bewertungen`;
}

function formatAverageRating(value) {
  const rating = Number(value);
  return Number.isFinite(rating) ? rating.toFixed(1) : "0.0";
}

function getStarRatingCalendarColor(value) {
  const rating = Math.min(5, Math.max(1, Number(value) || 1));
  const stops = [
    { rating: 1, h: 0, s: 80, l: 50 },
    { rating: 2, h: 30, s: 95, l: 55 },
    { rating: 3, h: 50, s: 90, l: 60 },
    { rating: 4, h: 120, s: 70, l: 50 },
    { rating: 5, h: 140, s: 80, l: 30 },
  ];
  const upperIndex = stops.findIndex((stop) => rating <= stop.rating);
  if (upperIndex <= 0) {
    const stop = stops[0];
    return `hsl(${stop.h}, ${stop.s}%, ${stop.l}%)`;
  }

  const lower = stops[upperIndex - 1];
  const upper = stops[upperIndex] || stops[stops.length - 1];
  const ratio = (rating - lower.rating) / (upper.rating - lower.rating);
  const h = lower.h + (upper.h - lower.h) * ratio;
  const s = lower.s + (upper.s - lower.s) * ratio;
  const l = lower.l + (upper.l - lower.l) * ratio;

  return `hsl(${h.toFixed(1)}, ${s.toFixed(1)}%, ${l.toFixed(1)}%)`;
}

function formatFavoriteMetricLabel(poll, favorite) {
  if (pollUsesStarRating(poll)) {
    return `${formatAverageRating(favorite.average)} Sterne`;
  }

  return formatVoteCountLabel(favorite.votes);
}

function formatFavoriteSlotLabel(poll, slot) {
  if (!slot) {
    return "";
  }

  return poll?.mode === "weekly" || poll?.mode === "timeslots" ? ` (${slot})` : ` um ${slot}`;
}

function renderPollOwnerActions() {
  const container = document.querySelector("#poll-owner-actions");
  const shell = document.querySelector("#poll-settings-shell");
  if (!container || !shell || !state.pollData?.permissions?.canManage) {
    if (container) {
      container.innerHTML = "";
    }
    if (shell) {
      shell.classList.add("is-hidden");
      shell.open = false;
    }
    return;
  }

  const { poll } = state.pollData;
  const exportDates = getPollExportDates(poll);
  const defaultDate = exportDates[0] || "";
  shell.classList.remove("is-hidden");
  container.innerHTML = `
    <div class="owner-action-stack">
      <button id="owner-edit-poll" class="settings-action" type="button">
        <span class="settings-action-copy">
          <span class="settings-action-title">Bearbeiten</span>
          <small>Titel, Beschreibung oder Modus anpassen.</small>
        </span>
        <i class="fa-solid fa-pen"></i>
      </button>

      <button id="owner-duplicate-poll" class="settings-action" type="button">
        <span class="settings-action-copy">
          <span class="settings-action-title">Duplizieren</span>
          <small>Neue Umfrage mit denselben Stammdaten anlegen.</small>
        </span>
        <i class="fa-regular fa-clone"></i>
      </button>

      <div class="settings-action">
        <span class="settings-action-copy">
          <span class="settings-action-title">ICS exportieren</span>
          <small>Direkt den besten Termin in den Kalender ziehen.</small>
        </span>
        <div class="settings-action-copy">
          <select id="poll-export-date">
            ${
              exportDates.length > 0
                ? exportDates
                    .map(
                      (date) => `
                        <option value="${date}" ${date === defaultDate ? "selected" : ""}>${escapeHtml(formatPollExportLabel(poll, date))}</option>
                      `
                    )
                    .join("")
                : '<option value="">Kein Datum verfügbar</option>'
            }
          </select>
          <button id="owner-export-ics" class="ghost-button wide-button" type="button" ${
            exportDates.length === 0 ? "disabled" : ""
          }>ICS herunterladen</button>
        </div>
      </div>

      <button id="owner-delete-poll" class="settings-action danger-button" type="button">
        <span class="settings-action-copy">
          <span class="settings-action-title">Löschen</span>
          <small>Entfernt die Umfrage inklusive aller Antworten dauerhaft.</small>
        </span>
        <i class="fa-regular fa-trash-can"></i>
      </button>
    </div>
  `;

  document.querySelector("#owner-edit-poll").addEventListener("click", () => {
    navigateTo(`/create?mode=${encodeURIComponent(poll.mode)}&edit=${encodeURIComponent(poll.id)}`).catch(handleRenderError);
  });

  document.querySelector("#owner-duplicate-poll").addEventListener("click", async () => {
    try {
      setFeedback(document.querySelector("#response-feedback"), "Umfrage wird dupliziert ...");
      const data = await apiFetch(`/api/polls/${poll.id}/duplicate`, { method: "POST" });
      await navigateTo(`/poll/${data.poll.id}`);
    } catch (error) {
      setFeedback(document.querySelector("#response-feedback"), error.message, "error");
    }
  });

  document.querySelector("#owner-export-ics")?.addEventListener("click", handleCalendarDownload);

  document.querySelector("#owner-delete-poll").addEventListener("click", async () => {
    if (!confirm("Umfrage wirklich löschen?")) {
      return;
    }

    try {
      setFeedback(document.querySelector("#response-feedback"), "Umfrage wird gelöscht ...");
      await apiFetch(`/api/polls/${poll.id}`, { method: "DELETE" });
      await navigateTo("/dashboard", { replace: true });
    } catch (error) {
      setFeedback(document.querySelector("#response-feedback"), error.message, "error");
    }
  });
}


function renderAvailabilityForm() {
  const grid = document.querySelector("#availability-grid");
  const legend = document.querySelector("#availability-legend");
  const panel = document.querySelector("#poll-response-panel");
  const cta = document.querySelector("#poll-open-response");
  const mobileCta = document.querySelector("#poll-mobile-response");
  const form = document.querySelector("#response-form");
  const submitButton = document.querySelector("#submit-response-button");

  if (!grid || !legend || !panel || !cta || !mobileCta || !form || !submitButton) {
    return;
  }

  if (!state.auth.user) {
    panel.classList.add("is-hidden");
    cta.classList.add("is-hidden");
    mobileCta.classList.add("is-hidden");
    form.reset();
    grid.innerHTML = "";
    legend.classList.add("is-hidden");
    return;
  }

  panel.classList.remove("is-hidden");
  cta.classList.remove("is-hidden");
  mobileCta.classList.remove("is-hidden");
  renderParticipantIdentity();
  updatePollResponseCta();
  syncPollResponsePanelState();
  grid.innerHTML = "";

  const participant = getCurrentParticipantState();
  const canRespond = participant.canVote && !participant.isBlocked;
  cta.disabled = !canRespond;
  cta.classList.toggle("is-disabled", !canRespond);
  mobileCta.disabled = !canRespond;
  mobileCta.classList.toggle("is-disabled", !canRespond);
  submitButton.disabled = !canRespond;
  submitButton.classList.toggle("is-disabled", !canRespond);

  if (!canRespond) {
    legend.classList.add("is-hidden");
    grid.innerHTML = renderEmptyStateMarkup(
      participant.isBlocked ? "fa-solid fa-user-lock" : "fa-solid fa-ban",
      participant.isBlocked ? "Du bist für diese Umfrage gesperrt" : "Deine Teilnahme ist aktuell deaktiviert",
      participant.isBlocked
        ? "Der Ersteller hat deine Teilnahme an dieser Umfrage blockiert."
        : "Der Ersteller hat deine Stimmabgabe vorübergehend deaktiviert."
    );
    return;
  }

  if (pollHasTimeSlots(state.pollData.poll)) {
    legend.classList.remove("is-hidden");
    renderFixedSlotAvailabilityForm(grid);
    return;
  }

  if (pollUsesBlockFixed(state.pollData.poll)) {
    legend.classList.remove("is-hidden");
    renderFixedSlotAvailabilityForm(grid);
    return;
  }

  if (pollUsesBlockFree(state.pollData.poll)) {
    legend.classList.add("is-hidden");
    renderBlockFreeAvailabilityForm(grid);
    return;
  }

  if (pollUsesWeeklySlots(state.pollData.poll)) {
    legend.classList.remove("is-hidden");
    renderWeeklyAvailabilityForm(grid);
    return;
  }

  if (pollUsesStarRating(state.pollData.poll)) {
    legend.classList.add("is-hidden");
    renderStarRatingAvailabilityForm(grid);
    return;
  }

  if (pollUsesParticipantSuggestions(state.pollData.poll.mode)) {
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

function renderStarRatingAvailabilityForm(grid) {
  const poll = state.pollData.poll;

  for (const date of poll.dates || []) {
    const card = document.createElement("div");
    card.className = "availability-card star-rating-card";
    card.innerHTML = `
      <strong>${escapeHtml(formatDateLong(date))}</strong>
      <div class="star-rating-row" role="radiogroup" aria-label="Bewertung für ${escapeHtml(formatDateLong(date))}">
        ${[1, 2, 3, 4, 5]
          .map((rating) => {
            const isActive = Number(state.responseDraft[date] || 0) >= rating;
            return `
              <button
                class="star-rating-button${isActive ? " active" : ""}"
                type="button"
                data-date="${date}"
                data-rating="${rating}"
                aria-label="${rating} von 5 Sternen"
                aria-pressed="${isActive ? "true" : "false"}"
              >
                <i class="${isActive ? "fa-solid" : "fa-regular"} fa-star"></i>
              </button>
            `;
          })
          .join("")}
      </div>
    `;

    card.querySelectorAll("[data-rating]").forEach((button) => {
      button.addEventListener("click", () => {
        const rating = Number(button.dataset.rating);
        if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
          return;
        }
        state.responseDraft[date] = rating;
        renderAvailabilityForm();
      });
    });

    grid.appendChild(card);
  }
}

function renderBlockFixedAvailabilityForm(grid) {
  const poll = state.pollData.poll;
  const selectableDates = getPollBlockSelectableDates(poll);

  if (selectableDates.length === 0) {
    grid.innerHTML = '<p class="description">Keine gültigen Block-Tage vorhanden.</p>';
    return;
  }

  selectableDates.forEach((date) => {
    const card = document.createElement("div");
    card.className = "availability-card";
    card.innerHTML = `<strong>${formatDateLong(date)}</strong>`;

    const row = document.createElement("div");
    row.className = "status-row";

    ["yes", "maybe", "no"].forEach((status) => {
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
    });

    card.appendChild(row);
    grid.appendChild(card);
  });
}

function renderBlockFreeAvailabilityForm(grid) {
  const poll = state.pollData.poll;
  const blockConfig = normalizePollBlockConfig(poll);
  const blockLength = blockConfig.length;
  const startWeekdayLabel = formatAllowedBlockStartDays(blockConfig.weekdays);
  const selectableDates = new Set(getPollBlockSelectableDates(poll));
  const selectedDates = getSelectedBlockFreeDates(state.responseDraft, poll);
  state.participantSelectedDates = new Set(selectedDates);

  const intro = document.createElement("div");
  intro.className = "free-mode-intro";
  intro.innerHTML = `
    <div>
      <strong>Markiere alle Tage, an denen du für den Block kannst</strong>
      <p class="description">Wähle im Kalender beliebige passende Tage aus. Die Auswertung sucht daraus automatisch die besten zusammenhängenden Blöcke über ${escapeHtml(formatBlockLengthLabel(blockLength))}.</p>
      <p class="description">Erlaubte Starttage: ${escapeHtml(startWeekdayLabel)}</p>
    </div>
    <button id="participant-toggle-calendar" class="ghost-button compact-button participant-mobile-toggle" type="button">
      ${state.participantCalendarExpanded ? "Kalender ausblenden" : "Teilnehmen"}
    </button>
  `;

  const calendarSection = document.createElement("div");
  calendarSection.className = `calendar-section${state.participantCalendarExpanded ? "" : " is-collapsed"}`;
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
        <span>Auswahl im Kalender sichtbar</span>
        <button id="participant-clear-dates" class="text-button" type="button">Leeren</button>
      </div>
    </div>
  `;

  grid.appendChild(intro);
  grid.appendChild(calendarSection);

  document.querySelector("#participant-toggle-calendar")?.addEventListener("click", () => {
    state.participantCalendarExpanded = !state.participantCalendarExpanded;
    renderAvailabilityForm();
  });

  document.querySelector("#participant-prev-month")?.addEventListener("click", () => {
    state.participantCurrentMonth = addMonths(state.participantCurrentMonth, -1);
    renderAvailabilityForm();
  });

  document.querySelector("#participant-next-month")?.addEventListener("click", () => {
    state.participantCurrentMonth = addMonths(state.participantCurrentMonth, 1);
    renderAvailabilityForm();
  });

  document.querySelector("#participant-clear-dates")?.addEventListener("click", () => {
    state.responseDraft = {};
    state.participantSelectedDates.clear();
    renderAvailabilityForm();
  });

  const calendarGrid = document.querySelector("#participant-calendar-grid");
  const calendarLabel = document.querySelector("#participant-calendar-label");
  if (calendarGrid && calendarLabel) {
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
      const isSelectable = pollUsesBlockFree(poll) ? true : selectableDates.has(day.isoDate);
      if (!day.inCurrentMonth || !isSelectable) {
        button.classList.add("muted");
      }
      if (!isSelectable) {
        button.disabled = true;
      }
      if (state.participantSelectedDates.has(day.isoDate)) {
        button.classList.add("selected");
      }

      button.innerHTML = `<span>${day.date.getDate()}</span>`;
      button.addEventListener("click", () => {
        if (!isSelectable) {
          return;
        }

        if (state.participantSelectedDates.has(day.isoDate)) {
          state.participantSelectedDates.delete(day.isoDate);
          delete state.responseDraft[day.isoDate];
        } else {
          state.participantSelectedDates.add(day.isoDate);
          state.responseDraft[day.isoDate] = "yes";
        }
        renderAvailabilityForm();
      });

      calendarGrid.appendChild(button);
    }

    bindCalendarSwipe(
      calendarGrid,
      () => {
        state.participantCurrentMonth = addMonths(state.participantCurrentMonth, -1);
        renderAvailabilityForm();
      },
      () => {
        state.participantCurrentMonth = addMonths(state.participantCurrentMonth, 1);
        renderAvailabilityForm();
      }
    );
  }
}

function renderFixedSlotAvailabilityForm(grid) {
  const poll = state.pollData.poll;
  const timeSlotsByDate = getPollTimeSlotsByDate(poll);

  for (const date of [...(poll.dates || [])].sort()) {
    const slots = timeSlotsByDate[date] || [];
    const dateCard = document.createElement("div");
    dateCard.className = "availability-card availability-slot-card";
    dateCard.innerHTML = `<strong>${formatDateLong(date)}</strong>`;

    if (slots.length === 0) {
      const group = document.createElement("div");
      group.className = "availability-slot-group";
      group.innerHTML = `<div class="availability-slot-label">Ganzer Tag</div>`;

      const row = document.createElement("div");
      row.className = "status-row";

      for (const status of ["yes", "maybe", "no"]) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "status-chip";
        button.dataset.date = date;
        button.dataset.status = status;
        button.textContent = statusLabels[status];
        if (state.responseDraft?.[date] === status) {
          button.classList.add("active");
        }
        button.addEventListener("click", () => {
          state.responseDraft[date] = status;
          renderAvailabilityForm();
        });
        row.appendChild(button);
      }

      group.appendChild(row);
      dateCard.appendChild(group);
      grid.appendChild(dateCard);
      continue;
    }

    for (const slot of slots) {
      const group = document.createElement("div");
      group.className = "availability-slot-group";
      group.innerHTML = `<div class="availability-slot-label">${escapeHtml(slot)}</div>`;

      const row = document.createElement("div");
      row.className = "status-row";

      for (const status of ["yes", "maybe", "no"]) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "status-chip";
        button.dataset.date = date;
        button.dataset.slot = slot;
        button.dataset.status = status;
        button.textContent = statusLabels[status];
        if (state.responseDraft?.[date]?.[slot] === status) {
          button.classList.add("active");
        }
        button.addEventListener("click", () => {
          if (!state.responseDraft[date]) {
            state.responseDraft[date] = {};
          }
          state.responseDraft[date][slot] = status;
          renderAvailabilityForm();
        });
        row.appendChild(button);
      }

      group.appendChild(row);
      dateCard.appendChild(group);
    }

    grid.appendChild(dateCard);
  }
}

function renderWeeklyAvailabilityForm(grid) {
  const slots = getWeeklySlotsFromPoll(state.pollData.poll);
  if (slots.length === 0) {
    grid.innerHTML = '<p class="description">Keine Wochen-Slots vorhanden.</p>';
    return;
  }

  const table = document.createElement("div");
  table.className = "weekly-response-grid";
  weeklyWeekdayOrder.forEach((weekday) => {
    const weekdaySlots = slots.filter((slot) => slot.weekday === weekday);
    if (weekdaySlots.length === 0) {
      return;
    }

    const dayColumn = document.createElement("div");
    dayColumn.className = "availability-card availability-slot-card";
    dayColumn.innerHTML = `<strong>${escapeHtml(formatWeeklyWeekday(weekday))}</strong>`;

    weekdaySlots.forEach((slot) => {
      const key = buildWeeklySlotKey(slot.weekday, slot.time);
      const group = document.createElement("div");
      group.className = "availability-slot-group";
      group.innerHTML = `<div class="availability-slot-label">${escapeHtml(slot.time)}</div>`;
      const row = document.createElement("div");
      row.className = "status-row";

      ["yes", "maybe", "no"].forEach((status) => {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "status-chip";
        button.dataset.status = status;
        button.dataset.weeklyKey = key;
        button.dataset.weeklyStatus = status;
        button.textContent = statusLabels[status];
        if (state.responseDraft[key] === status) {
          button.classList.add("active");
        }
        button.addEventListener("click", () => {
          state.responseDraft[key] = status;
          row.querySelectorAll(".status-chip").forEach((btn) => {
            btn.classList.toggle("active", state.responseDraft[btn.dataset.weeklyKey] === btn.dataset.weeklyStatus);
          });
        });
        row.appendChild(button);
      });

      group.appendChild(row);
      dayColumn.appendChild(group);
    });

    table.appendChild(dayColumn);
  });

  grid.appendChild(table);
}

function renderParticipantIdentity() {
  const container = document.querySelector("#participant-identity");
  if (!container || !state.pollData?.user) {
    return;
  }

  const participant = getCurrentParticipantState();
  const badges = [];
  if (participant.hasVeto) {
    badges.push('<span class="participant-role-badge"><i class="fa-solid fa-crown"></i> Veto</span>');
  }
  if (participant.isBlocked) {
    badges.push('<span class="participant-role-badge blocked"><i class="fa-solid fa-user-lock"></i> Gesperrt</span>');
  } else if (!participant.canVote) {
    badges.push('<span class="participant-role-badge blocked"><i class="fa-solid fa-ban"></i> Deaktiviert</span>');
  }

  container.innerHTML = `
    <div class="selected-dates-box">
      <div class="selected-header">
        <span>Antwort wird mit deinem Account gespeichert</span>
        <div class="participant-role-badge-row">${badges.join("")}</div>
      </div>
      <p class="description"><strong>${escapeHtml(state.pollData.user.email)}</strong></p>
    </div>
  `;
}

function renderFreeChoiceForm(grid) {
  const usesRangeSlots = suggestionModeUsesRangeSlots();
  const intro = document.createElement("div");
  intro.className = "free-mode-intro";
  intro.innerHTML = `
    <div>
      <strong>${usesRangeSlots ? "Wähle Tage und passende Zeitfenster" : "Wähle alle Tage, an denen du kannst"}</strong>
      <p class="description">${
        usesRangeSlots
          ? "Du kannst beliebige Tage im Kalender markieren und dazu passende Zeitfenster je Datum hinterlegen."
          : "Du kannst beliebige Tage im Kalender markieren."
      }</p>
    </div>
    <button id="participant-toggle-calendar" class="ghost-button compact-button participant-mobile-toggle" type="button">
      ${state.participantCalendarExpanded ? "Kalender ausblenden" : "Teilnehmen"}
    </button>
  `;

  const calendarSection = document.createElement("div");
  calendarSection.className = `calendar-section${state.participantCalendarExpanded ? "" : " is-collapsed"}`;
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
        <span>Deine Vorschläge</span>
        <button id="participant-clear-dates" class="text-button" type="button">Leeren</button>
      </div>
      <div id="participant-selected-dates" class="selected-dates"></div>
    </div>
  `;

  grid.appendChild(intro);
  grid.appendChild(calendarSection);

  document.querySelector("#participant-toggle-calendar")?.addEventListener("click", () => {
    state.participantCalendarExpanded = !state.participantCalendarExpanded;
    renderAvailabilityForm();
  });

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
    state.participantSuggestedTimes = {};
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
        delete state.participantSuggestedTimes[day.isoDate];
      } else {
        state.participantSelectedDates.add(day.isoDate);
      }
      syncParticipantSuggestedTimesWithSelectedDates();
      renderAvailabilityForm();
    });

    calendarGrid.appendChild(button);
  }

  bindCalendarSwipe(
    calendarGrid,
    () => {
      state.participantCurrentMonth = addMonths(state.participantCurrentMonth, -1);
      renderAvailabilityForm();
    },
    () => {
      state.participantCurrentMonth = addMonths(state.participantCurrentMonth, 1);
      renderAvailabilityForm();
    }
  );
}

function renderParticipantSelectedDates() {
  const container = document.querySelector("#participant-selected-dates");
  if (!container) {
    return;
  }

  const usesRangeSlots = suggestionModeUsesRangeSlots();
  syncParticipantSuggestedTimesWithSelectedDates();
  const dates = Array.from(state.participantSelectedDates).sort();
  if (dates.length === 0) {
    container.innerHTML = renderEmptyStateMarkup(
      "fa-regular fa-hand-point-up",
      "Noch keine Tage ausgewählt",
      usesRangeSlots
        ? "Markiere ein paar Optionen im Kalender. Für jeden Vorschlag kannst du danach passende Zeitfenster eintragen."
        : "Markiere ein paar Optionen im Kalender."
    );
    return;
  }

  container.innerHTML = "";
  for (const date of dates) {
    const card = document.createElement("div");
    card.className = "time-slot-date-card";
    const slots = Array.isArray(state.participantSuggestedTimes[date]) ? state.participantSuggestedTimes[date] : [];
    card.innerHTML = `
      <div class="time-slot-date-head">
        <strong>${escapeHtml(formatDateLong(date))}</strong>
        <div class="calendar-actions">
          ${usesRangeSlots ? `
          <button class="ghost-button compact-button" type="button" data-action="add-slot" data-date="${date}">
            <i class="fa-solid fa-plus"></i>
            Slot
          </button>` : ""}
          <button class="text-button" type="button" data-action="remove-date" data-date="${date}">
            Entfernen
          </button>
        </div>
      </div>
      ${
        usesRangeSlots
          ? (slots.length === 0
            ? '<p class="description"><strong>Ganzer Tag</strong></p><p class="description">Optional: Falls nur bestimmte Zeitfenster gehen, kannst du sie mit "+ Slot" hinzufuegen.</p>'
            : "")
          : '<p class="description"><strong>Ganzer Tag</strong></p>'
      }
      <div class="time-slot-list"></div>
    `;

    const list = card.querySelector(".time-slot-list");
    if (slots.length === 0) {
      list.innerHTML = "";
    } else {
      slots.forEach((slotValue, index) => {
        const row = document.createElement("div");
        row.className = `time-slot-row${usesRangeSlots ? " is-range" : ""}`;
        if (usesRangeSlots) {
          const draftRange = parseTimeRangeDraftValue(slotValue);
          row.innerHTML = `
            <div class="time-slot-range-fields">
              <input
                class="time-slot-input participant-time-slot-range-input"
                type="text"
                inputmode="numeric"
                autocomplete="off"
                spellcheck="false"
                maxlength="5"
                value="${escapeHtml(draftRange.start)}"
                placeholder="14:00"
                data-date="${date}"
                data-index="${index}"
                data-part="start"
              />
              <span class="time-slot-range-separator">bis</span>
              <input
                class="time-slot-input participant-time-slot-range-input"
                type="text"
                inputmode="numeric"
                autocomplete="off"
                spellcheck="false"
                maxlength="5"
                value="${escapeHtml(draftRange.end)}"
                placeholder="16:00"
                data-date="${date}"
                data-index="${index}"
                data-part="end"
              />
            </div>
            <button class="text-button danger-text-button" type="button" data-action="remove-slot" data-date="${date}" data-index="${index}">
              Entfernen
            </button>
          `;
        } else {
          row.innerHTML = `
            <input
              class="time-slot-input participant-time-slot-input"
              type="text"
              inputmode="numeric"
              autocomplete="off"
              spellcheck="false"
              maxlength="5"
              value="${escapeHtml(slotValue || "")}"
              placeholder="14:00"
              data-date="${date}"
              data-index="${index}"
            />
            <button class="text-button danger-text-button" type="button" data-action="remove-slot" data-date="${date}" data-index="${index}">
              Entfernen
            </button>
          `;
        }
        list.appendChild(row);
      });
    }

    container.appendChild(card);
  }

  if (usesRangeSlots) {
    container.querySelectorAll('[data-action="add-slot"]').forEach((button) => {
      button.addEventListener("click", () => {
        const { date } = button.dataset;
        if (!date) {
          return;
        }
        if (!Array.isArray(state.participantSuggestedTimes[date])) {
          state.participantSuggestedTimes[date] = [];
        }
        state.participantSuggestedTimes[date].push("");
        renderAvailabilityForm();
      });
    });
  }

  container.querySelectorAll('[data-action="remove-date"]').forEach((button) => {
    button.addEventListener("click", () => {
      const { date } = button.dataset;
      if (!date) {
        return;
      }
      state.participantSelectedDates.delete(date);
      delete state.participantSuggestedTimes[date];
      renderAvailabilityForm();
    });
  });

  container.querySelectorAll(".participant-time-slot-input, .participant-time-slot-range-input").forEach((input) => {
    input.addEventListener("input", () => {
      const { date, index } = input.dataset;
      if (!date || index === undefined) {
        return;
      }
      if (!Array.isArray(state.participantSuggestedTimes[date])) {
        state.participantSuggestedTimes[date] = [];
      }
      const filteredValue = filterTimeSlotInput(input.value);
      if (filteredValue !== input.value) {
        input.value = filteredValue;
      }
      if (usesRangeSlots) {
        const row = input.closest(".time-slot-row");
        const startInput = row?.querySelector('[data-part="start"]');
        const endInput = row?.querySelector('[data-part="end"]');
        state.participantSuggestedTimes[date][Number(index)] = buildTimeRangeDraftValue(startInput?.value, endInput?.value);
        return;
      }

      state.participantSuggestedTimes[date][Number(index)] = filteredValue;
    });

    input.addEventListener("blur", () => {
      const { date, index } = input.dataset;
      if (!date || index === undefined || !Array.isArray(state.participantSuggestedTimes[date])) {
        return;
      }

      if (usesRangeSlots) {
        const row = input.closest(".time-slot-row");
        const startInput = row?.querySelector('[data-part="start"]');
        const endInput = row?.querySelector('[data-part="end"]');
        const normalizedValue = normalizeTimeRangeValue(startInput?.value, endInput?.value);
        if (normalizedValue) {
          const parts = parseTimeRangeDraftValue(normalizedValue);
          if (startInput) {
            startInput.value = parts.start;
          }
          if (endInput) {
            endInput.value = parts.end;
          }
          state.participantSuggestedTimes[date][Number(index)] = normalizedValue;
        } else {
          state.participantSuggestedTimes[date][Number(index)] = buildTimeRangeDraftValue(startInput?.value, endInput?.value);
        }
        return;
      }

      const normalizedValue = normalizeTimeSlotValue(input.value);
      if (normalizedValue) {
        input.value = normalizedValue;
        state.participantSuggestedTimes[date][Number(index)] = normalizedValue;
      }
    });
  });

  container.querySelectorAll('[data-action="remove-slot"]').forEach((button) => {
    button.addEventListener("click", () => {
      const { date, index } = button.dataset;
      if (!date || index === undefined || !Array.isArray(state.participantSuggestedTimes[date])) {
        return;
      }
      state.participantSuggestedTimes[date].splice(Number(index), 1);
      renderAvailabilityForm();
    });
  });
}

function supportsResultsCalendar(poll) {
  return CREATE_POLL_MODES.has(poll?.mode) && poll?.mode !== "weekly" && !pollUsesBlockMode(poll);
}

function ensureResultsCalendarPanel() {
  const table = document.querySelector(".results-table");
  const resultsPanel = table?.closest("article.panel");
  if (!resultsPanel) {
    return {};
  }

  resultsPanel.classList.add("results-panel");

  let calendarPanel = document.querySelector("#results-calendar-panel");
  if (!calendarPanel) {
    calendarPanel = document.createElement("article");
    calendarPanel.id = "results-calendar-panel";
    calendarPanel.className = "panel results-calendar-panel is-hidden";
    resultsPanel.after(calendarPanel);
  }

  return { table, resultsPanel, calendarPanel };
}

function ensureBlockResultsPanel() {
  const table = document.querySelector(".results-table");
  const resultsPanel = table?.closest("article.panel");
  if (!resultsPanel) {
    return {};
  }

  let blockPanel = document.querySelector("#results-block-panel");
  if (!blockPanel) {
    blockPanel = document.createElement("article");
    blockPanel.id = "results-block-panel";
    blockPanel.className = "panel block-results-panel is-hidden";
    resultsPanel.after(blockPanel);
  }

  return { blockPanel };
}

function shiftResultsCalendar(delta) {
  if (!delta) {
    return;
  }

  const currentDate =
    state.resultsCalendarDate instanceof Date && !Number.isNaN(state.resultsCalendarDate.getTime())
      ? new Date(state.resultsCalendarDate.getFullYear(), state.resultsCalendarDate.getMonth(), state.resultsCalendarDate.getDate())
      : new Date();

  if (state.resultsCalendarView === "day") {
    state.resultsCalendarDate = addDays(currentDate, delta);
    return;
  }

  if (state.resultsCalendarView === "week") {
    state.resultsCalendarDate = addDays(currentDate, delta * 7);
    return;
  }

  if (state.resultsCalendarView === "year") {
    state.resultsCalendarDate = new Date(currentDate.getFullYear() + delta, currentDate.getMonth(), 1);
    return;
  }

  state.resultsCalendarDate = addMonths(currentDate, delta);
}

function getParticipantCalendarColor(name) {
  const normalizedName = typeof name === "string" && name.trim() ? name.trim() : "Teilnehmer";
  const baseHues = [10, 38, 74, 128, 176, 214, 266, 320];
  let hash = 0;

  for (const character of normalizedName) {
    hash = (hash << 5) - hash + character.charCodeAt(0);
    hash |= 0;
  }

  const safeHash = Math.abs(hash);
  const baseHue = baseHues[safeHash % baseHues.length];
  const hueOffset = ((safeHash >> 3) % 18) - 9;
  const hue = (baseHue + hueOffset + 360) % 360;
  const saturation = 66 + (safeHash % 10);
  const lightness = 48 + ((safeHash >> 5) % 10);

  return `hsl(${hue}, ${saturation}%, ${lightness}%)`;
}

function getResultsCalendarScheduleEntries(poll) {
  const timeSlotsByDate = getPollTimeSlotsByDate(poll);
  const dates =
    Array.isArray(poll?.dates) && poll.dates.length > 0 ? [...poll.dates].sort() : Object.keys(timeSlotsByDate).sort();

  return dates.flatMap((date) => {
    const slots = timeSlotsByDate[date] || [];
    if (slots.length === 0) {
      return [{ date, slot: "" }];
    }
    return slots.map((slot) => ({ date, slot }));
  });
}

function buildResultsCalendarEvent({
  id,
  date,
  name,
  color,
  slotValue = "",
  status = "",
  labelOverride = "",
  type = "",
  average = null,
  count = null,
}) {
  const slot = parseResultsCalendarTimeSlot(slotValue);
  const statusLabel = statusLabels[status] || "";
  const label = labelOverride || (status === "maybe" && statusLabel ? `${slot.label} · ${statusLabel}` : slot.label);
  const titleParts = [name, formatDateLong(date), slot.label];
  if (statusLabel) {
    titleParts.push(statusLabel);
  } else if (labelOverride) {
    titleParts.push(labelOverride);
  }

  return {
    id,
    date,
    name,
    color,
    isAllDay: slot.isAllDay,
    start: slot.start,
    end: slot.end,
    startMinutes: slot.startMinutes,
    endMinutes: slot.endMinutes,
    label,
    type,
    average,
    count,
    title: titleParts.join(" · "),
  };
}

function sortResultsCalendarEvents(events) {
  return events.sort((left, right) => {
    const leftDate = typeof left?.date === "string" ? left.date : "";
    const rightDate = typeof right?.date === "string" ? right.date : "";
    if (leftDate !== rightDate) {
      return leftDate.localeCompare(rightDate);
    }
    if (left.isAllDay !== right.isAllDay) {
      return left.isAllDay ? -1 : 1;
    }
    if (left.startMinutes !== right.startMinutes) {
      return left.startMinutes - right.startMinutes;
    }
    if (left.endMinutes !== right.endMinutes) {
      return left.endMinutes - right.endMinutes;
    }
    return left.name.localeCompare(right.name);
  });
}

function collectResultsCalendarEvents(poll, responses, results = state.pollData?.results) {
  const events = [];

  if (pollUsesStarRating(poll)) {
    const sourceEntries = Array.isArray(results?.summary) && results.summary.length > 0
      ? results.summary
      : getStarRatingStats(poll?.dates || [], responses).entries;

    for (const entry of sourceEntries) {
      const average = Number(entry.average);
      const count = Number(entry.count || 0);
      if (!entry.date || !Number.isFinite(average) || count <= 0) {
        continue;
      }

      const label = `${formatAverageRating(average)} Sterne (${formatRatingCountLabel(count)})`;
      events.push(
        buildResultsCalendarEvent({
          id: `star-rating-${entry.date}`,
          date: entry.date,
          name: "Durchschnitt",
          color: getStarRatingCalendarColor(average),
          labelOverride: label,
          type: "star-rating",
          average,
          count,
        })
      );
    }

    return sortResultsCalendarEvents(events);
  }

  if (!pollUsesParticipantSuggestions(poll?.mode)) {
    const scheduleEntries = getResultsCalendarScheduleEntries(poll);

    for (const response of responses || []) {
      const participantName = response?.name?.trim() || "Unbekannt";
      const color = getParticipantCalendarColor(participantName);

      for (const entry of scheduleEntries) {
        const status = entry.slot
          ? response.slotAvailabilities?.[entry.date]?.[entry.slot] || "no"
          : response.availabilities?.[entry.date] || "no";

        const rating = Number(status);
        const isRating = pollUsesStarRating(poll) && Number.isInteger(rating) && rating >= 1 && rating <= 5;
        if (status === "no" || (pollUsesStarRating(poll) && !isRating)) {
          continue;
        }

        events.push(
          buildResultsCalendarEvent({
            id: `${response.id || participantName}-${entry.date}-${entry.slot || "all-day"}-${status}-${events.length}`,
            date: entry.date,
            name: participantName,
            color,
            slotValue: entry.slot,
            status: isRating ? "" : status,
            labelOverride: isRating ? `${rating}/5 Sterne` : "",
          })
        );
      }
    }

    return sortResultsCalendarEvents(events);
  }

  for (const response of responses || []) {
    const participantName = response?.name?.trim() || "Unbekannt";
    const color = getParticipantCalendarColor(participantName);
    const dateEntries = getSuggestedDateEntries(response?.suggestedDateEntries || response?.suggestedDates);

    for (const entry of dateEntries) {
      const timeValues = Array.isArray(entry.times) && entry.times.length > 0 ? entry.times : [""];
      for (const value of timeValues) {
        events.push(
          buildResultsCalendarEvent({
            id: `${response.id || participantName}-${entry.date}-${value || "all-day"}-${events.length}`,
            date: entry.date,
            name: participantName,
            color,
            slotValue: value,
          })
        );
      }
    }
  }

  return sortResultsCalendarEvents(events);
}

function parseResultsCalendarTimeSlot(value) {
  const normalizedRange = normalizeTimeRangeValue(value);
  if (normalizedRange) {
    const [start, end] = normalizedRange.split("-");
    return {
      isAllDay: false,
      start,
      end,
      startMinutes: timeLabelToMinutes(start),
      endMinutes: timeLabelToMinutes(end),
      label: `${start}-${end}`,
    };
  }

  const normalizedTime = normalizeTimeSlotValue(value);
  if (normalizedTime) {
    const startMinutes = timeLabelToMinutes(normalizedTime);
    const endMinutes = Math.min(startMinutes + 60, 24 * 60);
    return {
      isAllDay: false,
      start: normalizedTime,
      end: minutesToTimeLabel(endMinutes),
      startMinutes,
      endMinutes,
      label: `${normalizedTime}-${minutesToTimeLabel(endMinutes)}`,
    };
  }

  return {
    isAllDay: true,
    start: "00:00",
    end: "24:00",
    startMinutes: 0,
    endMinutes: 24 * 60,
    label: "Ganztägig",
  };
}

function timeLabelToMinutes(value) {
  if (!/^\d{2}:\d{2}$/.test(value || "")) {
    return 0;
  }

  const [hours, minutes] = value.split(":").map(Number);
  return hours * 60 + minutes;
}

function minutesToTimeLabel(value) {
  const totalMinutes = Math.max(0, Math.min(24 * 60, Number(value) || 0));
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
}

function addDays(date, delta) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + delta);
}

function getWeekdayColumnIndex(dayIndex) {
  return (dayIndex - firstDayOfWeek + 7) % 7;
}

function startOfWeek(date) {
  const nextDate = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const weekdayIndex = getWeekdayColumnIndex(nextDate.getDay());
  return addDays(nextDate, -weekdayIndex);
}

function formatResultsCalendarRangeLabel(view, anchorDate) {
  const currentDate =
    anchorDate instanceof Date && !Number.isNaN(anchorDate.getTime()) ? anchorDate : new Date();

  if (view === "day") {
    return new Intl.DateTimeFormat("de-DE", {
      weekday: "long",
      day: "2-digit",
      month: "long",
      year: "numeric",
    }).format(currentDate);
  }

  if (view === "week") {
    const weekStart = startOfWeek(currentDate);
    const weekEnd = addDays(weekStart, 6);
    const startLabel = new Intl.DateTimeFormat("de-DE", { day: "2-digit", month: "2-digit" }).format(weekStart);
    const endLabel = new Intl.DateTimeFormat("de-DE", {
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
    }).format(weekEnd);
    return `${startLabel} - ${endLabel}`;
  }

  if (view === "year") {
    return String(currentDate.getFullYear());
  }

  return formatMonthYear(currentDate);
}

function getResultsCalendarVisibleRange(view, anchorDate) {
  const currentDate =
    anchorDate instanceof Date && !Number.isNaN(anchorDate.getTime()) ? anchorDate : new Date();

  if (view === "day") {
    const isoDate = toIsoDate(currentDate);
    return { start: isoDate, end: isoDate };
  }

  if (view === "week") {
    const weekStart = startOfWeek(currentDate);
    return { start: toIsoDate(weekStart), end: toIsoDate(addDays(weekStart, 6)) };
  }

  if (view === "year") {
    return { start: `${currentDate.getFullYear()}-01-01`, end: `${currentDate.getFullYear()}-12-31` };
  }

  const monthStart = new Date(currentDate.getFullYear(), currentDate.getMonth(), 1);
  const monthEnd = new Date(currentDate.getFullYear(), currentDate.getMonth() + 1, 0);
  return { start: toIsoDate(monthStart), end: toIsoDate(monthEnd) };
}

function filterResultsCalendarEvents(events, view, anchorDate) {
  const range = getResultsCalendarVisibleRange(view, anchorDate);
  return (events || []).filter((event) => event.date >= range.start && event.date <= range.end);
}

function groupResultsCalendarEventsByDate(events) {
  const groupedEvents = new Map();

  for (const event of events || []) {
    if (!groupedEvents.has(event.date)) {
      groupedEvents.set(event.date, []);
    }
    groupedEvents.get(event.date).push(event);
  }

  for (const [date, items] of groupedEvents.entries()) {
    groupedEvents.set(
      date,
      items.slice().sort((left, right) => {
        if (left.isAllDay !== right.isAllDay) {
          return left.isAllDay ? -1 : 1;
        }
        if (left.startMinutes !== right.startMinutes) {
          return left.startMinutes - right.startMinutes;
        }
        if (left.endMinutes !== right.endMinutes) {
          return left.endMinutes - right.endMinutes;
        }
        return left.name.localeCompare(right.name);
      })
    );
  }

  return groupedEvents;
}

function layoutResultsCalendarCluster(cluster) {
  const laneEndTimes = [];
  const positionedEvents = cluster.map((event) => {
    let laneIndex = laneEndTimes.findIndex((endMinute) => endMinute <= event.startMinutes);
    if (laneIndex === -1) {
      laneIndex = laneEndTimes.length;
      laneEndTimes.push(event.endMinutes);
    } else {
      laneEndTimes[laneIndex] = event.endMinutes;
    }

    return { ...event, laneIndex };
  });

  const laneCount = Math.max(laneEndTimes.length, 1);
  return positionedEvents.map((event) => ({ ...event, laneCount }));
}

function layoutResultsCalendarTimedEvents(events) {
  const sortedEvents = (events || []).slice().sort((left, right) => {
    if (left.startMinutes !== right.startMinutes) {
      return left.startMinutes - right.startMinutes;
    }
    if (left.endMinutes !== right.endMinutes) {
      return left.endMinutes - right.endMinutes;
    }
    return left.name.localeCompare(right.name);
  });

  const positionedEvents = [];
  let cluster = [];
  let clusterEndMinute = -1;

  const flushCluster = () => {
    if (cluster.length === 0) {
      return;
    }
    positionedEvents.push(...layoutResultsCalendarCluster(cluster));
    cluster = [];
    clusterEndMinute = -1;
  };

  for (const event of sortedEvents) {
    if (cluster.length === 0 || event.startMinutes < clusterEndMinute) {
      cluster.push(event);
      clusterEndMinute = Math.max(clusterEndMinute, event.endMinutes);
      continue;
    }

    flushCluster();
    cluster.push(event);
    clusterEndMinute = event.endMinutes;
  }

  flushCluster();
  return positionedEvents;
}

function getResultsCalendarParticipants(events) {
  const participants = new Map();

  for (const event of events || []) {
    if (!participants.has(event.name)) {
      participants.set(event.name, { name: event.name, color: event.color });
    }
  }

  return Array.from(participants.values()).sort((left, right) => left.name.localeCompare(right.name));
}

function renderResultsCalendarLegend(participants) {
  if (!participants.length) {
    return "";
  }

  return `
    <div class="results-calendar-legend">
      ${participants
        .map(
          (participant) => `
            <span class="results-calendar-legend-item" style="--participant-color: ${escapeHtml(participant.color)};">
              <span class="results-calendar-legend-dot"></span>
              <span>${escapeHtml(participant.name)}</span>
            </span>
          `
        )
        .join("")}
    </div>
  `;
}

function renderResultsCalendarAllDayItems(events) {
  if (!events.length) {
    return '<span class="results-calendar-lane-empty">Keine ganztägigen Einträge</span>';
  }

  return events
    .map(
      (event) => `
        <span
          class="results-calendar-chip${event.type === "star-rating" ? " is-star-rating" : ""}"
          style="--participant-color: ${escapeHtml(event.color)};"
          title="${escapeHtml(event.title)}"
          aria-label="${escapeHtml(event.title)}"
          tabindex="0"
        ></span>
      `
    )
    .join("");
}

function renderResultsCalendarTimedItem(event) {
  const top = (event.startMinutes / (24 * 60)) * 100;
  const rawHeight = ((event.endMinutes - event.startMinutes) / (24 * 60)) * 100;
  const height = Math.min(100 - top, Math.max(rawHeight, 1.8));
  const laneWidth = 100 / Math.max(event.laneCount || 1, 1);
  const left = laneWidth * (event.laneIndex || 0);

  return `
    <article
      class="results-calendar-event"
      style="
        --participant-color: ${escapeHtml(event.color)};
        top: ${top.toFixed(4)}%;
        height: ${height.toFixed(4)}%;
        left: calc(${left.toFixed(4)}% + 0.2rem);
        width: calc(${laneWidth.toFixed(4)}% - 0.35rem);
      "
      title="${escapeHtml(event.title)}"
      aria-label="${escapeHtml(event.title)}"
      tabindex="0"
    ></article>
  `;
}

function renderResultsCalendarTimeline(days, eventsByDate, options = {}) {
  const isSingleDay = Boolean(options.singleDay);
  const currentIsoDate = toIsoDate(new Date());

  return `
    <div class="results-calendar-stage results-calendar-stage--timeline${isSingleDay ? " is-single-day" : ""}">
      <div class="results-calendar-axis-column">
        <div class="results-calendar-axis-head">Zeit</div>
        <div class="results-calendar-axis-all-day">Ganzt.</div>
        <div class="results-calendar-axis-body">
          ${Array.from({ length: 24 }, (_, hour) => {
            const top = (hour / 24) * 100;
            return `<span class="results-calendar-axis-label" style="top: ${top.toFixed(4)}%;">${String(hour).padStart(
              2,
              "0"
            )}:00</span>`;
          }).join("")}
        </div>
      </div>

      <div class="results-calendar-columns${isSingleDay ? " is-single-day" : ""}">
        ${days
          .map((date) => {
            const dayEvents = eventsByDate.get(date) || [];
            const allDayEvents = dayEvents.filter((event) => event.isAllDay);
            const timedEvents = layoutResultsCalendarTimedEvents(dayEvents.filter((event) => !event.isAllDay));
            const headerDate = new Date(`${date}T00:00:00`);
            const weekdayLabel = new Intl.DateTimeFormat("de-DE", {
              weekday: isSingleDay ? "long" : "short",
            }).format(headerDate);
            const dateLabel = new Intl.DateTimeFormat("de-DE", {
              day: "2-digit",
              month: isSingleDay ? "long" : "2-digit",
            }).format(headerDate);

            return `
              <section class="results-calendar-column">
                <header class="results-calendar-column-head${date === currentIsoDate ? " is-today" : ""}">
                  <strong>${escapeHtml(weekdayLabel)}</strong>
                  <span>${escapeHtml(dateLabel)}</span>
                </header>
                <div class="results-calendar-all-day-lane">
                  ${renderResultsCalendarAllDayItems(allDayEvents)}
                </div>
                <div class="results-calendar-time-lane">
                  ${Array.from({ length: 25 }, (_, hour) => {
                    const top = (hour / 24) * 100;
                    return `<span class="results-calendar-hour-line" style="top: ${top.toFixed(4)}%;"></span>`;
                  }).join("")}
                  ${
                    timedEvents.length > 0
                      ? timedEvents.map((event) => renderResultsCalendarTimedItem(event)).join("")
                      : `<span class="results-calendar-time-empty">${
                          allDayEvents.length > 0 ? "Nur ganztägige Einträge" : "Keine Zeitfenster"
                        }</span>`
                  }
                </div>
              </section>
            `;
          })
          .join("")}
      </div>
    </div>
  `;
}

function renderResultsCalendarDayView(anchorDate, eventsByDate) {
  return renderResultsCalendarTimeline([toIsoDate(anchorDate)], eventsByDate, { singleDay: true });
}

function renderResultsCalendarWeekView(anchorDate, eventsByDate) {
  const weekStart = startOfWeek(anchorDate);
  const dates = Array.from({ length: 7 }, (_, index) => toIsoDate(addDays(weekStart, index)));
  return renderResultsCalendarTimeline(dates, eventsByDate);
}

function renderResultsCalendarMonthEntries(events) {
  if (!events.length) {
    return "";
  }

  const visibleEvents = events.slice(0, 3);
  return `
    <div class="results-calendar-month-list">
      ${visibleEvents
        .map(
          (event) => `
            <div
              class="results-calendar-mini-event${event.type === "star-rating" ? " is-star-rating" : ""}"
              style="--participant-color: ${escapeHtml(event.color)};"
              title="${escapeHtml(event.title)}"
              aria-label="${escapeHtml(event.title)}"
              tabindex="0"
            ></div>
          `
        )
        .join("")}
      ${
        events.length > visibleEvents.length
          ? `<span class="results-calendar-more">+${events.length - visibleEvents.length} weitere</span>`
          : ""
      }
    </div>
  `;
}

function renderResultsCalendarMonthView(anchorDate, eventsByDate) {
  const days = buildCalendarDays(anchorDate.getFullYear(), anchorDate.getMonth());
  const currentIsoDate = toIsoDate(new Date());

  return `
    <div class="results-calendar-stage results-calendar-stage--month">
      <div class="results-calendar-month-grid">
        ${weekdayLabels
          .map((weekday) => `<div class="results-calendar-month-weekday">${escapeHtml(weekday)}</div>`)
          .join("")}
        ${days
          .map((day) => {
            const dayEvents = eventsByDate.get(day.isoDate) || [];
            const starRatingEvent = dayEvents.find((event) => event.type === "star-rating");
            return `
              <article class="results-calendar-month-day${day.inCurrentMonth ? "" : " is-muted"}${
                day.isoDate === currentIsoDate ? " is-today" : ""
              }${starRatingEvent ? " has-star-rating" : ""}"${
                starRatingEvent ? ` style="--star-rating-color: ${escapeHtml(starRatingEvent.color)};"` : ""
              }>
                <div class="results-calendar-month-day-head">
                  <strong>${day.date.getDate()}</strong>
                  ${starRatingEvent ? `<span>${escapeHtml(formatAverageRating(starRatingEvent.average))}</span>` : dayEvents.length > 0 ? `<span>${dayEvents.length}</span>` : ""}
                </div>
                ${renderResultsCalendarMonthEntries(dayEvents)}
              </article>
            `;
          })
          .join("")}
      </div>
    </div>
  `;
}

function renderResultsCalendarYearMonth(year, monthIndex, anchorDate, eventsByDate) {
  const monthDate = new Date(year, monthIndex, 1);
  const days = buildCalendarDays(year, monthIndex);
  const anchorMonth = anchorDate.getMonth();
  const currentIsoDate = toIsoDate(new Date());

  return `
    <section class="results-calendar-year-month${anchorMonth === monthIndex ? " is-active" : ""}">
      <header class="results-calendar-year-month-head">
        <strong>${escapeHtml(formatMonthYear(monthDate))}</strong>
      </header>
      <div class="results-calendar-year-weekdays">
        ${weekdayLabels.map((weekday) => `<span>${escapeHtml(weekday)}</span>`).join("")}
      </div>
      <div class="results-calendar-year-days">
        ${days
          .map((day) => {
            const dayEvents = eventsByDate.get(day.isoDate) || [];
            const starRatingEvent = dayEvents.find((event) => event.type === "star-rating");
            const visibleParticipants = getResultsCalendarParticipants(dayEvents).slice(0, 3);
            const title =
              dayEvents.length > 0 ? dayEvents.map((event) => `${event.name}: ${event.label}`).join(" | ") : "";

            return `
              <div
                class="results-calendar-year-day${day.inCurrentMonth ? "" : " is-muted"}${
                  day.isoDate === currentIsoDate ? " is-today" : ""
                }${dayEvents.length > 0 ? " has-events" : ""}${starRatingEvent ? " has-star-rating" : ""}"
                ${starRatingEvent ? `style="--star-rating-color: ${escapeHtml(starRatingEvent.color)};"` : ""}
                ${title ? `title="${escapeHtml(title)}"` : ""}
              >
                <span class="results-calendar-year-number">${day.date.getDate()}</span>
                <span class="results-calendar-year-dots">
                  ${visibleParticipants
                    .map(
                      (participant) => `
                        <span
                          class="results-calendar-year-dot"
                          style="--participant-color: ${escapeHtml(participant.color)};"
                        ></span>
                      `
                    )
                    .join("")}
                </span>
                ${
                  starRatingEvent
                    ? `<small>${escapeHtml(formatAverageRating(starRatingEvent.average))}</small>`
                    : dayEvents.length > visibleParticipants.length
                      ? `<small>+${dayEvents.length - visibleParticipants.length}</small>`
                      : ""
                }
              </div>
            `;
          })
          .join("")}
      </div>
    </section>
  `;
}

function renderResultsCalendarYearView(anchorDate, eventsByDate) {
  const year = anchorDate.getFullYear();
  return `
    <div class="results-calendar-stage results-calendar-stage--year">
      <div class="results-calendar-year-grid">
        ${Array.from({ length: 12 }, (_, monthIndex) =>
          renderResultsCalendarYearMonth(year, monthIndex, anchorDate, eventsByDate)
        ).join("")}
      </div>
    </div>
  `;
}

function renderResultsCalendar(calendarEvents) {
  const { calendarPanel } = ensureResultsCalendarPanel();
  if (!calendarPanel) {
    return;
  }

  calendarPanel.classList.remove("is-hidden");

  const visibleEvents = filterResultsCalendarEvents(
    calendarEvents,
    state.resultsCalendarView,
    state.resultsCalendarDate
  );
  const eventsByDate = groupResultsCalendarEventsByDate(visibleEvents);
  const legendParticipants = getResultsCalendarParticipants(visibleEvents.length > 0 ? visibleEvents : calendarEvents);
  const visibleDateCount = new Set(visibleEvents.map((event) => event.date)).size;

  let calendarMarkup = "";
  if (state.resultsCalendarView === "day") {
    calendarMarkup = renderResultsCalendarDayView(state.resultsCalendarDate, eventsByDate);
  } else if (state.resultsCalendarView === "week") {
    calendarMarkup = renderResultsCalendarWeekView(state.resultsCalendarDate, eventsByDate);
  } else if (state.resultsCalendarView === "year") {
    calendarMarkup = renderResultsCalendarYearView(state.resultsCalendarDate, eventsByDate);
  } else {
    calendarMarkup = renderResultsCalendarMonthView(state.resultsCalendarDate, eventsByDate);
  }

  calendarPanel.innerHTML = `
    <div class="panel-header results-calendar-header">
      <div>
        <p class="eyebrow">Zusatzansicht</p>
        <h2>Kalenderansicht</h2>
      </div>
      <div class="results-calendar-toolbar">
        <div class="results-view-tabs" role="tablist" aria-label="Kalenderansicht">
          ${[
            ["day", "Tag"],
            ["week", "Woche"],
            ["month", "Monat"],
            ["year", "Jahr"],
          ]
            .map(
              ([view, label]) => `
                <button
                  class="results-view-tab${state.resultsCalendarView === view ? " is-active" : ""}"
                  type="button"
                  data-calendar-view="${view}"
                  aria-pressed="${state.resultsCalendarView === view}"
                >
                  ${label}
                </button>
              `
            )
            .join("")}
        </div>

        <div class="results-calendar-nav">
          <button class="ghost-button compact-button" type="button" data-calendar-shift="-1" aria-label="Vorheriger Zeitraum">
            <i class="fa-solid fa-chevron-left"></i>
          </button>
          <strong>${escapeHtml(formatResultsCalendarRangeLabel(state.resultsCalendarView, state.resultsCalendarDate))}</strong>
          <button class="ghost-button compact-button" type="button" data-calendar-shift="1" aria-label="Nächster Zeitraum">
            <i class="fa-solid fa-chevron-right"></i>
          </button>
        </div>
      </div>
    </div>
    <div class="results-calendar-summary">
      <div class="results-calendar-summary-copy">
        <strong>${
          visibleEvents.length > 0
            ? `${visibleEvents.length} Einträge auf ${visibleDateCount} ${visibleDateCount === 1 ? "Tag" : "Tagen"}`
            : "Keine Einträge in diesem Zeitraum"
        }</strong>
        <p class="description">${
          calendarEvents.length > 0
            ? "Farben markieren die Teilnehmenden. Blaettere oder wechsle die Ansicht für mehr Kontext."
            : "Sobald Antworten zu Tagen oder Zeitfenstern eingehen, erscheint hier die Kalender-Ansicht."
        }</p>
      </div>
      ${renderResultsCalendarLegend(legendParticipants)}
    </div>
    ${
      calendarEvents.length === 0
        ? renderEmptyStateMarkup(
            "fa-regular fa-calendar-plus",
            "Noch keine Kalendereintraege vorhanden",
            "Die Kalenderansicht füllt sich automatisch, sobald Antworten zu Tagen oder Zeitfenstern eingehen."
          )
        : visibleEvents.length === 0
          ? renderEmptyStateMarkup(
              "fa-regular fa-calendar",
              "Keine Kalendereintraege in diesem Zeitraum",
              "Wechsle die Ansicht oder springe in einen anderen Zeitraum."
            )
          : calendarMarkup
    }
  `;

  calendarPanel.querySelectorAll("[data-calendar-view]").forEach((button) => {
    button.addEventListener("click", () => {
      const nextView = button.dataset.calendarView || "week";
      if (state.resultsCalendarView === nextView) {
        return;
      }
      state.resultsCalendarView = nextView;
      renderResultsTable();
    });
  });

  calendarPanel.querySelectorAll("[data-calendar-shift]").forEach((button) => {
    button.addEventListener("click", () => {
      shiftResultsCalendar(Number(button.dataset.calendarShift) || 0);
      renderResultsTable();
    });
  });

  // Navigation: Jahr → Monat → Tag
  if (state.resultsCalendarView === "year") {
    calendarPanel.querySelectorAll(".results-calendar-year-month").forEach((section) => {
      section.addEventListener("click", () => {
        const monthText = section.querySelector("strong")?.textContent || "";
        const monthDate = parseMonthYear(monthText);
        if (monthDate) {
          state.resultsCalendarDate = monthDate;
          state.resultsCalendarView = "month";
          renderResultsTable();
        }
      });
    });
  }

  if (state.resultsCalendarView === "month" || state.resultsCalendarView === "week") {
    calendarPanel.querySelectorAll(".results-calendar-month-day, .results-calendar-column").forEach((day) => {
      day.addEventListener("click", () => {
        const dayNumber = day.querySelector("strong")?.textContent || day.querySelector(".results-calendar-year-number")?.textContent;
        if (dayNumber) {
          const year = state.resultsCalendarDate.getFullYear();
          const month = state.resultsCalendarDate.getMonth();
          state.resultsCalendarDate = new Date(year, month, Number(dayNumber));
          state.resultsCalendarView = "day";
          renderResultsTable();
        }
      });
    });
  }
}

function getBlockHeatTone(entry, maxYes) {
  if (!entry) {
    return "";
  }

  if (entry.yes <= 0) {
    return "empty";
  }

  const ratio = maxYes > 0 ? entry.yes / maxYes : 0;
  if (ratio >= 0.66) {
    return "high";
  }
  if (ratio >= 0.33) {
    return "mid";
  }
  return "low";
}

function normalizeBlockResultEntry(entry) {
  const start = typeof entry?.start === "string" ? entry.start : typeof entry?.date === "string" ? entry.date : "";
  const end = typeof entry?.end === "string" ? entry.end : typeof entry?.endDate === "string" ? entry.endDate : "";
  if (!start || !end) {
    return null;
  }

  return {
    ...entry,
    start,
    end,
    date: start,
    endDate: end,
    length: Number.isInteger(entry?.length) && entry.length > 0 ? entry.length : getInclusiveDateSpan(start, end),
    yes: Number(entry?.yes) || 0,
    maybe: Number(entry?.maybe) || 0,
    no: Number(entry?.no) || 0,
    score: Number(entry?.score) || 0,
  };
}

function getBlockResultEntries(results) {
  return getTopMatrixDates((results?.summary || []).map(normalizeBlockResultEntry).filter(Boolean));
}

function getBlockEntryDetailsLabel(entry, poll) {
  if (!entry) {
    return "";
  }

  const voteLabel = pollUsesBlockFree(poll)
    ? `${entry.yes} Ja · ${entry.no} Nein`
    : `${entry.yes} Ja · ${entry.maybe} Vielleicht · ${entry.no} Nein`;
  return `${formatBlockRangeLong(entry.date, entry.endDate)} · ${formatBlockPeriodMeta(
    entry.date,
    entry.endDate,
    entry.length
  )} · ${voteLabel}`;
}

function formatBlockVoteLabel(entry, poll) {
  if (!entry) {
    return "";
  }

  return pollUsesBlockFree(poll)
    ? `${entry.yes} Ja`
    : `${entry.yes} Ja · ${entry.maybe} Vielleicht`;
}

function buildBlockHeatmapEntryMap(entries) {
  const entryMap = new Map();

  entries.forEach((entry) => {
    const length = Number.isInteger(entry.length) && entry.length > 0 ? entry.length : getInclusiveDateSpan(entry.date, entry.endDate);
    for (let offset = 0; offset < length; offset += 1) {
      const date = addDaysToIsoDateValue(entry.date, offset);
      if (date) {
        entryMap.set(date, entry);
      }
    }
  });

  return entryMap;
}

function buildBlockHeatmapDateSet(entries) {
  return new Set(buildBlockHeatmapEntryMap(entries).keys());
}

function renderBlockHeatmapMonth(monthDate, entries, winnerDates, maxYes, poll) {
  const days = buildCalendarDays(monthDate.getFullYear(), monthDate.getMonth());
  const entryMap = buildBlockHeatmapEntryMap(entries);
  const currentIsoDate = toIsoDate(new Date());

  return `
    <div class="results-calendar-stage results-calendar-stage--month block-heatmap-stage">
      <div class="block-month-grid results-calendar-month-grid">
        ${weekdayLabels.map((weekday) => `<span class="block-month-weekday results-calendar-month-weekday">${escapeHtml(weekday)}</span>`).join("")}
        ${days
          .map((day) => {
            const entry = entryMap.get(day.isoDate);
            const tone = getBlockHeatTone(entry, maxYes);
            const isWinner = winnerDates.has(day.isoDate);
            const detailsLabel = getBlockEntryDetailsLabel(entry, poll);

            return `
              <article
                class="block-month-day results-calendar-month-day${day.inCurrentMonth ? "" : " is-muted"}${
                  day.isoDate === currentIsoDate ? " is-today" : ""
                }${entry ? ` is-active ${tone}` : ""}${isWinner ? " is-winner" : ""}"
                ${entry ? `title="${escapeHtml(detailsLabel)}" data-block-detail="${escapeHtml(detailsLabel)}" tabindex="0"` : ""}
              >
                <div class="block-month-day-head results-calendar-month-day-head">
                  <strong>${day.date.getDate()}</strong>
                  ${entry ? `<span>${escapeHtml(String(entry.yes))}</span>` : ""}
                </div>
                ${
                  entry
                    ? `
                      <div class="block-month-day-copy">
                        <span>${escapeHtml(formatDateShort(entry.endDate))}</span>
                        ${isWinner ? '<span class="block-month-winner">Top</span>' : ""}
                      </div>
                      <div class="block-month-day-votes" aria-label="${escapeHtml(formatBlockVoteLabel(entry, poll))}">
                        <span>${escapeHtml(`${entry.yes} Ja`)}</span>
                        ${pollUsesBlockFree(poll) ? "" : `<span>${escapeHtml(`${entry.maybe} Vielleicht`)}</span>`}
                        <span>${escapeHtml(`${entry.no} Nein`)}</span>
                      </div>
                    `
                    : ""
                }
              </article>
            `;
          })
          .join("")}
      </div>
    </div>
  `;
}

function shiftBlockHeatmapMonth(delta) {
  if (!delta) {
    return;
  }

  const currentDate =
    state.resultsCalendarDate instanceof Date && !Number.isNaN(state.resultsCalendarDate.getTime())
      ? new Date(state.resultsCalendarDate.getFullYear(), state.resultsCalendarDate.getMonth(), 1)
      : new Date();

  state.resultsCalendarDate = addMonths(currentDate, delta);
}

function renderBlockResultsHeatmap(poll, results) {
  const { blockPanel } = ensureBlockResultsPanel();
  if (!blockPanel) {
    return;
  }

  if (!pollUsesBlockMode(poll)) {
    blockPanel.classList.add("is-hidden");
    blockPanel.innerHTML = "";
    return;
  }

  const entries = getBlockResultEntries(results);
  if (entries.length === 0) {
    blockPanel.classList.remove("is-hidden");
    blockPanel.innerHTML = renderEmptyStateMarkup(
      "fa-regular fa-calendar",
      "Noch keine auswertbaren Blöcke vorhanden",
      "Sobald Antworten eingehen, erscheint hier eine Heatmap der möglichen zusammenhängenden Blöcke."
    );
    return;
  }

  const winnerDates = buildBlockHeatmapDateSet(
    (results?.bestBlocks || results?.bestDates || [])
      .map(normalizeBlockResultEntry)
      .filter(Boolean)
  );
  const maxYes = entries.reduce((highest, entry) => Math.max(highest, entry.yes), 0);
  const activeMonthDate =
    state.resultsCalendarDate instanceof Date && !Number.isNaN(state.resultsCalendarDate.getTime())
      ? new Date(state.resultsCalendarDate.getFullYear(), state.resultsCalendarDate.getMonth(), 1)
      : new Date(`${entries[0].date.slice(0, 7)}-01T00:00:00`);

  blockPanel.classList.remove("is-hidden");
  blockPanel.innerHTML = `
    <div class="panel-header block-heatmap-header">
      <div>
        <p class="eyebrow">Zusatzansicht</p>
        <h2>Block-Heatmap</h2>
      </div>
      <div class="results-calendar-nav block-heatmap-nav">
        <button class="ghost-button compact-button" type="button" data-block-calendar-shift="-1" aria-label="Vorheriger Monat">
          <i class="fa-solid fa-chevron-left"></i>
        </button>
        <strong>${escapeHtml(formatMonthYear(activeMonthDate))}</strong>
        <button class="ghost-button compact-button" type="button" data-block-calendar-shift="1" aria-label="Nächster Monat">
          <i class="fa-solid fa-chevron-right"></i>
        </button>
      </div>
    </div>
    ${renderBlockHeatmapMonth(activeMonthDate, entries, winnerDates, maxYes, poll)}
  `;

  blockPanel.querySelectorAll("[data-block-calendar-shift]").forEach((button) => {
    button.addEventListener("click", () => {
      shiftBlockHeatmapMonth(Number(button.dataset.blockCalendarShift) || 0);
      renderResultsTable();
    });
  });

  blockPanel.querySelectorAll("[data-block-detail]").forEach((day) => {
    day.addEventListener("click", () => {
      showToast(day.dataset.blockDetail || "");
    });
  });
}

function renderBlockFixedResultsTable(poll, responses, results, editableResponse, showEditIcon) {
  const head = document.querySelector("#results-head");
  const body = document.querySelector("#results-body");
  const foot = document.querySelector("#results-foot");
  const entries = getTopMatrixDates(results.summary || []);
  const winnerDates = new Set((results.bestDates || []).map((entry) => entry.date));

  head.innerHTML = `
    <tr>
      <th class="name-column">Name</th>
      ${entries
        .map(
          (entry) => `
            <th class="${winnerDates.has(entry.date) ? "winner-column" : ""}">
              <div class="results-matrix-header block-period-card is-compact">
                <strong>${escapeHtml(formatBlockRangeShort(entry.date, entry.endDate))}</strong>
                <span class="results-matrix-subline">${escapeHtml(formatBlockPeriodMeta(entry.date, entry.endDate, entry.length || getInclusiveDateSpan(entry.date, entry.endDate)))}</span>
              </div>
            </th>
          `
        )
        .join("")}
    </tr>
  `;

  if (responses.length === 0 || entries.length === 0) {
    foot.innerHTML = "";
    body.innerHTML = `
      <tr>
        <td colspan="${Math.max(entries.length, 1) + 1}" class="description">Noch keine Antworten eingetragen.</td>
      </tr>
    `;
    return;
  }

  body.innerHTML = responses
    .map((response) => {
      const cells = entries
        .map((entry) => {
          const status = getBlockFixedStatusForEntry(response, entry);
          return `<td class="matrix-cell"><span class="result-badge ${status}">${statusLabels[status]}</span></td>`;
        })
        .join("");

      return `<tr><td class="name-column">${renderMatrixNameCell(response.name, response, editableResponse, showEditIcon)}</td>${cells}</tr>`;
    })
    .join("");

  foot.innerHTML = `
    <tr>
      <td class="name-column score-footer">Ranking</td>
      ${entries
        .map(
          (entry) => `
            <td class="score-footer ${winnerDates.has(entry.date) ? "winner-column" : ""}">
              <strong>${entry.score}</strong>
              <div class="results-matrix-subline">${entry.yes} Ja · ${entry.maybe} Vielleicht</div>
            </td>
          `
        )
        .join("")}
    </tr>
  `;
}

function renderBlockFreeResultsTable(poll, responses, results, editableResponse, showEditIcon) {
  const head = document.querySelector("#results-head");
  const body = document.querySelector("#results-body");
  const foot = document.querySelector("#results-foot");
  const winner = getTopMatrixDates(results.bestDates || [])[0] || null;

  head.innerHTML = `
    <tr>
      <th class="name-column">Name</th>
      <th>Ausgewählte Tage</th>
      <th>Mögliche Blöcke</th>
    </tr>
  `;

  if (responses.length === 0) {
    foot.innerHTML = "";
    body.innerHTML = `
      <tr>
        <td colspan="3" class="description">Noch keine Antworten eingetragen.</td>
      </tr>
    `;
    return;
  }

  body.innerHTML = responses
    .map((response) => {
      const selectedDates = getSelectedBlockFreeDates(buildBlockFreeDailyDraft(poll, response), poll);
      const selectedLabel =
        selectedDates.length > 0
          ? `${selectedDates.length} ${selectedDates.length === 1 ? "Tag" : "Tage"}`
          : "";
      const selectedRange =
        selectedDates.length > 0
          ? formatBlockRangeShort(selectedDates[0], selectedDates[selectedDates.length - 1])
          : "";
      const selectedMeta =
        selectedDates.length > 1
          ? formatBlockPeriodMeta(selectedDates[0], selectedDates[selectedDates.length - 1])
          : "";
      const blockConfig = normalizePollBlockConfig(poll);
      const possibleBlocks = listBlockEntriesFromDates(selectedDates, blockConfig.length, blockConfig.weekdays);

      return `
        <tr>
          <td class="name-column">${renderMatrixNameCell(response.name, response, editableResponse, showEditIcon)}</td>
          <td>
            ${
              selectedLabel
                ? `
                  <div class="results-matrix-header block-period-card is-compact">
                    <strong>${escapeHtml(selectedLabel)}</strong>
                    <span class="results-matrix-subline">${escapeHtml(selectedRange)}${selectedMeta ? ` · ${escapeHtml(selectedMeta)}` : ""}</span>
                  </div>
                `
                : '<span class="matrix-empty">-</span>'
            }
          </td>
          <td>${escapeHtml(String(possibleBlocks.length))}</td>
        </tr>
      `;
    })
    .join("");

  foot.innerHTML = `
    <tr>
      <td class="name-column score-footer">Gewinner</td>
      <td colspan="2" class="score-footer ${winner ? "winner-column" : ""}">
        ${
          winner
            ? `
              <strong>${escapeHtml(formatBlockRangeLong(winner.date, winner.endDate))}</strong>
              <div class="results-matrix-subline">${escapeHtml(`${winner.yes} Ja-Stimmen`)}</div>
            `
            : '<span class="results-matrix-subline">Noch kein Gewinner verfügbar.</span>'
        }
      </td>
    </tr>
  `;
}

function renderResultsTable() {
  const { poll, responses, results } = state.pollData;
  const { table, calendarPanel } = ensureResultsCalendarPanel();
  const { blockPanel } = ensureBlockResultsPanel();
  const editableResponse = getEditableResponse();
  const showEditIcon = Boolean(editableResponse) && hasEditableResponse();
  const hasTimeSlots = pollHasTimeSlots(poll);
  const calendarEvents = supportsResultsCalendar(poll) ? collectResultsCalendarEvents(poll, responses, results) : [];

  if (!table) {
    return;
  }

  renderResultsMatrixTable(poll, responses, results, editableResponse, showEditIcon, hasTimeSlots);
  renderBlockResultsHeatmap(poll, results);

  if (supportsResultsCalendar(poll)) {
    renderResultsCalendar(calendarEvents);
  } else if (calendarPanel) {
    calendarPanel.classList.add("is-hidden");
    calendarPanel.innerHTML = "";
  }

  if (!pollUsesBlockMode(poll) && blockPanel) {
    blockPanel.classList.add("is-hidden");
    blockPanel.innerHTML = "";
  }
}

function renderResultsMatrixTable(poll, responses, results, editableResponse, showEditIcon, hasTimeSlots = pollHasTimeSlots(poll)) {
  const head = document.querySelector("#results-head");
  const body = document.querySelector("#results-body");
  const foot = document.querySelector("#results-foot");
  const table = document.querySelector(".results-table");
  if (!head || !body || !foot || !table) {
    return;
  }

  table.classList.toggle("free-choice-matrix", pollUsesParticipantSuggestions(poll.mode) && !hasTimeSlots);
  table.classList.toggle("fixed-choice-matrix", (poll.mode === "fixed" || poll.mode === "block_fixed") && !hasTimeSlots);
  table.classList.toggle("star-rating-matrix", pollUsesStarRating(poll));
  table.classList.toggle("slot-choice-matrix", hasTimeSlots);

  if (hasTimeSlots) {
    renderFixedSlotResultsTable(poll, responses, editableResponse, showEditIcon);
    bindMatrixEditButtons();
    return;
  }

  if (pollUsesBlockFixed(poll)) {
    renderBlockFixedResultsTable(poll, responses, results, editableResponse, showEditIcon);
    bindMatrixEditButtons();
    return;
  }

  if (pollUsesBlockFree(poll)) {
    renderBlockFreeResultsTable(poll, responses, results, editableResponse, showEditIcon);
    bindMatrixEditButtons();
    return;
  }

  if (pollUsesWeeklySlots(poll)) {
    renderWeeklyResultsTable(poll, responses, editableResponse, showEditIcon);
    bindMatrixEditButtons();
    return;
  }

  if (pollUsesStarRating(poll)) {
    renderStarRatingResultsTable(poll, responses, editableResponse, showEditIcon);
    bindMatrixEditButtons();
    return;
  }

  if (pollUsesParticipantSuggestions(poll.mode)) {
    foot.innerHTML = "";
    const matrixDates = getTopMatrixDates(results.summary);
    const topVoteCount = matrixDates.reduce((bestCount, entry) => Math.max(bestCount, entry.count), 0);
    head.innerHTML = `
      <tr>
        <th class="name-column">Name</th>
        ${matrixDates
          .map(
            (entry) => `
              <th>
                <div class="results-matrix-header">
                  <strong>${escapeHtml(formatDateShort(entry.date))}</strong>
                  ${
                    entry.timeSlots?.length
                      ? `<span class="results-matrix-subline">${escapeHtml(formatSuggestedTimeSlotSummary(entry.timeSlots))}</span>`
                      : ""
                  }
                </div>
              </th>
            `
          )
          .join("")}
      </tr>
    `;

    if (responses.length === 0 || matrixDates.length === 0) {
      body.innerHTML = `
        <tr>
          <td colspan="${Math.max(matrixDates.length, 1) + 1}" class="participant-column-empty">
            ${renderEmptyStateMarkup(
              "fa-regular fa-comments",
              "Noch niemand hat abgestimmt",
              "Sobald die ersten Antworten eingehen, siehst du hier sofort die Verfügbarkeits-Matrix."
            )}
          </td>
        </tr>
      `;
      return;
    }

    body.innerHTML = responses
      .map((response) => {
        const pickedDates = new Map(
          getSuggestedDateEntries(response.suggestedDateEntries || response.suggestedDates).map((entry) => [entry.date, entry])
        );
        const items = matrixDates
          .map((entry) => {
            const suggestion = pickedDates.get(entry.date);
            const isAvailable = Boolean(suggestion);
            const timeLabel = formatSuggestedTimeValues(suggestion?.times, 3);
            const fullTimeLabel = formatSuggestedTimeValues(suggestion?.times);
            return `
              <td class="matrix-cell ${isAvailable ? "is-available" : ""}" title="${escapeHtml(
                `${response.name}: ${isAvailable ? "Ja" : "Nein"} für ${formatDateLong(entry.date)}${
                  fullTimeLabel ? ` mit ${fullTimeLabel}` : ""
                }`
              )}">
                ${
                  isAvailable
                    ? `
                      <div>
                        <i class="fa-solid fa-check matrix-check" aria-label="Ja"></i>
                        ${timeLabel ? `<div class="results-matrix-subline">${escapeHtml(timeLabel)}</div>` : ""}
                      </div>
                    `
                    : '<span class="matrix-empty" aria-hidden="true">-</span>'
                }
              </td>
            `;
          })
          .join("");

        return `
          <tr>
            <td class="name-column">${renderMatrixNameCell(response.name, response, editableResponse, showEditIcon)}</td>
            ${items}
          </tr>
        `;
      })
      .join("");

    foot.innerHTML = `
      <tr>
        <td class="name-column score-footer" style="position: sticky; bottom: 0; z-index: 3;">Stimmen</td>
        ${matrixDates
          .map((entry) => {
            const percentage = responses.length > 0 ? Math.round((entry.count / responses.length) * 100) : 0;
            const isWinner = topVoteCount > 0 && entry.count === topVoteCount;
            return `
              <td
                class="score-footer ${isWinner ? "winner-column" : ""}"
                style="position: sticky; bottom: 0; z-index: 3; ${
                  isWinner
                    ? "background: rgba(16, 185, 129, 0.15); box-shadow: inset 0 0 0 1px rgba(16, 185, 129, 0.35);"
                    : ""
                }"
              >
                <strong>${escapeHtml(formatVoteCountLabel(entry.count))}</strong>
                <div class="results-matrix-subline">${percentage}%</div>
              </td>
            `;
          })
          .join("")}
      </tr>
    `;

    bindMatrixEditButtons();
    return;
  }

  const dateStats = getFixedDateStats(poll.dates, responses);
  head.innerHTML = `
    <tr>
      <th class="name-column">Name</th>
      ${dateStats.entries
        .map(
          (entry) => `<th class="${entry.date === dateStats.winnerDate ? "winner-column" : ""}">${escapeHtml(
            formatDateShort(entry.date)
          )}</th>`
        )
        .join("")}
    </tr>
  `;

  if (responses.length === 0) {
    foot.innerHTML = "";
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
          return `<td class="matrix-cell"><span class="result-badge ${status}">${statusLabels[status]}</span></td>`;
        })
        .join("");

      return `<tr><td class="name-column">${renderMatrixNameCell(response.name, response, editableResponse, showEditIcon)}</td>${cells}</tr>`;
    })
    .join("");

  foot.innerHTML = `
    <tr>
      <td class="name-column score-footer">Score</td>
      ${dateStats.entries
        .map(
          (entry) => `
            <td class="score-footer ${entry.date === dateStats.winnerDate ? "winner-column" : ""}">
              <strong>${entry.score}</strong>
              <div class="results-matrix-subline">${entry.yes} Ja</div>
            </td>
          `
        )
        .join("")}
    </tr>
    <tr>
      <td class="name-column score-footer" style="position: sticky; bottom: 0; z-index: 3;">Stimmen</td>
      ${dateStats.entries
        .map((entry) => {
          const percentage = responses.length > 0 ? Math.round((entry.yes / responses.length) * 100) : 0;
          const isWinner = entry.date === dateStats.winnerDate;
          return `
            <td
              class="score-footer ${isWinner ? "winner-column" : ""}"
              style="position: sticky; bottom: 0; z-index: 3; ${
                isWinner
                  ? "background: rgba(16, 185, 129, 0.15); box-shadow: inset 0 0 0 1px rgba(16, 185, 129, 0.35);"
                  : ""
              }"
            >
              <strong>${escapeHtml(formatVoteCountLabel(entry.yes))}</strong>
              <div class="results-matrix-subline">${percentage}%</div>
            </td>
          `;
        })
        .join("")}
    </tr>
  `;

  bindMatrixEditButtons();
}

function renderRatingStars(rating, options = {}) {
  const value = Number(rating);
  const rounded = Number.isFinite(value) ? Math.round(value) : 0;
  const label = options.label || `${formatAverageRating(value)} von 5 Sternen`;
  return `
    <span class="star-rating-display" aria-label="${escapeHtml(label)}">
      ${[1, 2, 3, 4, 5]
        .map((star) => `<i class="${star <= rounded ? "fa-solid" : "fa-regular"} fa-star"></i>`)
        .join("")}
    </span>
  `;
}

function renderStarRatingResultsTable(poll, responses, editableResponse, showEditIcon) {
  const head = document.querySelector("#results-head");
  const body = document.querySelector("#results-body");
  const foot = document.querySelector("#results-foot");
  const ratingStats = getStarRatingStats(poll.dates, responses);

  head.innerHTML = `
    <tr>
      <th class="name-column">Name</th>
      ${ratingStats.entries
        .map(
          (entry) => `
            <th class="${entry.date === ratingStats.winnerDate ? "winner-column" : ""}">
              <div class="results-matrix-header">
                <strong>${escapeHtml(formatDateShort(entry.date))}</strong>
                <span class="results-matrix-subline">${renderRatingStars(entry.average)} ${escapeHtml(formatAverageRating(entry.average))}</span>
              </div>
            </th>
          `
        )
        .join("")}
    </tr>
  `;

  if (responses.length === 0) {
    foot.innerHTML = "";
    body.innerHTML = `
      <tr>
        <td colspan="${Math.max(ratingStats.entries.length, 1) + 1}" class="description">Noch keine Bewertungen eingetragen.</td>
      </tr>
    `;
    return;
  }

  body.innerHTML = responses
    .map((response) => {
      const cells = ratingStats.entries
        .map((entry) => {
          const rating = Number(response.availabilities?.[entry.date]);
          const hasRating = Number.isInteger(rating) && rating >= 1 && rating <= 5;
          return `
            <td class="matrix-cell star-rating-result-cell ${entry.date === ratingStats.winnerDate ? "winner-column" : ""}">
              ${
                hasRating
                  ? `${renderRatingStars(rating, { label: `${rating} von 5 Sternen` })}<div class="results-matrix-subline">${rating}/5</div>`
                  : '<span class="matrix-empty" aria-hidden="true">-</span>'
              }
            </td>
          `;
        })
        .join("");

      return `<tr><td class="name-column">${renderMatrixNameCell(response.name, response, editableResponse, showEditIcon)}</td>${cells}</tr>`;
    })
    .join("");

  foot.innerHTML = `
    <tr>
      <td class="name-column score-footer">Durchschnitt</td>
      ${ratingStats.entries
        .map(
          (entry) => `
            <td class="score-footer ${entry.date === ratingStats.winnerDate ? "winner-column" : ""}">
              <strong>${renderRatingStars(entry.average)} ${escapeHtml(formatAverageRating(entry.average))}</strong>
              <div class="results-matrix-subline">${escapeHtml(formatRatingCountLabel(entry.count))}</div>
            </td>
          `
        )
        .join("")}
    </tr>
  `;
}

function getWeeklySlotStats(poll, responses) {
  const entries = getWeeklySlotsFromPoll(poll).map((slot) => ({
    ...slot,
    key: buildWeeklySlotKey(slot.weekday, slot.time),
    score: 0,
    yes: 0,
    maybe: 0,
    no: 0,
  }));

  for (const response of responses || []) {
    for (const entry of entries) {
      const status = response.weeklyAvailabilities?.[entry.key] || "no";
      if (status === "yes") {
        entry.yes += 1;
        entry.score += getScoreForStatus(status, response.hasVeto);
      } else if (status === "maybe") {
        entry.maybe += 1;
        entry.score += getScoreForStatus(status, response.hasVeto);
      } else {
        entry.no += 1;
      }
    }
  }

  const winnerEntry = entries.reduce((bestEntry, entry) => {
    if (!bestEntry || entry.score > bestEntry.score) {
      return entry;
    }
    if (bestEntry && entry.score === bestEntry.score && entry.yes > bestEntry.yes) {
      return entry;
    }
    return bestEntry;
  }, null);

  return {
    entries,
    winnerKey: winnerEntry?.key || "",
    winnerEntry,
  };
}

function renderWeeklyResultsTable(poll, responses, editableResponse, showEditIcon) {
  const head = document.querySelector("#results-head");
  const body = document.querySelector("#results-body");
  const foot = document.querySelector("#results-foot");
  const weeklyStats = getWeeklySlotStats(poll, responses);

  head.innerHTML = `
    <tr>
      <th class="name-column">Name</th>
      ${weeklyStats.entries
        .map(
          (entry) => `
            <th class="${entry.key === weeklyStats.winnerKey ? "winner-column" : ""}">
              <div class="results-matrix-header">
                <strong>${escapeHtml(formatWeeklyWeekday(entry.weekday))}</strong>
                <span class="results-matrix-subline">${escapeHtml(entry.time)}</span>
              </div>
            </th>
          `
        )
        .join("")}
    </tr>
  `;

  if (responses.length === 0) {
    foot.innerHTML = "";
    body.innerHTML = `
      <tr>
        <td colspan="${weeklyStats.entries.length + 1}" class="description">Noch keine Antworten eingetragen.</td>
      </tr>
    `;
    return;
  }

  body.innerHTML = responses
    .map((response) => {
      const cells = weeklyStats.entries
        .map((entry) => {
          const status = response.weeklyAvailabilities?.[entry.key] || "no";
          return `<td class="matrix-cell weekly-heat-${status}"><span class="result-badge ${status}">${statusLabels[status]}</span></td>`;
        })
        .join("");

      return `<tr><td class="name-column">${renderMatrixNameCell(response.name, response, editableResponse, showEditIcon)}</td>${cells}</tr>`;
    })
    .join("");

  foot.innerHTML = `
    <tr>
      <td class="name-column score-footer">Ranking</td>
      ${weeklyStats.entries
        .map(
          (entry) => `
            <td class="score-footer ${entry.key === weeklyStats.winnerKey ? "winner-column" : ""}">
              <strong>${entry.score}</strong>
              <div class="results-matrix-subline">${entry.yes} Ja · ${entry.maybe} Vielleicht</div>
            </td>
          `
        )
        .join("")}
    </tr>
  `;
}

function renderFixedSlotResultsTable(poll, responses, editableResponse, showEditIcon) {
  const head = document.querySelector("#results-head");
  const body = document.querySelector("#results-body");
  const foot = document.querySelector("#results-foot");
  const slotStats = getFixedSlotStats(poll, responses);

  head.innerHTML = `
    <tr>
      <th class="name-column">Name</th>
      ${slotStats.entries
        .map(
          (entry) => `
            <th class="${entry.key === slotStats.winnerKey ? "winner-column" : ""}">
              <div class="results-matrix-header">
                <strong>${escapeHtml(formatDateShort(entry.date))}</strong>
                <span class="results-matrix-subline">${escapeHtml(entry.slot || "Ganzer Tag")}</span>
              </div>
            </th>
          `
        )
        .join("")}
    </tr>
  `;

  if (responses.length === 0) {
    foot.innerHTML = "";
    body.innerHTML = `
      <tr>
        <td colspan="${slotStats.entries.length + 1}" class="description">Noch keine Antworten eingetragen.</td>
      </tr>
    `;
    return;
  }

  body.innerHTML = responses
    .map((response) => {
      const cells = slotStats.entries
        .map((entry) => {
          const status = entry.slot
            ? response.slotAvailabilities?.[entry.date]?.[entry.slot] || "no"
            : response.availabilities?.[entry.date] || "no";
          return `<td class="matrix-cell"><span class="result-badge ${status}">${statusLabels[status]}</span></td>`;
        })
        .join("");

      return `<tr><td class="name-column">${renderMatrixNameCell(response.name, response, editableResponse, showEditIcon)}</td>${cells}</tr>`;
    })
    .join("");

  foot.innerHTML = `
    <tr>
      <td class="name-column score-footer">Score</td>
      ${slotStats.entries
        .map(
          (entry) => `
            <td class="score-footer ${entry.key === slotStats.winnerKey ? "winner-column" : ""}">
              <strong>${entry.score}</strong>
              <div class="results-matrix-subline">${entry.yes} Ja</div>
            </td>
          `
        )
        .join("")}
    </tr>
    <tr>
      <td class="name-column score-footer" style="position: sticky; bottom: 0; z-index: 3;">Stimmen</td>
      ${slotStats.entries
        .map((entry) => {
          const percentage = responses.length > 0 ? Math.round((entry.yes / responses.length) * 100) : 0;
          const isWinner = entry.key === slotStats.winnerKey;
          return `
            <td
              class="score-footer ${isWinner ? "winner-column" : ""}"
              style="position: sticky; bottom: 0; z-index: 3; ${
                isWinner
                  ? "background: rgba(16, 185, 129, 0.15); box-shadow: inset 0 0 0 1px rgba(16, 185, 129, 0.35);"
                  : ""
              }"
            >
              <strong>${escapeHtml(formatVoteCountLabel(entry.yes))}</strong>
              <div class="results-matrix-subline">${percentage}%</div>
            </td>
          `;
        })
        .join("")}
    </tr>
  `;
}

function refreshPollView() {
  initializeDraftFromPoll(state.pollData.poll);
  fillPollSummary();
  renderAvailabilityForm();
  renderResultsTable();
}

function renderMatrixNameCell(name, response, editableResponse, showEditIcon) {
  const isOwnRow = Boolean(showEditIcon && editableResponse && response.id === editableResponse.id);
  const canManage = Boolean(state.pollData?.permissions?.canManage);
  const roleIcon = response.hasVeto
    ? '<span class="participant-inline-icon" title="Veto-Recht"><i class="fa-solid fa-crown"></i></span>'
    : "";

  return `
    <div class="matrix-name-cell">
      <span class="matrix-name-label">${escapeHtml(name)}${roleIcon}</span>
      <span class="matrix-action-group">
        <span class="matrix-actions-row">
        ${
          isOwnRow
            ? `
              <button class="matrix-edit-button" type="button" data-response-id="${response.id}" aria-label="Eigene Verfügbarkeit bearbeiten">
                <i class="fa-solid fa-pen-to-square" aria-hidden="true"></i>
              </button>
            `
            : ""
        }
        ${
          canManage
            ? `
              <select class="veto-dropdown veto-dropdown-inline" data-response-id="${response.id}" aria-label="Veto für ${escapeHtml(name)}">
                <option value="none" ${response.hasVeto ? "" : "selected"}>Kein Veto</option>
                <option value="veto" ${response.hasVeto ? "selected" : ""}>Veto</option>
              </select>
              <button class="matrix-delete-button" type="button" data-response-id="${response.id}" aria-label="Antwort löschen">
                <i class="fa-regular fa-trash-can" aria-hidden="true"></i>
              </button>
            `
            : ""
        }
        </span>
      </span>
    </div>
  `;
}

function bindMatrixEditButtons() {
  const table = document.querySelector(".results-table");
  if (!table) {
    return;
  }

  // Remove old event listeners by cloning and replacing the table
  const newTable = table.cloneNode(true);
  table.parentNode.replaceChild(newTable, table);

  newTable.addEventListener("click", (event) => {
    const editButton = event.target.closest(".matrix-edit-button");
    if (editButton) {
      event.preventDefault();
      event.stopPropagation();
      console.debug("[matrix] edit click", { responseId: editButton.dataset.responseId || "" });
      openPollResponseDrawer({ resetDraft: true });
      return;
    }

    const deleteButton = event.target.closest(".matrix-delete-button");
    if (!deleteButton) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();

    const { responseId = "" } = deleteButton.dataset;
    console.debug("[matrix] delete click", { responseId });
    handleAdminDeleteResponse(responseId).catch((error) => {
      setFeedback(document.querySelector("#response-feedback"), error.message, "error");
    });
  });

  newTable.addEventListener("change", (event) => {
    const vetoDropdown = event.target.closest(".veto-dropdown");
    if (!vetoDropdown) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();

    handleMatrixVetoChange(vetoDropdown.dataset.responseId, vetoDropdown.value, vetoDropdown).catch((error) => {
      setFeedback(document.querySelector("#response-feedback"), error.message, "error");
      refreshPollView();
    });
  });
}

async function handleResponseSubmit(event) {
  event.preventDefault();

  const feedback = document.querySelector("#response-feedback");
  const isFixed = state.pollData.poll.mode === "fixed" || state.pollData.poll.mode === "block_fixed";
  const payload = {};

  if (pollHasTimeSlots(state.pollData.poll)) {
    payload.slotResponses = buildSlotResponsePayload(
      state.pollData.poll,
      state.responseDraft
    );
  } else if (pollUsesWeeklySlots(state.pollData.poll)) {
    payload.weeklyAvailabilities = { ...state.responseDraft };
  } else if (pollUsesBlockFree(state.pollData.poll)) {
    const availabilityPayload = buildBlockFreeAvailabilityPayload(state.pollData.poll, state.responseDraft);
    if (!availabilityPayload.ok) {
      setFeedback(feedback, availabilityPayload.message, "error");
      return;
    }
    payload.availabilities = availabilityPayload.value;
  } else if (pollUsesStarRating(state.pollData.poll)) {
    const ratingPayload = buildStarRatingAvailabilityPayload(state.pollData.poll, state.responseDraft);
    if (!ratingPayload.ok) {
      setFeedback(feedback, ratingPayload.message, "error");
      return;
    }
    payload.availabilities = ratingPayload.value;
  } else if (isFixed) {
    payload.availabilities = state.responseDraft;
  } else {
    syncParticipantSuggestedTimesFromEditor();
    payload.suggestedDates = normalizeParticipantSuggestionsForSubmit();
    if (payload.suggestedDates === null) {
      setFeedback(
        feedback,
        suggestionModeUsesRangeSlots()
          ? "Bitte nutze für vorgeschlagene Zeitslots das Format HH:MM-HH:MM."
          : "Bitte nutze für optionale Uhrzeiten das Format HH:MM.",
        "error"
      );
      return;
    }
  }

  try {
    setFeedback(feedback, "Antwort wird gespeichert ...");
    const data = await apiFetch(`/api/polls/${state.pollData.poll.id}/responses`, {
      method: "POST",
      body: JSON.stringify(payload),
    });

    state.pollData = data;
    refreshPollView();
    setFeedback(document.querySelector("#response-feedback"), "Antwort gespeichert.", "success");

    if (!isCompactPollLayout()) {
      window.setTimeout(() => {
        closePollResponseDrawer();
      }, 180);
    }
  } catch (error) {
    setFeedback(feedback, error.message, "error");
  }
}

async function sharePollLink() {
  const shareUrl = state.pollData?.poll?.absoluteShareUrl || window.location.href;
  const shareTitle = state.pollData?.poll?.title || "Termin-Abstimmung";

  if (navigator.share) {
    try {
      await navigator.share({
        title: shareTitle,
        text: "Schau dir diese Termin-Abstimmung an:",
        url: shareUrl,
      });
      return;
    } catch (error) {
      if (error?.name !== "AbortError") {
        console.log("Share failed:", error);
      }
    }
  }

  await copyTextToClipboard(shareUrl);
  showToast("Link kopiert!");
}

async function handleCalendarDownload() {
  const poll = state.pollData?.poll;
  if (!poll) {
    return;
  }

  const exportDate = getSelectedExportDate();
  if (!exportDate) {
    setFeedback(document.querySelector("#response-feedback"), "Noch kein exportierbarer Termin verfügbar.", "error");
    return;
  }
  const query = exportDate ? `?date=${encodeURIComponent(exportDate)}` : "";
  window.open(`/api/polls/${poll.id}/ics${query}`, "_blank", "noopener");
}

function formatPollExportLabel(poll, startDate) {
  if (pollUsesBlockMode(poll)) {
    const blockLength = normalizePollBlockConfig(poll).length;
    return formatBlockRangeLong(startDate, getBlockEndDateValue(startDate, blockLength));
  }

  return formatDateLong(startDate);
}

function getPollExportDates(poll) {
  if (!poll) {
    return [];
  }

  if (pollHasTimeSlots(poll) || poll.mode === "weekly") {
    return [];
  }

  if (poll.mode === "block_fixed") {
    return getPollBlockStartDates(poll);
  }

  if (poll.mode === "block_free") {
    return Array.isArray(state.pollData?.results?.summary) ? state.pollData.results.summary.map((entry) => entry.date) : [];
  }

  if (poll.mode === "fixed" || poll.mode === "star_rating") {
    return [...poll.dates];
  }

  if (Array.isArray(poll.bestDates)) {
    return poll.bestDates.map((entry) => entry.date);
  }

  return (state.pollData?.results?.bestDates || []).map((entry) => entry.date);
}

function getSelectedExportDate() {
  const select = document.querySelector("#poll-export-date");
  if (select?.value) {
    return select.value;
  }

  const poll = state.pollData?.poll;
  return getPollExportDates(poll)[0] || "";
}

function getTopMatrixDates(summary) {
  return [...(summary || [])].sort(compareResultEntries);
}

function getPollTimeSlotsByDate(poll) {
  const source = poll?.timeSlots || poll?.time_slots || {};
  const dates = Array.isArray(poll?.dates) ? [...poll.dates].sort() : Object.keys(source).sort();
  const normalized = {};

  for (const date of dates) {
    normalized[date] = Array.isArray(source[date])
      ? source[date].map((slot) => normalizePollSlotValue(slot)).filter(Boolean)
      : [];
  }

  return normalized;
}

function getFixedScheduleEntries(poll) {
  const usesTimeSlots = pollHasTimeSlots(poll);
  if (!usesTimeSlots) {
    return [];
  }

  const entries = [];
  const timeSlotsByDate = getPollTimeSlotsByDate(poll);
  for (const date of [...(poll?.dates || [])].sort()) {
    const slots = timeSlotsByDate[date] || [];
    if (slots.length === 0) {
      entries.push({
        key: `${date}__all-day`,
        date,
        slot: "",
        label: "Ganzer Tag",
      });
      continue;
    }

    for (const slot of slots) {
      entries.push({
        key: `${date}__${slot}`,
        date,
        slot,
        label: slot,
      });
    }
  }

  return entries;
}

function getFixedDateStats(dates, responses) {
  const entries = (dates || []).map((date) => ({
    date,
    score: 0,
    yes: 0,
    maybe: 0,
    no: 0,
  }));
  const entryByDate = new Map(entries.map((entry) => [entry.date, entry]));

  for (const response of responses || []) {
    for (const date of dates || []) {
      const status = response.availabilities?.[date] || "no";
      const entry = entryByDate.get(date);
      if (!entry) {
        continue;
      }

      if (status === "yes") {
        entry.yes += 1;
        entry.score += getScoreForStatus(status, response.hasVeto);
      } else if (status === "maybe") {
        entry.maybe += 1;
        entry.score += getScoreForStatus(status, response.hasVeto);
      } else {
        entry.no += 1;
      }
    }
  }

  const winnerEntry = entries.reduce((bestEntry, entry) => {
    if (!bestEntry || entry.score > bestEntry.score) {
      return entry;
    }

    return bestEntry;
  }, null);

  return {
    entries,
    winnerDate: winnerEntry?.date || "",
    winnerEntry,
  };
}

function getStarRatingStats(dates, responses) {
  const entries = (dates || []).map((date) => ({
    date,
    total: 0,
    count: 0,
    average: 0,
    participants: responses?.length || 0,
  }));
  const entryByDate = new Map(entries.map((entry) => [entry.date, entry]));

  for (const response of responses || []) {
    for (const date of dates || []) {
      const rating = Number(response.availabilities?.[date]);
      const entry = entryByDate.get(date);
      if (!entry || !Number.isInteger(rating) || rating < 1 || rating > 5) {
        continue;
      }

      entry.total += rating;
      entry.count += 1;
    }
  }

  entries.forEach((entry) => {
    entry.average = entry.count > 0 ? entry.total / entry.count : 0;
    entry.score = entry.average;
  });

  const sortedEntries = [...entries].sort((left, right) => {
    if (right.average !== left.average) {
      return right.average - left.average;
    }
    if (right.count !== left.count) {
      return right.count - left.count;
    }
    return left.date.localeCompare(right.date);
  });

  const bestAverage = sortedEntries[0]?.average || 0;

  return {
    entries: sortedEntries,
    winnerDate: bestAverage > 0 ? sortedEntries[0]?.date || "" : "",
    winnerEntry: bestAverage > 0 ? sortedEntries[0] : null,
  };
}

function getFixedSlotStats(poll, responses) {
  const entries = getFixedScheduleEntries(poll).map((entry) => ({
    ...entry,
    score: 0,
    yes: 0,
    maybe: 0,
    no: 0,
  }));

  for (const response of responses || []) {
    for (const entry of entries) {
      const status = entry.slot
        ? response.slotAvailabilities?.[entry.date]?.[entry.slot] || "no"
        : response.availabilities?.[entry.date] || "no";
      if (status === "yes") {
        entry.yes += 1;
        entry.score += getScoreForStatus(status, response.hasVeto);
      } else if (status === "maybe") {
        entry.maybe += 1;
        entry.score += getScoreForStatus(status, response.hasVeto);
      } else {
        entry.no += 1;
      }
    }
  }

  const winnerEntry = entries.reduce((bestEntry, entry) => {
    if (!bestEntry || entry.score > bestEntry.score) {
      return entry;
    }
    if (bestEntry && entry.score === bestEntry.score && entry.yes > bestEntry.yes) {
      return entry;
    }
    return bestEntry;
  }, null);

  return {
    entries,
    winnerKey: winnerEntry?.key || "",
    winnerEntry,
  };
}

function getPollFavorite(poll, responses, results) {
  if (!responses?.length) {
    return null;
  }

  if (pollUsesBlockMode(poll)) {
    const favorite = (results?.bestDates || [])
      .slice()
      .sort(compareResultEntries)[0];
    return favorite
      ? { date: favorite.date, endDate: favorite.endDate, votes: favorite.yes, score: favorite.score }
      : null;
  }

  if (pollHasTimeSlots(poll)) {
    const { winnerEntry } = getFixedSlotStats(poll, responses);
    return winnerEntry
      ? { date: winnerEntry.date, slot: winnerEntry.slot, votes: winnerEntry.yes, score: winnerEntry.score }
      : null;
  }

  if (pollUsesWeeklySlots(poll)) {
    const { winnerEntry } = getWeeklySlotStats(poll, responses);
    return winnerEntry
      ? { date: formatWeeklyWeekday(winnerEntry.weekday), slot: winnerEntry.time, votes: winnerEntry.yes, score: winnerEntry.score }
      : null;
  }

  if (pollUsesStarRating(poll)) {
    const { winnerEntry } = getStarRatingStats(poll.dates, responses);
    return winnerEntry
      ? { date: winnerEntry.date, votes: winnerEntry.count, average: winnerEntry.average, score: winnerEntry.average }
      : null;
  }

  if (poll.mode === "fixed") {
    const { winnerEntry } = getFixedDateStats(poll.dates, responses);
    return winnerEntry ? { date: winnerEntry.date, votes: winnerEntry.yes, score: winnerEntry.score } : null;
  }

  const favorite = (results?.bestDates || [])
    .slice()
    .sort(compareResultEntries)[0];
  return favorite ? { date: favorite.date, votes: favorite.count, score: favorite.count } : null;
}

function getScoreForStatus(status, hasVeto = false) {
  if (hasVeto) {
    if (status === "yes") {
      return 3;
    }
    if (status === "maybe") {
      return 2;
    }
  }

  if (status === "yes") {
    return 2;
  }
  if (status === "maybe") {
    return 1;
  }
  return 0;
}

function countPollTimeSlots(timeSlots) {
  return Object.values(timeSlots || {}).reduce(
    (total, slots) => total + (Array.isArray(slots) ? slots.length : 0),
    0
  );
}

function countPollScheduleEntries(poll) {
  if (pollUsesWeeklySlots(poll)) {
    return getWeeklySlotsFromPoll(poll).length;
  }

  if (!pollHasTimeSlots(poll)) {
    return Array.isArray(poll?.dates) ? poll.dates.length : 0;
  }

  return getFixedScheduleEntries(poll).length;
}

function pollHasTimeSlots(poll) {
  return Boolean(
    poll &&
      (poll.mode === "timeslots" ||
        poll.allowTimeSlots ||
        poll.has_time_slots ||
        countPollTimeSlots(poll.timeSlots || poll.time_slots || {}) > 0)
  );
}

function buildSlotResponsePayload(poll, draft) {
  return getFixedScheduleEntries(poll).map((entry) => ({
    dateId: entry.date,
    slotId: entry.slot ? `${poll.id}__${entry.date}__${entry.slot.replace(":", "-")}` : `${poll.id}__${entry.date}__all-day`,
    availability: entry.slot ? draft?.[entry.date]?.[entry.slot] || "no" : draft?.[entry.date] || "no",
  }));
}

function syncParticipantRights(participantData) {
  const userId = participantData?.userId;
  if (!userId) {
    return;
  }

  state.pollData.responses = (state.pollData.responses || []).map((response) =>
    String(response.userId) === String(userId)
      ? {
          ...response,
          hasVeto: participantData.hasVeto,
          canVote: participantData.canVote,
          isBlocked: participantData.isBlocked,
        }
      : response
  );

  if (state.pollData?.user?.id && String(state.pollData.user.id) === String(userId)) {
    state.pollData.participant = {
      canVote: participantData.canVote,
      hasVeto: participantData.hasVeto,
      isBlocked: participantData.isBlocked,
    };
  }
}

async function handleMatrixVetoChange(responseId, vetoValue, selectElement) {
  const response = (state.pollData?.responses || []).find((entry) => String(entry.id) === String(responseId));
  if (!response?.userId) {
    throw new Error("Teilnehmer konnte nicht gefunden werden.");
  }

  selectElement.disabled = true;

  try {
    const payload = {
      hasVeto: vetoValue === "veto",
      canVote: response.canVote ?? true,
      isBlocked: response.isBlocked ?? false,
    };

    const data = await apiFetch(`/api/polls/${state.pollData.poll.id}/participants/${encodeURIComponent(response.userId)}`, {
      method: "PUT",
      body: JSON.stringify(payload),
    });

    syncParticipantRights(data.participant);
    refreshPollView();
    setFeedback(document.querySelector("#response-feedback"), "Veto gespeichert.", "success");
  } finally {
    selectElement.disabled = false;
  }
}

async function handleAdminDeleteResponse(responseId) {
  if (!responseId) {
    console.debug("[Delete] Aborted: missing responseId");
    return;
  }

  console.log("[Delete] Button clicked, responseId:", responseId);

  const confirmed = confirm("Diese Antwort wirklich löschen?");
  console.log("[Delete] Dialog confirmed:", confirmed);

  if (!confirmed) {
    console.debug("[Delete] Cancelled by user", { responseId });
    return;
  }

  const feedback = document.querySelector("#response-feedback");
  const pollId = state.pollData?.poll?.id;
  if (!pollId) {
    const error = new Error("Poll-ID fehlt. Antwort kann nicht gelöscht werden.");
    console.error("[Delete] Error:", error);
    throw error;
  }

  try {
    console.log("[Delete] API call starting...");
    setFeedback(feedback, "Antwort wird gelöscht ...");

    const data = await apiFetch(`/api/polls/${pollId}/responses/${encodeURIComponent(responseId)}`, {
      method: "DELETE",
    });

    console.log("[Delete] API response:", 200);

    if (!data?.poll || !Array.isArray(data.responses)) {
      throw new Error("Unerwartete Server-Antwort nach dem Löschen.");
    }

    state.pollData = data;

    console.log("[Delete] Success, re-rendering...");
    refreshPollView();

    setFeedback(feedback, "Antwort gelöscht.", "success");
  } catch (error) {
    console.error("[Delete] Error:", error);
    setFeedback(feedback, error.message, "error");
    throw error;
  }
}

function renderEmptyStateMarkup(iconClass, title, description) {
  return `
    <div class="empty-state free-empty-state">
      <div class="empty-state-visual">
        <i class="${escapeHtml(iconClass)}"></i>
      </div>
      <div class="empty-state-copy">
        <strong>${escapeHtml(title)}</strong>
        <p class="description">${escapeHtml(description)}</p>
      </div>
    </div>
  `;
}

async function copyTextToClipboard(text) {
  if (!text) {
    throw new Error("Kein Share-Link verfügbar.");
  }

  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }

  const field = document.createElement("textarea");
  field.value = text;
  field.setAttribute("readonly", "readonly");
  field.style.position = "absolute";
  field.style.left = "-9999px";
  document.body.appendChild(field);
  field.select();
  document.execCommand("copy");
  field.remove();
}

function showToast(message) {
  if (!toastElement) {
    return;
  }

  window.clearTimeout(toastTimeoutId);
  toastElement.textContent = message;
  toastElement.style.position = "fixed";
  toastElement.style.left = "50%";
  toastElement.style.bottom = "2rem";
  toastElement.style.transform = "translateX(-50%) translateY(0)";
  toastElement.style.background = "var(--accent-strong)";
  toastElement.style.color = "#fff";
  toastElement.style.padding = "0.75rem 1.5rem";
  toastElement.style.borderRadius = "0.5rem";
  toastElement.style.boxShadow = "0 16px 40px rgba(15, 23, 42, 0.28)";
  toastElement.style.zIndex = "1000";
  toastElement.style.opacity = "1";
  toastElement.style.pointerEvents = "none";
  toastElement.style.transition = "opacity 180ms ease, transform 180ms ease";

  toastTimeoutId = window.setTimeout(() => {
    toastElement.style.opacity = "0";
    toastElement.style.transform = "translateX(-50%) translateY(-10px)";
  }, 1800);
}

function setFeedback(element, message, type = "") {
  if (!element) {
    return;
  }

  element.textContent = message;
  element.className = `feedback ${type}`.trim();
}

function buildCalendarDays(year, month) {
  const firstDay = new Date(year, month, 1);
  const lastDay = new Date(year, month + 1, 0);
  const prefix = getWeekdayColumnIndex(firstDay.getDay());
  const suffix = 6 - getWeekdayColumnIndex(lastDay.getDay());
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

function isIsoDateValue(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(typeof value === "string" ? value.trim() : "");
}

function parseIsoDateValue(value) {
  if (!isIsoDateValue(value)) {
    return null;
  }

  const parsed = new Date(`${value}T00:00:00Z`);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function addDaysToIsoDateValue(value, delta) {
  const parsed = parseIsoDateValue(value);
  if (!parsed) {
    return "";
  }

  parsed.setUTCDate(parsed.getUTCDate() + delta);
  return [
    parsed.getUTCFullYear(),
    String(parsed.getUTCMonth() + 1).padStart(2, "0"),
    String(parsed.getUTCDate()).padStart(2, "0"),
  ].join("-");
}

function getIsoDateWeekdayValue(value) {
  return parseIsoDateValue(value)?.getUTCDay() ?? -1;
}

function getInclusiveDateSpan(startDate, endDate) {
  const start = parseIsoDateValue(startDate);
  const end = parseIsoDateValue(endDate);
  if (!start || !end || end < start) {
    return 0;
  }

  const milliseconds = end.getTime() - start.getTime();
  return Math.floor(milliseconds / (24 * 60 * 60 * 1000)) + 1;
}

function formatMonthYear(date) {
  return new Intl.DateTimeFormat("de-DE", {
    month: "long",
    year: "numeric",
  }).format(date);
}

function parseMonthYear(text) {
  const months = {
    Januar: 0, Februar: 1, Maerz: 2, April: 3, Mai: 4, Juni: 5,
    Juli: 6, August: 7, September: 8, Oktober: 9, November: 10, Dezember: 11
  };
  const match = text.match(/^(\w+)\s+(\d{4})$/);
  if (!match) return null;
  const monthName = match[1];
  const year = Number(match[2]);
  const month = months[monthName];
  if (month === undefined || Number.isNaN(year)) return null;
  return new Date(year, month, 1);
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

function formatDateTime(date) {
  return new Intl.DateTimeFormat("de-DE", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(date));
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
