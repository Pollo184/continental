// skins.js - Catálogo compartido de skins y badges
// Se carga en index.html y perfil.html

const SKINS = [
  { id: 'clasico',    label: 'Clásico',    bg: 'linear-gradient(135deg,#1a3a80,#0d2050)', border: 'rgba(255,255,255,.25)', free: true },
  { id: 'rojo',       label: 'Rojo',       bg: 'linear-gradient(135deg,#7a1a1a,#3d0a0a)', border: 'rgba(255,100,100,.4)',  free: true },
  { id: 'obsidiana',  label: 'Obsidiana',  bg: 'linear-gradient(135deg,#1a1a1a,#0a0a0a)', border: 'rgba(200,160,69,.4)',   free: true },
  { id: 'esmeralda',  label: 'Esmeralda',  bg: 'linear-gradient(135deg,#0d3320,#061a10)', border: 'rgba(46,204,113,.4)',   free: true },
  { id: 'plata',      label: 'Plata',      bg: 'linear-gradient(135deg,#8b96a6,#4d5663,#d7dde6,#4d5663)', border: 'rgba(225,235,245,.6)', free: true },
  { id: 'bronce',     label: 'Bronce',     bg: 'linear-gradient(135deg,#8a5630,#4a2815,#b97a4a,#4a2815)', border: 'rgba(206,139,85,.55)', free: true },
  { id: 'zafiro',     label: 'Zafiro',     bg: 'linear-gradient(135deg,#0b2458,#07122d,#1d58b8,#07122d)', border: 'rgba(93,152,255,.6)', free: true },
  { id: 'dorado',     label: '👑 Dorado',   bg: 'linear-gradient(135deg,#7a5c00,#3d2e00,#c8a045,#3d2e00)', border: 'rgba(200,160,69,.7)', free: false, roles: ['owner'] },
  { id: 'neon',       label: '⚡ Neon',     bg: 'linear-gradient(135deg,#001a33,#003366)', border: 'rgba(0,200,255,.6)',    free: false, roles: ['owner','vip','beta_tester'] },
  { id: 'imperial',   label: '👑 Imperial', bg: 'linear-gradient(135deg,#3f0018,#160008,#8f0f3b,#160008)', border: 'rgba(255,133,183,.6)', free: false, roles: ['owner'] },
  { id: 'arcoiris',   label: '🌈 Arcoíris', bg: 'linear-gradient(135deg,#ff4d6d,#ff9f1c,#ffe66d,#2ec4b6,#4d96ff,#8b5cf6,#ff4d6d)', border: 'rgba(255,255,255,.72)', free: false, roles: ['owner'] },
  { id: 'amatista',   label: '⭐ Amatista', bg: 'linear-gradient(135deg,#35105e,#170728,#7e39c6,#170728)', border: 'rgba(186,132,255,.65)', free: false, roles: ['vip'] },
  { id: 'cobalto',    label: '🧪 Cobalto',  bg: 'linear-gradient(135deg,#0a1e46,#071024,#1453c2,#071024)', border: 'rgba(88,151,255,.62)', free: false, roles: ['beta_tester'] },
  { id: 'marfil',     label: '🎖️ Marfil',   bg: 'linear-gradient(135deg,#8a7b63,#4a4134,#e6d8bc,#4a4134)', border: 'rgba(240,225,194,.62)', free: false, roles: ['early_adopter'] },
];

const BADGE_EMOJI = {
  'owner': '👑', 'beta_tester': '🧪', 'early_adopter': '🎖️', 'vip': '⭐',
};
const BADGE_LABELS = {
  'owner': 'Owner', 'beta_tester': 'Beta Tester', 'early_adopter': 'Early Adopter', 'vip': 'VIP',
};

// Títulos de logro: se ganan jugando y son equipables desde el perfil.
const TITULOS = {
  'veterano':          { label: 'Veterano',          emoji: '🎖️' },
  'leyenda':           { label: 'Leyenda',           emoji: '👑' },
  'dios_continental':  { label: 'Dios del Continental', emoji: '🏛️' },
  'inmortal':          { label: 'Inmortal',          emoji: '♾️' },
  'imparable':         { label: 'Imparable',         emoji: '🔥' },
  'invencible':        { label: 'Invencible',        emoji: '🏆' },
  'magnate':           { label: 'Magnate',           emoji: '💰' },
  'perfecto':          { label: 'Perfecto',          emoji: '💎' },
  'ahorrativo':        { label: 'Ahorrativo',        emoji: '🪙' },
};
const TITULO_LABELS = Object.fromEntries(Object.entries(TITULOS).map(([k, v]) => [k, v.label]));
const TITULO_EMOJI  = Object.fromEntries(Object.entries(TITULOS).map(([k, v]) => [k, v.emoji]));

// HTML del título equipado (texto dorado bajo el nombre).
function tituloHtml (titulo) {
  if (!titulo || !TITULOS[titulo]) return '';
  const t = TITULOS[titulo];
  return ` <span class="titulo-chip${t.tone ? ' titulo-' + t.tone : ''}" title="Título: ${t.label}">${t.label}</span>`;
}

// Clase extra para estilizar el título de badges especiales (p. ej. "Perfecto" en diamante).
function badgeToneClass(badge) {
  return badge === 'perfecto' ? 'badge-diamante' : '';
}
window.badgeToneClass = badgeToneClass;

function hasAccessToSkin (skin) {
  if (skin.free) return true;
  const u = window.AUTH?.usuario;
  if (u?.rol === 'owner') return true;
  return skin.roles?.includes(u?.rol) || skin.roles?.includes(u?.badge);
}

function skinById (id) {
  return SKINS.find(s => s.id === id);
}
