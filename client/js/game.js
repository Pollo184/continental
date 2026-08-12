// client/js/game.js
'use strict';
let castigoEnviado = false;
let pendingCastigo = null;
const params = new URLSearchParams(location.search);
const MY_ID = params.get('pid');
const MY_SEAT = params.get('seat') || '';
const ROOM = params.get('code');
const SUIT_CLS = { '♠': 'blk-s', '♥': 'red-s', '♦': 'red-s', '♣': 'blk-s' };
const REQ_LABELS = {
    1: '2 tercias',
    2: '1 tercia + 1 corrida',
    3: '2 corridas',
    4: '3 tercias',
    5: '2 tercias + 1 corrida',
    6: '2 corridas + 1 tercia',
    7: '3 corridas — sin pagar'
};

const REQ = {
    1: { t: 2, c: 0 },
    2: { t: 1, c: 1 },
    3: { t: 0, c: 2 },
    4: { t: 3, c: 0 },
    5: { t: 2, c: 1 },
    6: { t: 1, c: 2 },
    7: { t: 0, c: 3 }
};

const VN = { 'A':1, '2':2, '3':3, '4':4, '5':5, '6':6, '7':7, '8':8, '9':9, '10':10, 'J':11, 'Q':12, 'K':13 };
const ACTIVE_GAME_KEY = 'continental_active_game';
const GUIDE_ENABLED_KEY = 'continental_guide_enabled';
const GUIDE_DONE_GAME_KEY = 'continental_guide_done_game';
const SESSION_USER = JSON.parse(localStorage.getItem('usuario') || 'null');
const IS_OWNER = SESSION_USER?.rol === 'owner';

let G = null;
let myIdx = -1;
let selId = null;
let ackSent = false;
let intercambioMode = false;
let selectedComodinInfo = null;
let hideHandDuringDeal = true;
let _lastRenderedTurn = null;
let _lastRenderedRound = null;
let _turnJustChanged = false;
let _pendingTurnAlert = false;
let guideAutoTimer = null;
let guideState = { active: false, steps: [], index: 0, doneKey: null };

// Eventos cuyo render SÍ puede coalescerse: son acciones ajenas cuyo feedback
// visual no depende de que el DOM tenga el estado nuevo de inmediato.
const COALESCIBLE_EVENTS = new Set([
    'tomar_mazo', 'tomar_fondo', 'pagar', 'bajar', 'acomodar',
    'reordenar', 'intercambiar_comodin', 'castigo',
]);
let _lastRenderAt = 0;

// Render con coalescing: si ya se rindió en este frame y el evento es de otro
// jugador, se salta el render (el siguiente mensaje lo aplicará). Reduce
// repintados del fieltro cuando varios jugadores actúan seguido.
function renderStateUpdate(event, data) {
    const actorIdx = data?.jugadorIdx;
    const isOpponentEvent = COALESCIBLE_EVENTS.has(event)
        && typeof actorIdx === 'number'
        && actorIdx !== myIdx;
    const now = performance.now();
    if (isOpponentEvent && now - _lastRenderAt < 16) return;
    render();
    _lastRenderAt = now;
}

let buildingCards = new Map(); // slotIndex (string) -> array de cartas completas

function escapeHtml(value) {
    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function isRedSuit(suit) {
    return suit === '♥' || suit === '♦';
}

function renderGuideMiniCards(cards) {
    return cards.map(card => {
        if (card.joker) {
            return '<span class="guide-mini-card joker">🃏</span>';
        }
        const suit = card.suit || '';
        const cls = isRedSuit(suit) ? ' red' : '';
        return `<span class="guide-mini-card${cls}">${escapeHtml(card.rank)}${escapeHtml(suit)}</span>`;
    }).join('');
}

function buildGuideExamples(examples) {
    if (!Array.isArray(examples) || !examples.length) return '';
    return examples.map(example => `
        <div class="guide-example">
            <div class="guide-example-label">${escapeHtml(example.label)}</div>
            <div class="guide-mini-cards">${renderGuideMiniCards(example.cards || [])}</div>
            ${example.caption ? `<div class="guide-example-caption">${escapeHtml(example.caption)}</div>` : ''}
        </div>
    `).join('');
}

function buildGuideTipExamples(examples) {
    if (!Array.isArray(examples) || !examples.length) return '';
    return examples.map(example => `
        <div class="guide-tip-example">
            <div class="guide-tip-example-label">${escapeHtml(example.label)}</div>
            <div class="guide-mini-cards">${renderGuideMiniCards(example.cards || [])}</div>
        </div>
    `).join('');
}

function getRoundRequirementText(ronda) {
    const req = REQ[ronda] || { t: 0, c: 0 };
    const parts = [];
    if (req.t) parts.push(`${req.t} tercia${req.t > 1 ? 's' : ''}`);
    if (req.c) parts.push(`${req.c} corrida${req.c > 1 ? 's' : ''}`);
    if (ronda === 7) parts.push('sin sobrantes al bajarte');
    return parts.join(' + ');
}

function getRoundExampleData(ronda) {
    const needsRun = (REQ[ronda]?.c || 0) > 0;
    const needsSet = (REQ[ronda]?.t || 0) > 0;
    const examples = [];
    if (needsSet) {
        examples.push({
            label: 'Tercia de ejemplo',
            cards: [
                { rank: '7', suit: '♣' },
                { rank: '7', suit: '♥' },
                { rank: '7', suit: '♠' },
            ],
            caption: 'Mismo valor. El palo no importa en una tercia.',
        });
    }
    if (needsRun) {
        examples.push({
            label: 'Corrida de ejemplo',
            cards: [
                { rank: '4', suit: '♥' },
                { rank: '5', suit: '♥' },
                { rank: '6', suit: '♥' },
                { rank: '7', suit: '♥' },
            ],
            caption: 'Mismo palo y en secuencia. No mezcles corazones con tréboles.',
        });
    }
    return examples;
}

function getGuideActionContext() {
    if (!G || myIdx < 0) return null;
    const me = G.jugadores[myIdx];
    if (!me) return null;

    const requirement = getRoundRequirementText(G.ronda);
    const corridaExample = {
        label: 'Corrida válida',
        cards: [
            { rank: '4', suit: '♥' },
            { rank: '5', suit: '♥' },
            { rank: '6', suit: '♥' },
            { rank: '7', suit: '♥' },
        ],
    };
    const terciaExample = {
        label: 'Tercia válida',
        cards: [
            { rank: 'Q', suit: '♣' },
            { rank: 'Q', suit: '♦' },
            { rank: 'Q', suit: '♠' },
        ],
    };
    const intercambios = detectarIntercambiosPosibles();

    if (!isMyTurn()) {
        if (G.estado === 'fase_castigo' && G.castigo_idx === myIdx) {
            return {
                badge: 'Castigo',
                title: 'Tienes prioridad de castigo',
                text: 'Puedes aceptar la carta del fondo y además recibir una carta extra del mazo. Decide antes de que siga el turno.',
            };
        }
        return {
            badge: 'Observa',
            title: `Turno de ${G.jugadores[G.turno]?.nombre || 'otro jugador'}`,
            text: `Mientras esperas, recuerda el requisito de esta ronda: ${requirement}.`,
            examples: getRoundExampleData(G.ronda).slice(0, 1),
        };
    }

    if (G.estado === 'esperando_robo') {
        return {
            badge: 'Paso 1',
            title: me.bajado ? 'Ya estás bajado: roba del mazo' : 'Primero debes robar',
            text: me.bajado
                ? 'Después de bajarte ya no puedes tomar del fondo. En este estado solo robas del mazo.'
                : 'Antes de hacer cualquier otra acción debes tomar del fondo o robar del mazo. Si te bajas después, recuerda que las corridas deben ser del mismo palo.',
            examples: (REQ[G.ronda]?.c || 0) > 0 ? [corridaExample] : [terciaExample],
        };
    }

    if (G.estado === 'fase_castigo') {
        return {
            badge: 'Castigo',
            title: G.castigo_idx === myIdx ? 'Decide si te castigas' : 'Esperando decisión de castigo',
            text: G.castigo_idx === myIdx
                ? 'Si aceptas el castigo tomas la carta del fondo y una extra del mazo. Úsalo cuando esa carta te mejore la jugada.'
                : `Debes esperar a que ${G.jugadores[G.castigo_idx]?.nombre || 'el jugador'} decida.`,
        };
    }

    if (!me.bajado && G.estado === 'esperando_accion') {
        if (me.penalizacion?.activa) {
            return {
                badge: 'Penalización',
                title: 'Aún no puedes bajarte',
                text: `Tienes ${me.penalizacion.turnosRestantes} turno(s) bloqueado(s) para bajar. Aun así puedes preparar la construcción para el siguiente turno.`,
                examples: getRoundExampleData(G.ronda),
            };
        }
        if (slotsListosParaBajar()) {
            return {
                badge: 'Listo',
                title: 'Ya puedes bajarte',
                text: `Cumples el requisito de la ronda ${G.ronda}: ${requirement}. Pulsa Bajarme para confirmar tus jugadas.`,
                examples: getRoundExampleData(G.ronda),
            };
        }
        if (intercambios.length > 0) {
            const ic = intercambios[0];
            return {
                badge: 'Joker',
                title: 'Puedes reclamar un joker',
                text: `Ya robaste y tienes la carta exacta ${ic.cartaValor}${ic.cartaPalo || ''}. Puedes intercambiarla por el joker y completar tu bajada.`,
                examples: [{
                    label: 'Intercambio de ejemplo',
                    cards: [
                        { rank: ic.cartaValor, suit: ic.cartaPalo || '' },
                        { joker: true },
                        { rank: ic.cartaValor, suit: ic.cartaPalo || '' },
                    ],
                }],
            };
        }
        return {
            badge: 'Construcción',
            title: `Aún te falta completar: ${requirement}`,
            text: (REQ[G.ronda]?.c || 0) > 0
                ? 'Arma las corridas con cartas consecutivas del mismo palo. Luego completa las tercias que falten.'
                : 'Agrupa cartas del mismo valor en los slots. Cuando todo quede completo podrás bajarte.',
            examples: getRoundExampleData(G.ronda),
        };
    }

    if (me.bajado && G.estado === 'esperando_accion') {
        if (intercambios.length > 0) {
            const ic = intercambios[0];
            return {
                badge: 'Joker',
                title: 'Puedes intercambiar un joker ahora',
                text: `Como ya estás bajado, si colocas ${ic.cartaValor}${ic.cartaPalo || ''} en la jugada correcta recibes el joker para acomodarlo en otra jugada.`,
            };
        }
        return {
            badge: 'Mesa',
            title: 'Ya estás bajado: ahora acomoda o paga',
            text: 'Selecciona una carta de tus sobrantes para acomodarla en las jugadas de la mesa o déjala lista para pagar al fondo.',
        };
    }

    if (G.estado === 'esperando_pago') {
        return {
            badge: 'Paso final',
            title: 'Debes pagar una carta al fondo',
            text: me.bajado
                ? 'Antes de cerrar tu turno todavía puedes acomodar o intercambiar un joker si aplica. Cuando termines, paga una carta al fondo.'
                : 'Después de tu acción principal debes escoger una carta y pagarla al fondo para terminar el turno.',
            examples: [
                {
                    label: 'Carta que sale al fondo',
                    cards: [{ rank: '9', suit: '♣' }],
                },
            ],
        };
    }

    return {
        badge: 'Guía',
        title: `Ronda ${G.ronda}`,
        text: `Requisito actual: ${requirement}.`,
        examples: getRoundExampleData(G.ronda),
    };
}

function updateGuideTip() {
    const tip = document.getElementById('guide-tip');
    const badge = document.getElementById('guide-tip-badge');
    const title = document.getElementById('guide-tip-title');
    const text = document.getElementById('guide-tip-text');
    const examples = document.getElementById('guide-tip-examples');
    if (!tip || !badge || !title || !text || !examples) return;

    if (!isGuideEnabled()) {
        tip.classList.remove('show');
        examples.innerHTML = '';
        return;
    }

    const ctx = getGuideActionContext();
    if (!ctx) {
        tip.classList.remove('show');
        return;
    }

    badge.textContent = ctx.badge || 'Guía';
    title.textContent = ctx.title || '';
    text.textContent = ctx.text || '';
    examples.innerHTML = buildGuideTipExamples(ctx.examples || []);
    tip.classList.add('show');
}

function saveActiveGameSession(extra = {}) {
    const usuario = JSON.parse(localStorage.getItem('usuario') || 'null');
    const color = extra.color || sessionStorage.getItem('tableColor') || params.get('color') || 'green';
    localStorage.setItem(ACTIVE_GAME_KEY, JSON.stringify({
        code: ROOM,
        playerId: MY_ID,
        seatToken: MY_SEAT || extra.seatToken || null,
        userId: usuario?.id || null,
        nombre: usuario?.nombre || localStorage.getItem('nombre_' + MY_ID) || 'Jugador',
        color,
        ronda: G?.ronda || null,
        savedAt: Date.now(),
    }));
}

function clearActiveGameSession() {
    localStorage.removeItem(ACTIVE_GAME_KEY);
}

function isGuideEnabled() {
    return localStorage.getItem(GUIDE_ENABLED_KEY) === '1';
}

function setGuideEnabled(enabled) {
    if (enabled) localStorage.setItem(GUIDE_ENABLED_KEY, '1');
    else localStorage.removeItem(GUIDE_ENABLED_KEY);
    syncGuidePreferenceUi();
    updateGuideTip();
}

function syncGuidePreferenceUi() {
    const enabled = isGuideEnabled();
    const btn = document.getElementById('btn-guide-game');
    const toggle = document.getElementById('guide-auto-toggle');
    const status = document.getElementById('guide-settings-status');

    if (btn) {
        btn.textContent = enabled ? '📘 Guía ON' : '📘 Guía OFF';
        btn.style.borderColor = enabled ? 'rgba(200,160,69,.4)' : 'rgba(255,255,255,.14)';
        btn.style.color = enabled ? 'var(--gold)' : 'var(--text-dim)';
    }
    if (toggle) toggle.checked = enabled;
    if (status) {
        status.textContent = enabled
            ? 'La guía se abrirá automáticamente la primera vez que entres a la mesa en este navegador.'
            : 'La guía solo se abrirá cuando la lances manualmente desde este botón.';
    }
}

function openGuideSettings() {
    syncGuidePreferenceUi();
    document.getElementById('guide-settings-overlay')?.classList.add('show');
}

function closeGuideSettings() {
    document.getElementById('guide-settings-overlay')?.classList.remove('show');
}

function toggleGuideAuto(checked) {
    setGuideEnabled(checked);
}

function startGuideFromSettings() {
    closeGuideSettings();
    startGameGuide();
}

function isVisibleGuideTarget(el) {
    return !!(el && el.getClientRects && el.getClientRects().length);
}

function buildGameGuideSteps() {
    return {
        doneKey: GUIDE_DONE_GAME_KEY,
        steps: [
            {
                selector: '.topbar',
                title: 'Estado de la ronda',
                text: 'Aquí ves el número de ronda, el requisito actual, la conexión y el marcador acumulado de todos.',
                contextTitle: 'Qué mirar aquí',
                contextBody: 'La ronda define exactamente cuántas tercias y corridas debes completar antes de bajarte.',
            },
            {
                selector: '#mazo-wrap',
                title: 'Mazo',
                text: 'Robas desde aquí al inicio de tu turno cuando el juego te pida tomar del mazo.',
            },
            {
                selector: '#fondo-wrap',
                title: 'Fondo',
                text: 'El fondo muestra la carta visible. Solo puedes tomarla antes de bajarte en esa ronda.',
                contextTitle: 'Regla importante',
                contextBody: 'Si ya estás bajado, en tu siguiente robo solo podrás tomar del mazo.',
            },
            {
                selector: '#building-row',
                title: 'Construcción',
                text: 'Aquí armas tus tercias o corridas antes de bajarte. Puedes reordenar y preparar la jugada sin enviarla todavía.',
                dynamic: () => ({
                    contextTitle: `Ronda ${G?.ronda || '—'}: ${getRoundRequirementText(G?.ronda || 1)}`,
                    contextBody: (REQ[G?.ronda || 1]?.c || 0) > 0
                        ? 'Las corridas siempre deben ser consecutivas y del mismo palo. Los ejemplos de abajo son solo ilustrativos.'
                        : 'En esta ronda te conviene fijarte en el valor de las cartas para completar tercias.',
                    examples: getRoundExampleData(G?.ronda || 1),
                }),
            },
            {
                selector: '#discard-zone',
                title: 'Sobrantes',
                text: 'Las cartas que no estás usando quedan aquí. Desde esta zona seleccionas, arrastras y terminas pagando al fondo.',
            },
            {
                selector: '.action-bar',
                title: 'Instrucciones y acciones',
                text: 'Esta barra te dice exactamente qué toca hacer y te muestra los botones válidos según el estado del turno.',
                dynamic: () => {
                    const ctx = getGuideActionContext();
                    return ctx ? {
                        contextTitle: ctx.title,
                        contextBody: ctx.text,
                        examples: ctx.examples || [],
                    } : null;
                },
            },
            {
                selector: '#opponents',
                title: 'Mesa de jugadas',
                text: 'Las bajadas aparecen delante del asiento de cada jugador sobre el fieltro. Después de bajarte puedes pagar cartas o acomodar comodines sobre estas jugadas.',
                contextTitle: 'Sobre los jokers',
                contextBody: 'Solo puedes reclamar un joker si tienes la carta exacta que representa y estás en un estado válido para intercambiar.',
            },
        ],
    };
}

function resolveGuideTarget(step) {
    const target = typeof step.selector === 'function' ? step.selector() : document.querySelector(step.selector);
    return isVisibleGuideTarget(target) ? target : null;
}

function positionGuideCard(rect) {
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

function renderGuideStep() {
    if (!guideState.active) return;

    const step = guideState.steps[guideState.index];
    if (!step) {
        finishGuide();
        return;
    }

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
        const ctxWrap = document.getElementById('guide-context-copy');
        const ctxTitle = document.getElementById('guide-context-title');
        const ctxBody = document.getElementById('guide-context-body');
        const examples = document.getElementById('guide-examples');
        const dynamicData = typeof step.dynamic === 'function' ? step.dynamic() : null;
        const extra = dynamicData || step;

        focus.style.left = `${Math.max(8, rect.left - 8)}px`;
        focus.style.top = `${Math.max(8, rect.top - 8)}px`;
        focus.style.width = `${Math.min(window.innerWidth - 16, rect.width + 16)}px`;
        focus.style.height = `${rect.height + 16}px`;

        title.textContent = step.title;
        text.textContent = step.text;
        progress.textContent = `Paso ${guideState.index + 1} de ${guideState.steps.length}`;
        nextBtn.textContent = guideState.index === guideState.steps.length - 1 ? 'Terminar' : 'Siguiente';

        if (ctxWrap && ctxTitle && ctxBody) {
            if (extra?.contextTitle || extra?.contextBody) {
                ctxWrap.style.display = 'block';
                ctxTitle.textContent = extra.contextTitle || 'Detalle';
                ctxBody.textContent = extra.contextBody || '';
            } else {
                ctxWrap.style.display = 'none';
                ctxTitle.textContent = '';
                ctxBody.textContent = '';
            }
        }
        if (examples) {
            examples.innerHTML = buildGuideExamples(extra?.examples || []);
        }
        positionGuideCard(rect);
    });
}

function startGameGuide() {
    const config = buildGameGuideSteps();
    if (!config.steps.length) {
        toast('No hay guía disponible en esta mesa.', 'green');
        return;
    }

    guideState = {
        active: true,
        steps: config.steps,
        index: 0,
        doneKey: config.doneKey,
    };
    document.getElementById('guide-overlay')?.classList.add('show');
    renderGuideStep();
}

function closeGuide() {
    guideState.active = false;
    document.getElementById('guide-overlay')?.classList.remove('show');
}

function finishGuide() {
    if (guideState.doneKey) localStorage.setItem(guideState.doneKey, '1');
    closeGuide();
}

function nextGuideStep() {
    if (!guideState.active) return;
    guideState.index += 1;
    if (guideState.index >= guideState.steps.length) {
        finishGuide();
        return;
    }
    renderGuideStep();
}

