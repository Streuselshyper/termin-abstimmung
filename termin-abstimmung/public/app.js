const navElement = document.querySelector("#topbar-nav");
const topbarPrimaryElement = document.querySelector("#topbar-primary");
const themeToggle = document.querySelector("#theme-toggle");
const dynamicViewElement = document.querySelector("#dynamic-view");
const toastElement = document.querySelector("#toast");
const staticViewIds = ["landing-view", "login-view", "register-view", "forgot-password-view", "dynamic-view"];
const weekdayLabels = ["Mo", "Di", "Mi", "Do", "Fr", "Sa", "So"];
const statusLabels = {
  yes: "Ja",
  maybe: "Vielleicht",
  no: "Nein",
};

const state = {
  auth: {
    user: null,
    csrfToken: "",
    sessionTimeoutMinutes: 30,
  },
  dashboardStats: null,
  dashboardPolls: [],
  selectedDates: new Set(),
  currentMonth: startOfMonth(new Date()),
  participantSelectedDates: new Set(),
  participantCurrentMonth: startOfMonth(new Date()),
  participantCalendarExpanded: !window.matchMedia("(max-width: 720px)").matches,
  pollData: null,
  responseDraft: {},
  pollDrawerOpen: false,
  createMode: "fixed",
};

let toastTimeoutId = 0;

initializeRouting();
bindStaticEventHandlers();
document.addEventListener("keydown", handleGlobalKeydown);

initializeApp().catch(handleRenderError);

themeToggle.addEventListener("click", toggleTheme);
applyStoredTheme();

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

  if (route.type === "reset-password") {
    await renderResetPasswordPage(route.token);
    return;
  }

  if (["dashboard", "create"].includes(route.type) && !state.auth.user) {
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
    <a class="ghost-link" href="/account"><i class="fa-regular fa-user"></i> Konto</a>
    <span class="nav-user">${escapeHtml(state.auth.user.email)}</span>
    <button id="logout-button" class="ghost-button wide-button" type="button">Logout</button>
  `;

  document.querySelector("#logout-button").addEventListener("click", handleLogout);
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
  if (pathname === "/create") {
    const mode = ["fixed", "free"].includes(params.get("mode")) ? params.get("mode") : "fixed";
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
    setFeedback(feedback, "Es fehlt ein gueltiger Reset-Token.", "error");
    details.innerHTML = '<p class="description">Fordere zuerst einen neuen Link an.</p>';
    return;
  }

  setFeedback(feedback, "Reset-Link wird geprueft ...");

  try {
    const data = await apiFetch(`/api/auth/reset-password/${encodeURIComponent(token)}`);
    details.innerHTML = `
      <p class="description">Konto: <strong>${escapeHtml(data.email)}</strong></p>
      <p class="description">Gueltig bis ${escapeHtml(formatDateTime(data.expiresAt))}</p>
    `;
    setFeedback(feedback, "Link ist gueltig. Du kannst jetzt ein neues Passwort setzen.", "success");
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

  document.querySelector("#refresh-dashboard").addEventListener("click", () => {
    loadDashboardPolls().catch(handleRenderError);
  });

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
            <span>E-Mail-Adresse bleibt unveraenderlich</span>
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
              <h2>Persoenliche Daten</h2>
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
              <h2>Passwort aendern</h2>
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
              <span>Neues Passwort bestaetigen</span>
              <input
                id="account-confirm-password"
                type="password"
                name="confirmPassword"
                autocomplete="new-password"
                required
                minlength="8"
                placeholder="Neues Passwort bestaetigen"
              />
            </label>

            <div id="account-password-feedback" class="feedback" role="status" aria-live="polite"></div>

            <button class="primary-button" type="submit">
              <i class="fa-solid fa-key"></i>
              Passwort aendern
            </button>
          </form>
        </article>

        <article class="panel">
          <div class="panel-header">
            <div>
              <p class="eyebrow">Gefahrenzone</p>
              <h2>Konto loeschen</h2>
            </div>
          </div>

          <div class="stack-form">
            <p class="description">
              Beim Loeschen werden dein Konto, deine Antworten und alle von dir erstellten Umfragen dauerhaft entfernt.
            </p>
            <div id="account-delete-feedback" class="feedback" role="status" aria-live="polite"></div>
            <button id="account-delete-button" class="ghost-button wide-button" type="button">
              <i class="fa-regular fa-trash-can"></i>
              Konto loeschen
            </button>
          </div>
        </article>
      </section>
    `;

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

  state.createMode = mode === "free" ? "free" : "fixed";
  state.selectedDates = new Set();
  state.currentMonth = startOfMonth(new Date());

  let existingPoll = null;
  if (pollId) {
    const data = await apiFetch(`/api/polls/${pollId}`);
    if (!data.permissions?.canManage) {
      throw new Error("Diese Umfrage kann nicht bearbeitet werden.");
    }
    existingPoll = data.poll;
    state.createMode = existingPoll.mode;
    state.selectedDates = new Set(existingPoll.dates || []);
    state.currentMonth = startOfMonth(getFirstSelectedCreateDate(existingPoll.dates));
  }

  dynamicViewElement.innerHTML = "";
  dynamicViewElement.appendChild(template.content.cloneNode(true));

  fillCreateForm(existingPoll);
  bindCreateForm(existingPoll);
}

