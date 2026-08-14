// client/js/lobby.js
'use strict';

/* ================================================================
   CONSTANTES
   ================================================================ */

/** Código de sala: sólo letras mayúsculas y números (sin caracteres ambiguos) */
const CODE_RE  = /^[A-Z0-9]+$/;

const COOKIE_KEY  = 'continental_nombre';
const ACTIVE_LOBBY_KEY = 'continental_active_lobby';
const ACTIVE_GAME_KEY = 'continental_active_game';
const GUIDE_ENABLED_KEY = 'continental_guide_enabled';
const GUIDE_DONE_LOBBY_SETUP_KEY = 'continental_guide_done_lobby_setup';
const GUIDE_DONE_LOBBY_ROOM_KEY = 'continental_guide_done_lobby_room';

/* ================================================================
   ESTADO DEL MÓDULO
   ================================================================ */
let maxPlayers  = 4;
let roomPublic  = false;
let roomApuesta = false;
let roomAnte    = 100;
let myChips     = 0;
let publicRooms = [];
let myRoomPublic = false;
let myRoomApuesta = false;
let myId        = null;
let myCode      = null;
let mySeatToken = null;
let isHost      = false;
let playersList = [];
let currentTableColor = 'green';
let musicPlaying = false;
let musicAudio = null;
let lobbyActionPending = false;
let guideAutoTimer = null;
let guideState = { active: false, steps: [], index: 0, doneKey: null, restoreTab: null };

function setLobbyActionPending (pending) {
  lobbyActionPending = pending;

  const createBtn = document.getElementById('btn-create-room');
  const joinBtn = document.getElementById('btn-join-room');

  if (createBtn) createBtn.disabled = pending;
  if (joinBtn) joinBtn.disabled = pending;
}

function saveActiveLobbySession () {
  if (!myCode || !myId) return;
  sessionStorage.setItem(ACTIVE_LOBBY_KEY, JSON.stringify({
    code: myCode,
    playerId: myId,
    seatToken: mySeatToken,
    isHost,
  }));
}

function getActiveLobbySession () {
  try {
    return JSON.parse(sessionStorage.getItem(ACTIVE_LOBBY_KEY) || 'null');
  } catch (_) {
    return null;
  }
}

function clearActiveLobbySession () {
  sessionStorage.removeItem(ACTIVE_LOBBY_KEY);
}

function getActiveGameSession () {
  try {
    const active = JSON.parse(localStorage.getItem(ACTIVE_GAME_KEY) || 'null');
    const usuario = JSON.parse(localStorage.getItem('usuario') || 'null');
    if (!active?.code || !active?.playerId) return null;
    if (active.userId && usuario?.id && active.userId !== usuario.id) return null;
    return active;
  } catch (_) {
    return null;
  }
}

function clearActiveGameSession () {
  localStorage.removeItem(ACTIVE_GAME_KEY);
}

function renderActiveGameCard () {
  const card = document.getElementById('resume-game-card');
  const roomEl = document.getElementById('resume-game-room');
  const detailEl = document.getElementById('resume-game-detail');
  if (!card || !roomEl || !detailEl) return;

  const active = getActiveGameSession();
  if (!active) {
    card.classList.remove('show');
    return;
  }

  roomEl.textContent = `Sala ${active.code}`;
  detailEl.textContent = `Tu mesa sigue activa${active.ronda ? ` · ronda ${active.ronda}` : ''}. Puedes volver a entrar con tu mismo asiento.`;
  card.classList.add('show');
}

function resumeActiveGame () {
  const active = getActiveGameSession();
  if (!active?.code || !active?.playerId) {
    clearActiveGameSession();
    renderActiveGameCard();
    toast('No hay una mesa activa para reconectar.');
    return;
  }
  const color = active.color || sessionStorage.getItem('tableColor') || 'green';
  window.location.href = `/game?code=${active.code}&pid=${active.playerId}&seat=${active.seatToken || ''}&color=${color}`;
}

function rejoinActiveLobbyIfNeeded () {
  const active = getActiveLobbySession();
  if (!active?.code || !active?.playerId) return;

  myCode = active.code;
  myId = active.playerId;
  mySeatToken = active.seatToken || null;
  isHost = !!active.isHost;

  const nombre = (window.getAuthNombre ? window.getAuthNombre() : '') || getCookie(COOKIE_KEY);
  const usuario = JSON.parse(localStorage.getItem('usuario') || 'null');
  const userId = usuario?.id || null;

  if (!nombre) return;

  console.log('[LOBBY] rejoin automático', { code: myCode, playerId: myId, isHost });
  WS.send({ type: 'join_room', nombre, userId, code: myCode, playerId: myId, seatToken: mySeatToken });
}

/* ================================================================
   COOKIES
   ================================================================ */
function getCookie (key) {
  const match = document.cookie.match(new RegExp('(?:^|; )' + key + '=([^;]*)'));
  return match ? decodeURIComponent(match[1]) : '';
}

/* ================================================================
   VALIDACIÓN / SANITIZACIÓN
   ================================================================ */

/**
 * Limpia un input de código de sala:
 * - Solo letras y números (sin guiones ni especiales)
 * - Convierte a mayúsculas
 */
function sanitizeCode (input) {
  const raw   = input.value;
  const clean = raw.toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (raw !== clean || input.value !== clean) input.value = clean;
  hideHint('unirse-code');
}