function queueAutoGuide(delay = 900) {
    clearTimeout(guideAutoTimer);
    guideAutoTimer = setTimeout(() => {
        if (guideState.active || !isGuideEnabled()) return;
        if (!G || myIdx < 0) return;
        if (localStorage.getItem(GUIDE_DONE_GAME_KEY) === '1') return;
        startGameGuide();
    }, delay);
}

function refreshGuideLayout() {
    if (guideState.active) renderGuideStep();
}

// ═══════════════════════════════════════════════════
// VALIDACIÓN CLIENTE PARA HABILITAR BOTÓN BAJAR
// ═══════════════════════════════════════════════════

function slotTerciaValido(cards) {
    if (cards.length < 3) return false;
    const normales = cards.filter(c => !c.comodin);
    const comodines = cards.filter(c => c.comodin);
    if (normales.length === 0) return false;
    if (comodines.length > 1) return false;
    const valorBase = normales[0].valor;
    return normales.every(c => c.valor === valorBase);
}

function slotCorridaValido(cards) {
    if (cards.length < 4) return false;
    const normales = cards.filter(c => !c.comodin);
    const comodines = cards.filter(c => c.comodin);
    if (normales.length === 0) return false;
    if (comodines.length > 1) return false;
    const palo = normales[0].palo;
    if (!normales.every(c => c.palo === palo)) return false;
    if (new Set(normales.map(c => c.valor)).size !== normales.length) return false;

    function esSecuenciaValida(vals, numComodines) {
        let huecos = 0;
        for (let i = 0; i < vals.length - 1; i++) {
            const diff = vals[i + 1] - vals[i];
            if (diff === 1) continue;
            if (diff === 2) { huecos++; continue; }
            return false;
        }
        return huecos <= numComodines;
    }

    const valsNorm = normales.map(c => VN[c.valor]).sort((a, b) => a - b);
    if (esSecuenciaValida(valsNorm, comodines.length)) return true;
    if (valsNorm.includes(1)) {
        const valsA14 = valsNorm.map(v => v === 1 ? 14 : v).sort((a, b) => a - b);
        if (esSecuenciaValida(valsA14, comodines.length)) return true;
    }
    return false;
}

function slotTerciaCasiCompleta(cards) {
    if (cards.length < 3) return false;
    const normales = cards.filter(c => !c.comodin);
    const comodines = cards.filter(c => c.comodin);
    if (normales.length === 0) return false;
    if (comodines.length > 1) return false;
    if (comodines.length === 1 && normales.length >= 2) return true;
    const conteo = {};
    normales.forEach(c => { conteo[c.valor] = (conteo[c.valor] || 0) + 1; });
    return Object.values(conteo).some(n => n >= 2);
}

function slotCorridaCasiCompleta(cards) {
    if (cards.length < 4) return false;
    const normales = cards.filter(c => !c.comodin);
    const comodines = cards.filter(c => c.comodin);
    if (normales.length === 0) return false;
    if (comodines.length > 1) return false;
    const palo = normales[0].palo;
    if (!normales.every(c => c.palo === palo)) return false;
    if (new Set(normales.map(c => c.valor)).size !== normales.length) return false;

    function contarHuecos(vals) {
        let h = 0;
        for (let i = 0; i < vals.length - 1; i++) {
            const diff = vals[i + 1] - vals[i];
            if (diff >= 2) h += diff - 1;
        }
        return h;
    }

    const valsNorm = normales.map(c => VN[c.valor]).sort((a, b) => a - b);
    const h1 = contarHuecos(valsNorm);
    if ((h1 - comodines.length) === 1) return true;
    if (valsNorm.includes(1)) {
        const valsA14 = valsNorm.map(v => v === 1 ? 14 : v).sort((a, b) => a - b);
        const h2 = contarHuecos(valsA14);
        if ((h2 - comodines.length) === 1) return true;
    }
    return false;
}

// ═══════════════════════════════════════════════════
// DETECCIÓN AUTOMÁTICA DE INTERCAMBIOS POSIBLES
// ═══════════════════════════════════════════════════

const _intercambiosCache = new Map();

// ─────────────────────────────────────────────────────────────────────────────
// detectarIntercambiosPosibles()
//
// CASO A — Jugador NO bajado (esperando_accion):
//   La carta debe permitir bajarse después del intercambio.
//   Validación: misma lógica que antes.
//
// CASO B — Jugador YA bajado (esperando_accion o esperando_pago):
//   Solo necesita que la carta encaje en el joker (mismo valor/palo).
//   No hay validación de "puede bajarse" — ya está bajado.
//   El joker recibido podrá acomodarse en otra jugada de la mesa.
//   Se valida también que el joker PUEDA acomodarse en alguna jugada
//   disponible para que el intercambio tenga utilidad.
// ─────────────────────────────────────────────────────────────────────────────
function detectarIntercambiosPosibles() {
    if (!G || myIdx < 0) return [];
    if (!isMyTurn()) return [];

    const me = G.jugadores[myIdx];
    if (!me) return [];

    const estadosValidos = ['esperando_accion', 'esperando_pago'];
    if (!estadosValidos.includes(G.estado)) return [];

    // Pre-bajada solo en esperando_accion
    if (!me.bajado && G.estado !== 'esperando_accion') return [];

    const intercambios = [];
    const cartasEnSlots = new Set();
    buildingCards.forEach(cards => cards.forEach(c => cartasEnSlots.add(c.id)));

    G.jugadores.forEach((jOrigen, ji) => {
        if (!jOrigen.bajado) return;
        // Post-bajada: también puede intercambiar en sus PROPIAS jugadas
        // Pre-bajada: solo en jugadas de otros (el joker recibido va a slots)
        if (!me.bajado && ji === myIdx) return;

        jOrigen.jugadas?.forEach((jug, jugi) => {
            const comodin = jug.cartas.find(c => c.comodin);
            if (!comodin) return;

            const valorNecesario = comodin.valorReemplazado;
            const paloNecesario = comodin.paloReemplazado;

            me.mano.forEach(carta => {
                if (carta.comodin) return;
                if (!me.bajado && cartasEnSlots.has(carta.id)) return;

                // ¿Esta carta encaja en el joker?
                const encaja = jug.tipo === 'tercia'
                    ? carta.valor === valorNecesario
                    : carta.valor === valorNecesario && carta.palo === paloNecesario;

                if (!encaja) return;

                // ══════════════════════════════════════════════
                // CASO B: Ya bajado — validación simplificada
                // Solo verifica que el joker recibido pueda ser
                // útil: que haya al menos una jugada en la mesa
                // donde se pueda acomodar.
                // ══════════════════════════════════════════════
                if (me.bajado) {
                    // El joker recibido puede acomodarse en cualquier jugada bajada
                    // que no tenga ya un joker (una jugada = máx 1 joker según reglas)
                    const jokerEsUtil = G.jugadores.some((jDest, jdi) => {
                        if (!jDest.bajado) return false;
                        return jDest.jugadas?.some((jugDest, jugiDest) => {
                            // No en la misma jugada de donde viene
                            if (jdi === ji && jugiDest === jugi) return false;
                            // La jugada destino no debe tener ya un joker
                            if (jugDest.cartas.some(c => c.comodin)) return false;
                            // El joker puede ir al final de una corrida o completar una tercia
                            return true; // el server valida la posición exacta
                        });
                    });

                    if (!jokerEsUtil) return;

                    const icObj = {
                        cartaId: carta.id,
                        cartaValor: carta.valor,
                        cartaPalo: carta.palo,
                        jugadorIdx: ji,
                        jugadaIdx: jugi,
                        comodinId: comodin.id,
                        esCasoBajado: true,
                    };
                    const icKey = `${ji}-${jugi}-${comodin.id}`;
                    _intercambiosCache.set(icKey, icObj);
                    intercambios.push(icObj);
                    return;
                }

                // ══════════════════════════════════════════════
                // CASO A: No bajado — validación completa
                // (lógica original sin cambios)
                // ══════════════════════════════════════════════
                const defs = getSlotDefsRonda(G.ronda);
                const jugadasSimuladas = [];
                let comodinUsadoEnSlot = false;

                for (const def of defs) {
                    const cards = buildingCards.get(def.index) || [];
                    if (cards.length === 0) continue;
                    const tieneLaCarta = cards.some(c => c.id === carta.id);
                    let cartasSlot = cards;
                    if (tieneLaCarta) {
                        cartasSlot = cards.map(c => c.id === carta.id ? { ...comodin, comodin: true } : c);
                        comodinUsadoEnSlot = true;
                    }
                    jugadasSimuladas.push({ tipo: def.type, cartas: cartasSlot.filter(Boolean) });
                }

                if (!comodinUsadoEnSlot) {
                    let comodinAsignado = false;
                    for (const def of defs) {
                        const slotCards = buildingCards.get(def.index) || [];
                        if (comodinAsignado) {
                            jugadasSimuladas.push({ tipo: def.type, cartas: slotCards.filter(Boolean) });
                            continue;
                        }
                        const conComodin = [...slotCards, { ...comodin, comodin: true }];
                        const valido = def.type === 'tercia' ? slotTerciaValido(conComodin) : slotCorridaValido(conComodin);
                        const sinComodin = def.type === 'tercia' ? slotTerciaValido(slotCards) : slotCorridaValido(slotCards);
                        if (!sinComodin && valido) {
                            jugadasSimuladas.push({ tipo: def.type, cartas: conComodin });
                            comodinAsignado = true;
                        } else {
                            jugadasSimuladas.push({ tipo: def.type, cartas: slotCards.filter(Boolean) });
                        }
                    }
                }

                const req = REQ[G.ronda];
                let terciasOk = 0, corridasOk = 0;
                for (const js of jugadasSimuladas) {
                    if (!js.cartas || js.cartas.length === 0) continue;
                    if (js.tipo === 'tercia' && slotTerciaValido(js.cartas)) terciasOk++;
                    if (js.tipo === 'corrida' && slotCorridaValido(js.cartas)) corridasOk++;
                }
                if (terciasOk < req.t || corridasOk < req.c) return;

                const icObj = {
                    cartaId: carta.id,
                    cartaValor: carta.valor,
                    cartaPalo: carta.palo,
                    jugadorIdx: ji,
                    jugadaIdx: jugi,
                    comodinId: comodin.id,
                    jugadasSimuladas,
                    esCasoBajado: false,
                };
                const icKey = `${ji}-${jugi}-${comodin.id}`;
                _intercambiosCache.set(icKey, icObj);
                intercambios.push(icObj);
            });
        });
    });

    return intercambios;
}

function getSlotDefsRonda(ronda) {
    const T = i => ({ index: String(i), type: 'tercia' });
    const C = i => ({ index: String(i), type: 'corrida' });
    const map = {
        1: [T(0), T(1)],
        2: [T(0), C(1)],
        3: [C(0), C(1)],
        4: [T(0), T(1), T(2)],
        5: [T(0), T(1), C(2)],
        6: [C(0), C(1), T(2)],
        7: [C(0), C(1), C(2)],
    };
    return map[ronda] || [];
}

function slotsListosParaBajar() {
    if (!G || myIdx < 0) return false;
    const me = G.jugadores[myIdx];
    if (!me || me.bajado) return false;
    if (G.estado !== 'esperando_accion') return false;
    if (me.penalizacion?.activa) return false;

    const req = REQ[G.ronda];
    const defs = getSlotDefsRonda(G.ronda);

    let completos = 0, casiCompletos = 0, insuficientes = 0;
    for (const def of defs) {
        const cards = buildingCards.get(def.index) || [];
        const esCompleto = def.type === 'tercia' ? slotTerciaValido(cards) : slotCorridaValido(cards);
        const esCasi    = def.type === 'tercia' ? slotTerciaCasiCompleta(cards) : slotCorridaCasiCompleta(cards);
        if (esCompleto) completos++;
        else if (esCasi) casiCompletos++;
        else insuficientes++;
    }

    const totalSlots = defs.length;
    if (G.ronda === 7) {
        if (completos !== totalSlots) return false;
        const cartasEnSlots = new Set();
        buildingCards.forEach(cards => cards.forEach(c => { if (c?.id) cartasEnSlots.add(c.id); }));
        const sobrantes = (me.mano || []).filter(c => !cartasEnSlots.has(c.id));
        return sobrantes.length === 0;
    }
    if (completos === totalSlots) return true;
    if (completos === totalSlots - 1 && casiCompletos >= 1 && insuficientes === 0) return true;
    return false;
}

// ═══════════════════════════════════════════════════
// INICIALIZACIÓN Y SOCKET
// ═══════════════════════════════════════════════════

// ═══════════════════════════════════════════════════
// EFECTOS DE SONIDO (Web Audio API)
// ═══════════════════════════════════════════════════
const SFX = (() => {
    let ctx = null;
    function getCtx() {
        if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)();
        return ctx;
    }
    async function unlock() {
        try {
            const ac = getCtx();
            if (ac.state === 'suspended') await ac.resume();
            return ac.state === 'running';
        } catch (e) {
            return false;
        }
    }
    function play(type) {        try {
            const ac = getCtx();
            if (ac.state === 'suspended') return false;
            const g  = ac.createGain();
            g.connect(ac.destination);

            if (type === 'robar') {
                // Sonido suave de carta deslizándose
                const o = ac.createOscillator();
                o.type = 'sine';
                o.frequency.setValueAtTime(600, ac.currentTime);
                o.frequency.exponentialRampToValueAtTime(300, ac.currentTime + 0.12);
                g.gain.setValueAtTime(0.15, ac.currentTime);
                g.gain.exponentialRampToValueAtTime(0.001, ac.currentTime + 0.12);
                o.connect(g); o.start(); o.stop(ac.currentTime + 0.12);

            } else if (type === 'pagar') {
                // Sonido negativo corto
                const o = ac.createOscillator();
                o.type = 'sawtooth';
                o.frequency.setValueAtTime(200, ac.currentTime);
                o.frequency.exponentialRampToValueAtTime(100, ac.currentTime + 0.18);
                g.gain.setValueAtTime(0.12, ac.currentTime);
                g.gain.exponentialRampToValueAtTime(0.001, ac.currentTime + 0.18);
                o.connect(g); o.start(); o.stop(ac.currentTime + 0.18);

            } else if (type === 'bajar') {
                // Fanfarria corta positiva — 3 notas
                [0, 0.1, 0.2].forEach((t, i) => {
                    const o = ac.createOscillator();
                    const gn = ac.createGain();
                    o.type = 'triangle';
                    o.frequency.value = [440, 554, 659][i];
                    gn.gain.setValueAtTime(0.18, ac.currentTime + t);
                    gn.gain.exponentialRampToValueAtTime(0.001, ac.currentTime + t + 0.15);
                    o.connect(gn); gn.connect(ac.destination);
                    o.start(ac.currentTime + t);
                    o.stop(ac.currentTime + t + 0.15);
                });

            } else if (type === 'carta') {
                // Click suave al contar carta
                const buf = ac.createBuffer(1, ac.sampleRate * 0.05, ac.sampleRate);
                const data = buf.getChannelData(0);
                for (let i = 0; i < data.length; i++) {
                    data[i] = (Math.random() * 2 - 1) * (1 - i / data.length) * 0.3;
                }
                const src = ac.createBufferSource();
                src.buffer = buf;
                src.connect(g);
                g.gain.setValueAtTime(0.4, ac.currentTime);
                g.gain.exponentialRampToValueAtTime(0.001, ac.currentTime + 0.05);
                src.start();

            } else if (type === 'victoria') {
                // Fanfarria de victoria — 5 notas ascendentes
                [0, 0.12, 0.24, 0.36, 0.48].forEach((t, i) => {
                    const o = ac.createOscillator();
                    const gn = ac.createGain();
                    o.type = 'triangle';
                    o.frequency.value = [392, 440, 494, 587, 659][i];
                    gn.gain.setValueAtTime(0.2, ac.currentTime + t);
                    gn.gain.exponentialRampToValueAtTime(0.001, ac.currentTime + t + 0.2);
                    o.connect(gn); gn.connect(ac.destination);
                    o.start(ac.currentTime + t);
                    o.stop(ac.currentTime + t + 0.2);
                });

            } else if (type === 'turno') {
                [
                    { t: 0, freq: 784, gain: 0.12, dur: 0.12 },
                    { t: 0.14, freq: 1046, gain: 0.14, dur: 0.16 },
                ].forEach(note => {
                    const o = ac.createOscillator();
                    const gn = ac.createGain();
                    o.type = 'sine';
                    o.frequency.setValueAtTime(note.freq, ac.currentTime + note.t);
                    gn.gain.setValueAtTime(note.gain, ac.currentTime + note.t);
                    gn.gain.exponentialRampToValueAtTime(0.001, ac.currentTime + note.t + note.dur);
                    o.connect(gn); gn.connect(ac.destination);
                    o.start(ac.currentTime + note.t);
                    o.stop(ac.currentTime + note.t + note.dur);
                });

            } else if (type === 'chips') {
                // Clac de fichas de poker — sintetizado (sin archivos).
                // Mezcla: ruido agudo filtrado + anillo brillante + golpe grave.
                const t0 = ac.currentTime;

                // 1) Ataque: estallido de ruido en banda aguda
                const dur = 0.09;
                const buf = ac.createBuffer(1, Math.ceil(ac.sampleRate * dur), ac.sampleRate);
                const d = buf.getChannelData(0);
                for (let i = 0; i < d.length; i++) {
                    d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / d.length, 2);
                }
                const noiseSrc = ac.createBufferSource();
                noiseSrc.buffer = buf;
                const bp = ac.createBiquadFilter();
                bp.type = 'bandpass';
                bp.frequency.value = 3800;
                bp.Q.value = 0.8;
                const ng = ac.createGain();
                ng.gain.setValueAtTime(0.5, t0);
                ng.gain.exponentialRampToValueAtTime(0.001, t0 + dur);
                noiseSrc.connect(bp); bp.connect(ng); ng.connect(g);
                noiseSrc.start(t0);
                noiseSrc.stop(t0 + dur);

                // 2) Anillo brillante (resonancia de la ficha)
                [2600, 3900].forEach((f, i) => {
                    const o = ac.createOscillator();
                    o.type = 'sine';
                    o.frequency.value = f;
                    const og = ac.createGain();
                    og.gain.setValueAtTime(0.1, t0);
                    og.gain.exponentialRampToValueAtTime(0.001, t0 + 0.12 + i * 0.02);
                    o.connect(og); og.connect(g);
                    o.start(t0);
                    o.stop(t0 + 0.15);
                });

                // 3) Golpe de cuerpo (dos fichas chocando)
                const o2 = ac.createOscillator();
                o2.type = 'triangle';
                o2.frequency.setValueAtTime(420, t0);
                o2.frequency.exponentialRampToValueAtTime(180, t0 + 0.06);
                const g2 = ac.createGain();
                g2.gain.setValueAtTime(0.25, t0);
                g2.gain.exponentialRampToValueAtTime(0.001, t0 + 0.09);
                o2.connect(g2); g2.connect(g);
                o2.start(t0); o2.stop(t0 + 0.1);
            }
            return true;
        } catch(e) {}
        return false;
    }
    return { play, unlock };
})();

let _firstLoad = true;
const _animatedBajadas = new Set(); // IDs de cartas ya animadas en mesa

function init() {
    if (!MY_ID || !ROOM) { location.href = '/'; return; }
    localStorage.setItem('nombre_' + MY_ID, localStorage.getItem('nombre_' + MY_ID) || 'Jugador');
    saveActiveGameSession();
    setupAudioUnlock();
    syncGuidePreferenceUi();
    window.addEventListener('resize', refreshGuideLayout);
    // El layout de asientos/bajadas depende del ancho del fieltro (dinámico):
    // re-renderiza oponentes y bajadas al redimensionar.
    let _seatResizeT;
    window.addEventListener('resize', () => {
        clearTimeout(_seatResizeT);
        _seatResizeT = setTimeout(() => {
            if (G && myIdx >= 0) {
                renderOpponents();
                renderTableBajadas();
            }
        }, 120);
    });
    const handZone = document.getElementById('discard-zone');
    if (handZone) handZone.addEventListener('scroll', updateHandScroll, { passive: true });
    const scrollArrow = document.getElementById('hand-scroll-arrow');
    if (scrollArrow) scrollArrow.addEventListener('click', () => {
        const z = document.getElementById('discard-zone');
        if (!z) return;
        z.scrollBy({ left: Math.max(120, z.clientWidth * 0.6), behavior: 'smooth' });
        setTimeout(updateHandScroll, 400);
    });
    document.addEventListener('keydown', e => {
        const tag = e.target && e.target.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
        if (!G || myIdx < 0) return;
        if ((e.key === 'r' || e.key === 'R') && G.turno === myIdx && G.estado === 'esperando_robo') {
            e.preventDefault(); acMazo();
        } else if ((e.key === 'f' || e.key === 'F') && G.turno === myIdx && ['esperando_robo'].includes(G.estado)) {
            e.preventDefault(); acFondo();
        } else if (e.key === ' ' && G.turno === myIdx && G.estado === 'esperando_accion' && selId != null) {
            e.preventDefault(); acBajar();
        }
    });
    setupSocketEvents();
    WS.connect();
}