function fillCreateForm(existingPoll) {
  const isEditing = Boolean(existingPoll);
  const isFixed = state.createMode === "fixed";
  const pageTitle = document.querySelector("#create-page-title");
  const pageDescription = document.querySelector("#create-page-description");
  const pageBadge = document.querySelector("#create-page-badge");
  const formTitle = document.querySelector("#create-form-title");
  const submitButton = document.querySelector("#create-submit-button");

  document.querySelector("#create-title").value = existingPoll?.title || "";
  document.querySelector("#create-description").value = existingPoll?.description || "";
  pageBadge.textContent = isEditing ? "Bearbeiten" : "Neue Umfrage";
  pageTitle.textContent = isEditing ? "Umfrage bearbeiten" : "Neue Termin-Abstimmung";
  pageDescription.textContent = isFixed
    ? "Lege Titel, Beschreibung und feste Termine fest. Teilnehmende stimmen danach strukturiert pro Termin ab."
    : "Lege Titel und Beschreibung fest. Teilnehmende koennen danach selbst beliebige passende Tage markieren.";
  formTitle.textContent = isFixed ? "Feste Termine konfigurieren" : "Freie Wahl konfigurieren";
  submitButton.innerHTML = isEditing
    ? '<i class="fa-regular fa-floppy-disk"></i> Aenderungen speichern'
    : '<i class="fa-regular fa-floppy-disk"></i> Umfrage speichern';

  document.querySelector("#create-fixed-fields").classList.toggle("is-hidden", !isFixed);
  document.querySelector("#create-free-fields").classList.toggle("is-hidden", isFixed);
  document.querySelectorAll('.create-mode-card[href^="/create?mode="]').forEach((card) => {
    const url = new URL(card.href, window.location.origin);
    card.classList.toggle("is-active", url.searchParams.get("mode") === state.createMode);
  });

  if (isFixed) {
    renderCreateCalendar();
    renderCreateSelectedDates();
  }
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
    renderCreateCalendar();
    renderCreateSelectedDates();
  });

  document.querySelector("#create-form").addEventListener("submit", (event) => handleCreateSubmit(event, existingPoll?.id || ""));
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
      renderCreateCalendar();
      renderCreateSelectedDates();
    });
    grid.appendChild(button);
  }
}

function renderCreateSelectedDates() {
  const container = document.querySelector("#create-selected-dates");
  if (!container) {
    return;
  }

  const dates = Array.from(state.selectedDates).sort();
  if (dates.length === 0) {
    container.innerHTML = '<p class="description">Noch keine Termine ausgewaehlt.</p>';
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
      renderCreateCalendar();
      renderCreateSelectedDates();
    });
    container.appendChild(pill);
  }
}