/** Muestra un hint de error bajo un campo */
function showHint (id, msg) {
  const el = document.getElementById('hint-' + id);
  if (!el) return;
  el.textContent = msg;
  el.classList.add('show');
}

function hideHint (id) {
  const el = document.getElementById('hint-' + id);
  if (el) el.classList.remove('show');
}

/** Valida código de sala, retorna true si es válido */
function validateCode (value) {
  const v = value.trim().toUpperCase();
  if (!v || v.length < 4) {
    showHint('unirse-code', 'Ingresa el código de sala (4-5 caracteres).');
    return false;
  }
  if (!CODE_RE.test(v)) {
    showHint('unirse-code', 'Solo letras y números.');
    return false;
  }
  hideHint('unirse-code');
  return true;
}

/* ================================================================
   TABS / MODO / JUGADORES
   ================================================================ */
function switchTab (t) {
  document.querySelectorAll('.tab').forEach((el, i) =>
    el.classList.toggle('active', (i === 0 && t === 'crear') || (i === 1 && t === 'unirse'))
  );
  document.getElementById('panel-crear').classList.toggle('active', t === 'crear');
  document.getElementById('panel-unirse').classList.toggle('active', t === 'unirse');
}

function chgMax (d) {
  maxPlayers = Math.max(2, Math.min(5, maxPlayers + d));
  document.getElementById('max-val').textContent = maxPlayers;
  updateHotBadge();
}

function updateHotBadge () {
  const badge = document.getElementById('hot-badge');
  if (badge) badge.style.display = maxPlayers === 5 ? 'inline-flex' : 'none';
}

/* ================================================================
   VISIBILIDAD DE SALA (pública / privada)
   ================================================================ */
function setRoomPublic (v) {
  roomPublic = !!v;
  document.getElementById('seg-publica')?.classList.toggle('active', roomPublic);
  document.getElementById('seg-privada')?.classList.toggle('active', !roomPublic);
}

/* ================================================================
   APUESTAS (mesas con fichas)
   ================================================================ */
const ANTE_MIN = 2;
const ANTE_MAX = 10000;

function setRoomApuesta (v) {
  roomApuesta = !!v;
  document.getElementById('seg-conapuesta')?.classList.toggle('active', roomApuesta);
  document.getElementById('seg-sinapuesta')?.classList.toggle('active', !roomApuesta);
  document.getElementById('bet-info')?.style.setProperty('display', roomApuesta ? 'flex' : 'none');
  syncBetCreateState();
}

// La apuesta por ronda debe ser múltiplo de 2: la mitad va al ganador
// de ronda y la otra mitad a la banca.
function setRoomAnte (raw) {
  const n = Math.floor(Number(raw));
  const input = document.getElementById('bet-ante');
  const hint  = document.getElementById('bet-ante-hint');
  const anteInfo = document.getElementById('bet-info-ante');

  const valido = Number.isFinite(n) && n >= ANTE_MIN && n <= ANTE_MAX && n % 2 === 0;
  roomAnte = valido ? n : roomAnte;

  input?.classList.toggle('invalid', !valido);
  if (hint) {
    hint.textContent = valido
      ? `múltiplo de 2 (${(n / 2).toLocaleString('es-MX')} por mitad)`
      : 'debe ser un número par entre 2 y 10.000';
    hint.classList.toggle('invalid', !valido);
  }
  if (anteInfo) {
    anteInfo.innerHTML = valido
      ? `<i class="ph ph-coins"></i> Cada quien apuesta <strong>${fmtChips(n)}</strong> por ronda: <strong>${fmtChips(n / 2)}</strong> al ganador de ronda y <strong>${fmtChips(n / 2)}</strong> a la banca.`
      : anteInfo.innerHTML;
  }
  syncBetCreateState();
}

function syncBetCreateState () {
  const btn = document.getElementById('btn-create-room');
  if (!btn) return;
  const chipsEl = document.getElementById('bet-my-chips');
  if (chipsEl) chipsEl.innerHTML = `<i class="ph ph-wallet"></i>Tus fichas: <strong>${fmtChips(myChips)}</strong> (mínimo ${fmtChips(roomAnte)})`;
  if (chipsEl) chipsEl.classList.toggle('warn', myChips < roomAnte);

  if (roomApuesta && myChips < roomAnte) {
    btn.disabled = true;
    btn.innerHTML = `<i class="ph ph-coins"></i>Necesitas ${fmtChips(roomAnte)} fichas`;
  } else {
    btn.disabled = false;
    btn.innerHTML = '<i class="ph ph-play-fill"></i>Crear Sala';
  }
}

function fmtChips (n) {
  return Number(n || 0).toLocaleString('es-MX');
}

function refreshChips () {
  const token = localStorage.getItem('token');
  const usuario = JSON.parse(localStorage.getItem('usuario') || 'null');
  if (!token) return;
  fetch('/api/me', { headers: { Authorization: `Bearer ${token}` } })
    .then(r => r.json())
    .then(d => {
      if (!d?.usuario) return;
      const u = d.usuario;
      myChips = Number(u.chips ?? myChips);
      const stored = JSON.parse(localStorage.getItem('usuario') || '{}');
      localStorage.setItem('usuario', JSON.stringify({ ...stored, chips: myChips, ...u }));
      const chipsEl = document.getElementById('user-chips');
      if (chipsEl) chipsEl.textContent = fmtChips(myChips);
      syncBetCreateState();
    })
    .catch(() => {});
}