function isActionRequiredForPlayer(state, playerIdx) {
    if (!state || playerIdx < 0) return false;
    if (state.estado === 'fase_castigo') return state.castigo_idx === playerIdx;
    return state.turno === playerIdx && ['esperando_robo', 'esperando_accion', 'esperando_pago'].includes(state.estado);
}

function maybePlayTurnAlert(prevState, options = {}) {
    const { skip = false } = options;
    if (skip || !G || myIdx < 0) return;

    const prevIdx = prevState?.jugadores?.findIndex(j => j.id === MY_ID) ?? myIdx;
    const actionBefore = isActionRequiredForPlayer(prevState, prevIdx);
    const actionNow = isActionRequiredForPlayer(G, myIdx);

    if (!actionNow) {
        _pendingTurnAlert = false;
        return;
    }
    if (!prevState || actionBefore) return;

    if (!SFX.play('turno')) {
        _pendingTurnAlert = true;
    }
}

function setupAudioUnlock() {
    const events = ['pointerdown', 'touchstart', 'keydown'];
    const onUnlock = async () => {
        const unlocked = await SFX.unlock();
        if (!unlocked) return;

        events.forEach(eventName => {
            window.removeEventListener(eventName, onUnlock, true);
        });

        if (_pendingTurnAlert && isActionRequiredForPlayer(G, myIdx)) {
            _pendingTurnAlert = false;
            SFX.play('turno');
        }
    };

    events.forEach(eventName => {
        window.addEventListener(eventName, onUnlock, { passive: true, capture: true });
    });
}

function clearPendingCastigo(reason = '') {
    if (pendingCastigo || castigoEnviado) {
        console.log('[GAME] clearPendingCastigo', { reason, pendingCastigo });
    }
    pendingCastigo = null;
    castigoEnviado = false;
}

function maybeReplayPendingCastigo(event) {
    if (event !== 'reconnect' || !pendingCastigo || !G) return;
    const sigueVigente = G.estado === 'fase_castigo' && G.castigo_idx === myIdx;
    if (!sigueVigente) {
        clearPendingCastigo('castigo ya no vigente tras reconnect');
        return;
    }
    if (pendingCastigo.replayedSocketId === WS._socketId) return;

    pendingCastigo.replayedSocketId = WS._socketId || null;
    castigoEnviado = true;
    console.log('[GAME] replay pending castigo', {
        socketId: WS._socketId || null,
        pendingCastigo,
        estado: G.estado,
        castigo_idx: G.castigo_idx,
        turno: G.turno,
    });
    WS.send({ type: 'castigo', acepta: pendingCastigo.acepta });
}

function setupSocketEvents() {
    WS.on('_connected', () => {
        document.getElementById('modal-disconnected').classList.remove('show');
        document.getElementById('mode-pill').textContent = '🟢 Conectado';
        console.log('[GAME] socket conectado', { room: ROOM, myId: MY_ID, socketId: WS._socketId || null });
    });
    WS.on('_disconnected', () => {
        document.getElementById('modal-disconnected').classList.add('show');
        document.getElementById('mode-pill').textContent = '🔴 Desconectado';
        castigoEnviado = false;
        console.warn('[GAME] socket desconectado', {
            room: ROOM,
            myId: MY_ID,
            socketId: WS._socketId || null,
            online: navigator.onLine,
            visible: document.visibilityState,
        });
    });
    WS.on('state_update', async ({ event, data, state, tableColor }) => {
        if (!WS._heartbeatStarted) {
            WS._heartbeatStarted = true;

            clearInterval(WS._pingInterval);
            clearTimeout(WS._pongTimeout);

            WS._pingInterval = setInterval(() => {
                if (WS.ws?.readyState === WebSocket.OPEN) {
                    WS._lastPingAt = Date.now();
                    WS.send({ type: 'ping' });
                    console.log('[GAME] 📡 ping enviado', {
                        socketId: WS._socketId || null,
                        room: ROOM,
                        visible: document.visibilityState,
                        online: navigator.onLine,
                    });

                    clearTimeout(WS._pongTimeout);
                    WS._pongTimeout = setTimeout(() => {
                        console.warn('[GAME] 💀 sin pong -> cerrando socket', {
                            socketId: WS._socketId || null,
                            room: ROOM,
                            msSincePing: WS._lastPingAt ? Date.now() - WS._lastPingAt : null,
                            msSincePong: WS._lastPongAt ? Date.now() - WS._lastPongAt : null,
                            readyState: WS.ws?.readyState,
                            visible: document.visibilityState,
                            online: navigator.onLine,
                        });
                        WS.ws.close();
                    }, 10000);
                }
            }, 15000);
        }
        if (!state) return;
        console.log('[GAME] state_update', {
            event,
            room: ROOM,
            myId: MY_ID,
            estado: state.estado,
            turno: state.turno,
            castigo_idx: state.castigo_idx,
            data,
        });

        if (_firstLoad && event === 'player_connection_changed' && data?.playerId === MY_ID) {
            console.log('[GAME] ignorando player_connection_changed inicial propio');
            return;
        }

        const prev = G;
        G = state;
        myIdx = G.jugadores.findIndex(j => j.id === MY_ID);
        if (tableColor) applyTableTheme(tableColor);
        saveActiveGameSession({ color: tableColor || undefined });

        if (event === 'esperando_siguiente_ronda') {
            const readyPlayerIds = Array.isArray(data?.readyPlayerIds) ? data.readyPlayerIds : [];
            if (readyPlayerIds.includes(MY_ID)) {
                showNextRoundWait(data);
            } else {
                hideNextRoundWait();
            }
        }

        if (event === 'castigo_acepta' || event === 'castigo_pasa') {
            clearPendingCastigo(`ack ${event}`);
        } else if (pendingCastigo && (G.estado !== 'fase_castigo' || G.castigo_idx !== myIdx)) {
            clearPendingCastigo('estado cambió antes de confirmar castigo');
        }

        maybeReplayPendingCastigo(event);

        const isNewRound = event === 'game_started' || event === 'nueva_ronda';
        const isReconnect = event === 'reconnect';
        const isInitialReconnect = _firstLoad && isReconnect;
        maybePlayTurnAlert(prev, { skip: _firstLoad || isReconnect });
        _firstLoad = false;

        if (isNewRound) hideNextRoundWait();
        if (event === 'nueva_ronda' && data?.reinicio) {
            toast('⚠️ Se agotó dos veces la baraja. La ronda se reinició.', 'yellow');
        }

        // Animar reparto si inicia ronda nueva o si esta es la primera
        // reconexión al entrar a game.html y aún no se animó la ronda actual.
        const roundKey = `dealt_${ROOM}_r${G.ronda}`;
        const yaAnimado = sessionStorage.getItem(roundKey);

        if ((isNewRound || isInitialReconnect) && !yaAnimado) {
            sessionStorage.setItem(roundKey, '1');
            await handleNewRound();
        } else if (isReconnect) {
            // En reconexión solo renderizar, no animar
            hideHandDuringDeal = false;
            render();
            // Si el juego terminó mientras estábamos desconectados
            if (G.estado === 'fin_juego' && G.jugadores) {
                showModalJuego({ jugadores: G.jugadores, fichas: null, bancaRepartida: null, conApuesta: G.conApuesta });
            }
        } else {
            hideHandDuringDeal = false;
            renderStateUpdate(event, data);
            await applyEvent(event, data, prev);
        }

        queueAutoGuide(isNewRound ? 1300 : 650);
    });
    WS.on('player_reconnected', ({ nombre }) => toast(`${nombre} se reconectó`, 'green'));
    WS.on('player_disconnected', ({ nombre }) => toast(`${nombre} se desconectó`));
    WS.on('error', ({ msg }) => {
        if (msg === 'Sala no encontrada.') {
            clearActiveGameSession();
            toast(msg, 'red');
            setTimeout(() => { location.href = '/'; }, 900);
            return;
        }
        toast(msg, 'red');
        const esBajada = msg && (
            msg.includes('BAJADA EN FALSO') ||
            msg.includes('Tercia') ||
            msg.includes('Corrida') ||
            msg.includes('Necesitas') ||
            msg.includes('no está en tu mano') ||
            msg.includes('No hay jugadas')
        );
        if (esBajada && buildingCards.size > 0) {
            const me = G?.jugadores?.[myIdx];
            if (me) {
                buildingCards.forEach((cards) => {
                    cards.forEach(carta => {
                        if (carta && !me.mano.some(c => c.id === carta.id)) me.mano.push(carta);
                    });
                });
                buildingCards.clear();
                if (msg.includes('BAJADA EN FALSO')) {
                    toast('⚠️ Las cartas regresaron a tus sobrantes. Penalizado 2 turnos.', 'red');
                    shakePlayerHeader(myIdx, { red: true });
                }
                render();
            }
        }
    });
    WS.on('room_closed', ({ msg }) => {
        clearActiveGameSession();
        toast(msg || 'La mesa fue cerrada por administración.', 'red');
        setTimeout(() => { location.href = '/'; }, 900);
    });
    WS.on('progreso', (p) => {
        if (!p) return;
        const stored = JSON.parse(localStorage.getItem('usuario') || '{}');
        const next = { ...stored, xp: p.xpTotal, nivel: p.nivel, badge: p.badge || stored.badge };
        localStorage.setItem('usuario', JSON.stringify(next));
        window.AUTH = window.AUTH
            ? { ...window.AUTH, usuario: { ...(window.AUTH.usuario || {}), ...next } }
            : window.AUTH;

        const reduced = typeof window.matchMedia === 'function'
            && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

        if (p.subioNivel) {
            enqueueNotif('level', {
                icon: '🎉',
                title: `¡Subiste al nivel ${p.nivel}!`,
                desc: p.nuevoTitulo ? `Nuevo título: «${escapeHtml(p.nuevoTitulo)}»` : '',
                xp: p.xpGanada ? `+${p.xpGanada} XP` : '',
            });
            if (Anim.confetti && !reduced) {
                Anim.confetti(window.innerWidth / 2, window.innerHeight * 0.4, 90);
            }
        }
        (p.nuevosLogros || []).forEach(l => {
            enqueueNotif('logro', {
                icon: l.icono ? `<i class="ph ph-${l.icono}"></i>` : '🏅',
                title: l.nombre || 'Logro desbloqueado',
                desc: l.titulo ? `Título «${escapeHtml(l.titulo)}» desbloqueado` : 'Nuevo logro conseguido',
                xp: [
                    l.xp ? `+${l.xp} XP` : '',
                    l.fichas ? `+${Number(l.fichas).toLocaleString('es-MX')} fichas` : '',
                ].filter(Boolean).join(' · '),
            });
        });
        if (p.fichasBonus > 0 && !(p.nuevosLogros || []).length) {
            enqueueNotif('logro', {
                icon: '🪙',
                title: 'Fichas ganadas',
                desc: 'Por tu partida',
                xp: `+${Number(p.fichasBonus).toLocaleString('es-MX')}`,
            });
        }
    });
}

// ── Cola de notificaciones (logros / XP / nivel) ──────────────────
function enqueueNotif(kind, { icon, title, desc, xp } = {}) {
    const stack = document.getElementById('notif-stack');
    if (!stack) return;
    const card = document.createElement('div');
    card.className = `notif-card${kind === 'level' ? ' level' : ''}`;
    card.innerHTML = `
        <div class="notif-icon">${icon || '🏅'}</div>
        <div class="notif-body">
            <div class="notif-title">${title || ''}</div>
            ${desc ? `<div class="notif-desc">${desc}</div>` : ''}
        </div>
        ${xp ? `<div class="notif-xp">${xp}</div>` : ''}
    `;
    stack.appendChild(card);
    while (stack.children.length > 4) stack.firstElementChild.remove();
    const dismiss = () => {
        card.classList.add('out');
        card.style.animation = 'notifOut .28s cubic-bezier(.22,1,.36,1) both';
        setTimeout(() => card.remove(), 320);
    };
    const t = setTimeout(dismiss, 4000);
    card.addEventListener('click', () => { clearTimeout(t); dismiss(); });
    card.addEventListener('animationend', (e) => { if (e.animationName === 'notifIn') card.style.animation = ''; });
}

// ═══════════════════════════════════════════════════
// EVENTOS / ANIMACIONES
// ═══════════════════════════════════════════════════

async function applyEvent(event, data, prev) {
    if (!event || !data) return;
    switch (event) {
        case 'game_started':
        case 'nueva_ronda':
            await handleNewRound(); break;
        case 'tomar_mazo':
            await handleTomarMazo(data); break;
        case 'tomar_fondo':
            await handleTomarFondo(data); break;
        case 'pagar':
            await handlePagar(data); break;
        case 'bajar':
            await handleBajar(data); break;
        case 'castigo_acepta':
        case 'castigo_pasa':
            castigoEnviado = false;
            if (event === 'castigo_acepta') {
                await handleCastigo(data);
            }
            break;
        case 'intercambiar_comodin':
            await handleIntercambiarComodin(data); break;
        case 'fin_ronda':
            await handleFinRonda(data); break;
        case 'fin_juego':
            await handleFinJuego(data); break;
        case 'esperando_siguiente_ronda':
            break;
    }
}

async function handleNewRound() {
    ackSent = false;
    intercambioMode = false;
    selectedComodinInfo = null;
    buildingCards.clear();
    _animatedBajadas.clear();

    const mazoEl  = document.getElementById('mazo-wrap');
    const handZone = document.getElementById('discard-zone');
    const mano     = G.jugadores[myIdx]?.mano || [];

    // 0. Renderizar asientos (mano oculta) y animar el ante al pozo
    //    en mesas con apuesta, ANTES de barajar y repartir.
    hideHandDuringDeal = true;
    render();
    if (G?.conApuesta) {
        const seats = [...document.querySelectorAll('#opponents .opp')];
        const mySeat = document.querySelector('.player-header');
        if (mySeat) seats.push(mySeat);
        await Anim.betChipsToPot({
            seats,
            potEl: document.getElementById('pot-area'),
            chipsPerSeat: 2,
            stagger: 110,
            flight: 560,
        });
    }

    // 1. Shuffle del mazo
    await Anim.shuffleAnim(mazoEl);

    // 2. Render final (mano oculta) justo antes de repartir
    render();

    // 3. Ocultar cartas para la animación de reparto
    const cardEls = handZone?.querySelectorAll('.card');
    cardEls?.forEach(el => { el.style.opacity = '0'; el.style.transition = 'none'; });

    // Esperar un frame para que el DOM esté listo
    await new Promise(r => requestAnimationFrame(r));
    await new Promise(r => requestAnimationFrame(r));

    if (!mazoEl || !handZone || !mano.length) {
        hideHandDuringDeal = false;
        renderHand();
        return;
    }

    await Anim.dealAnim(mazoEl, handZone, mano, 0, {
        stepDelay: 82,
        duration: 255,
        hold: 225,
        preScale: 1.06,
        revealOptions: {
            opacityDuration: 110,
            scaleDuration: 150,
            scaleFrom: 1.04,
            settleDelay: 55,
        },
    });

    hideHandDuringDeal = false;
}

// Feedback visual sobre la tarjeta de un oponente (destello + texto flotante)
function oppFlash(jugadorIdx, { color = 'rgba(255,255,255,.25)', text = '', glow = '0 0 16px' } = {}) {
    const oppEl = document.querySelector(`.opp[data-idx="${jugadorIdx}"]`);
    if (!oppEl) return;
    oppEl.style.transition = 'box-shadow .15s ease, border-color .15s ease';
    oppEl.style.boxShadow = `${glow} ${color}`;
    setTimeout(() => { oppEl.style.boxShadow = ''; }, 450);
    if (text) {
        const rect = oppEl.getBoundingClientRect();
        const txt = document.createElement('div');
        txt.textContent = text;
        txt.style.cssText = `
            position: fixed; z-index: 9900; pointer-events: none;
            left: ${rect.left + rect.width / 2}px; top: ${rect.top}px;
            transform: translate(-50%, -6px);
            font-size: .7rem; font-weight: 700; color: #e8d9a8;
            text-shadow: 0 1px 4px rgba(0,0,0,.6);
            opacity: 0;
            animation: oppFloatUp .8s cubic-bezier(.22,1,.36,1) forwards;
        `;
        document.body.appendChild(txt);
        setTimeout(() => txt.remove(), 850);
    }
}

// Sacudida + flash en el header del jugador (castigo / bajada en falso)
function shakePlayerHeader(jugadorIdx, { red = true } = {}) {
    const el = jugadorIdx === myIdx
        ? document.querySelector('.player-header')
        : document.querySelector(`.opp[data-idx="${jugadorIdx}"]`);
    if (!el) return;
    el.classList.remove('player-shake', 'player-flash-red');
    void el.offsetWidth;
    el.classList.add('player-shake');
    if (red) el.classList.add('player-flash-red');
    setTimeout(() => {
        el.classList.remove('player-shake', 'player-flash-red');
    }, 720);
}

async function handleTomarMazo(data) {
    if (data.jugadorIdx === myIdx) {
        const mazoEl    = document.getElementById('mazo-wrap');
        const handZone  = document.getElementById('discard-zone');
        if (!mazoEl || !handZone) return;

        const src = mazoEl.getBoundingClientRect();

        // Render con la carta nueva ya en mano pero oculta
        render();
        const newCardEl = handZone.querySelector(`.card[data-id="${data.carta?.id}"]`);
        if (newCardEl) {
            newCardEl.style.opacity    = '0';
            newCardEl.style.transition = 'none';
        }

        await new Promise(r => requestAnimationFrame(r));

        await Anim.transferGhostToTarget(mazoEl, newCardEl || handZone, {
            useBackSkin: true,
            duration: 300,
            hold: 280,
            preScale: 1.1,
            endBoxShadow: '0 0 20px rgba(200,160,69,.5)'
        });

        if (newCardEl) Anim.revealCard(newCardEl);

    } else {
        // Otro jugador robó — destello dorado + indicador flotante
        oppFlash(data.jugadorIdx, { color: 'rgba(200,160,69,.5)', text: '⬆ Roba del mazo', glow: '0 0 18px' });
    }
}

async function handleTomarFondo(data) {
    if (data.jugadorIdx === myIdx) {
        const fondoEl  = document.getElementById('fondo-wrap');
        const handZone = document.getElementById('discard-zone');
        if (!fondoEl || !handZone) return;
        const srcCard = fondoEl.querySelector('.card');
        render();
        const newCardEl = handZone.querySelector(`.card[data-id="${data.carta?.id}"]`);
        if (newCardEl) { newCardEl.style.opacity = '0'; newCardEl.style.transition = 'none'; }
        await new Promise(r => requestAnimationFrame(r));

        await Anim.transferGhostToTarget(srcCard || fondoEl, newCardEl || handZone, {
            templateEl: srcCard || null,
            useBackSkin: !srcCard,
            duration: 320,
            hold: 300,
            preScale: 1.05,
            perspective: 600,
            rotateYStart: 0,
            rotateYEnd: 360,
            endBoxShadow: '0 0 20px rgba(200,160,69,.6)'
        });

        if (newCardEl) Anim.revealCard(newCardEl);
    } else {
        oppFlash(data.jugadorIdx, { color: 'rgba(200,160,69,.7)', text: '⬆ Toma del fondo', glow: '0 0 18px' });
    }
}