async function handleCreateSubmit(event, pollId) {
  event.preventDefault();
  const feedback = document.querySelector("#create-feedback");
  const title = document.querySelector("#create-title").value.trim();
  const description = document.querySelector("#create-description").value.trim();
  const payload = {
    title,
    description,
    mode: state.createMode,
    dates: state.createMode === "fixed" ? Array.from(state.selectedDates).sort() : [],
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

async function loadDashboardPolls() {
  const list = document.querySelector("#dashboard-polls");
  const summary = document.querySelector("#dashboard-list-summary");
  list.innerHTML = '<p class="description">Deine Umfragen werden geladen ...</p>';

  try {
    const data = await apiFetch("/api/user/dashboard");
    state.dashboardPolls = data.polls;
    state.dashboardStats = data.stats;
    summary.textContent = `${data.polls.length} Umfragen`;

    if (data.polls.length === 0) {
      list.innerHTML = `
        <article class="poll-card poll-empty-state">
          <strong>Noch keine Umfragen</strong>
          <p class="description">Erstelle oben deine erste Termin-Abstimmung.</p>
        </article>
      `;
      return;
    }

    list.innerHTML = data.polls.map(renderDashboardPollCard).join("");
    list.querySelectorAll("[data-poll-link]").forEach((row) => {
      row.addEventListener("click", (event) => handleDashboardRowOpen(event, row.dataset.pollLink || ""));
      row.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          handleDashboardRowOpen(event, row.dataset.pollLink || "");
        }
      });
    });
  } catch (error) {
    if (error.status === 401) {
      await navigateTo("/login", { replace: true });
      return;
    }

    list.innerHTML = `<p class="feedback error">${escapeHtml(error.message)}</p>`;
  }
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

function renderDashboardPollCard(poll) {
  const lastUpdated = poll.latestResponseAt || poll.updatedAt || poll.createdAt;
  const lastUpdatedDate = typeof lastUpdated === "string" ? lastUpdated.slice(0, 10) : "";
  const status = getDashboardPollStatus(poll);
  const type = getDashboardPollTypeMeta(poll.mode);

  return `
    <article class="poll-list-row" data-poll-link="${poll.shareUrl}" tabindex="0">
      <div class="poll-list-main">
        <h3 class="poll-list-title">${escapeHtml(poll.title)}</h3>
      </div>
      <div class="poll-list-meta" aria-label="Zuletzt aktualisiert und Status">
        <span class="poll-list-date">
          ${escapeHtml(lastUpdatedDate ? formatDateShort(lastUpdatedDate) : "-")}
        </span>
        <span class="dashboard-status-badge dashboard-status-${status.tone}">${escapeHtml(status.label)}</span>
      </div>
      <div class="poll-card-actions poll-list-actions">
      </div>
    </article>
  `;
}

function getDashboardPollStatus(poll) {
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

  return { label: "Freie Wahl", icon: "fa-regular fa-pen-to-square" };
}