/* ================================================================
   EXPLORAR MESAS PÚBLICAS
   ================================================================ */
function openRoomsBrowser () {
  const ov = document.getElementById('rooms-overlay');
  if (!ov) return;
  renderRoomsList(publicRooms, true);
  ov.classList.add('show');
  WS.send({ type: 'list_rooms' });
}

function closeRoomsBrowser () {
  document.getElementById('rooms-overlay')?.classList.remove('show');
}

function refreshRoomsBrowser () {
  WS.send({ type: 'list_rooms' });
}

/* ── Novedades (changelog) ─────────────────────────────── */
const CHANGELOG_SEEN_KEY = 'continental_changelog_seen';
let changelogEntries = [];
let changelogLatest = null;

function getSeenChangelog () {
  return new Set((localStorage.getItem(CHANGELOG_SEEN_KEY) || '').split(',').filter(Boolean));
}

async function initChangelog () {
  try {
    const res = await fetch('/changelog.json', { cache: 'no-store' });
    if (!res.ok) return;
    const data = await res.json();
    changelogEntries = Array.isArray(data) ? data : [];
    if (!changelogEntries.length) return;
    changelogLatest = changelogEntries[0].version;
    const seen = getSeenChangelog();
    const unread = changelogEntries.some(e => !seen.has(e.version));
    const badge = document.getElementById('news-badge');
    if (badge) badge.style.display = unread ? 'block' : 'none';
    if (!localStorage.getItem(CHANGELOG_SEEN_KEY) && localStorage.getItem(WELCOME_SEEN_KEY)) {
      setTimeout(openChangelog, 600);
    }
  } catch {}
}

function renderChangelog () {
  const list = document.getElementById('changelog-list');
  if (!list) return;
  if (!changelogEntries.length) {
    list.innerHTML = '<div class="rooms-empty">No hay novedades todavía.</div>';
    return;
  }
  const seen = getSeenChangelog();
  const latest = changelogEntries[0]?.version;
  list.innerHTML = changelogEntries.map((e, i) => {
    const isNew = e.version === latest && !seen.has(e.version);
    return `
      <div class="changelog-entry ${isNew ? 'new' : ''}" style="animation-delay:${Math.min(i * 50, 400)}ms">
        <div class="changelog-ver">
          <span>${esc(e.version)}</span>
          ${isNew ? '<span class="changelog-tag">Nuevo</span>' : ''}
          <span class="changelog-date">${esc(e.fecha || '')}</span>
        </div>
        <div class="changelog-titulo">${esc(e.titulo || '')}</div>
        <ul>${(e.cambios || []).map(c => `<li>${esc(c)}</li>`).join('')}</ul>
      </div>`;
  }).join('');
}

function openChangelog () {
  renderChangelog();
  const ov = document.getElementById('changelog-overlay');
  if (!ov) return;
  ov.classList.add('show');
  if (changelogLatest) {
    const seen = getSeenChangelog();
    changelogEntries.forEach(e => seen.add(e.version));
    localStorage.setItem(CHANGELOG_SEEN_KEY, [...seen].join(','));
  }
  const badge = document.getElementById('news-badge');
  if (badge) badge.style.display = 'none';
}

function closeChangelog () {
  document.getElementById('changelog-overlay')?.classList.remove('show');
}

function renderRoomsList (rooms, loading = false) {
  const list = document.getElementById('rooms-list');
  if (!list) return;
  if (loading && rooms.length === 0) {
    list.innerHTML = '<div class="rooms-empty">Cargando mesas…</div>';
    return;
  }
  if (rooms.length === 0) {
    list.innerHTML = '<div class="rooms-empty">No hay mesas públicas abiertas ahora mismo.<br>Crea una con <i class="ph ph-eye"></i><strong>Pública</strong> y déjala aparecer aquí.</div>';
    return;
  }
  const tableColorName = { green: 'Verde', navy: 'Azul', wine: 'Vino', black: 'Negro' };
  list.innerHTML = rooms.map((r, i) => {
    const full = r.playerCount >= r.maxPlayers;
    const rAnte = r.ante || 100;
    const sinFichas = r.conApuesta && myChips < rAnte;
    const delay = Math.min(i * 60, 500);
    const meta = `
      <span>${r.playerCount}/${r.maxPlayers} jugadores</span>
      <span class="room-table-dot" data-color="${r.tableColor}" style="display:inline-block;width:8px;height:8px;border-radius:50%"></span>
      <span>${tableColorName[r.tableColor] || 'Verde'}</span>
      ${r.conApuesta ? `<span class="room-bet-tag ${sinFichas ? 'warn' : ''}"><i class="ph ph-coins"></i>${sinFichas ? `Necesitas ${fmtChips(rAnte)}` : `Apuesta ${fmtChips(rAnte)}/rd`}</span>` : ''}
      ${r.hot ? '<span class="room-flame"><i class="ph ph-fire"></i>Caliente</span>' : ''}
    `;
    return `
      <div class="room-row ${full ? 'full' : ''}" style="animation-delay:${delay}ms">
        <div class="room-info">
          <div class="room-host"><i class="ph ph-user-circle"></i> ${esc(r.host)}</div>
          <div class="room-meta">${meta}</div>
        </div>
        <div class="room-join">
          ${full
            ? '<button class="btn btn-hub" disabled style="background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.1);color:var(--text-dim)">Llena</button>'
            : (sinFichas
              ? `<button class="btn btn-hub" disabled style="background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.1);color:var(--text-dim)" title="Necesitas al menos ${fmtChips(rAnte)} fichas">Sin fichas</button>`
              : `<button class="btn btn-hub btn-hub--ghost" onclick="joinPublicRoom('${r.code}')"><i class="ph ph-sign-in"></i>Unirse</button>`)}
        </div>
      </div>`;
  }).join('');
}