async function handleCastigo(data) {
    if (data.jugadorIdx === myIdx) {
        const fondoEl  = document.getElementById('fondo-wrap');
        const mazoEl   = document.getElementById('mazo-wrap');
        const handZone = document.getElementById('discard-zone');
        if (!fondoEl || !mazoEl || !handZone) return;

        const fondoCard = fondoEl.querySelector('.card');

        // Flash en el fondo
        fondoEl.style.transition = 'transform 120ms ease, box-shadow 120ms ease';
        fondoEl.style.transform  = 'scale(1.15)';
        fondoEl.style.boxShadow  = '0 0 40px rgba(200,160,69,.9)';
        setTimeout(() => { fondoEl.style.transform = 'scale(1)'; fondoEl.style.boxShadow = ''; }, 150);

        render();

        await new Promise(r => requestAnimationFrame(r));
        await new Promise(r => requestAnimationFrame(r));

        // Buscar cartas nuevas por ID
        let newCards = [];
        if (data.cartaFondo?.id && data.cartaMazo?.id) {
            const e1 = handZone.querySelector(`.card[data-id="${data.cartaFondo.id}"]`);
            const e2 = handZone.querySelector(`.card[data-id="${data.cartaMazo.id}"]`);
            newCards = [e1, e2].filter(Boolean);
        }
        // Fallback: últimas 2 cartas
        if (newCards.length < 2) newCards = [...handZone.querySelectorAll('.card')].slice(-2);
        if (newCards.length < 2) return;

        newCards.forEach(el => { el.style.opacity = '0'; el.style.transition = 'none'; });

        const firstTarget = newCards[0];
        const secondTarget = newCards[1];

        await Promise.all([
            Anim.transferGhostToTarget(fondoCard || fondoEl, firstTarget, {
                templateEl: fondoCard || null,
                useBackSkin: !fondoCard,
                duration: 320,
                hold: 320,
                preScale: 1,
                endBoxShadow: '0 0 20px rgba(200,160,69,.6)'
            }),
            (async () => {
                await new Promise(r => setTimeout(r, 120));
                await Anim.transferGhostToTarget(mazoEl, secondTarget, {
                    useBackSkin: true,
                    duration: 260,
                    hold: 260,
                    preScale: 1,
                    endBoxShadow: '0 0 20px rgba(200,160,69,.6)'
                });
            })()
        ]);

        newCards.forEach(el => Anim.revealCard(el));
        shakePlayerHeader(myIdx, { red: false });

    } else {
        // Otro jugador se castigó
        animateCastigo(data.jugadorIdx);
    }
}

async function handlePagar(data) {
    if (data.jugadorIdx !== myIdx) {
        const oppEl = document.querySelector(`.opp[data-idx="${data.jugadorIdx}"]`);
        const fondoW = document.getElementById('fondo-wrap');
        if (oppEl && fondoW) await Anim.rivalPaysToFondo(oppEl, fondoW, null);
    }
}



// Flash + texto "¡SE BAJÓ!" sobre la tarjeta del oponente
function animateOponenteBajo(jugadorIdx) {
    const oppEl = document.querySelector(`.opp[data-idx="${jugadorIdx}"]`);
    if (!oppEl) return;

    // Flash en la tarjeta
    oppEl.style.transition = 'box-shadow .15s ease, border-color .15s ease';
    oppEl.style.boxShadow  = '0 0 30px rgba(200,160,69,.9), 0 0 60px rgba(200,160,69,.4)';
    oppEl.style.borderColor = 'rgba(200,160,69,.9)';
    setTimeout(() => {
        oppEl.style.boxShadow   = '';
        oppEl.style.borderColor = '';
    }, 800);

    // Texto flotante "¡SE BAJÓ!"
    const rect = oppEl.getBoundingClientRect();
    const txt  = document.createElement('div');
    txt.textContent = '¡SE BAJÓ!';
    txt.style.cssText = `
        position:fixed;
        left:${rect.left + rect.width / 2}px;
        top:${rect.top}px;
        transform:translate(-50%, -10px);
        font-family:'Cormorant Garamond',serif;
        font-size:1.3rem;
        font-weight:700;
        color:#ffe066;
        text-shadow:0 0 20px rgba(200,160,69,.8), 0 2px 8px rgba(0,0,0,.8);
        pointer-events:none;
        z-index:9999;
        white-space:nowrap;
        animation:floatUp .9s cubic-bezier(.22,1,.36,1) forwards;
    `;
    document.body.appendChild(txt);
    setTimeout(() => txt.remove(), 1000);

    // Partículas doradas
    Anim.spawnParticles(rect.left + rect.width / 2, rect.top + rect.height / 2, 14);
}

function animateCastigo(jugadorIdx) {
    const oppEl = document.querySelector(`.opp[data-idx="${jugadorIdx}"]`);
    if (!oppEl) return;

    // Sacudida + flash naranja en la tarjeta
    shakePlayerHeader(jugadorIdx, { red: false });
    oppEl.style.transition = 'box-shadow .15s ease, border-color .15s ease';
    oppEl.style.boxShadow  = '0 0 30px rgba(255,140,0,.9), 0 0 60px rgba(255,140,0,.4)';
    oppEl.style.borderColor = 'rgba(255,140,0,.9)';
    setTimeout(() => {
        oppEl.style.boxShadow   = '';
        oppEl.style.borderColor = '';
    }, 800);

    // Texto flotante "¡CASTIGO!"
    const rect = oppEl.getBoundingClientRect();
    const txt  = document.createElement('div');
    txt.textContent = '¡CASTIGO!';
    txt.style.cssText = `
        position:fixed;
        left:${rect.left + rect.width / 2}px;
        top:${rect.top}px;
        transform:translate(-50%, -10px);
        font-family:'Cormorant Garamond',serif;
        font-size:1.3rem;
        font-weight:700;
        color:#ff8c00;
        text-shadow:0 0 20px rgba(255,140,0,.8), 0 2px 8px rgba(0,0,0,.8);
        pointer-events:none;
        z-index:9999;
        white-space:nowrap;
        animation:floatUp .9s cubic-bezier(.22,1,.36,1) forwards;
    `;
    document.body.appendChild(txt);
    setTimeout(() => txt.remove(), 1000);

    // Partículas naranjas
    const colors = ['#ff8c00', '#ffa500', '#ffb732', '#fff'];
    Anim.spawnParticles(rect.left + rect.width / 2, rect.top + rect.height / 2, 14);
}

async function handleBajar(data) {
    // Si otro jugador se bajó — mostrar animación de atención
    if (data.jugadorIdx !== myIdx) {
        animateOponenteBajo(data.jugadorIdx);
        render();
        restoreAnimatedBajadas();
        return;
    }
    if (data.jugadorIdx === myIdx) {
        const discardZone = document.getElementById('discard-zone');
        const buildingRow = document.getElementById('building-row');

        // 1. Capturar clones visuales ANTES de tocar el DOM
        const allCardEls = [
            ...(discardZone?.querySelectorAll('.card') || []),
            ...(buildingRow?.querySelectorAll('.card')  || []),
        ];

        // Crear ghosts fijos en su posición actual
        const ghosts = allCardEls.map(el => {
            const rect  = el.getBoundingClientRect();
            const ghost = el.cloneNode(true);
            ghost.style.cssText = `
                position:fixed; z-index:9990; pointer-events:none;
                width:${rect.width}px; height:${rect.height}px;
                left:${rect.left}px; top:${rect.top}px;
                border-radius:var(--r);
                box-shadow:0 8px 24px rgba(0,0,0,.5);
                transition:none;
            `;
            document.body.appendChild(ghost);
            return { ghost, rect };
        });

        // 2. Actualizar estado y renderizar mesa con bajadas (ocultas)
        buildingCards.clear();
        render();

        await new Promise(r => requestAnimationFrame(r));
        await new Promise(r => requestAnimationFrame(r));

        // 3. Destino: tu bajada en el anillo inferior del fieltro
        const bajadas   = document.getElementById('felt-plays')?.querySelector(`.seat-plays[data-pi="${myIdx}"]`);
        const slotArr   = bajadas?.querySelectorAll('.bajada-pile-cards') || [];
        const dstEl     = slotArr[0] || bajadas;
        const dstRect   = dstEl?.getBoundingClientRect();

        if (!dstRect) {
            ghosts.forEach(({ ghost }) => ghost.remove());
            return;
        }

        // 4. Animar cada ghost volando al destino
        const perSlot = Math.max(1, Math.ceil(ghosts.length / Math.max(slotArr.length, 1)));

        ghosts.forEach(({ ghost, rect }, i) => {
            const slotIdx  = Math.floor(i / perSlot);
            const targetEl = slotArr[slotIdx] || dstEl;
            const tRect    = targetEl?.getBoundingClientRect() || dstRect;

            const delay = i * 60;

            setTimeout(() => {
                ghost.style.transition = 'all 150ms cubic-bezier(.34,1.56,.64,1)';
                ghost.style.transform  = `translateY(-20px) scale(1.1) rotate(${(Math.random()-.5)*8}deg)`;

                setTimeout(() => {
                    const dx = tRect.left + tRect.width  / 2 - rect.left - rect.width  / 2;
                    const dy = tRect.top  + tRect.height / 2 - rect.top  - rect.height / 2;

                    ghost.style.transition = 'all 360ms cubic-bezier(.22,1,.36,1)';
                    ghost.style.transform  = `translate(${dx}px, ${dy}px) scale(.9) rotate(0deg)`;
                    ghost.style.boxShadow  = '0 0 20px rgba(200,160,69,.7)';

                    setTimeout(() => {
                        ghost.style.transition = 'all 80ms ease';
                        ghost.style.transform  = `translate(${dx}px, ${dy}px) scale(1.06)`;
                        ghost.style.boxShadow  = '0 0 40px rgba(200,160,69,1)';

                        Anim.spawnParticles(
                            tRect.left + tRect.width  / 2,
                            tRect.top  + tRect.height / 2,
                            8
                        );

                        setTimeout(() => {
                            ghost.style.transition = 'opacity 100ms ease';
                            ghost.style.opacity    = '0';
                            setTimeout(() => ghost.remove(), 110);
                        }, 90);
                    }, 340);
                }, 160);
            }, delay);
        });

        await new Promise(r => setTimeout(r, ghosts.length * 60 + 700));


    }
}

async function handleIntercambiarComodin(data) {
    if (data.jugadorIdx === myIdx) {
        toast('Intercambiaste una carta por un comodín', 'green');
    } else if (data.origenJugadorIdx === myIdx) {
        toast('Te intercambiaron un comodín de tus jugadas', 'yellow');
    }
}

async function handleFinRonda(data) {
    // Primero float scores
    setTimeout(() => {
        G.jugadores.forEach((j, i) => {
            const pts = data.puntos?.[i];
            if (!pts) return;
            const el = i === myIdx
                ? document.getElementById('my-name')
                : document.querySelector(`.opp[data-idx="${i}"] .opp-name`);
            if (el) Anim.floatScore(el, pts.pts_r, pts.pts_r === 0);
        });
    }, 300);

    // Luego animación de conteo si hay manosFinales
    const delay = data.manosFinales?.some(m => m.mano?.length > 0) ? 800 : 900;
    setTimeout(async () => {
        if (data.manosFinales?.some(m => m.mano?.length > 0)) {
            await showConteoCartas(data.manosFinales, data.ganadorIdx);
        }
        showModalRonda(data);
    }, delay);
}

async function handleFinJuego(data) {
    hideNextRoundWait();
    document.getElementById('modal-ronda')?.classList.remove('show');

    setTimeout(() => {
        G.jugadores.forEach((j, i) => {
            const pts = data.puntos?.[i];
            if (!pts) return;
            const el = i === myIdx
                ? document.getElementById('my-name')
                : document.querySelector(`.opp[data-idx="${i}"] .opp-name`);
            if (el) Anim.floatScore(el, pts.pts_r, pts.pts_r === 0);
        });
    }, 300);

    const delay = data.manosFinales?.some(m => m.mano?.length > 0) ? 800 : 900;
    setTimeout(async () => {
        if (data.manosFinales?.some(m => m.mano?.length > 0)) {
            await showConteoCartas(data.manosFinales, data.ganadorIdx);
        }
        showModalJuego(data);
    }, delay);
}

function getCartaConteoCompleta(carta) {
    const PUNTOS_CONTEO = {
        'A': 20, 'J': 10, 'Q': 10, 'K': 10, '10': 10,
        '9': 10, '8': 10, '2': 5, '3': 5, '4': 5, '5': 5, '6': 5, '7': 5
    };

    if (!carta || carta.hidden || (!carta.comodin && !carta.valor)) {
        const fallbackMap = new Map();

        const me = G?.jugadores?.[myIdx];
        (me?.mano || []).forEach(c => {
            if (c?.id != null) fallbackMap.set(c.id, c);
        });

        buildingCards.forEach(cards => {
            cards.forEach(c => {
                if (c?.id != null) fallbackMap.set(c.id, c);
            });
        });

        const fallback = fallbackMap.get(carta?.id);
        if (fallback) {
            return {
                ...fallback,
                pts: fallback.comodin ? 50 : (PUNTOS_CONTEO[fallback.valor] || 10),
            };
        }
    }

    return carta;
}

async function showConteoCartas(manosFinales, ganadorIdx) {
    return new Promise(resolve => {
        const PUNTOS_CLIENT = {
            'A': 20, 'J': 10, 'Q': 10, 'K': 10, '10': 10,
            '9': 10, '8': 10, '2': 5, '3': 5, '4': 5, '5': 5, '6': 5, '7': 5
        };
        const SUIT_CLS_LOCAL = { '♠': 'blk-s', '♥': 'red-s', '♦': 'red-s', '♣': 'blk-s' };
        const compact = window.innerWidth <= 575;
        const rowDelay = compact ? 140 : 200;
        const cardDelay = compact ? 130 : 180;
        const badgeDelay = compact ? 110 : 150;
        const outroDelay = compact ? 1400 : 1800;

        // Solo jugadores con cartas
        const perdedores = manosFinales
            .map(m => ({
                ...m,
                mano: (m.mano || []).map(carta => getCartaConteoCompleta(carta)),
            }))
            .filter(m => m.mano?.length > 0);
        if (!perdedores.length) { resolve(); return; }

        // Overlay
        const overlay = document.createElement('div');
        overlay.className = 'conteo-overlay';
        document.body.appendChild(overlay);

    // Confeti (si la capa GSAP está disponible)
    if (Anim.confetti) Anim.confetti(window.innerWidth / 2, window.innerHeight * 0.4, 80);

        // Título
        const titulo = document.createElement('div');
        titulo.className = 'conteo-title';
        titulo.textContent = '🃏 Conteo de cartas';
        overlay.appendChild(titulo);

        // Contenedor de filas por jugador
        const rows = document.createElement('div');
        rows.className = 'conteo-rows';
        overlay.appendChild(rows);

        requestAnimationFrame(() => {
            requestAnimationFrame(() => {
                overlay.style.opacity = '1';
                overlay.style.transform = 'scale(1)';
                titulo.style.opacity = '1';
                titulo.style.transform = 'translateY(0)';
            });
        });

        let allDone = 0;
        const totalPerdedores = perdedores.length;

        perdedores.forEach((m, pi) => {
            // Fila del jugador
            const row = document.createElement('div');
            row.className = 'conteo-row';

            // Header con nombre y total
            const header = document.createElement('div');
            header.className = 'conteo-row-head';
            const nombre = document.createElement('span');
            nombre.className = 'conteo-row-name';
            nombre.textContent = m.nombre;
            const total = document.createElement('span');
            total.className = 'conteo-total';
            total.textContent = '0 pts';
            header.appendChild(nombre);
            header.appendChild(total);
            row.appendChild(header);

            // Cartas
            const cardsRow = document.createElement('div');
            cardsRow.className = 'conteo-cards';
            row.appendChild(cardsRow);
            rows.appendChild(row);

            setTimeout(() => {
                row.style.opacity = '1';
                row.style.transform = 'translateY(0) scale(1)';
            }, pi * 70);

            // Animar cartas una por una
            let acum = 0;
            m.mano.forEach((carta, ci) => {
                setTimeout(() => {
                    // Crear carta
                    const cardEl = document.createElement('div');
                    const pts = carta.pts || (carta.comodin ? 50 : (PUNTOS_CLIENT[carta.valor] || 10));

                    if (carta.comodin) {
                        cardEl.innerHTML = `<div style="font-size:.6rem">🃏</div>`;
                        cardEl.style.cssText = `
                            width:28px;height:40px;border-radius:4px;
                            background:linear-gradient(135deg,#4a2080,#2a1040);
                            border:1px solid rgba(255,220,100,.4);
                            display:flex;align-items:center;justify-content:center;
                            transform:perspective(400px) rotateY(90deg) translateY(8px) scale(.86);
                            opacity:0;
                            transition:transform 260ms cubic-bezier(.22,1,.36,1), opacity 180ms ease, box-shadow 180ms ease;
                            flex-shrink:0;
                            box-shadow:0 10px 24px rgba(18,6,40,.36);
                        `;
                    } else if (!carta?.valor || !carta?.palo) {
                        cardEl.innerHTML = `<div style="font-size:.7rem;color:#c8a045">?</div>`;
                        cardEl.style.cssText = `
                            width:28px;height:40px;border-radius:4px;
                            background:linear-gradient(135deg,#1f355f,#0d1c36);
                            border:1px solid rgba(255,255,255,.18);
                            display:flex;align-items:center;justify-content:center;
                            transform:perspective(400px) rotateY(90deg) translateY(8px) scale(.86);
                            opacity:0;
                            transition:transform 260ms cubic-bezier(.22,1,.36,1), opacity 180ms ease, box-shadow 180ms ease;
                            flex-shrink:0; position:relative;
                            box-shadow:0 10px 24px rgba(9,18,40,.3);
                        `;
                    } else {
                        const sc = SUIT_CLS_LOCAL[carta.palo] || '';
                        const isRed = sc === 'red-s';
                        cardEl.innerHTML = `
                            <div style="font-size:.55rem;font-weight:700;color:${isRed?'#e05050':'#1b1b1b'};line-height:1.1;text-align:center">
                                ${carta.valor}<br>${carta.palo}
                            </div>`;
                        cardEl.style.cssText = `
                            width:28px;height:40px;border-radius:4px;
                            background:#f5f0e8; border:1px solid rgba(0,0,0,.15);
                            display:flex;align-items:center;justify-content:center;
                            transform:perspective(400px) rotateY(90deg) translateY(8px) scale(.86);
                            opacity:0;
                            transition:transform 260ms cubic-bezier(.22,1,.36,1), opacity 180ms ease, box-shadow 180ms ease;
                            flex-shrink:0; position:relative;
                            box-shadow:0 10px 24px rgba(20,14,8,.18);
                        `;
                    }
                    cardsRow.appendChild(cardEl);

                    // Aparecer con flip suave
                    requestAnimationFrame(() => {
                        requestAnimationFrame(() => {
                            cardEl.style.opacity = '1';
                            cardEl.style.transform = 'perspective(400px) rotateY(0deg) translateY(0) scale(1)';
                            cardEl.style.boxShadow = '0 14px 26px rgba(0,0,0,.2), 0 0 0 1px rgba(255,255,255,.05) inset';
                            SFX.play('carta');
                        });
                    });

                    // Badge de puntos sobre la carta
                    setTimeout(() => {
                        const badge = document.createElement('div');
                        badge.textContent = `+${pts}`;
                        badge.style.cssText = `
                            position:absolute; top:-8px; right:-4px;
                            background:var(--gold); color:#0b1e12;
                            font-size:.5rem; font-weight:700;
                            border-radius:8px; padding:1px 4px;
                            pointer-events:none; z-index:1;
                            animation:popIn .2s cubic-bezier(.34,1.56,.64,1) both, floatUp .9s cubic-bezier(.22,1,.36,1) .28s both;
                            box-shadow:0 8px 14px rgba(200,160,69,.22);
                        `;
                        cardEl.style.position = 'relative';
                        cardEl.appendChild(badge);

                        // Sumar al total
                        acum += pts;
                        total.textContent = `${acum} pts`;
                        if (acum > 0) total.style.color = '#ff7070';
                        total.style.transform = 'scale(1.08)';
                        setTimeout(() => { total.style.transform = 'scale(1)'; }, 120);

                        if (ci === m.mano.length - 1) {
                            row.style.borderColor = 'rgba(200,160,69,.36)';
                            row.style.boxShadow = '0 20px 40px rgba(0,0,0,.28), 0 0 0 1px rgba(200,160,69,.08) inset';
                        }

                        // Último
                        if (ci === m.mano.length - 1) {
                            allDone++;
                            if (allDone === totalPerdedores) {
                                // Esperar y cerrar
                                setTimeout(() => {
                                    overlay.style.transition = 'opacity 400ms ease, transform 400ms cubic-bezier(.22,1,.36,1)';
                                    overlay.style.opacity = '0';
                                    overlay.style.transform = 'scale(1.015)';
                                    setTimeout(() => { overlay.remove(); resolve(); }, 400);
                                }, outroDelay);
                            }
                        }
                    }, badgeDelay);

                }, pi * rowDelay + ci * cardDelay);
            });
        });
    });
}