async function handleRegister(event) {
  event.preventDefault();
  const feedback = document.querySelector("#register-feedback");
  const email = document.querySelector("#register-email").value.trim();
  const password = document.querySelector("#register-password").value;
  const passwordConfirm = document.querySelector("#register-password-confirm").value;

  if (password !== passwordConfirm) {
    setFeedback(feedback, "Die Passwoerter stimmen nicht ueberein.", "error");
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
    setFeedback(feedback, "Login wird geprueft ...");
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
      openButton.textContent = "Reset-Seite oeffnen";
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
    setFeedback(feedback, "Die Passwoerter stimmen nicht ueberein.", "error");
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

async function handleLogout() {
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
    setFeedback(feedback, "Die neuen Passwoerter stimmen nicht ueberein.", "error");
    return;
  }

  try {
    setFeedback(feedback, "Passwort wird geaendert ...");
    await apiFetch("/api/user/password", {
      method: "PUT",
      body: JSON.stringify({ currentPassword, newPassword }),
    });
    document.querySelector("#account-password-form").reset();
    setFeedback(feedback, "Passwort erfolgreich geaendert.", "success");
  } catch (error) {
    setFeedback(feedback, error.message, "error");
  }
}

async function handleAccountDelete() {
  const feedback = document.querySelector("#account-delete-feedback");
  const confirmed = confirm("Willst du dein Konto wirklich dauerhaft loeschen?");
  if (!confirmed) {
    return;
  }

  try {
    setFeedback(feedback, "Konto wird geloescht ...");
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
  state.participantCalendarExpanded = !window.matchMedia("(max-width: 720px)").matches;

  if (poll.mode === "free") {
    state.responseDraft = {};
    state.participantSelectedDates = new Set(editableResponse?.suggestedDates || []);
    state.participantCurrentMonth = startOfMonth(new Date());
    return;
  }

  const defaultDraft = {};
  for (const date of poll.dates) {
    defaultDraft[date] = editableResponse?.availabilities?.[date] || "maybe";
  }

  state.responseDraft = defaultDraft;
  state.participantSelectedDates = new Set();
  state.participantCurrentMonth = startOfMonth(new Date());
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
  return window.matchMedia("(max-width: 720px)").matches;
}

function updatePollResponseCta() {
  const label = document.querySelector("#poll-open-response-label");
  const currentParticipant = getCurrentParticipantState();
  if (!label) {
    return;
  }

  if (currentParticipant.isBlocked) {
    label.textContent = "Gesperrt";
    return;
  }
  if (!currentParticipant.canVote) {
    label.textContent = "Derzeit deaktiviert";
    return;
  }
  label.textContent = hasEditableResponse() ? "Verfuegbarkeit aendern" : "Jetzt abstimmen";
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

  const drawerOpen = state.pollDrawerOpen && !isCompactPollLayout();
  panel.classList.toggle("is-open", drawerOpen);
  overlay.classList.toggle("is-hidden", !drawerOpen);
  document.body.classList.toggle("poll-drawer-open", drawerOpen);
}

function openPollResponseDrawer(options = {}) {
  if (options.resetDraft) {
    initializeDraftFromPoll(state.pollData.poll);
    renderAvailabilityForm();
  }

  if (isCompactPollLayout()) {
    document.querySelector("#poll-response-panel")?.scrollIntoView({ behavior: "smooth", block: "start" });
    return;
  }

  state.pollDrawerOpen = true;
  syncPollResponsePanelState();
}

function closePollResponseDrawer() {
  state.pollDrawerOpen = false;
  syncPollResponsePanelState();
}

function bindPollResponseEvents() {
  document.querySelector("#poll-open-response")?.addEventListener("click", () => {
    openPollResponseDrawer();
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
  const isFixed = poll.mode === "fixed";
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
      ? `🏆 Favorit: ${formatDateShort(favorite.date)} mit ${formatVoteCountLabel(favorite.votes)}`
      : "";
  favoriteSummary.classList.toggle("is-hidden", !(responses.length > 0 && favorite));
  document.querySelector("#participant-form-title").textContent = hasEditableResponse()
    ? "Verfuegbarkeit anpassen"
    : isFixed
      ? "Deine Verfuegbarkeit"
      : "Teilnehmen";
  document.querySelector("#poll-back-link").setAttribute("href", state.auth.user ? "/dashboard" : "/");
  document.querySelector("#poll-back-link").innerHTML = state.auth.user
    ? '<i class="fa-solid fa-arrow-left"></i> Zurueck'
    : '<i class="fa-solid fa-arrow-left"></i> Start';

  meta.innerHTML = [
    `<span class="pill"><i class="fa-regular fa-compass"></i> ${escapeHtml(isFixed ? "Feste Termine" : "Freie Wahl")}</span>`,
    `<span class="pill"><i class="fa-regular fa-calendar"></i> ${escapeHtml(isFixed ? `${poll.dates.length} Termine` : `${results.summary.length || 0} genannte Tage`)}</span>`,
    `<span class="pill"><i class="fa-regular fa-user"></i> ${escapeHtml(formatResponseCountLabel(responses.length))}</span>`,
    ownerLabel
      ? `<span class="pill"><i class="fa-regular fa-id-badge"></i> ${escapeHtml(ownerLabel)}</span>`
      : "",
  ].filter(Boolean).join("");

  const currentParticipant = getCurrentParticipantState();
  if (currentParticipant.hasVeto) {
    meta.innerHTML += `<span class="pill"><i class="fa-solid fa-crown"></i> Veto-Recht</span>`;
  }

  summaryEmpty.classList.add("is-hidden");
  summaryEmpty.innerHTML = "";
  renderPollOwnerActions();
  updatePollResponseCta();

  if (!isFixed) {
    if (results.bestDates.length === 0) {
      summaryEmpty.innerHTML = renderEmptyStateMarkup(
        "fa-regular fa-calendar-plus",
        "Noch keine Vorschlaege eingegangen",
        "Die Matrix bleibt bewusst schlank. Die ersten Eintraege tauchen direkt in der Uebersicht auf."
      );
      summaryEmpty.classList.remove("is-hidden");
    }
    return;
  }

  if (responses.length === 0) {
    summaryEmpty.innerHTML = renderEmptyStateMarkup(
      "fa-regular fa-comments",
      "Noch keine Antworten eingegangen",
      "Die Matrix fuellt sich automatisch, sobald die ersten Personen abstimmen."
    );
    summaryEmpty.classList.remove("is-hidden");
  }
}

function formatResponseCountLabel(count) {
  return count === 1 ? "1 Antwort" : `${count} Antworten`;
}

function formatVoteCountLabel(count) {
  return count === 1 ? "1 Stimme" : `${count} Stimmen`;
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
                        <option value="${date}" ${date === defaultDate ? "selected" : ""}>${escapeHtml(
                          formatDateLong(date)
                        )}</option>
                      `
                    )
                    .join("")
                : '<option value="">Kein Datum verfuegbar</option>'
            }
          </select>
          <button id="owner-export-ics" class="ghost-button wide-button" type="button" ${
            exportDates.length === 0 ? "disabled" : ""
          }>ICS herunterladen</button>
        </div>
      </div>

      <button id="owner-delete-poll" class="settings-action danger-button" type="button">
        <span class="settings-action-copy">
          <span class="settings-action-title">Loeschen</span>
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
    if (!confirm("Umfrage wirklich loeschen?")) {
      return;
    }

    try {
      setFeedback(document.querySelector("#response-feedback"), "Umfrage wird geloescht ...");
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
  const form = document.querySelector("#response-form");
  const submitButton = document.querySelector("#submit-response-button");

  if (!grid || !legend || !panel || !cta || !form || !submitButton) {
    return;
  }

  if (!state.auth.user) {
    panel.classList.add("is-hidden");
    cta.classList.add("is-hidden");
    form.reset();
    grid.innerHTML = "";
    legend.classList.add("is-hidden");
    return;
  }

  panel.classList.remove("is-hidden");
  cta.classList.remove("is-hidden");
  renderParticipantIdentity();
  updatePollResponseCta();
  syncPollResponsePanelState();
  grid.innerHTML = "";

  const participant = getCurrentParticipantState();
  const canRespond = participant.canVote && !participant.isBlocked;
  cta.disabled = !canRespond;
  cta.classList.toggle("is-disabled", !canRespond);
  submitButton.disabled = !canRespond;
  submitButton.classList.toggle("is-disabled", !canRespond);

  if (!canRespond) {
    legend.classList.add("is-hidden");
    grid.innerHTML = renderEmptyStateMarkup(
      participant.isBlocked ? "fa-solid fa-user-lock" : "fa-solid fa-ban",
      participant.isBlocked ? "Du bist fuer diese Umfrage gesperrt" : "Deine Teilnahme ist aktuell deaktiviert",
      participant.isBlocked
        ? "Der Ersteller hat deine Teilnahme an dieser Umfrage blockiert."
        : "Der Ersteller hat deine Stimmabgabe voruebergehend deaktiviert."
    );
    return;
  }

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
  const intro = document.createElement("div");
  intro.className = "free-mode-intro";
  intro.innerHTML = `
    <div>
      <strong>Waehle alle Tage, an denen du kannst</strong>
      <p class="description">Du kannst beliebige Tage im Kalender markieren, auch in anderen Monaten oder Jahren.</p>
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
        <button id="participant-next-month" class="ghost-button compact-button" type="button" aria-label="Naechster Monat">
          <i class="fa-solid fa-chevron-right"></i>
        </button>
      </div>
    </div>
    <div id="participant-calendar-grid" class="calendar-grid" aria-live="polite"></div>
    <div class="selected-dates-box">
      <div class="selected-header">
        <span>Deine gewaehlten Tage</span>
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
    container.innerHTML = renderEmptyStateMarkup(
      "fa-regular fa-hand-point-up",
      "Noch keine Tage ausgewaehlt",
      "Markiere ein paar Optionen im Kalender, dann siehst du sie hier als schnelle Badge-Liste."
    );
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

function renderResultsTable() {
  const { poll, responses, results } = state.pollData;
  const head = document.querySelector("#results-head");
  const body = document.querySelector("#results-body");
  const foot = document.querySelector("#results-foot");
  const table = document.querySelector(".results-table");
  const editableResponse = getEditableResponse();
  const showEditIcon = Boolean(editableResponse) && hasEditableResponse();

  table.classList.toggle("free-choice-matrix", poll.mode === "free");
  table.classList.toggle("fixed-choice-matrix", poll.mode === "fixed");

  if (poll.mode === "free") {
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
              "Sobald die ersten Antworten eingehen, siehst du hier sofort die Verfuegbarkeits-Matrix."
            )}
          </td>
        </tr>
      `;
      return;
    }

    body.innerHTML = responses
      .map((response) => {
        const pickedDates = new Set(response.suggestedDates || []);
        const items = matrixDates
          .map((entry) => {
            const isAvailable = pickedDates.has(entry.date);
            return `
              <td class="matrix-cell ${isAvailable ? "is-available" : ""}" title="${escapeHtml(
                `${response.name}: ${isAvailable ? "Ja" : "Nein"} fuer ${formatDateLong(entry.date)}`
              )}">
                ${
                  isAvailable
                    ? '<i class="fa-solid fa-check matrix-check" aria-label="Ja"></i>'
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
              <button class="matrix-edit-button" type="button" data-response-id="${response.id}" aria-label="Eigene Verfuegbarkeit bearbeiten">
                <i class="fa-solid fa-pen-to-square" aria-hidden="true"></i>
              </button>
            `
            : ""
        }
        ${
          canManage
            ? `
              <select class="veto-dropdown veto-dropdown-inline" data-response-id="${response.id}" aria-label="Veto fuer ${escapeHtml(name)}">
                <option value="none" ${response.hasVeto ? "" : "selected"}>Kein Veto</option>
                <option value="veto" ${response.hasVeto ? "selected" : ""}>Veto</option>
              </select>
              <button class="matrix-delete-button" type="button" data-response-id="${response.id}" aria-label="Antwort loeschen">
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
  const isFixed = state.pollData.poll.mode === "fixed";
  const payload = {};

  if (isFixed) {
    payload.availabilities = state.responseDraft;
  } else {
    payload.suggestedDates = Array.from(state.participantSelectedDates).sort();
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
    setFeedback(document.querySelector("#response-feedback"), "Noch kein exportierbarer Termin verfuegbar.", "error");
    return;
  }
  const query = exportDate ? `?date=${encodeURIComponent(exportDate)}` : "";
  window.open(`/api/polls/${poll.id}/ics${query}`, "_blank", "noopener");
}

function getPollExportDates(poll) {
  if (!poll) {
    return [];
  }

  if (poll.mode === "fixed") {
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
  return [...(summary || [])].sort((left, right) => left.date.localeCompare(right.date));
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

function getPollFavorite(poll, responses, results) {
  if (!responses?.length) {
    return null;
  }

  if (poll.mode === "fixed") {
    const { winnerEntry } = getFixedDateStats(poll.dates, responses);
    return winnerEntry ? { date: winnerEntry.date, votes: winnerEntry.yes, score: winnerEntry.score } : null;
  }

  const favorite = (results?.bestDates || [])
    .slice()
    .sort((left, right) => left.date.localeCompare(right.date))[0];
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

  const confirmed = confirm("Diese Antwort wirklich loeschen?");
  console.log("[Delete] Dialog confirmed:", confirmed);

  if (!confirmed) {
    console.debug("[Delete] Cancelled by user", { responseId });
    return;
  }

  const feedback = document.querySelector("#response-feedback");
  const pollId = state.pollData?.poll?.id;
  if (!pollId) {
    const error = new Error("Poll-ID fehlt. Antwort kann nicht geloescht werden.");
    console.error("[Delete] Error:", error);
    throw error;
  }

  try {
    console.log("[Delete] API call starting...");
    setFeedback(feedback, "Antwort wird geloescht ...");

    const data = await apiFetch(`/api/polls/${pollId}/responses/${encodeURIComponent(responseId)}`, {
      method: "DELETE",
    });

    console.log("[Delete] API response:", 200);

    if (!data?.poll || !Array.isArray(data.responses)) {
      throw new Error("Unerwartete Server-Antwort nach dem Loeschen.");
    }

    state.pollData = data;

    console.log("[Delete] Success, re-rendering...");
    refreshPollView();

    setFeedback(feedback, "Antwort geloescht.", "success");
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
    throw new Error("Kein Share-Link verfuegbar.");
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