function joinPublicRoom (code) {
  closeRoomsBrowser();
  const input = document.getElementById('unirse-code');
  if (input) input.value = code;
  unirse();
}

function esc (s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

/* ================================================================
   ACCIONES DE LOBBY
   ================================================================ */
/* ================================================================
   COLOR DE MESA
   ================================================================ */
function setMesaColor (color) {
  currentTableColor = color;
  document.querySelectorAll('.mesa-swatch').forEach(s => {
    s.classList.toggle('active', s.dataset.color === color);
  });
  WS.send({ type: 'set_table_color', color });
}

/* ================================================================
   MÚSICA
   ================================================================ */
// Jazz de casino - usamos una URL pública de stream libre
function initMusic () {
  musicAudio = new Audio('https://files.catbox.moe/bs0qiq.mp3');
  musicAudio.loop = true;
  musicAudio.volume = 0.25;
}

function toggleMusic () {
  if (!musicAudio) initMusic();
  if (musicPlaying) {
    musicAudio.pause();
    musicPlaying = false;
    document.getElementById('music-toggle').innerHTML = '<i class="ph ph-play"></i><span>Play</span>';
  } else {
    musicAudio.play().catch(() => {});
    musicPlaying = true;
    document.getElementById('music-toggle').innerHTML = '<i class="ph ph-pause"></i><span>Pausa</span>';
  }
}

function setVolume (val) {
  if (musicAudio) musicAudio.volume = val / 100;
}

function copyCode () {
  navigator.clipboard?.writeText(myCode);
  toast('¡Código copiado!', 'green');
}

function isGuideEnabled () {
  return localStorage.getItem(GUIDE_ENABLED_KEY) === '1';
}

function setGuideEnabled (enabled) {
  if (enabled) localStorage.setItem(GUIDE_ENABLED_KEY, '1');
  else localStorage.removeItem(GUIDE_ENABLED_KEY);
  syncGuidePreferenceUi();
}

function syncGuidePreferenceUi () {
  const enabled = isGuideEnabled();
  const btn = document.getElementById('btn-guide');
  const toggle = document.getElementById('guide-auto-toggle');
  const status = document.getElementById('guide-settings-status');

  if (btn) {
    btn.innerHTML = enabled ? '<i class="ph ph-books"></i><span>Guía ON</span>' : '<i class="ph ph-books"></i><span>Guía OFF</span>';
    btn.style.borderColor = enabled ? 'rgba(200,160,69,.42)' : 'rgba(255,255,255,.15)';
    btn.style.color = enabled ? 'var(--gold)' : 'var(--text-dim)';
  }
  if (toggle) toggle.checked = enabled;
  if (status) {
    status.textContent = enabled
      ? 'La guía se abrirá automáticamente una vez en lobby y otra al entrar a la partida. También puedes relanzarla manualmente.'
      : 'La guía solo se abrirá cuando la pidas desde este botón.';
  }
}

function openGuideSettings () {
  syncGuidePreferenceUi();
  document.getElementById('guide-settings-overlay')?.classList.add('show');
}

function closeGuideSettings () {
  document.getElementById('guide-settings-overlay')?.classList.remove('show');
}

/* ── Bienvenida primera visita ─────────────────────────── */
const WELCOME_SEEN_KEY = 'continental_welcome_seen';

function maybeShowWelcome () {
  if (localStorage.getItem(WELCOME_SEEN_KEY)) return;
  const ov = document.getElementById('welcome-overlay');
  if (ov) setTimeout(() => ov.classList.add('show'), 1200);
}

function dismissWelcome () {
  localStorage.setItem(WELCOME_SEEN_KEY, '1');
  document.getElementById('welcome-overlay')?.classList.remove('show');
}

function startWelcomeGuide () {
  localStorage.setItem(WELCOME_SEEN_KEY, '1');
  setGuideEnabled(true);
  document.getElementById('welcome-overlay')?.classList.remove('show');
  startGuideFromSettings();
}

function toggleGuideAuto (checked) {
  setGuideEnabled(checked);
}

function startGuideFromSettings () {
  closeGuideSettings();
  startCurrentGuide();
}

function isVisibleGuideTarget (el) {
  return !!(el && el.getClientRects && el.getClientRects().length);
}

function getCurrentGuideConfig () {
  const inRoom = document.getElementById('lobby-room')?.classList.contains('show');

  if (inRoom) {
    return {
      doneKey: GUIDE_DONE_LOBBY_ROOM_KEY,
      steps: [
        {
          selector: '#room-code-display',
          title: 'Código de sala',
          text: 'Este código se comparte para que los demás entren a tu misma mesa. Con un clic lo copias.',
        },
        {
          selector: '#player-list',
          title: 'Jugadores conectados',
          text: 'Aquí ves quién ya entró, quién es host y quién se desconectó temporalmente.',
        },
        {
          selector: () => document.getElementById('mesa-picker-wrap')?.style.display !== 'none'
            ? document.getElementById('mesa-picker-wrap')
            : document.querySelector('.music-bar'),
          title: 'Opciones de espera',
          text: 'El host puede cambiar el color de la mesa. Mientras esperan, todos pueden ajustar la música.',
        },
        {
          selector: () => document.getElementById('btn-start')?.style.display !== 'none'
            ? document.getElementById('btn-start')
            : document.getElementById('waiting-msg'),
          title: 'Inicio de partida',
          text: 'Cuando haya suficientes jugadores, el host verá aquí el botón para iniciar. Si no eres host, esta zona te indica el estado de espera.',
        },
      ],
    };
  }

  return {
    doneKey: GUIDE_DONE_LOBBY_SETUP_KEY,
    steps: [
      {
        selector: '.hub-title',
        title: 'Bienvenido al lobby',
        text: 'Esta es tu mesa de mando. Desde la izquierda navegas y a la derecha creas o te unes a una sala.',
      },
      {
        selector: '.hub-grid',
        title: 'Crear o unirte',
        text: 'Elige entre crear una sala nueva o entrar con un código. A un lado tienes un resumen rápido del juego.',
      },
      {
        selector: '#panel-crear',
        title: 'Crear sala',
        text: 'Aquí eliges el modo de juego, el número máximo de jugadores y luego creas la sala.',
      },
      {
        selector: '#btn-create-room',
        title: 'Crear en un toque',
        text: 'Este botón arma la sala y te mete directo a la espera para compartir el código.',
      },
      {
        selector: '#unirse-code',
        before: () => switchTab('unirse'),
        title: 'Unirse con código',
        text: 'Si un amigo ya creó la sala, pega aquí el código y entra sin configurar nada más.',
      },
    ],
  };
}

function resolveGuideTarget (step) {
  const target = typeof step.selector === 'function' ? step.selector() : document.querySelector(step.selector);
  return isVisibleGuideTarget(target) ? target : null;
}

function positionGuideCard (rect) {
  const card = document.getElementById('guide-card');
  if (!card) return;

  const margin = 12;
  const cardWidth = Math.min(360, window.innerWidth - (margin * 2));
  const desiredLeft = rect.left + (rect.width / 2) - (cardWidth / 2);
  const left = Math.max(margin, Math.min(window.innerWidth - cardWidth - margin, desiredLeft));
  card.style.width = `${cardWidth}px`;

  const cardHeight = card.offsetHeight || 210;
  const belowTop = rect.bottom + 14;
  const aboveTop = rect.top - cardHeight - 14;
  const top = (belowTop + cardHeight <= window.innerHeight - margin || aboveTop < margin)
    ? Math.min(window.innerHeight - cardHeight - margin, belowTop)
    : Math.max(margin, aboveTop);

  card.style.left = `${left}px`;
  card.style.top = `${top}px`;
}

function renderGuideStep () {
  if (!guideState.active) return;

  const step = guideState.steps[guideState.index];
  if (!step) {
    finishGuide();
    return;
  }

  if (typeof step.before === 'function') step.before();

  requestAnimationFrame(() => {
    const target = resolveGuideTarget(step);
    if (!target) {
      nextGuideStep();
      return;
    }

    const rect = target.getBoundingClientRect();
    const focus = document.getElementById('guide-focus');
    const title = document.getElementById('guide-title');
    const text = document.getElementById('guide-text');
    const progress = document.getElementById('guide-progress');
    const nextBtn = document.getElementById('guide-next-btn');

    focus.style.left = `${Math.max(8, rect.left - 8)}px`;
    focus.style.top = `${Math.max(8, rect.top - 8)}px`;
    focus.style.width = `${Math.min(window.innerWidth - 16, rect.width + 16)}px`;
    focus.style.height = `${rect.height + 16}px`;

    title.textContent = step.title;
    text.textContent = step.text;
    progress.textContent = `Paso ${guideState.index + 1} de ${guideState.steps.length}`;
    nextBtn.textContent = guideState.index === guideState.steps.length - 1 ? 'Terminar' : 'Siguiente';

    positionGuideCard(rect);
  });
}

function startCurrentGuide () {
  const config = getCurrentGuideConfig();
  if (!config.steps.length) {
    toast('No hay guía disponible en esta pantalla.', 'green');
    return;
  }

  guideState = {
    active: true,
    steps: config.steps,
    index: 0,
    doneKey: config.doneKey,
    restoreTab: document.getElementById('panel-crear')?.classList.contains('active') ? 'crear' : 'unirse',
  };
  document.getElementById('guide-overlay')?.classList.add('show');
  renderGuideStep();
}

function closeGuide () {
  if (!document.getElementById('lobby-room')?.classList.contains('show') && guideState.restoreTab) {
    switchTab(guideState.restoreTab);
  }
  guideState.active = false;
  document.getElementById('guide-overlay')?.classList.remove('show');
}

function finishGuide () {
  if (guideState.doneKey) localStorage.setItem(guideState.doneKey, '1');
  closeGuide();
}

function nextGuideStep () {
  if (!guideState.active) return;
  guideState.index += 1;
  if (guideState.index >= guideState.steps.length) {
    finishGuide();
    return;
  }
  renderGuideStep();
}

function queueAutoGuide (delay = 500) {
  clearTimeout(guideAutoTimer);
  guideAutoTimer = setTimeout(() => {
    if (guideState.active || !isGuideEnabled()) return;
    const config = getCurrentGuideConfig();
    if (!config.steps.length) return;
    if (localStorage.getItem(config.doneKey) === '1') return;
    startCurrentGuide();
  }, delay);
}

function refreshGuideLayout () {
  if (guideState.active) renderGuideStep();
}

function toast (msg, type = 'red') {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.style.background = type === 'green' ? 'rgba(40,160,80,.9)' : 'rgba(180,50,50,.9)';
  t.style.display = 'block';
  clearTimeout(t._t);
  t._t = setTimeout(() => (t.style.display = 'none'), 2500);
}

function crearSala () {
  const nombre   = (window.getAuthNombre ? window.getAuthNombre() : '');
  const usuario  = JSON.parse(localStorage.getItem('usuario') || 'null');
  const userId   = usuario?.id || null;
  if (!nombre) { window.location.href = '/login'; return; }
  if (lobbyActionPending) return;
  const anteInput = document.getElementById('bet-ante');
  const anteVal = anteInput ? Math.floor(Number(anteInput.value)) : roomAnte;
  if (roomApuesta) {
    if (!Number.isFinite(anteVal) || anteVal < ANTE_MIN || anteVal > ANTE_MAX || anteVal % 2 !== 0) {
      toast('La apuesta por ronda debe ser un múltiplo de 2 (mitad al ganador, mitad a la banca).', 'red');
      return;
    }
    if (myChips < anteVal) {
      toast(`Necesitas al menos ${fmtChips(anteVal)} fichas para una mesa con apuesta de ${fmtChips(anteVal)}/ronda.`, 'red');
      return;
    }
  }
  setLobbyActionPending(true);
  WS.send({ type: 'create_room', nombre, userId, mode: 'realtime', maxPlayers, public: roomPublic, conApuesta: roomApuesta, ante: roomApuesta ? anteVal : 100 });
}

function unirse () {
  const nombre   = (window.getAuthNombre ? window.getAuthNombre() : '');
  const usuario  = JSON.parse(localStorage.getItem('usuario') || 'null');
  const userId   = usuario?.id || null;
  const cInput   = document.getElementById('unirse-code');
  const code     = cInput.value.trim().toUpperCase();
  if (!nombre) { window.location.href = '/login'; return; }
  if (!validateCode(code)) return;
  if (lobbyActionPending) return;
  setLobbyActionPending(true);
  WS.send({ type: 'join_room', nombre, userId, code });
}

function iniciarJuego () {
  WS.send({ type: 'start_game' });
}

function salirDeLaMesa () {
  if (lobbyActionPending) return;
  setLobbyActionPending(true);
  WS.send({ type: 'leave_room' });
}

/* ================================================================
   SALA DE ESPERA
   ================================================================ */
function showLobby (lobbyState, pid, code, host) {
  setLobbyActionPending(false);
  myId   = pid;
  myCode = code;
  isHost = host;
  myRoomPublic = !!lobbyState?.public;
  myRoomApuesta = !!lobbyState?.conApuesta;
  const myRoomAnte = Number(lobbyState?.ante) || 100;
  saveActiveLobbySession();

  document.getElementById('lobby-setup').style.display = 'none';
  const lr = document.getElementById('lobby-room');
  lr.classList.add('show');
  document.getElementById('room-code-text').textContent = code;
  // En mesas públicas el código se oculta: se entra desde el lobby
  const codeBox = document.getElementById('room-code-display');
  const hintEl  = document.getElementById('room-code-hint');
  const pubBadge = document.getElementById('room-public-badge');
  const betBadge = document.getElementById('room-bet-badge');
  if (codeBox)  codeBox.style.display = myRoomPublic ? 'none' : '';
  if (pubBadge) pubBadge.style.display = myRoomPublic ? 'inline-flex' : 'none';
  if (betBadge) {
    betBadge.style.display = myRoomApuesta ? 'inline-flex' : 'none';
    betBadge.innerHTML = myRoomApuesta
      ? `<i class="ph ph-coins"></i>Con apuesta · ${fmtChips(myRoomAnte)}/ronda`
      : betBadge.innerHTML;
  }
  if (hintEl)   hintEl.textContent = myRoomPublic
    ? 'Mesa pública · cualquiera puede unirse desde el lobby'
    : 'Comparte este código con tus amigos';
  // Mostrar selector de color solo al host
  const pickerWrap = document.getElementById('mesa-picker-wrap');
  if (pickerWrap) pickerWrap.style.display = host ? 'block' : 'none';
  updateLobbyState(lobbyState);
  queueAutoGuide(650);
}

function updateLobbyState (lobbyState) {
  playersList = lobbyState.players;

  const list = document.getElementById('player-list');
  const BADGES_LOBBY = {
    'owner':         { emoji: '👑', label: 'Owner' },
    'beta_tester':   { emoji: '🧪', label: 'Beta Tester' },
    'early_adopter': { emoji: '🎖️', label: 'Early Adopter' },
    'vip':           { emoji: '⭐', label: 'VIP' },
  };
  const SKIN_AVATAR_BG = {
    'clasico':   'linear-gradient(135deg,#1a3a80,#0d2050)',
    'rojo':      'linear-gradient(135deg,#7a1a1a,#3d0a0a)',
    'obsidiana': 'linear-gradient(135deg,#1a1a1a,#0a0a0a)',
    'esmeralda': 'linear-gradient(135deg,#0d3320,#061a10)',
    'plata':     'linear-gradient(135deg,#8b96a6,#4d5663)',
    'bronce':    'linear-gradient(135deg,#8a5630,#4a2815)',
    'zafiro':    'linear-gradient(135deg,#0b2458,#07122d)',
    'dorado':    'linear-gradient(135deg,#c8a045,#7a5c00)',
    'neon':      'linear-gradient(135deg,#001a33,#003366)',
    'imperial':  'linear-gradient(135deg,#3f0018,#160008)',
    'arcoiris':  'linear-gradient(135deg,#ff4d6d,#ff9f1c,#2ec4b6,#4d96ff)',
    'amatista':  'linear-gradient(135deg,#35105e,#170728)',
    'cobalto':   'linear-gradient(135deg,#0a1e46,#071024)',
    'marfil':    'linear-gradient(135deg,#8a7b63,#4a4134)',
  };
  const SKIN_AVATAR_BORDER = {
    'clasico':   'rgba(255,255,255,.25)',  'rojo':    'rgba(255,100,100,.4)',
    'obsidiana': 'rgba(200,160,69,.4)',    'esmeralda':'rgba(46,204,113,.4)',
    'plata':     'rgba(225,235,245,.6)',   'bronce':  'rgba(206,139,85,.55)',
    'zafiro':    'rgba(93,152,255,.6)',    'dorado':  'rgba(200,160,69,.7)',
    'neon':      'rgba(0,200,255,.6)',     'imperial':'rgba(255,133,183,.6)',
    'arcoiris':  'rgba(255,255,255,.72)',  'amatista':'rgba(186,132,255,.65)',
    'cobalto':   'rgba(88,151,255,.62)',   'marfil':  'rgba(240,225,194,.62)',
  };
  list.innerHTML = playersList.map((p, i) => {
    const badge = p.badge && BADGES_LOBBY[p.badge] ? BADGES_LOBBY[p.badge] : null;
    const av = badge ? badge.emoji : (p.nombre.trim()[0] || '?').toUpperCase();
    return `
    <div class="player-item">
      <div class="player-avatar" title="${badge ? badge.label : ''}" style="background:${SKIN_AVATAR_BG[p.skin] || SKIN_AVATAR_BG.clasico};border-color:${SKIN_AVATAR_BORDER[p.skin] || 'rgba(255,255,255,.25)'}">${av}</div>
      <span class="player-name">${escHtml(p.nombre)}</span>${p.titulo && (window.TITULOS || {})[p.titulo] ? ` <span class="titulo-chip">${window.TITULOS[p.titulo].label}</span>` : ''}
      ${i === 0 ? '<span class="player-badge">HOST</span>' : ''}
      <div class="player-dot ${p.conectado ? '' : 'away'}" title="${p.conectado ? 'Conectado' : 'Desconectado'}"></div>
    </div>`;
  }).join('');

  const canStart = playersList.length >= 2 && lobbyState.status === 'lobby';
  const btn      = document.getElementById('btn-start');
  const soyHost  = playersList.length > 0 && myId && playersList[0].id === myId;
  btn.style.display = canStart && soyHost ? 'block' : 'none';

  // Si el host sale, el siguiente jugador toma el rol
  if (isHost !== soyHost) {
    isHost = soyHost;
    const pickerWrap = document.getElementById('mesa-picker-wrap');
    if (pickerWrap) pickerWrap.style.display = soyHost ? 'block' : 'none';
    if (soyHost) toast('Ahora eres el host de esta mesa.', 'green');
  }

  const waiting = document.getElementById('waiting-msg');
  waiting.innerHTML = canStart
    ? `<span style="color:var(--gold-hi)">${playersList.length} jugadores listos</span>`
    : `Esperando jugadores<span class="dot-pulse"></span>`;
}

/* ================================================================
   EVENTOS DEL SOCKET
   ================================================================ */
function setupSocketEvents () {
  WS.on('_connected', () => {
    const usuario = JSON.parse(localStorage.getItem('usuario') || 'null');
    if (usuario?.id) {
      WS.send({ type: 'identify', userId: usuario.id, nombre: usuario.nombre || '' });
    }
    rejoinActiveLobbyIfNeeded();
  });

  WS.on('_disconnected', () => {
    setLobbyActionPending(false);
  });

  WS.on('room_created', ({ code, playerId, seatToken, lobbyState }) => {
    mySeatToken = seatToken || null;
    showLobby(lobbyState, playerId, code, true);
    localStorage.setItem('cid_' + code, playerId);
    saveActiveLobbySession();
  });

  WS.on('room_joined', ({ code, playerId, seatToken, lobbyState }) => {
    const soyHost = lobbyState?.players?.[0]?.id === playerId;
    mySeatToken = seatToken || null;
    showLobby(lobbyState, playerId, code, soyHost);
    localStorage.setItem('cid_' + code, playerId);
    saveActiveLobbySession();
  });

  WS.on('rooms_list', ({ rooms }) => {
    publicRooms = Array.isArray(rooms) ? rooms : [];
    renderRoomsList(publicRooms);
  });

  WS.on('player_joined', ({ lobbyState }) => {
    if (lobbyState) updateLobbyState(lobbyState);
  });

  WS.on('player_reconnected', ({ lobbyState }) => {
    if (lobbyState) updateLobbyState(lobbyState);
  });

  WS.on('player_disconnected', ({ lobbyState }) => {
    if (lobbyState) updateLobbyState(lobbyState);
  });

  WS.on('player_left', ({ lobbyState }) => {
    if (lobbyState) updateLobbyState(lobbyState);
  });

  WS.on('room_left', () => {
    setLobbyActionPending(false);
    clearActiveLobbySession();
    myCode = null;
    myId   = null;
    mySeatToken = null;
    isHost = false;
    document.getElementById('lobby-room').classList.remove('show');
    document.getElementById('lobby-setup').style.display = 'block';
    toast('Saliste de la mesa.', 'green');
  });

  WS.on('table_color_changed', ({ color, lobbyState }) => {
    currentTableColor = color;
    // Actualizar swatches si el host los ve
    document.querySelectorAll('.mesa-swatch').forEach(s => {
      s.classList.toggle('active', s.dataset.color === color);
    });
    if (lobbyState) updateLobbyState(lobbyState);
    // Guardar en sessionStorage para que game.html lo lea al cargar
    sessionStorage.setItem('tableColor', color);
  });

  WS.on('lobby_state_updated', ({ lobbyState }) => {
    if (lobbyState) updateLobbyState(lobbyState);
  });

  WS.on('profile_updated', ({ profile }) => {
    if (!profile) return;
    try {
      const usuario = JSON.parse(localStorage.getItem('usuario') || 'null');
      if (!usuario) return;
      if (String(usuario.id) !== String(profile.id) && usuario.nombre !== profile.nombre) return;
      const updated = { ...usuario, ...profile, skin: profile.skin || usuario.skin || 'clasico' };
      localStorage.setItem('usuario', JSON.stringify(updated));
      window.AUTH = { ...(window.AUTH || {}), usuario: updated };
      if (typeof window.refreshAuthUi === 'function') window.refreshAuthUi(updated);
      toast('Tu perfil se actualizó.', 'green');
    } catch (_) {}
  });

  WS.on('state_update', ({ event, tableColor }) => {
    if (event === 'game_started' || event === 'nueva_ronda') {
      // El host ya tiene currentTableColor; los demás lo reciben en tableColor del servidor
      const color = tableColor || currentTableColor || 'green';
      currentTableColor = color;
      clearActiveLobbySession();
      sessionStorage.setItem('tableColor', color);
      if (musicAudio) sessionStorage.setItem('musicTime', musicAudio.currentTime);
      sessionStorage.setItem('musicPlaying', musicPlaying ? '1' : '0');
      window.location.href = `/game?code=${myCode}&pid=${myId}&seat=${mySeatToken || ''}&color=${color}`;
    }
  });

  WS.on('error', ({ msg }) => {
    setLobbyActionPending(false);
    if (msg === 'Sala no encontrada.') clearActiveLobbySession();
    toast(msg);
  });

  WS.on('room_closed', ({ msg }) => {
    setLobbyActionPending(false);
    clearActiveLobbySession();
    clearActiveGameSession();
    toast(msg || 'La mesa fue cerrada por administración.');
    setTimeout(() => {
      window.location.href = '/';
    }, 900);
  });
}

/* ================================================================
   INIT
   ================================================================ */
function escHtml (str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function init () {
  syncGuidePreferenceUi();
  renderActiveGameCard();
  updateHotBadge();
  refreshChips();
  syncBetCreateState();
  initChangelog();
  maybeShowWelcome();
  window.addEventListener('resize', refreshGuideLayout);
  window.addEventListener('scroll', refreshGuideLayout, { passive: true });
  setupSocketEvents();
  WS.connect();
  queueAutoGuide(700);

  const qp = new URLSearchParams(window.location.search);
  if (qp.get('open') === 'guia') openGuideSettings();
  else if (qp.get('open') === 'feedback') window.openFeedback?.();
  else if (qp.get('open') === 'mesas') setTimeout(openRoomsBrowser, 400);

  const favColor = localStorage.getItem('continental_mesa_fav');
  if (favColor && ['green', 'navy', 'wine', 'black'].includes(favColor)) {
    currentTableColor = favColor;
    document.querySelectorAll('.mesa-swatch').forEach(s => {
      s.classList.toggle('active', s.dataset.color === favColor);
    });
  }
}

/* Exponer globales que usa el HTML */
window.setMesaColor        = setMesaColor;
window.toggleMusic         = toggleMusic;
window.setVolume           = setVolume;
window.switchTab           = switchTab;
window.chgMax              = chgMax;
window.copyCode            = copyCode;
window.crearSala           = crearSala;
window.unirse              = unirse;
window.iniciarJuego        = iniciarJuego;
window.salirDeLaMesa       = salirDeLaMesa;
window.sanitizeCode        = sanitizeCode;
window.openGuideSettings   = openGuideSettings;
window.closeGuideSettings  = closeGuideSettings;
window.toggleGuideAuto     = toggleGuideAuto;
window.startGuideFromSettings = startGuideFromSettings;
window.closeGuide          = closeGuide;
window.nextGuideStep       = nextGuideStep;
window.resumeActiveGame    = resumeActiveGame;
window.setRoomPublic       = setRoomPublic;
window.setRoomApuesta      = setRoomApuesta;
window.setRoomAnte         = setRoomAnte;
window.openRoomsBrowser    = openRoomsBrowser;
window.closeRoomsBrowser   = closeRoomsBrowser;
window.refreshRoomsBrowser = refreshRoomsBrowser;
window.openChangelog       = openChangelog;
window.closeChangelog      = closeChangelog;
window.dismissWelcome      = dismissWelcome;
window.startWelcomeGuide   = startWelcomeGuide;
window.joinPublicRoom      = joinPublicRoom;

document.addEventListener('DOMContentLoaded', init);