// ═══════════════════════════════════════════════════
// ACCIONES DEL JUGADOR
// ═══════════════════════════════════════════════════

function isMyTurn() { return myIdx === G?.turno; }
function isPayable() { return isMyTurn() && ['esperando_accion', 'esperando_pago'].includes(G?.estado); }

function acMazo() {
    if (!isMyTurn() || G.estado !== 'esperando_robo') return;
    cancelIntercambio();
    SFX.play('robar');
    WS.send({ type: 'tomar_mazo' });
}

function acFondo() {
    if (!isMyTurn() || G.estado !== 'esperando_robo') return;
    if (G.jugadores[myIdx]?.bajado) { toast('Ya te bajaste.'); return; }
    cancelIntercambio();
    WS.send({ type: 'tomar_fondo' });
}

function acFondoDrag() {
    WS.send({ type: 'tomar_fondo' });
    cancelIntercambio();
}

function acCastigo(acepta) {
    if (G.estado !== 'fase_castigo') {
        console.warn("🚫 Intento de castigo fuera de fase");
        return;
    }
    if (castigoEnviado) return;
    pendingCastigo = {
        acepta,
        room: ROOM,
        playerId: MY_ID,
        castigo_idx: G.castigo_idx,
        turno: G.turno,
        sentAt: Date.now(),
        replayedSocketId: null,
    };
    castigoEnviado = true;
    console.log('[GAME] enviar castigo', { pendingCastigo });
    WS.send({ type: 'castigo', acepta });
}

function acBajar() {
    if (!slotsListosParaBajar()) { toast('❌ Completa las jugadas requeridas en los slots antes de bajarte'); return; }
    const defs = getSlotDefsRonda(G.ronda);
    const jugadas = [];
    for (const def of defs) {
        const cards = buildingCards.get(def.index) || [];
        if (cards.length === 0) continue;
        const cartasReales = cards.filter(Boolean);
        if (cartasReales.length === 0) continue;
        jugadas.push({ tipo: def.type, cartas: cartasReales });
    }
    if (jugadas.length === 0) { toast('❌ No hay cartas en los slots de construcción'); return; }
    SFX.play('bajar');
    WS.send({ type: 'bajar', jugadas });
    cancelIntercambio();
}

function acPagar(cartaId) {
    const id = cartaId || selId;
    if (!id) { toast('Selecciona una carta para pagar.'); return; }
    buildingCards.forEach((cards, slotIndex) => {
        const index = cards.findIndex(c => c.id === id);
        if (index > -1) {
            cards.splice(index, 1);
            if (cards.length === 0) buildingCards.delete(slotIndex);
            updateSlotUI(slotIndex, cards);
        }
    });
    SFX.play('pagar');
    WS.send({ type: 'pagar', cartaId: id });
    selId = null;
    cancelIntercambio();
}

function acAcomodar(cartaId, destJugadorIdx, destJugadaIdx, posicion = null) {
    const me = G?.jugadores?.[myIdx];
    const jugada = G?.jugadores?.[destJugadorIdx]?.jugadas?.[destJugadaIdx];

    // Solo preguntar alta/baja cuando:
    //   1. El jugador YA está bajado (está acomodando sobrantes)
    //   2. La jugada destino es una corrida
    //   3. No tiene posición elegida todavía
    // Buscar si la carta es joker en la mano (puede venir de intercambio reciente)
    if (me?.bajado && jugada?.tipo === 'corrida' && posicion === null) {
        const carta = me?.mano?.find(c => c.id === cartaId);
        if (carta?.comodin) {
            mostrarSelectorPosicionJoker(cartaId, destJugadorIdx, destJugadaIdx, jugada);
            return;
        }
    }

    buildingCards.forEach((cards, slotIndex) => {
        const index = cards.findIndex(c => c.id === cartaId);
        if (index > -1) {
            cards.splice(index, 1);
            if (cards.length === 0) buildingCards.delete(slotIndex);
            updateSlotUI(slotIndex, cards);
        }
    });

    WS.send({ type: 'acomodar', cartaId, destJugadorIdx, destJugadaIdx, posicion: posicion || null });
    selId = null;
    cancelIntercambio();
}

// ─────────────────────────────────────────────────────────────────────────────
// mostrarSelectorPosicionJoker
// Muestra un mini-modal inline en las bajadas preguntando si el joker
// va como carta ALTA (final de la corrida) o BAJA (inicio de la corrida).
// Muestra el contexto: "5♦ 6♦ 7♦ 8♦ → ¿Joker como 4♦ o 9♦?"
// ─────────────────────────────────────────────────────────────────────────────
function mostrarSelectorPosicionJoker(cartaId, destJugadorIdx, destJugadaIdx, jugada) {
    const renderMiniCarta = ({ valor, palo, comodin = false, resaltada = false }) => {
        if (comodin) {
            return `
                <div class="mini-card joker${resaltada ? ' resaltada' : ''}">
                    <span>🃏</span><span class="mc-lbl">JOKER</span>
                </div>
            `;
        }

        const isRed = palo === '♥' || palo === '♦';
        return `
            <div class="mini-card natural${resaltada ? ' resaltada' : ''}" style="color:${isRed ? '#d84c4c' : '#1d2430'}">
                <div class="mc-corner tl">${valor}<br>${palo}</div>
                <div class="mc-suit" style="color:${isRed ? '#d84c4c' : '#1d2430'}">${palo}</div>
                <div class="mc-corner br">${valor}<br>${palo}</div>
            </div>
        `;
    };

    // Calcular qué valor sería en cada posición para mostrarlo al usuario
    const VN_MAP = { A:1, 2:2, 3:3, 4:4, 5:5, 6:6, 7:7, 8:8, 9:9, 10:10, J:11, Q:12, K:13 };
    const VN_REV = {1:'A',2:'2',3:'3',4:'4',5:'5',6:'6',7:'7',8:'8',9:'9',10:'10',11:'J',12:'Q',13:'K',14:'A'};
    const normales = jugada.cartas.filter(c => !c.comodin);
    const palo = normales[0]?.palo || '';
    const vals = normales.map(c => VN_MAP[c.valor] || parseInt(c.valor)).sort((a, b) => a - b);

    // Detectar si hay As como 14
    const tieneAs = vals.includes(1);
    const tieneAltas = vals.some(v => v >= 11);
    const useA14 = tieneAs && tieneAltas && !vals.includes(2);
    const valsReales = vals.map(v => (v === 1 && useA14) ? 14 : v).sort((a, b) => a - b);

    const minVal = valsReales[0];
    const maxVal = valsReales[valsReales.length - 1];
    const valBaja = minVal - 1;
    const valAlta = maxVal + 1;

    const lblBaja = valBaja >= 1 ? `${VN_REV[valBaja] || valBaja}${palo}` : null;
    const lblAlta = valAlta <= 14 ? `${VN_REV[valAlta] || valAlta}${palo}` : null;
    const cartaBaja = valBaja >= 1 ? { valor: VN_REV[valBaja] || String(valBaja), palo } : null;
    const cartaAlta = valAlta <= 14 ? { valor: VN_REV[valAlta] || String(valAlta), palo } : null;

    // Quitar modal anterior si existe
    const prev = document.getElementById('joker-pos-modal');
    if (prev) prev.remove();

    const modal = document.createElement('div');
    modal.id = 'joker-pos-modal';
    modal.className = 'joker-modal-backdrop';

    const secuenciaHtml = jugada.cartas.map(c => renderMiniCarta(c)).join(`
        <div class="joker-seq-sep">+</div>
    `);

    modal.innerHTML = `
        <div class="joker-modal-box">
            <div class="joker-modal-title">¿Dónde va el 🃏 Joker?</div>
            <div class="joker-modal-seq">
                ${secuenciaHtml}
            </div>
            <div class="joker-pos-actions">
                ${lblBaja ? `<button class="joker-pos-btn" onclick="window._confirmarPosJoker('${cartaId}',${destJugadorIdx},${destJugadaIdx},'baja')">
                    <span class="lbl">⬅ Baja</span>
                    ${renderMiniCarta({ ...cartaBaja, resaltada: true })}
                    <small>${lblBaja}</small>
                </button>` : ''}
                ${lblAlta ? `<button class="joker-pos-btn" onclick="window._confirmarPosJoker('${cartaId}',${destJugadorIdx},${destJugadaIdx},'alta')">
                    <span class="lbl">Alta ➡</span>
                    ${renderMiniCarta({ ...cartaAlta, resaltada: true })}
                    <small>${lblAlta}</small>
                </button>` : ''}
                ${!lblBaja && !lblAlta ? `<span class="joker-modal-note">Solo hay una posición posible</span>` : ''}
            </div>
            <button class="joker-cancel" onclick="document.getElementById('joker-pos-modal').remove(); window.cancelIntercambio();">
                ✕ Cancelar
            </button>
        </div>
    `;

    document.body.appendChild(modal);

    // Si solo hay una opción, elegirla automáticamente sin preguntar
    if (!lblBaja && lblAlta) {
        modal.remove();
        acAcomodar(cartaId, destJugadorIdx, destJugadaIdx, 'alta');
    } else if (lblBaja && !lblAlta) {
        modal.remove();
        acAcomodar(cartaId, destJugadorIdx, destJugadaIdx, 'baja');
    }
}

window._confirmarPosJoker = function(cartaId, destJugadorIdx, destJugadaIdx, posicion) {
    const modal = document.getElementById('joker-pos-modal');
    if (modal) modal.remove();
    // cartaId viene del atributo HTML como string — convertir al tipo original
    // Los ids del engine son números, intentar parsear
    const id = isNaN(cartaId) ? cartaId : Number(cartaId);
    const ji = Number(destJugadorIdx);
    const jugi = Number(destJugadaIdx);
    acAcomodar(id, ji, jugi, posicion);
};

// ─────────────────────────────────────────────────────────────────────────────
// acIntercambiarComodin
// Ahora válido en esperando_accion (pre-bajada) Y esperando_pago (post-bajada).
// Post-bajada no manda jugadasEnSlots porque ya no tiene slots activos.
// ─────────────────────────────────────────────────────────────────────────────
function acIntercambiarComodin(cartaId, origenJugadorIdx, origenJugadaIdx) {
    if (!isMyTurn()) { toast('No es tu turno.'); return; }
    const estadosValidos = ['esperando_accion', 'esperando_pago'];
    if (!estadosValidos.includes(G.estado)) { toast('No puedes intercambiar en este momento.'); return; }

    const me = G.jugadores[myIdx];
    const jugadasEnSlots = [];

    // Solo manda slots si NO está bajado (pre-bajada)
    if (!me?.bajado) {
        const defs = getSlotDefsRonda(G.ronda);
        for (const def of defs) {
            const cards = buildingCards.get(def.index) || [];
            if (cards.length > 0) jugadasEnSlots.push({ tipo: def.type, cartas: cards.filter(Boolean) });
        }
    }

    WS.send({ type: 'intercambiar_comodin', cartaId, origenJugadorIdx, origenJugadaIdx, jugadasEnSlots });
    selId = null;
    cancelIntercambio();
}

// ─────────────────────────────────────────────────────────────────────────────
// activarModoIntercambio — permite intercambio manual (clic en joker)
// Ahora también funciona post-bajada en esperando_pago.
// ─────────────────────────────────────────────────────────────────────────────
function activarModoIntercambio(jugadorIdx, jugadaIdx, comodinId) {
    if (!isMyTurn()) { toast('No es tu turno para intercambiar.'); return; }
    const estadosValidos = ['esperando_accion', 'esperando_pago'];
    if (!estadosValidos.includes(G.estado)) { toast('No puedes intercambiar en este momento.'); return; }

    // Removemos la restricción de "me.bajado" — post-bajada también es válido
    if (!selId) { toast('Primero selecciona una carta de tu mano para intercambiar.'); return; }
    const me = G.jugadores[myIdx];
    const cartaSeleccionada = me?.mano?.find(c => c.id === selId);
    if (!cartaSeleccionada) { toast('Error: carta no encontrada.'); return; }
    if (cartaSeleccionada.comodin) { toast('No puedes intercambiar un comodín por otro comodín.'); return; }

    intercambioMode = true;
    selectedComodinInfo = { jugadorIdx, jugadaIdx, comodinId };
    toast(`Intercambiarás ${cartaSeleccionada.valor}${cartaSeleccionada.palo || ''} por el comodín`, 'green');
    render();
}

function cancelIntercambio() {
    intercambioMode = false;
    selectedComodinInfo = null;
    _intercambiosCache.clear();
    render();
}

function ejecutarIntercambioDesdeKey(key) {
    const intercambio = _intercambiosCache.get(key);
    if (!intercambio) { toast('Intercambio no disponible, vuelve a intentar.'); return; }
    ejecutarIntercambioDirecto(intercambio);
}

// ─────────────────────────────────────────────────────────────────────────────
// ejecutarIntercambioDirecto
// Ahora maneja los dos casos:
//   esCasoBajado=false → pre-bajada, manda jugadasEnSlots para validación
//   esCasoBajado=true  → post-bajada, no manda slots, el server solo valida encaje
// ─────────────────────────────────────────────────────────────────────────────
function ejecutarIntercambioDirecto(intercambio) {
    if (!isMyTurn()) { toast('No es tu turno.'); return; }
    const estadosValidos = ['esperando_accion', 'esperando_pago'];
    if (!estadosValidos.includes(G.estado)) { toast('Solo puedes intercambiar después de robar.'); return; }

    const me = G.jugadores[myIdx];
    const carta = `${intercambio.cartaValor}${intercambio.cartaPalo}`;

    if (intercambio.esCasoBajado) {
        // Post-bajada: intercambio simple, sin slots
        toast(`🔄 Intercambiando ${carta} por el Joker…`, 'green');
        WS.send({
            type: 'intercambiar_comodin',
            cartaId: intercambio.cartaId,
            origenJugadorIdx: intercambio.jugadorIdx,
            origenJugadaIdx: intercambio.jugadaIdx,
            jugadasEnSlots: [],
        });
    } else {
        // Pre-bajada: incluye slots para validación
        const defs = getSlotDefsRonda(G.ronda);
        const jugadasEnSlots = [];
        for (const def of defs) {
            const cards = buildingCards.get(def.index) || [];
            if (cards.length > 0) jugadasEnSlots.push({ tipo: def.type, cartas: cards.filter(Boolean) });
        }
        if (jugadasEnSlots.length === 0) { toast('Arma tus jugadas en los slots antes de intercambiar.', 'red'); return; }
        toast(`🔄 Intercambiando ${carta} por el Joker…`, 'green');
        WS.send({
            type: 'intercambiar_comodin',
            cartaId: intercambio.cartaId,
            origenJugadorIdx: intercambio.jugadorIdx,
            origenJugadaIdx: intercambio.jugadaIdx,
            jugadasEnSlots,
        });
    }

    selId = null;
    cancelIntercambio();
}

function confirmarIntercambio() {
    if (!intercambioMode || !selectedComodinInfo || !selId) { cancelIntercambio(); return; }
    acIntercambiarComodin(selId, selectedComodinInfo.jugadorIdx, selectedComodinInfo.jugadaIdx);
}

function acReorder(draggedId, beforeId) {
    const me = G.jugadores[myIdx];
    if (!me) return;
    let slotOrigen = null;
    buildingCards.forEach((cards, slotIndex) => {
        if (cards.some(c => c.id === draggedId)) slotOrigen = slotIndex;
    });
    if (slotOrigen !== null) { toast('No puedes reordenar cartas que están en construcción'); return; }
    const fromIdx = me.mano.findIndex(c => c.id === draggedId);
    if (fromIdx < 0) return;
    let toIdx = beforeId;
    if (beforeId === Infinity || beforeId >= me.mano.length) toIdx = me.mano.length - 1;
    const newOrder = [...me.mano];
    const [moved] = newOrder.splice(fromIdx, 1);
    newOrder.splice(toIdx, 0, moved);
    me.mano = newOrder;
    renderHand();
    WS.send({ type: 'reordenar', order: newOrder.map(c => c.id) });
}

function selCard(id) {
    if (intercambioMode && selectedComodinInfo) {
        selId = id;
        confirmarIntercambio();
    } else {
        selId = selId === id ? null : id;
        renderHand();
        renderActions();
    }
}

function ackRonda() {
    if (ackSent) return;
    if (G?.ronda >= 7 || G?.estado === 'fin_juego') return;
    ackSent = true;
    document.getElementById('modal-ronda').classList.remove('show');
    const connected = getConnectedPlayers();
    showNextRoundWait({
        readyCount: 1,
        totalCount: connected.length || 1,
        waitingNames: connected
            .filter(j => j.id !== MY_ID)
            .map(j => j.nombre),
    });
    WS.send({ type: 'ack_fin_ronda' });
}

function getConnectedPlayers() {
    return (G?.jugadores || []).filter(j => j.conectado !== false);
}

function showNextRoundWait(data = {}) {
    const modal = document.getElementById('modal-next-round-wait');
    const progress = document.getElementById('next-round-progress');
    const detail = document.getElementById('next-round-detail');
    if (!modal || !progress || !detail) return;

    const connected = getConnectedPlayers();
    const totalCount = data.totalCount || connected.length || 1;
    const readyCount = Math.min(data.readyCount || 1, totalCount);
    const waitingNames = Array.isArray(data.waitingNames) ? data.waitingNames : [];

    progress.textContent = `${readyCount}/${totalCount} listos`;
    detail.textContent = waitingNames.length
        ? `Esperando a: ${waitingNames.join(', ')}`
        : 'Esperando confirmación de los demás jugadores...';
    modal.classList.add('show');
}

function hideNextRoundWait() {
    document.getElementById('modal-next-round-wait')?.classList.remove('show');
}

// ═══════════════════════════════════════════════════
// RENDERIZADO
// ═══════════════════════════════════════════════════

const BADGES = {
    'owner':         { emoji: '👑', label: 'Owner' },
    'beta_tester':   { emoji: '🧪', label: 'Beta Tester' },
    'early_adopter': { emoji: '🎖️', label: 'Early Adopter' },
    'vip':           { emoji: '⭐', label: 'VIP' },
    'veterano':      { emoji: '🎖️', label: 'Veterano' },
    'leyenda':       { emoji: '👑', label: 'Leyenda' },
    'imparable':     { emoji: '🔥', label: 'Imparable' },
    'invencible':    { emoji: '🏆', label: 'Invencible' },
    'magnate':       { emoji: '💰', label: 'Magnate' },
    'perfecto':      { emoji: '💎', label: 'Perfecto' },
    'dios_continental': { emoji: '🏛️', label: 'Dios del Continental' },
    'inmortal':      { emoji: '♾️', label: 'Inmortal' },
    'ahorrativo':    { emoji: '🪙', label: 'Ahorrativo' },
};
function skinClass(skin) {
    if (!skin || skin === 'clasico') return '';
    return `skin-${skin}`;
}

function badgeHtml(badge) {
    if (!badge || !BADGES[badge]) return '';
    return ` <span title="${BADGES[badge].label}" style="cursor:default;font-size:.85rem">${BADGES[badge].emoji}</span>`;
}

function applyMySkin() {
    if (!G || myIdx < 0) return;
    const me = G.jugadores[myIdx];
    const skin = me?.skin || 'clasico';
    // Apply to all my cback elements
    document.querySelectorAll('#discard-zone .cback, #mazo-wrap .cback, .hand-zone .cback').forEach(el => {
        el.className = el.className.replace(/\bskin-\w+\b/g, '').trim();
        if (skin !== 'clasico') el.classList.add(`skin-${skin}`);
    });
}

function applyTableTheme(color) {
    const valid = ['green', 'navy', 'wine', 'black'];
    if (!valid.includes(color)) return;
    [document.documentElement, document.body].forEach(el => {
        el.className = el.className.replace(/\btheme-\w+\b/g, '').trim();
        el.classList.add('theme-' + color);
    });
    sessionStorage.setItem('tableColor', color);
}

function restoreAnimatedBajadas() {
    if (!_animatedBajadas.size) return;
    document.querySelectorAll('#felt-plays .seat-plays .card-sm, #felt-plays .seat-plays .joker-sm').forEach(el => {
        const id = el.dataset.id || el.dataset.comodinId;
        if (!id) return;
        if (_animatedBajadas.has(id)) {
            el.style.animation  = 'none';
            el.style.opacity    = '1';
            el.style.transform  = 'none';
            el.style.transition = 'none';
        }
    });
}

function fmtChips (n) {
  return Number(n ?? 0).toLocaleString('es-MX');
}

function renderPot() {
    const potArea = document.getElementById('pot-area');
    const potVal  = document.getElementById('pot-value');
    const potBanca = document.getElementById('pot-banca');
    const esApuesta = !!G?.conApuesta;
    if (potArea) potArea.style.display = esApuesta ? 'flex' : 'none';
    if (!esApuesta) return;
    if (potVal)   potVal.textContent   = fmtChips(G.pot ?? 0);
    if (potBanca) potBanca.textContent = `Banca · ${fmtChips(G.banca ?? 0)}`;
}

function updateHandScroll() {
    const wrap = document.getElementById('hand-scroll-wrap');
    const zone = document.getElementById('discard-zone');
    if (!wrap || !zone) return;
    const canScroll = zone.scrollWidth > zone.clientWidth + 4;
    wrap.classList.toggle('can-scroll', canScroll);
    wrap.classList.toggle('scrolled-end', canScroll && zone.scrollLeft + zone.clientWidth >= zone.scrollWidth - 8);
}

function render() {
    if (!G || myIdx < 0) return;
    const me = G.jugadores[myIdx];
    _turnJustChanged = _lastRenderedTurn !== null && _lastRenderedTurn !== G.turno;

    const roundChanged = _lastRenderedRound !== null && _lastRenderedRound !== G.ronda;
    if (roundChanged) {
        const topbar = document.querySelector('.topbar');
        if (topbar) {
            topbar.classList.remove('round-changed');
            void topbar.offsetWidth;
            topbar.classList.add('round-changed');
            setTimeout(() => topbar.classList.remove('round-changed'), 950);
        }
    }
    _lastRenderedRound = G.ronda;

    document.getElementById('ronda-pill').textContent = `Ronda ${G.ronda} de 7`;
    document.getElementById('req-pill').textContent = REQ_LABELS[G.ronda] || '';
    renderRoundProgress();
    renderScoreboard();
    renderOpponents();
    renderTableBajadas();
    renderMazo();
    renderFondo(me);
    renderPot();
    renderPlayerInfo(me);
    renderHand();
    renderActions();
    renderOwnerConsole();
    restoreAnimatedBajadas();
    applyMySkin();
    updateHandScroll();
    _lastRenderedTurn = G.turno;
    _turnJustChanged = false;
}

function renderRoundProgress() {
    const el = document.getElementById('round-dots');
    if (!el) return;
    el.innerHTML = '';
    for (let i = 1; i <= 7; i++) {
        const d = document.createElement('span');
        d.className = 'rdot' + (i < G.ronda ? ' done' : i === G.ronda ? ' active' : '');
        el.appendChild(d);
    }
}

function renderOwnerConsole() {
    const button = document.getElementById('owner-console-btn');
    const panel = document.getElementById('owner-console-panel');
    const list = document.getElementById('owner-console-list');
    if (!button || !panel || !list) return;

    if (!IS_OWNER) {
        button.style.display = 'none';
        panel.classList.remove('show');
        return;
    }

    button.style.display = 'inline-flex';
    const logs = Array.isArray(G?.log) ? G.log : [];

    if (!logs.length) {
        list.innerHTML = '<div class="owner-console-empty">Sin logs recientes para mostrar.</div>';
        return;
    }

    list.innerHTML = logs.map(line => `
        <div class="owner-console-entry">${escapeHtml(line)}</div>
    `).join('');
}

function toggleOwnerConsole() {
    if (!IS_OWNER) return;
    const panel = document.getElementById('owner-console-panel');
    if (!panel) return;
    panel.classList.toggle('show');
}

function closeOwnerConsole() {
    document.getElementById('owner-console-panel')?.classList.remove('show');
}



function renderScoreboard() {
    document.getElementById('scoreboard').innerHTML = G.jugadores.map((j, i) => `
        <div class="sitem ${i === myIdx ? 'me' : ''}">
            <div class="sname">${badgeHtml(j.badge)}${j.nombre}</div>
            <div class="spts">${j.pts_t}</div>
        </div>
    `).join('');
}

// ─────────────────────────────────────────────────────────────────────────────
// seatLayout(n)
// Devuelve posiciones (%) sobre el fieltro para asientos y bajadas de cada
// jugador, más el tamaño máximo de la bajada (maxW %) y su zona (para el paso
// de ajuste fitSeatPlays). Los oponentes se sientan en orden de array
// alrededor del óvalo; la bajada de cada uno queda en el "anillo" frente a su
// asiento, sin invadir mazo/fondo (zona central). El jugador propio (myIdx)
// queda abajo al centro.
//  - 5 jugadores en pantallas anchas: 2 arriba + 2 laterales.
//  - 5 jugadores en pantallas estrechas (<1000px): 4 en una fila superior.
//  - Landscape corto (≤500px alto): todos en una fila superior compacta.
// ─────────────────────────────────────────────────────────────────────────────
function seatLayout(n) {
    const feltEl = document.getElementById('felt');
    const feltW = feltEl ? feltEl.clientWidth : 0;
    const feltH = feltEl ? feltEl.clientHeight : 0;
    const land = window.matchMedia?.('(orientation: landscape) and (max-height: 500px)').matches;
    const narrow = feltW > 0 && feltW < 1000;

    // El fieltro es un óvalo (border-radius: 50% / 42%), con overflow:hidden.
    // Los asientos deben quedar COMPLETOS dentro del óvalo, así que se colocan
    // sobre el borde: y = borde del óvalo en la columna (x ± medio panel) + medio
    // panel + margen. Antes se fijaba y=9% y el panel centrado quedaba recortado
    // por el canto del fieltro.
    const HP = 52, WP = 104;      // medio panel .opp normal (px aprox)
    const HP_T = 17, WP_T = 45;   // medio panel compacto .opp--tiny
    const MARG = 1.5, GAP = 6;    // márgenes (% del alto del fieltro)
    const RY = 42;                // ry del óvalo (border-radius: 50% / 42%)

    const edgeY = (x) => {
        const u = Math.max(-1, Math.min(1, (x - 50) / 50));
        return 50 - RY * Math.sqrt(1 - u * u);
    };
    const seatY = (x, hwPct, hhPct) => {
        const cornerX = x < 50 ? x - hwPct : x + hwPct;
        return Math.max(3, edgeY(cornerX) + hhPct + MARG);
    };
    const halfs = (tiny) => ({
        hwPct: ((tiny ? WP_T : WP) / feltW) * 100,
        hhPct: ((tiny ? HP_T : HP) / feltH) * 100,
    });

    let seats, plays, maxWs, zones, seatWs;
    if (land) {
        const k = Math.max(n - 1, 1);
        const xArr = Array.from({ length: k }, (_, i) => Math.round(100 * (i + 1) / (k + 1)));
        const { hwPct, hhPct } = halfs(false);
        seats = xArr.map(x => [x, Math.min(28, seatY(x, hwPct, hhPct))]);
        plays = xArr.map((x, i) => [x, Math.min(32, seats[i][1] + hhPct + GAP)]);
        maxWs = xArr.map(() => ({ 1: 30, 2: 24, 3: 20, 4: 18 }[k] || 18));
        zones = xArr.map(() => 'land');
        seatWs = xArr.map(() => Math.max(10, Math.floor(80 / k)));
    } else if (n === 5 && narrow) {
        // 4 oponentes en fila superior; paneles compactos para que quepan en el óvalo
        const xs = [20, 40, 60, 80];
        const { hwPct, hhPct } = halfs(true);
        seats = xs.map(x => [x, seatY(x, hwPct, hhPct)]);
        plays = xs.map((x, i) => [x, Math.min(40, seats[i][1] + hhPct + GAP)]);
        maxWs = [16, 16, 16, 16];
        zones = ['top', 'top', 'top', 'top'];
        seatWs = xs.map(() => Math.min(17, (94 * 100) / feltW)); // fuerza .opp--tiny
    } else {
        const M = {
            2: { xs: [50], maxW: [30], seatW: [30] },
            3: { xs: [30, 70], maxW: [24, 24], seatW: [26, 26] },
            4: { xs: [20, 50, 80], maxW: [23, 23, 23], seatW: [26, 26, 26] },
            5: { xs: [33, 67], side: [14, 86], maxW: [22, 22, 13, 13], seatW: [26, 26, 14, 14] },
        }[n] || { xs: [30, 70], maxW: [24, 24], seatW: [26, 26] };

        const { hwPct, hhPct } = halfs(false);
        seats = M.xs.map(x => [x, seatY(x, hwPct, hhPct)]);
        plays = M.xs.map((x, i) => [x, seats[i][1] + hhPct + GAP]);
        if (M.side) {
            M.side.forEach(x => seats.push([x, seatY(x, hwPct * 0.92, hhPct)]));
            const base = M.xs.length;
            M.side.forEach((x, i) => {
                const sy = seats[base + i][1];
                plays.push([x, Math.min(52, sy + hhPct + GAP)]);
            });
        }
        maxWs = M.maxW;
        seatWs = M.seatW;
        zones = plays.map((_, i) => (M.side && i >= M.xs.length ? 'side' : 'top'));
    }

    const seatOf = (ji) => {
        if (ji === myIdx) {
            return { seat: null, play: [50, land ? 86 : 81], maxW: land ? 80 : 72, zone: 'me', seatW: 0 };
        }
        const seatIdx = ji < myIdx ? ji : ji - 1;
        return { seat: seats[seatIdx], play: plays[seatIdx], maxW: maxWs[seatIdx], zone: zones[seatIdx], seatW: seatWs[seatIdx] };
    };

    return { oppCount: n - 1, feltW, feltH, narrow, land, seatOf };
}

let _oppSigs = {};
let _oppLayoutKey = '';
let _playsSigs = {};
let _playsInteractionSig = null;
let _playsLayoutKey = '';
let _handSig = '';

function layoutKey() {
    const feltEl = document.getElementById('felt');
    return feltEl ? feltEl.clientWidth + 'x' + feltEl.clientHeight : '0x0';
}

function renderOpponents() {
    const opEl = document.getElementById('opponents');
    if (!opEl) return;
    const layout = seatLayout(G.jugadores.length);
    const lk = layoutKey();
    const layoutChanged = lk !== _oppLayoutKey;
    _oppLayoutKey = lk;

    const newSigs = {};
    const existing = [...opEl.children];

    G.jugadores.forEach((j, i) => {
        if (i === myIdx) return;
        const pos = layout.seatOf(i);
        const tiny = layout.feltW && layout.feltW * pos.seatW / 100 < 95;
        const sig = `${j.nombre}|${j.badge}|${j.skin}|${j.pts_t}|${j.fichas}|${j.quebrado ? 1 : 0}|${j.conectado ? 1 : 0}|${j.bajado ? 1 : 0}|${(j.mano || []).length}|${(j.jugadas || []).length}|${i === G.turno ? 1 : 0}|${pos.zone}|${pos.seat ? pos.seat[0] + '/' + pos.seat[1] : ''}|${pos.seatW}|${tiny ? 1 : 0}`;
        newSigs[i] = sig;

        let el = opEl.querySelector(`.opp[data-idx="${i}"]`);
        if (el && !layoutChanged && _oppSigs[i] === sig) return;

        if (el) el.remove();
        const d = document.createElement('div');
        d.className = `opp${i === G.turno ? ' turn' : ''}${j.bajado ? ' bajado' : ''}${pos.zone === 'side' ? ' opp--side' : ''}`;
        if (pos.seat) {
            d.style.left = pos.seat[0] + '%';
            d.style.top = pos.seat[1] + '%';
            d.style.maxWidth = pos.seatW + '%';
            if (tiny) d.classList.add('opp--tiny');
        }
        d.dataset.idx = i;
        const avBg = skinAvatarStyle(j.skin).bg;
        const avBd = skinAvatarStyle(j.skin).border;
        const avatarChar = (j.badge && BADGES[j.badge]) ? BADGES[j.badge].emoji : ((j.nombre || '?').trim()[0] || '?').toUpperCase();
        d.innerHTML = `
            ${i === G.turno ? '<div class="opp-turn-arrow">▼</div>' : ''}
            <div class="opp-top">
                <span class="opp-avatar" style="background:${avBg};border-color:${avBd}">${avatarChar}</span>
                <span class="opp-name">${escapeHtml(j.nombre)}${!j.conectado ? ' 📴' : ''}</span>
            </div>
            <div class="opp-backs">${(j.mano || []).map(() => `<div class="cback-xs ${skinClass(j.skin)}"></div>`).join('')}</div>
            <div class="opp-meta">
                ${j.bajado ? '<span class="opp-bajado-chip">Bajado</span>' : ''}
                ${j.fichas != null ? `<span class="opp-chips${j.quebrado ? ' quebrado' : ''}">🪙 ${fmtChips(j.fichas)}</span>` : ''}
                <span class="opp-count">${j.mano?.length || 0} cartas · ${j.pts_t}pts</span>
            </div>
            ${j.bajado && j.jugadas?.length ? `<div class="opp-jugadas">${j.jugadas.length} jugada(s)</div>` : ''}
        `;
        opEl.appendChild(d);
    });

    // Eliminar paneles de jugadores que ya no son oponentes
    existing.forEach(el => {
        const idx = Number(el.dataset.idx);
        if (!newSigs[idx]) el.remove();
    });

    // Transitorio: clase de entrada cuando el turno acaba de cambiar
    if (_turnJustChanged) {
        const el = opEl.querySelector(`.opp[data-idx="${G.turno}"]`);
        if (el && !el.classList.contains('turn-arrive')) el.classList.add('turn-arrive');
    }

    _oppSigs = newSigs;
}

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
function skinAvatarStyle(skin) {
    return {
        bg:     SKIN_AVATAR_BG[skin]     || SKIN_AVATAR_BG.clasico,
        border: SKIN_AVATAR_BORDER[skin] || 'rgba(255,255,255,.25)',
    };
}

// ─────────────────────────────────────────────────────────────────────────────
// renderTableBajadas
// Ahora muestra jokers intercambiables también cuando el jugador YA está bajado
// (esperando_accion o esperando_pago), usando la misma función de detección.
// ─────────────────────────────────────────────────────────────────────────────
function renderTableBajadas() {
    const feltPlays = document.getElementById('felt-plays');
    const layout = seatLayout(G.jugadores.length);
    const lk = layoutKey();
    const layoutChanged = lk !== _playsLayoutKey;
    _playsLayoutKey = lk;

    // Componente global que afecta el HTML interno de todas las pilas
    // (marcadores de intercambio, onclicks, resaltados).
    const _me = G.jugadores[myIdx];
    const interactionSig = `${intercambioMode ? 1 : 0}|${G.turno}|${G.estado}|${selId}|${isMyTurn() ? 1 : 0}|${_me?.bajado ? 1 : 0}|${(_me?.mano || []).map(c => c.id).join(',')}`;
    const interactionChanged = interactionSig !== _playsInteractionSig;
    _playsInteractionSig = interactionSig;

    const newSigs = {};
    G.jugadores.forEach((j, ji) => {
        if (!j.bajado || !j.jugadas?.length) return;
        newSigs[ji] = j.jugadas.map(jug =>
            jug.tipo + ':' + jug.cartas.map(c =>
                c.comodin ? `J${c.id}(${c.valorReemplazado || ''}${c.paloReemplazado || ''})` : c.id
            ).join(',')
        ).join('|');
    });

    if (!layoutChanged && !interactionChanged) {
        // Diff por jugador: solo reconstruir lo que cambió
        let changed = false;
        const existing = feltPlays ? [...feltPlays.querySelectorAll('.seat-plays')] : [];
        existing.forEach(w => {
            const ji = Number(w.dataset.pi);
            if (newSigs[ji] === undefined || newSigs[ji] !== _playsSigs[ji]) {
                w.remove();
                changed = true;
            }
        });
        for (const ji in newSigs) {
            if (!feltPlays?.querySelector(`.seat-plays[data-pi="${ji}"]`)) {
                _buildSeatPlays(feltPlays, layout, Number(ji));
                changed = true;
            }
        }
        if (!changed) {
            ensurePlaysDisplay(feltPlays);
            return;
        }
    } else {
        if (feltPlays) feltPlays.innerHTML = '';
        for (const ji in newSigs) _buildSeatPlays(feltPlays, layout, Number(ji));
    }

    _playsSigs = newSigs;
    ensurePlaysDisplay(feltPlays);
    fitSeatPlays();
    animateNewPlays();
}

function _buildSeatPlays(feltPlays, layout, ji) {
    if (!feltPlays) return;
    const j = G.jugadores[ji];
    if (!j || !j.bajado || !j.jugadas?.length) return;

    const pos = layout.seatOf(ji);
    const target = document.createElement('div');
    target.className = `seat-plays${ji === myIdx ? ' sp--me' : (pos.zone === 'side' ? ' sp--side' : '')}`;
    target.dataset.pi = ji;
    target.dataset.maxW = String(pos.maxW);
    target.dataset.zone = pos.zone;
    if (pos.play) { target.style.left = pos.play[0] + '%'; target.style.top = pos.play[1] + '%'; }
    if (pos.maxW && pos.zone !== 'land') target.style.maxWidth = pos.maxW + '%';
    feltPlays.appendChild(target);

    j.jugadas.forEach((jug, jugi) => {
        const pile = document.createElement('div');
        pile.className = 'bajada-pile';
        if (intercambioMode) pile.classList.add('intercambio-mode');
        pile.dataset.pi = ji;
        pile.dataset.ji = jugi;

        // ── Detectar intercambios posibles ──
        // Antes: solo si !me.bajado && esperando_accion
        // Ahora: también si me.bajado && (esperando_accion || esperando_pago)
        const _me = G.jugadores[myIdx];
        const puedeIntercambiar = isMyTurn() && ['esperando_accion', 'esperando_pago'].includes(G.estado);
        const intercambiosPosibles = puedeIntercambiar ? detectarIntercambiosPosibles() : [];

        const cardsHtml = jug.cartas.map(c => {
            if (c.comodin) {
                const vr = c.valorReemplazado || '?';
                const vrPalo = c.paloReemplazado ? c.paloReemplazado : '';
                const intercPosible = intercambiosPosibles.find(
                    ic => ic.jugadorIdx === ji && ic.jugadaIdx === jugi && ic.comodinId === c.id
                );
                if (intercPosible) {
                    const icKey = `${ji}-${jugi}-${c.id}`;
                    // Tooltip diferente según si ya está bajado o no
                    const tipTxt = intercPosible.esCasoBajado
                        ? `🔄 Poner ${intercPosible.cartaValor}${intercPosible.cartaPalo} aquí → recibes el Joker para acomodar`
                        : `🔄 Intercambiar por ${intercPosible.cartaValor}${intercPosible.cartaPalo} → recibes el Joker`;
                    return `<div class="card-sm joker-sm comodin-intercambiable joker-highlight"
                                 title="${tipTxt}"
                                 data-ic-key="${icKey}"
                                 data-comodin-id="${c.id}"
                                 onclick="event.stopPropagation(); window.ejecutarIntercambioDesdeKey('${icKey}')">
                                 🃏<small style="font-size:12px;display:block;color:#ffe066;">=${vr}${vrPalo}</small>
                                 <small style="font-size:10px;display:block;color:#4de88a;">↔ CLIC</small></div>`;
                }
                if (intercambioMode && isMyTurn() && ji !== myIdx) {
                    return `<div class="card-sm joker-sm comodin-intercambiable"
                                 title="Reemplaza a: ${vr}${vrPalo}"
                                 data-comodin-id="${c.id}" data-jugador="${ji}" data-jugada="${jugi}"
                                 onclick="event.stopPropagation(); window.activarModoIntercambio(${ji}, ${jugi}, '${c.id}')">
                                 🃏<small style="font-size:12px;display:block;">=${vr}${vrPalo}</small></div>`;
                }
                return `<div class="card-sm joker-sm" title="Reemplaza a: ${vr}${vrPalo}" data-comodin-id="${c.id}">🃏<small style="font-size:12px;display:block;">=${vr}${vrPalo}</small></div>`;
            }
            return cSm(c);
        }).join('');

        pile.innerHTML = `<div class="bajada-pile-label">${jug.tipo}</div><div class="bajada-pile-cards">${cardsHtml}</div>`;
        if (!intercambioMode && _me?.bajado) {
            pile.onclick = () => {
                if (!selId || !isMyTurn()) return;
                // null como posicion: si es joker en corrida, preguntará automáticamente
                acAcomodar(selId, ji, jugi, null);
            };
        }
        target.appendChild(pile);
    });
}

function ensurePlaysDisplay(feltPlays) {
    const hayJugadas = G.jugadores.some(j => j.bajado && j.jugadas?.length);
    if (feltPlays) feltPlays.style.display = hayJugadas ? 'flex' : 'none';
}

// Anima solo cartas nuevas (con ID real, no textContent)
function animateNewPlays() {
    const allPlays = document.querySelectorAll('#felt-plays .seat-plays .card-sm, #felt-plays .seat-plays .joker-sm');
    allPlays.forEach((el, i) => {
        const id = el.dataset.id || el.dataset.comodinId;
        if (!id) return;
        if (!_animatedBajadas.has(id)) {
            _animatedBajadas.add(id);
            const pile = el.closest('.bajada-pile');
            if (pile) {
                pile.classList.remove('pile-land');
                pile.offsetHeight;
                pile.classList.add('pile-land');
            }
            el.style.animation = 'none';
            el.offsetHeight;
            el.style.animation = `cardLand 320ms cubic-bezier(.22,1,.36,1) ${i * 40}ms both`;
        }
    });
}

// ─────────────────────────────────────────────────────────────────────────────
// fitSeatPlays
// Reduce --plays-scale de cada .seat-plays hasta que su ancho/alto quepan en su
// zona (maxW % del fieltro y una fracción del alto), evitando invadir
// mazo/fondo. No agranda: solo encoge cuando hace falta.
// ─────────────────────────────────────────────────────────────────────────────
function fitSeatPlays() {
    const feltEl = document.getElementById('felt');
    if (!feltEl) return;
    const feltW = feltEl.clientWidth;
    const feltH = feltEl.clientHeight;
    const MAXH = { top: 0.16, side: 0.26, me: 0.30, land: 0.20 };
    const DEFAULT_SCALE = { me: 1.875, side: 0.95 };
    const MIN_SCALE = { land: 0.35 };

    document.querySelectorAll('#felt-plays .seat-plays').forEach(el => {
        const zone = el.dataset.zone || 'top';
        const maxW = parseFloat(el.dataset.maxW || '24');
        const maxWPx = feltW * maxW / 100;
        const maxHPx = feltH * (MAXH[zone] || 0.16);
        const minScale = MIN_SCALE[zone] || 0.45;
        let scale = parseFloat(getComputedStyle(el).getPropertyValue('--plays-scale'));
        if (!isFinite(scale) || scale <= 0) scale = DEFAULT_SCALE[el.dataset.zone] || 1.1;

        let guard = 0;
        let r = el.getBoundingClientRect();
        while (guard++ < 10 && (r.width > maxWPx + 1 || r.height > maxHPx + 1) && scale > minScale) {
            scale = Math.max(minScale, scale - 0.08);
            el.style.setProperty('--plays-scale', String(scale));
            r = el.getBoundingClientRect();
        }
    });
}

function renderMazo() {
    document.getElementById('mazo-count').textContent = `${G.mazo_count} cartas`;
    const mazoW = document.getElementById('mazo-wrap');
    const canRob = isMyTurn() && G.estado === 'esperando_robo';
    mazoW.style.cursor = canRob ? 'pointer' : 'default';
    mazoW.classList.toggle('can-act-ring', canRob);
    const hint = document.getElementById('mazo-hint');
    if (hint) hint.style.display = canRob ? 'block' : 'none';
}

function renderFondo(me) {
    const fw = document.getElementById('fondo-wrap');
    const countEl = document.getElementById('fondo-count');
    if (countEl) countEl.textContent = G.fondo_count > 0 ? `${G.fondo_count} cartas` : '';
    const canTake = isMyTurn() && G.estado === 'esperando_robo' && !me?.bajado;
    const hint = document.getElementById('fondo-hint');
    if (hint) hint.style.display = canTake && G.fondo_top ? 'block' : 'none';
    fw.classList.toggle('can-act-ring', canTake && !!G.fondo_top);
    if (G.fondo_top) {
        fw.innerHTML = cFull(G.fondo_top, false);
        const fc = fw.querySelector('.card');
        if (fc) {
            if (!canTake) {
                fc.classList.add('disabled');
            } else {
                fc.onclick = acFondo;
                fc.addEventListener('mousedown', e => DragDrop.startFondoDrag(e, fc, { onTakeFondo: () => acFondoDrag() }));
                fc.addEventListener('touchstart', e => DragDrop.startFondoDrag(e, fc, { onTakeFondo: () => acFondoDrag() }), { passive: false });
            }
        }
    } else {
        fw.innerHTML = `<div class="cback" style="opacity:.3;cursor:default"></div>`;
    }
}

function renderPlayerInfo(me) {
    document.getElementById('my-name').innerHTML = (me?.badge ? badgeHtml(me.badge) : '') + (me?.nombre || '—');
    document.getElementById('hand-count').textContent = `${me?.mano?.length || 0} cartas`;
    const chipsEl = document.getElementById('my-chips');
    if (chipsEl) {
        if (me?.fichas != null) {
            chipsEl.style.display = '';
            chipsEl.textContent = `🪙 ${fmtChips(me.fichas)}${me.quebrado ? ' · Quebrado' : ''}`;
            chipsEl.classList.toggle('low', !!me.quebrado);
        } else {
            chipsEl.style.display = 'none';
        }
    }
    const dot = document.getElementById('pulse-dot');
    if (dot) dot.style.display = isMyTurn() ? 'inline-block' : 'none';
    const turnTag = document.getElementById('turn-tag');
    const header = document.querySelector('.player-header');
    if (header) {
        header.classList.toggle('my-turn', isMyTurn());
        header.classList.toggle('turn-arrive', _turnJustChanged && isMyTurn());
    }
    if (turnTag) {
        turnTag.textContent = isMyTurn() ? 'Tu turno' : `Turno de ${G.jugadores[G.turno]?.nombre || '…'}`;
        turnTag.classList.toggle('turn-live', isMyTurn());
    }
}

// ═══════════════════════════════════════════════════
// SLOTS DE CONSTRUCCIÓN
// ═══════════════════════════════════════════════════

function renderBuildingRow() {
    if (!G || myIdx < 0) return;
    const buildingRow = document.getElementById('building-row');
    if (!buildingRow) return;
    const buildingLabel = document.getElementById('building-label');
    const me = G.jugadores[myIdx];
    const oculto = !!me?.bajado;
    if (buildingLabel) buildingLabel.style.display = oculto ? 'none' : 'flex';
    buildingRow.style.display = oculto ? 'none' : 'flex';
    const reqEl = document.getElementById('building-requirement');
    if (reqEl) reqEl.textContent = REQ_LABELS[G.ronda] || '';

    const slotDef = (title, type, index, min, hint) => `
        <div class="building-slot" data-slot-type="${type}" data-slot-index="${index}" data-min-cards="${min}">
            <div class="building-slot-header">
                <span class="building-slot-title">${title}</span>
                <span class="building-slot-count">0/${min}+</span>
            </div>
            <div class="building-slot-cards" id="slot-${index}-cards"></div>
            <div class="slot-hint">${hint}</div>
        </div>`;
    const T = (t, i) => slotDef(t, 'tercia', i, 3, 'Mínimo 3 cartas del mismo valor');
    const C = (t, i) => slotDef(t, 'corrida', i, 4, 'Mínimo 4 cartas del mismo palo en secuencia');

    const htmlMap = {
        1: T('TERCIA 1', 0) + T('TERCIA 2', 1),
        2: T('TERCIA', 0) + C('CORRIDA', 1),
        3: C('CORRIDA 1', 0) + C('CORRIDA 2', 1),
        4: T('TERCIA 1', 0) + T('TERCIA 2', 1) + T('TERCIA 3', 2),
        5: T('TERCIA 1', 0) + T('TERCIA 2', 1) + C('CORRIDA', 2),
        6: C('CORRIDA 1', 0) + C('CORRIDA 2', 1) + T('TERCIA', 2),
        7: C('CORRIDA 1', 0) + C('CORRIDA 2', 1) + C('CORRIDA 3', 2),
    };

    buildingRow.innerHTML = htmlMap[G.ronda] || '';
    buildingCards.forEach((cards, slotIndex) => updateSlotUI(slotIndex, cards));
}

function renderHand() {
    if (!G || myIdx < 0) return;
    const me = G.jugadores[myIdx];
    const discardZone = document.getElementById('discard-zone');
    if (!discardZone) return;

    const manoIds = (me.mano || []).map(c => c.id).join(',');
    const buildingSig = [...buildingCards.entries()]
        .sort((a, b) => String(a[0]).localeCompare(String(b[0])))
        .map(([k, cards]) => k + ':' + cards.map(c => c.id).join(','))
        .join(';');
    const sig = `${myIdx}|${hideHandDuringDeal ? 1 : 0}|${selId}|${intercambioMode ? 1 : 0}|${manoIds}|${buildingSig}`;

    if (sig === _handSig && discardZone.querySelectorAll('.card').length === (me.mano || []).length) {
        return;
    }
    _handSig = sig;

    renderBuildingRow();
    discardZone.innerHTML = '';

    const cartasEnSlots = new Set();
    buildingCards.forEach(cards => cards.forEach(c => { if (c?.id) cartasEnSlots.add(c.id); }));

    (me.mano || []).forEach(c => {
        if (!cartasEnSlots.has(c.id)) discardZone.appendChild(createCardElement(c));
    });

    document.getElementById('hand-count').textContent = `${me?.mano?.length || 0} cartas`;
}

function createCardElement(c, fromSlot = null) {
    const el = document.createElement('div');
    el.className = 'card' + (c.id === selId ? ' selected' : '');
    if (intercambioMode && selId && c.id === selId) el.classList.add('pending-intercambio');
    if (hideHandDuringDeal) {
        el.style.opacity = '0';
        el.style.transition = 'none';
    }
    el.dataset.id = c.id;
    if (fromSlot !== null) el.dataset.slot = fromSlot;
    el.draggable = false;

    if (c.comodin) {
        el.innerHTML = `<div class="card-face joker-f"><span class="cv">🃏</span><span class="cs" style="font-size:.55rem">JOKER</span></div>`;
    } else {
        const sc = SUIT_CLS[c.palo] || '';
        const fig = ['J', 'Q', 'K'].includes(c.valor);
        const faceCls = ['A', 'J', 'Q', 'K'].includes(c.valor) ? ` face-${c.valor.toLowerCase()}` : '';
        el.innerHTML = `
            <div class="card-face ${sc}${faceCls}">
                <div class="corner tl">${c.valor}<br>${c.palo}</div>
                <div class="corner tr">${c.valor}<br>${c.palo}</div>
                <div class="corner bl">${c.valor}<br>${c.palo}</div>
                <div class="corner br">${c.valor}<br>${c.palo}</div>
                <div class="cv">${c.palo}</div>
                <div class="cs${fig ? ' fig' : ''}">${fig ? '<i class="ph-fill ph-crown"></i>' : ''}${c.valor}</div>
            </div>`;
    }

    el.addEventListener('click', e => { e.stopPropagation(); selCard(c.id); });

    const dragCallbacks = {
        isPayable,
        onPagar: id => acPagar(id),
        onAcomodar: (id, pi, ji) => acAcomodar(id, pi, ji),
        onReorder: (id, beforeId) => acReorder(id, beforeId),
        onBuildingDrop: (id, slotIndex, slotType, insertIdx) => handleBuildingDrop(id, slotIndex, slotType, insertIdx),
        onRemoveFromSlot: (id, slotIndex) => handleRemoveFromSlot(id, slotIndex),
        onMoveBetweenSlots: (id, fromSlot, toSlot, toSlotType, insertIdx) => handleMoveBetweenSlots(id, fromSlot, toSlot, toSlotType, insertIdx),
        onReturnToHand: (id, slotIndex) => handleReturnToHand(id, slotIndex),
        onReorderWithinSlot: (id, slotIndex, insertIdx) => handleReorderWithinSlot(id, slotIndex, insertIdx),
    };

    el.addEventListener('mousedown', e => { if (e.button !== 0) return; DragDrop.startHandDrag(e, el, c.id, dragCallbacks); });
    el.addEventListener('touchstart', e => DragDrop.startHandDrag(e, el, c.id, dragCallbacks), { passive: false });

    return el;
}

function handleBuildingDrop(cartaId, slotIndex, slotType, insertIdx) {
    const me = G.jugadores[myIdx];
    if (!me || me.bajado) { toast('Ya estás bajado, no puedes construir más jugadas'); return; }
    const cartaIndex = me.mano.findIndex(c => c.id === cartaId);
    if (cartaIndex === -1) { toast('Carta no encontrada en la mano'); return; }
    let cartaEnOtroSlot = false;
    buildingCards.forEach(cards => { if (cards.some(c => c.id === cartaId)) cartaEnOtroSlot = true; });
    if (cartaEnOtroSlot) { toast('Esta carta ya está en otra jugada'); return; }
    const [cartaMovida] = me.mano.splice(cartaIndex, 1);
    if (!buildingCards.has(slotIndex)) buildingCards.set(slotIndex, []);
    const slotCards = buildingCards.get(slotIndex);
    if (insertIdx !== undefined && insertIdx !== null && insertIdx < slotCards.length) {
        slotCards.splice(insertIdx, 0, cartaMovida);
    } else {
        slotCards.push(cartaMovida);
    }
    updateSlotUI(slotIndex, slotCards);
    renderHand();
    renderActions();
    selId = null;
    toast(`Carta ${cartaMovida.valor}${cartaMovida.palo || ''} agregada a ${slotType}`, 'green');
}

function updateSlotUI(slotIndex, cards) {
    const slot = document.querySelector(`.building-slot[data-slot-index="${slotIndex}"]`);
    if (!slot) return;
    const cardsContainer = document.getElementById(`slot-${slotIndex}-cards`);
    if (!cardsContainer) return;
    cardsContainer.innerHTML = '';
    cards.forEach(carta => {
        if (!carta) return;
        cardsContainer.appendChild(createCardElement(carta, slotIndex));
    });
    const countSpan = slot.querySelector('.building-slot-count');
    const minCards = parseInt(slot.dataset.minCards);
    const slotType = slot.dataset.slotType;
    const esValido = slotType === 'tercia' ? slotTerciaValido(cards) : slotCorridaValido(cards);
    if (countSpan) {
        countSpan.textContent = `${cards.length}/${minCards}+`;
        countSpan.classList.toggle('valid', esValido);
        slot.classList.toggle('complete', esValido);
    }
}

function handleRemoveFromSlot(cartaId, slotIndex) {
    const me = G.jugadores[myIdx];
    if (!me || me.bajado) { toast('Ya estás bajado, no puedes modificar jugadas'); return; }
    const slotCards = buildingCards.get(slotIndex);
    if (!slotCards) return;
    const index = slotCards.findIndex(c => c.id === cartaId);
    if (index > -1) {
        slotCards.splice(index, 1);
        if (slotCards.length === 0) buildingCards.delete(slotIndex);
        updateSlotUI(slotIndex, slotCards);
        renderHand();
        renderActions();
        toast('Carta removida de la jugada', 'green');
    }
}

function handleReturnToHand(cartaId, slotIndex) {
    const me = G.jugadores[myIdx];
    if (!me || me.bajado) { toast('Ya estás bajado, no puedes modificar jugadas', 'red'); return; }
    slotIndex = String(slotIndex);
    const slotCards = buildingCards.get(slotIndex);
    if (!slotCards) return;
    const cartaIndex = slotCards.findIndex(c => c.id === cartaId);
    if (cartaIndex === -1) return;
    const [cartaDevuelta] = slotCards.splice(cartaIndex, 1);
    if (slotCards.length === 0) buildingCards.delete(slotIndex);
    const yaEnMano = me.mano.some(c => c.id === cartaDevuelta.id);
    if (!yaEnMano) me.mano.push(cartaDevuelta);
    renderHand();
    renderActions();
    toast(`Carta ${cartaDevuelta.valor}${cartaDevuelta.palo || ''} devuelta a sobrantes`, 'green');
}

function handleMoveBetweenSlots(cartaId, fromSlotIndex, toSlotIndex, toSlotType, insertIdx) {
    const me = G.jugadores[myIdx];
    if (!me || me.bajado) { toast('Ya estás bajado, no puedes modificar jugadas'); return; }
    fromSlotIndex = String(fromSlotIndex);
    toSlotIndex = String(toSlotIndex);
    const fromSlotCards = buildingCards.get(fromSlotIndex);
    if (!fromSlotCards) return;
    const cartaIndex = fromSlotCards.findIndex(c => c.id === cartaId);
    if (cartaIndex === -1) return;
    const [cartaMovida] = fromSlotCards.splice(cartaIndex, 1);
    if (fromSlotCards.length === 0) buildingCards.delete(fromSlotIndex);
    else updateSlotUI(fromSlotIndex, fromSlotCards);
    if (!buildingCards.has(toSlotIndex)) buildingCards.set(toSlotIndex, []);
    const toSlotCards = buildingCards.get(toSlotIndex);
    if (insertIdx !== undefined && insertIdx !== null && insertIdx < toSlotCards.length) {
        toSlotCards.splice(insertIdx, 0, cartaMovida);
    } else {
        toSlotCards.push(cartaMovida);
    }
    updateSlotUI(toSlotIndex, toSlotCards);
    renderActions();
}

function handleReorderWithinSlot(cartaId, slotIndex, insertIdx) {
    const me = G.jugadores[myIdx];
    if (!me || me.bajado) return;
    slotIndex = String(slotIndex);
    const slotCards = buildingCards.get(slotIndex);
    if (!slotCards) return;
    const currentIdx = slotCards.findIndex(c => c.id === cartaId);
    if (currentIdx === -1) return;
    const [carta] = slotCards.splice(currentIdx, 1);
    const adjustedIdx = (insertIdx > currentIdx) ? Math.max(0, insertIdx - 1) : insertIdx;
    slotCards.splice(adjustedIdx, 0, carta);
    updateSlotUI(slotIndex, slotCards);
    renderActions();
}

// ═══════════════════════════════════════════════════
// RENDER ACTIONS
// ═══════════════════════════════════════════════════

function renderActions() {
    if (!G || myIdx < 0) return;

    const me = G.jugadores[myIdx];
    const myTurn = isMyTurn();
    const btns = document.getElementById('action-btns');
    const instr = document.getElementById('instr');
    const cb = document.getElementById('castigo-banner');
    const logLine = document.getElementById('log-line');

    const starterIdx = G.jugadores?.length ? ((G.dealer + 1) % G.jugadores.length) : -1;
    const resumenRonda = G.jugadores?.length
        ? `Ronda ${G.ronda}. Dealer: ${G.jugadores[G.dealer]?.nombre || '—'}. Inicia: ${G.jugadores[starterIdx]?.nombre || '—'}.`
        : '';
    if (logLine) logLine.textContent = G.log?.[G.log.length - 1] || resumenRonda;

    if (cb) cb.style.display = 'none';
    if (btns) btns.innerHTML = '';

    const add = (txt, cls, fn, dis = false, hero = false) => {
        if (!btns) return;
        const b = document.createElement('button');
        b.className = `abtn ${cls}${hero ? ' abtn-hero' : ''}`;
        b.textContent = txt;
        b.disabled = dis;
        b.onclick = fn;
        btns.appendChild(b);
    };

    if (intercambioMode) {
        if (instr) instr.textContent = '🔄 Selecciona una carta de tu mano para intercambiar por el comodín';
        add('❌ Cancelar Intercambio', 'abtn-red', cancelIntercambio);
        updateGuideTip();
        return;
    }

    const hasComodinesIntercambiables = () => {
        if (!selId) return false;
        const carta = me?.mano?.find(c => c.id === selId);
        if (!carta || carta.comodin) return false;
        // Buscar jugadas bajadas con joker donde esta carta encaje
        return G.jugadores.some((j, ji) => {
            if (!j.bajado) return false;
            // Post-bajada: puede intercambiar en sus propias jugadas también
            // Pre-bajada: solo en jugadas de otros
            if (!me?.bajado && ji === myIdx) return false;
            return j.jugadas?.some(jug => jug.cartas.some(c => c.comodin));
        });
    };

    if (!myTurn) {
        if (instr) instr.textContent = `Turno de ${G.jugadores[G.turno]?.nombre || '…'}`;
        if (G.estado === 'fase_castigo' && G.castigo_idx === myIdx && cb) {
            const top = G.fondo_top;
            cb.style.display = 'block';
            cb.textContent = `⚡ ¿Te castigas el ${top?.valor}${top?.palo || ''}?`;
            if (instr) instr.textContent = 'Tienes prioridad de castigo.';
            add('✅ Sí, castigarme', 'abtn-green', () => acCastigo(true));
            add('❌ No', 'abtn-red', () => acCastigo(false));
        }
        updateGuideTip();
        return;
    }

    switch (G.estado) {
        case 'esperando_robo':
            if (instr) instr.textContent = me?.bajado
                ? `${me.nombre} (bajado) — roba del mazo.`
                : `Tu turno — toma del fondo o roba del mazo.`;
            if (!me?.bajado) add('📥 Tomar Fondo', 'abtn-gold', acFondo, !G.fondo_top, true);
            add('🎴 Robar Mazo', me?.bajado ? 'abtn-gold' : 'abtn-outline', acMazo, false, !!me?.bajado);
            break;

        case 'fase_castigo': {
            const jc = G.jugadores[G.castigo_idx];
            const top = G.fondo_top;
            if (G.castigo_idx === myIdx && cb) {
                cb.style.display = 'block';
                cb.textContent = `⚡ ¿Te castigas el ${top?.valor}${top?.palo || ''}? (carta extra del mazo)`;
                if (instr) instr.textContent = 'Tienes prioridad de castigo.';
                add('✅ Sí', 'abtn-green', () => acCastigo(true), false, true);
                add('❌ No', 'abtn-red', () => acCastigo(false));
            } else {
                if (instr) instr.textContent = `Esperando que ${jc?.nombre} decida el castigo…`;
            }
            break;
        }

        case 'esperando_accion': {
            const listoParaBajar = slotsListosParaBajar();
            const br = document.getElementById('building-row');
            if (br) br.classList.toggle('ready-pulse', !!listoParaBajar && !me?.bajado);
            if (!me?.bajado) {
                // ── Pre-bajada ──
                if (me?.penalizacion?.activa) {
                    if (instr) instr.textContent = `⚠️ Penalización activa: ${me.penalizacion.turnosRestantes} turno(s) sin bajar.`;
                } else if (listoParaBajar) {
                    if (instr) instr.textContent = '✅ Jugadas listas — pulsa Bajarme para confirmar.';
                } else {
                    if (instr) instr.textContent = selId
                        ? 'Carta seleccionada — págala o arrástrala a un slot.'
                        : 'Arrastra cartas a los slots para armar tus jugadas.';
                }
                add('🔥 Bajarme', 'abtn-gold', acBajar, !listoParaBajar, true);
                if (listoParaBajar) {
                    const heroBtn = btns.querySelector('.abtn-hero');
                    if (heroBtn) heroBtn.classList.add('hero-pulse');
                }
                add('💳 Pagar', 'abtn-outline', () => acPagar(selId), !selId);

                const intercambiosPosibles = detectarIntercambiosPosibles();
                if (intercambiosPosibles.length > 0) {
                    const ic = intercambiosPosibles[0];
                    add(`🔄 Intercambiar ${ic.cartaValor}${ic.cartaPalo} por Joker`, 'abtn-green', () => ejecutarIntercambioDirecto(ic));
                    if (instr) instr.textContent = `💡 Puedes intercambiar ${ic.cartaValor}${ic.cartaPalo} por el Joker de ${G.jugadores[ic.jugadorIdx]?.nombre} y bajarte!`;
                } else if (selId && hasComodinesIntercambiables()) {
                    add('🔄 Intercambiar por comodín', 'abtn-outline', () => {
                        toast('Haz clic en un comodín de las jugadas de otros jugadores', 'green');
                        intercambioMode = true;
                        render();
                    });
                }
            } else {
                // ── Post-bajada, esperando_accion ──
                if (instr) instr.textContent = selId
                    ? 'Carta seleccionada — acomódala en jugadas de otros o intercambia por un Joker.'
                    : 'Selecciona una carta para acomodar o intercambiar.';
                add('💳 Pagar', 'abtn-outline', () => acPagar(selId), !selId, true);

                // ── Intercambio post-bajada: detectar y mostrar botón ──
                const intercambiosPosibles = detectarIntercambiosPosibles();
                if (intercambiosPosibles.length > 0) {
                    const ic = intercambiosPosibles[0];
                    add(`🔄 Intercambiar ${ic.cartaValor}${ic.cartaPalo} por Joker`, 'abtn-green', () => ejecutarIntercambioDirecto(ic));
                    if (instr) instr.textContent = `💡 Puedes intercambiar ${ic.cartaValor}${ic.cartaPalo} por el Joker — luego acomódalo donde lo necesites.`;
                } else if (selId && hasComodinesIntercambiables()) {
                    add('🔄 Intercambiar por comodín', 'abtn-outline', () => {
                        toast('Haz clic en un comodín de las jugadas', 'green');
                        intercambioMode = true;
                        render();
                    });
                }
            }
            break;
        }

        case 'esperando_pago':
            // ── Post-bajada, esperando_pago ──
            if (instr) instr.textContent = selId
                ? 'Carta seleccionada — acomódala, intercámbia por un Joker, o págala.'
                : 'Selecciona una carta para acomodar, intercambiar o pagar.';
            add('💳 Pagar', selId ? 'abtn-gold' : 'abtn-outline', () => acPagar(selId), !selId, true);

            // ── Intercambio post-bajada en esperando_pago ──
            const intercambiosPosibles = detectarIntercambiosPosibles();
            if (intercambiosPosibles.length > 0) {
                const ic = intercambiosPosibles[0];
                add(`🔄 Intercambiar ${ic.cartaValor}${ic.cartaPalo} por Joker`, 'abtn-green', () => ejecutarIntercambioDirecto(ic));
                if (instr) instr.textContent = `💡 Puedes intercambiar ${ic.cartaValor}${ic.cartaPalo} por el Joker — luego acomódalo donde lo necesites.`;
            } else if (selId && hasComodinesIntercambiables()) {
                add('🔄 Intercambiar por comodín', 'abtn-outline', () => {
                    toast('Haz clic en un comodín de las jugadas', 'green');
                    intercambioMode = true;
                    render();
                });
            }
            break;
    }

    updateGuideTip();

}

// ═══════════════════════════════════════════════════
// HELPERS CARTAS
// ═══════════════════════════════════════════════════

function cFull(c, withId = true) {
    if (!c) return '';
    if (c.comodin) {
        return `<div class="card"${withId ? ` data-id="${c.id}"` : ''}>
            <div class="card-face joker-f"><span class="cv">🃏</span><span class="cs" style="font-size:.55rem">JOKER</span></div>
        </div>`;
    }
    const sc = SUIT_CLS[c.palo] || '';
    const fig = ['J', 'Q', 'K'].includes(c.valor);
    const faceCls = ['A', 'J', 'Q', 'K'].includes(c.valor) ? ` face-${c.valor.toLowerCase()}` : '';
    return `<div class="card"${withId ? ` data-id="${c.id}"` : ''}>
        <div class="card-face ${sc}${faceCls}">
            <div class="corner tl">${c.valor}<br>${c.palo}</div>
            <div class="corner tr">${c.valor}<br>${c.palo}</div>
            <div class="corner bl">${c.valor}<br>${c.palo}</div>
            <div class="corner br">${c.valor}<br>${c.palo}</div>
            <div class="cv">${c.palo}</div>
            <div class="cs${fig ? ' fig' : ''}">${fig ? '<i class="ph-fill ph-crown"></i>' : ''}${c.valor}</div>
        </div>
    </div>`;
}

function cSm(c) {
    if (!c) return '';
    if (c.comodin) return `<div class="card-sm joker-sm" data-comodin-id="${c.id || ''}">🃏</div>`;
    const sc = SUIT_CLS[c.palo] || '';
    return `<div class="card-sm natural ${sc}" data-id="${c.id || ''}">${c.valor}<br>${c.palo}</div>`;
}

// ═══════════════════════════════════════════════════
// MODALES
// ═══════════════════════════════════════════════════

function showModalRonda(data) {
    const modal = document.getElementById('modal-ronda');
    if (!modal) return;
    const ganadorIdx = data.ganadorIdx;
    const puntos = data.puntos;
    const hayGanador = Number.isInteger(ganadorIdx) && ganadorIdx >= 0;
    document.getElementById('mr-title').textContent = hayGanador
        ? `🏆 Ronda ${G.ronda} — ${G.jugadores[ganadorIdx]?.nombre} gana!`
        : `📋 Ronda ${G.ronda} cerrada por agotamiento de mazo`;
    document.getElementById('mr-msg').textContent = hayGanador
        ? (G.ronda < 7 ? `Siguiente: ronda ${G.ronda + 1}.` : '¡Última ronda!')
        : (G.ronda < 7 ? `Todos cuentan sus cartas. Siguiente: ronda ${G.ronda + 1}.` : 'Todos cuentan sus cartas. Fin del juego.');
    const apuestaInfo = G.conApuesta && data.pot != null
        ? `<div class="mr-apuesta">🪙 Pozo: ${fmtChips(data.pot)}${data.banca != null ? ` · Banca: ${fmtChips(data.banca)}` : ''}</div>`
        : '';
    document.getElementById('mr-scores').innerHTML = apuestaInfo + G.jugadores.map((j, i) => `
        <div class="srow ${hayGanador && i === ganadorIdx ? 'winner' : ''}">
            <span>${j.nombre}${hayGanador && i === ganadorIdx ? ' 🏆' : ''}</span>
            <span class="srow-pts">+${puntos?.[i]?.pts_r ?? 0} · Total: ${j.pts_t}</span>
        </div>
    `).join('');
    ackSent = false;
    const card = modal.querySelector('.modal');
    if (card) {
        card.classList.remove('modal-pop');
        void card.offsetWidth;
        card.classList.add('modal-pop');
    }
    modal.classList.add('show');
}

function showModalJuego(data) {
    clearActiveGameSession();
    hideNextRoundWait();
    document.getElementById('modal-ronda')?.classList.remove('show');
    SFX.play('victoria');
    showConfetti();
    showPodio(data.jugadores, data.fichas, data.bancaRepartida, data.conApuesta);
}

function startNewGameFromPodium() {
    clearActiveGameSession();
    const isHost = G?.jugadores?.[0]?.id === MY_ID;
    if (isHost && WS?.ws?.readyState === WebSocket.OPEN) {
        WS.send({ type: 'close_room' });
        setTimeout(() => { location.href = '/'; }, 500);
        return;
    }
    location.href = '/';
}

function showConfetti() {
    const colors = ['#ff6b6b','#ffd93d','#6bcb77','#4d96ff','#ff922b','#cc5de8','#fff','#c8a045'];
    for (let i = 0; i < 120; i++) {
        setTimeout(() => {
            const el = document.createElement('div');
            const color = colors[Math.floor(Math.random() * colors.length)];
            const size  = 6 + Math.random() * 9;
            el.style.cssText = `
                position:fixed; left:${Math.random()*100}vw; top:-10px;
                width:${size}px; height:${size}px;
                background:${color};
                border-radius:${Math.random()>.5?'50%':'2px'};
                pointer-events:none; z-index:9994;
                animation:confettiFall ${2000+Math.random()*2000}ms ease-in forwards;
            `;
            document.body.appendChild(el);
            setTimeout(() => el.remove(), 4100);
        }, Math.random() * 1000);
    }
}

function showPodio(jugadores, fichas, bancaRepartida, conApuesta) {
    const sorted = [...jugadores].map((j, idx) => ({ ...j, idx })).sort((a, b) => a.pts_t - b.pts_t);
    const fichasMap = {};
    (Array.isArray(fichas) ? fichas : []).forEach(f => { fichasMap[f.jugadorIdx] = f; });
    const bancaNote = (conApuesta && bancaRepartida && bancaRepartida.porJugador > 0)
        ? `<div class="podio-banca-note">🪙 Banca repartida: +${fmtChips(bancaRepartida.porJugador)} a ${bancaRepartida.ganadores.length > 1 ? `${bancaRepartida.ganadores.length} empatados` : 'el menor puntaje'}</div>`
        : '';
    const podioColors = [
        { bg: 'linear-gradient(135deg,#c8a045,#7a5c00)', border: 'rgba(200,160,69,.8)', medal: '🥇', label: '1er lugar', glow: '0 0 30px rgba(200,160,69,.6)' },
        { bg: 'linear-gradient(135deg,#8a8a8a,#4a4a4a)', border: 'rgba(200,200,200,.5)', medal: '🥈', label: '2do lugar', glow: '0 0 20px rgba(150,150,150,.4)' },
        { bg: 'linear-gradient(135deg,#8a5a2a,#4a2a10)', border: 'rgba(180,100,40,.5)', medal: '🥉', label: '3er lugar', glow: '0 0 16px rgba(180,100,40,.3)' },
    ];

    const overlay = document.createElement('div');
    overlay.id = 'podio-overlay';

    // Título
    const titulo = document.createElement('div');
    titulo.className = 'podio-title';
    titulo.innerHTML = '<i class="ph ph-trophy"></i> ¡Fin del juego!';
    overlay.appendChild(titulo);

    // Podio cards
    const podioWrap = document.createElement('div');
    podioWrap.className = 'podio-wrap';
    overlay.appendChild(podioWrap);

    if (bancaNote) {
        const bn = document.createElement('div');
        bn.innerHTML = bancaNote;
        podioWrap.appendChild(bn);
    }

    const cards = [];
    sorted.forEach((j, i) => {
        const col = podioColors[i] || { bg:'rgba(0,0,0,.3)', border:'rgba(255,255,255,.1)', medal:['4️⃣','5️⃣'][i-3]||'', label:`${i+1}º lugar`, glow:'none' };

        const card = document.createElement('div');
        card.className = 'podio-card';
        card.style.cssText = `
            background:${col.bg};
            border:2px solid ${col.border};
            box-shadow:${col.glow};
        `;

        card.innerHTML = `
            <div class="podio-medal" style="font-size:${i===0?'2.2rem':'1.6rem'}">${col.medal}</div>
            <div style="flex:1">
                <div class="podio-name" style="font-size:${i===0?'1.1rem':'.95rem'}">${j.nombre}</div>
                <div class="podio-label">${col.label}</div>
            </div>
            <div class="podio-right">
                ${fichasMap[j.idx] != null ? `<div class="podio-chips">🪙 ${fmtChips(fichasMap[j.idx].fichas)}</div>` : ''}
                ${fichasMap[j.idx] != null ? `<div class="podio-ganancia" style="color:${fichasMap[j.idx].ganancia >= 0 ? '#6bcf77' : '#ffb3a0'}">${fichasMap[j.idx].ganancia >= 0 ? '+' : ''}${fmtChips(fichasMap[j.idx].ganancia)}</div>` : ''}
                <div class="podio-pts" style="font-size:${i===0?'1.6rem':'1.2rem'};color:${i===0?'#ffe066':'rgba(255,255,255,.8)'}">${j.pts_t} pts</div>
            </div>
        `;

        podioWrap.appendChild(card);
        cards.push(card);
    });

    // Botón nueva partida
    const btnWrap = document.createElement('div');
    btnWrap.className = 'podio-btn-wrap';
    btnWrap.innerHTML = `<button class="podio-new-btn" onclick="startNewGameFromPodium()">Nueva Partida →</button>`;
    overlay.appendChild(btnWrap);

    document.body.appendChild(overlay);

    // ── Entrada animada ──
    const reduced = typeof window.matchMedia === 'function'
        && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const useGsap = !reduced && typeof window.gsap !== 'undefined';

    if (useGsap) {
        overlay.querySelectorAll('.podio-title, .podio-card, .podio-btn-wrap')
            .forEach(el => { el.style.transition = 'none'; });
        const gsap = window.gsap;
        const tl = gsap.timeline();
        tl.fromTo(overlay, { opacity: 0 }, { opacity: 1, duration: 0.22, ease: 'power1.out' });
        tl.fromTo(titulo, { opacity: 0, y: -24 }, { opacity: 1, y: 0, duration: 0.5, ease: 'back.out(1.5)' }, '-=0.08');
        tl.fromTo(cards, { opacity: 0, y: 46, scale: 0.9 }, { opacity: 1, y: 0, scale: 1, duration: 0.52, ease: 'back.out(1.3)', stagger: 0.15 }, '-=0.2');
        if (cards[0]) {
            tl.add(() => {
                cards[0].classList.add('podio-winner-glow');
                const r = cards[0].getBoundingClientRect();
                SFX.play('victoria');
                if (Anim.confetti) Anim.confetti(r.left + r.offsetWidth / 2, r.top, 45);
            }, '-=0.05');
        }
        tl.fromTo(btnWrap, { opacity: 0, y: 12 }, { opacity: 1, y: 0, duration: 0.38, ease: 'power2.out' }, '+=0.1');
        return;
    }

    if (reduced) {
        overlay.style.opacity = '1';
        titulo.style.opacity = '1';
        titulo.style.transform = 'none';
        cards.forEach(c => { c.style.opacity = '1'; c.style.transform = 'none'; });
        btnWrap.style.opacity = '1';
        return;
    }

    // Fallback sin GSAP (transiciones CSS existentes)
    requestAnimationFrame(() => {
        requestAnimationFrame(() => {
            titulo.style.opacity = '1';
            titulo.style.transform = 'translateY(0)';
        });
    });
    cards.forEach((card, i) => {
        setTimeout(() => {
            requestAnimationFrame(() => {
                requestAnimationFrame(() => {
                    card.style.opacity = '1';
                    card.style.transform = 'translateX(0)';
                    if (i === 0) {
                        cards[0].classList.add('podio-winner-glow');
                        SFX.play('victoria');
                        if (Anim.confetti) Anim.confetti(card.getBoundingClientRect().left + card.offsetWidth / 2, card.getBoundingClientRect().top, 45);
                    }
                });
            });
        }, 300 + i * 300);
    });
    setTimeout(() => { btnWrap.style.opacity = '1'; }, 300 + cards.length * 300 + 400);
}

function toast(msg, type = 'red') {
    const t = document.getElementById('toast');
    if (!t) return;
    t.setAttribute('role', 'status');
    t.setAttribute('aria-live', 'polite');
    t.textContent = msg;
    t.classList.remove('toast-green', 'toast-yellow', 'toast-red', 'show');
    t.classList.add(type === 'green' ? 'toast-green' : type === 'yellow' ? 'toast-yellow' : 'toast-red');
    t.style.display = 'block';
    clearTimeout(t._t);
    requestAnimationFrame(() => {
        requestAnimationFrame(() => t.classList.add('show'));
    });
    t._t = setTimeout(() => {
        t.classList.remove('show');
        setTimeout(() => { t.style.display = 'none'; }, 220);
    }, 2600);
}

// Exponer funciones para los onclick
window.acMazo = acMazo;
window.acFondo = acFondo;
window.acCastigo = acCastigo;
window.acBajar = acBajar;
window.acPagar = acPagar;
window.acAcomodar = acAcomodar;
window.acIntercambiarComodin = acIntercambiarComodin;
window.acReorder = acReorder;
window.selCard = selCard;
window.ackRonda = ackRonda;
window.toast = toast;
window.activarModoIntercambio = activarModoIntercambio;
window.cancelIntercambio = cancelIntercambio;
window.ejecutarIntercambioDirecto = ejecutarIntercambioDirecto;
window.ejecutarIntercambioDesdeKey = ejecutarIntercambioDesdeKey;
window.openGuideSettings = openGuideSettings;
window.closeGuideSettings = closeGuideSettings;
window.toggleGuideAuto = toggleGuideAuto;
window.startGuideFromSettings = startGuideFromSettings;
window.closeGuide = closeGuide;
window.nextGuideStep = nextGuideStep;
window.toggleOwnerConsole = toggleOwnerConsole;
window.closeOwnerConsole = closeOwnerConsole;

document.addEventListener('DOMContentLoaded', init);