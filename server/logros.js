'use strict';

// Catálogo de logros + motor de niveles/XP.
// La progresión se guarda en la BD (usuarios.xp/nivel, logros, logros_usuario).

const XP_BASE_PARTIDA  = 40;   // XP por terminar una partida
const XP_POR_RONDA     = 8;    // XP por cada ronda jugada (hasta 7)
const XP_POSICION      = [100, 60, 35, 20, 10]; // 1º, 2º, 3º, 4º, 5º
const MULT_APUESTA     = 1.3;  // bonus por mesa con apuesta

// ─── Catálogo de logros ─────────────────────────────────────────
// tipo: 'contador' (se acumula de partidas_jugadores) | 'hito' (evento en una partida)
const LOGROS = [
  { clave: 'primera_partida',    nombre: 'Primera partida',         descripcion: 'Termina tu primera partida',                              tipo: 'contador', meta: 1,      icono: 'cards',          xp: 50,   fichas: 0 },
  { clave: 'partidas_10',        nombre: 'Jugador habitual',        descripcion: 'Juega 10 partidas',                                      tipo: 'contador', meta: 10,     icono: 'cards-three',    xp: 100,  fichas: 500 },
  { clave: 'partidas_25',        nombre: 'Frecuente',               descripcion: 'Juega 25 partidas',                                      tipo: 'contador', meta: 25,     icono: 'cards-three',    xp: 150,  fichas: 1000 },
  { clave: 'partidas_50',        nombre: 'Veterano',                descripcion: 'Juega 50 partidas',                                      tipo: 'contador', meta: 50,     icono: 'medal',          xp: 250,  fichas: 2500, titulo: 'veterano' },
  { clave: 'partidas_100',       nombre: 'Leyenda del Continental', descripcion: 'Juega 100 partidas',                                     tipo: 'contador', meta: 100,    icono: 'crown',          xp: 500,  fichas: 5000, titulo: 'leyenda' },
  { clave: 'partidas_500',       nombre: 'Dios del Continental',    descripcion: 'Juega 500 partidas',                                     tipo: 'contador', meta: 500,    icono: 'bank',           xp: 1500, fichas: 10000, titulo: 'dios_continental' },
  { clave: 'partidas_1000',      nombre: 'Inmortal',                descripcion: 'Juega 1,000 partidas',                                   tipo: 'contador', meta: 1000,   icono: 'crown-simple',   xp: 3000, fichas: 20000, titulo: 'inmortal' },
  { clave: 'primera_victoria',   nombre: 'Primera victoria',        descripcion: 'Gana tu primera partida',                                tipo: 'contador', meta: 1,      icono: 'trophy',         xp: 100,  fichas: 0 },
  { clave: 'victorias_10',       nombre: 'Imparable',               descripcion: 'Gana 10 partidas',                                       tipo: 'contador', meta: 10,     icono: 'fire',           xp: 300,  fichas: 0, titulo: 'imparable' },
  { clave: 'victorias_50',       nombre: 'Invencible',              descripcion: 'Gana 50 partidas',                                       tipo: 'contador', meta: 50,     icono: 'shield-star',    xp: 800,  fichas: 0, titulo: 'invencible' },
  { clave: 'racha_3',            nombre: 'Tricampeón',              descripcion: 'Gana 3 partidas consecutivas',                           tipo: 'contador', meta: 3,      icono: 'lightning',      xp: 400,  fichas: 0 },
  { clave: 'racha_5',            nombre: 'Invicto',                 descripcion: 'Gana 5 partidas consecutivas',                           tipo: 'contador', meta: 5,      icono: 'lightning',      xp: 500,  fichas: 0 },
  { clave: 'racha_10',           nombre: 'Imperturbable',           descripcion: 'Gana 10 partidas consecutivas',                          tipo: 'contador', meta: 10,     icono: 'lightning',      xp: 800,  fichas: 0, titulo: 'imparable_10' },
  { clave: 'top3_20',            nombre: 'Siempre en la pelea',     descripcion: 'Quedá entre los 3 primeros en 20 partidas',              tipo: 'contador', meta: 20,     icono: 'medal',          xp: 300,  fichas: 1000 },
  { clave: 'segundo_5',          nombre: 'Casi perfecto',           descripcion: 'Queda en 2º lugar en 5 partidas',                        tipo: 'contador', meta: 5,      icono: 'medal',          xp: 200,  fichas: 0 },
  { clave: 'apuesta_5',          nombre: 'Aventurero',              descripcion: 'Juega 5 partidas con apuesta',                           tipo: 'contador', meta: 5,      icono: 'coins',          xp: 150,  fichas: 0 },
  { clave: 'apuesta_10',         nombre: 'Valiente',                descripcion: 'Juega 10 partidas con apuesta',                          tipo: 'contador', meta: 10,     icono: 'coins',          xp: 250,  fichas: 1500 },
  { clave: 'apuesta_25',         nombre: 'Alto riesgo',             descripcion: 'Juega 25 partidas con apuesta',                          tipo: 'contador', meta: 25,     icono: 'chart-line-up',  xp: 400,  fichas: 2000 },
  { clave: 'victorias_apuesta_5',nombre: 'Cara de póker',           descripcion: 'Gana 5 partidas con apuesta',                            tipo: 'contador', meta: 5,      icono: 'trophy',         xp: 400,  fichas: 0 },
  { clave: 'victorias_apuesta_10',nombre:'Apostador nato',           descripcion: 'Gana 10 partidas con apuesta',                           tipo: 'contador', meta: 10,     icono: 'trophy',         xp: 600,  fichas: 3000, titulo: 'apostador_nato' },
  { clave: 'fichas_5000',        nombre: 'Acaparador',              descripcion: 'Gana 5,000 fichas en total',                             tipo: 'contador', meta: 5000,   icono: 'sack-dollar',    xp: 200,  fichas: 0 },
  { clave: 'fichas_25000',       nombre: 'Magnate',                 descripcion: 'Gana 25,000 fichas en total',                            tipo: 'contador', meta: 25000,  icono: 'bank',           xp: 600,  fichas: 5000, titulo: 'magnate' },
  { clave: 'fichas_1000000',     nombre: 'Millonario',              descripcion: 'Gana 1,000,000 fichas en total',                         tipo: 'contador', meta: 1000000, icono: 'crown',         xp: 1500, fichas: 10000, titulo: 'millonario' },
  { clave: 'primer_trio',        nombre: 'En buen camino',          descripcion: 'Baja tu primer trío en una partida',                     tipo: 'hito',     meta: 1,      icono: 'dots-three-outline', xp: 50, fichas: 0 },
  { clave: 'primer_corrida',     nombre: 'En racha',                descripcion: 'Baja tu primera corrida en una partida',                  tipo: 'hito',     meta: 1,      icono: 'list-numbers',   xp: 50,   fichas: 0 },
  { clave: 'partida_perfecta',   nombre: 'Perfecto',                descripcion: 'Queda en 1er lugar con 0 puntos',                         tipo: 'hito',     meta: 1,      icono: 'star-four',      xp: 3000, fichas: 10000, titulo: 'perfecto' },
  { clave: 'inmaculado',         nombre: 'Sin errores',             descripcion: 'Termina una partida sin bajada en falso',                 tipo: 'hito',     meta: 1,      icono: 'sparkle',        xp: 150,  fichas: 0 },
  { clave: 'sin_cartas_extra',   nombre: 'Sin cartas extra',        descripcion: 'Completa una partida sin castigarte',                     tipo: 'hito',     meta: 1,      icono: 'coins',          xp: 200,  fichas: 500, titulo: 'ahorrativo' },
  { clave: 'sin_comodines',      nombre: 'Puro poker',              descripcion: 'Ganá una partida sin usar comodines',                    tipo: 'hito',     meta: 1,      icono: 'hand-poker',     xp: 600,  fichas: 0 },
  { clave: 'back_to_back',       nombre: 'Vuelta y vuelta',         descripcion: 'Ganá 2 partidas seguidas saliendo primero',              tipo: 'hito',     meta: 1,      icono: 'arrows-clock',   xp: 500,  fichas: 0 },
];

// ─── Niveles (curva progresiva) ─────────────────────────────────
// Subir de nivel N → N+1 cuesta 100×N XP.
// XP acumulada para llegar al nivel L: Σ_{k=1..L-1} 100k = 50·L·(L−1)
function xpAcumuladaParaNivel(nivel) {
  return 50 * nivel * (nivel - 1);
}

function xpParaSubir(nivel) {
  return 100 * nivel;
}

function calcularNivel(xp) {
  const x = Math.max(0, Number(xp) || 0);
  let nivel = Math.floor((1 + Math.sqrt(1 + (4 * x) / 50)) / 2);
  while (xpAcumuladaParaNivel(nivel) > x) nivel--;
  while (xpAcumuladaParaNivel(nivel + 1) <= x) nivel++;
  return Math.max(1, nivel);
}

function progresoNivel(xp) {
  const x = Math.max(0, Number(xp) || 0);
  const nivel = calcularNivel(x);
  return {
    nivel,
    xpTotal: x,
    xpEnNivel: x - xpAcumuladaParaNivel(nivel),
    xpParaSiguiente: xpParaSubir(nivel),
    pct: Math.min(100, Math.round(((x - xpAcumuladaParaNivel(nivel)) / xpParaSubir(nivel)) * 100)),
  };
}

function tituloNivel(nivel) {
  if (nivel >= 50) return 'Leyenda';
  if (nivel >= 40) return 'Gran Maestro';
  if (nivel >= 30) return 'Maestro';
  if (nivel >= 20) return 'Profesional';
  if (nivel >= 10) return 'Entusiasta';
  if (nivel >= 5)  return 'Aprendiz';
  return 'Novato';
}

// XP de una partida concreta para un jugador.
function xpPartida({ posicion, ronda, conApuesta }) {
  const pos = XP_POSICION[Math.max(0, (posicion || 1) - 1)] ?? 10;
  const base = XP_BASE_PARTIDA + XP_POR_RONDA * Math.max(1, ronda || 1) + pos;
  return Math.round(base * (conApuesta ? MULT_APUESTA : 1));
}

// ─── Seed del catálogo ──────────────────────────────────────────
async function seedLogros(pool) {
  for (const [i, l] of LOGROS.entries()) {
    await pool.query(
      `INSERT INTO logros (clave, nombre, descripcion, tipo, meta, icono, xp, fichas, titulo, orden)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       ON CONFLICT (clave) DO UPDATE SET
         nombre     = EXCLUDED.nombre,
         descripcion = EXCLUDED.descripcion,
         tipo       = EXCLUDED.tipo,
         meta       = EXCLUDED.meta,
         icono      = EXCLUDED.icono,
         xp         = EXCLUDED.xp,
         fichas     = EXCLUDED.fichas,
         titulo     = EXCLUDED.titulo,
         orden      = EXCLUDED.orden`,
      [l.clave, l.nombre, l.descripcion, l.tipo, l.meta, l.icono, l.xp, l.fichas, l.titulo || null, i + 1]
    );
  }
}

// ─── Aplicar progreso de una partida a un usuario ───────────────
// Corre DENTRO de la transacción de _registrarPartida (client = pool.connect()).
// Devuelve el payload del evento WS 'progreso' para el jugador.
async function aplicarLogrosPartida(client, partidaId, userId, { posicion, ronda, conApuesta }) {
  const yaOtorgado = await client.query('SELECT xp_awarded FROM partidas WHERE id = $1', [partidaId]);
  if (yaOtorgado.rows[0]?.xp_awarded) return null;

  const row = await client.query(
    'SELECT pts_totales, posicion, bajo_tercia, bajo_corrida, castigos, se_castigo, uso_comodines, back_to_back FROM partidas_jugadores WHERE partida_id = $1 AND user_id = $2',
    [partidaId, userId]
  );
  const p = row.rows[0];

  const agg = await client.query(
    `SELECT
        COUNT(*)::int                                                AS partidas,
        COUNT(*) FILTER (WHERE pj.posicion = 1)::int                 AS victorias,
        COUNT(*) FILTER (WHERE pj.posicion = 1 AND p.con_apuesta)::int AS victorias_con_apuesta,
        COUNT(*) FILTER (WHERE pj.posicion = 2)::int                 AS segundos,
        COUNT(*) FILTER (WHERE pj.posicion <= 3)::int                AS top3,
        COUNT(*) FILTER (WHERE p.con_apuesta)::int                   AS apuestas,
        COALESCE(SUM(GREATEST(pj.ganancia, 0)), 0)::bigint           AS fichas_ganadas
     FROM partidas_jugadores pj
     JOIN partidas p ON p.id = pj.partida_id
     WHERE pj.user_id = $1`,
    [userId]
  );
  const { partidas, victorias, victorias_con_apuesta, segundos, top3, apuestas, fichas_ganadas } = agg.rows[0];

  const racha = await client.query(
    `SELECT pj.posicion
     FROM partidas_jugadores pj
     JOIN partidas p ON p.id = pj.partida_id
     WHERE pj.user_id = $1
     ORDER BY p.id ASC`,
    [userId]
  );
  // Mejor racha histórica: nunca decrece, así el logro no se revierte
  let rachaActual = 0;
  let mejorRacha = 0;
  for (const r of racha.rows) {
    if (r.posicion === 1) {
      rachaActual++;
      mejorRacha = Math.max(mejorRacha, rachaActual);
    } else {
      rachaActual = 0;
    }
  }

  const contadores = {
    primera_partida: partidas,
    partidas_10: partidas,
    partidas_25: partidas,
    partidas_50: partidas,
    partidas_100: partidas,
    partidas_500: partidas,
    partidas_1000: partidas,
    primera_victoria: victorias,
    victorias_10: victorias,
    victorias_50: victorias,
    victorias_apuesta_5: victorias_con_apuesta,
    victorias_apuesta_10: victorias_con_apuesta,
    segundo_5: segundos,
    top3_20: top3,
    racha_3: mejorRacha,
    racha_5: mejorRacha,
    racha_10: mejorRacha,
    apuesta_5: apuestas,
    apuesta_10: apuestas,
    apuesta_25: apuestas,
    fichas_5000: Number(fichas_ganadas),
    fichas_25000: Number(fichas_ganadas),
    fichas_1000000: Number(fichas_ganadas),
  };

  const hitos = {
    primer_trio: p.bajo_tercia ? 1 : 0,
    primer_corrida: p.bajo_corrida ? 1 : 0,
    partida_perfecta: (p.posicion === 1 && Number(p.pts_totales) === 0) ? 1 : 0,
    inmaculado: Number(p.castigos) === 0 ? 1 : 0,
    sin_cartas_extra: p.se_castigo ? 0 : 1,
    sin_comodines: (p.posicion === 1 && !p.uso_comodines) ? 1 : 0,
    back_to_back: p.back_to_back ? 1 : 0,
  };

  const logros = await client.query('SELECT id, clave, tipo, meta, xp, fichas, titulo FROM logros');
  const prev = await client.query('SELECT logro_id, completado FROM logros_usuario WHERE user_id = $1', [userId]);
  const prevCompletado = new Map(prev.rows.map(r => [r.logro_id, r.completado]));

  let xpGanada = xpPartida({ posicion, ronda, conApuesta });
  let fichasBonus = 0;
  const nuevosLogros = [];
  let nuevoTitulo = null;

  for (const l of logros.rows) {
    const progreso = l.tipo === 'contador' ? (contadores[l.clave] ?? 0) : (hitos[l.clave] ?? 0);
    const completado = progreso >= l.meta;
    const yaCompletado = prevCompletado.get(l.id) === true;

    await client.query(
      `INSERT INTO logros_usuario (user_id, logro_id, progreso, completado, completado_at)
       VALUES ($1, $2, $3, $4, CASE WHEN $4 THEN NOW() ELSE NULL END)
       ON CONFLICT (user_id, logro_id) DO UPDATE SET
         progreso      = EXCLUDED.progreso,
         completado    = EXCLUDED.completado,
         completado_at = CASE
                            WHEN NOT logros_usuario.completado AND EXCLUDED.completado THEN NOW()
                            ELSE logros_usuario.completado_at
                          END`,
      [userId, l.id, progreso, completado]
    );

    if (completado && !yaCompletado) {
      xpGanada += l.xp;
      fichasBonus += Number(l.fichas || 0);
      nuevosLogros.push({ clave: l.clave, nombre: l.nombre, icono: l.icono, xp: l.xp, fichas: Number(l.fichas || 0), titulo: l.titulo });
      if (l.titulo) {
        await client.query(
          'INSERT INTO usuarios_titulos (user_id, titulo) VALUES ($1, $2) ON CONFLICT DO NOTHING',
          [userId, l.titulo]
        );
        if (!nuevoTitulo) nuevoTitulo = l.titulo;
      }
    }
  }

  const u = await client.query('SELECT xp, nivel, titulo FROM usuarios WHERE id = $1', [userId]);
  const xpTotal = Number(u.rows[0].xp || 0) + xpGanada;
  const nivelAntes = u.rows[0].nivel;
  const nivelDespues = calcularNivel(xpTotal);
  // Solo se auto-equipa el título si el jugador no tenía uno puesto.
  const tituloFinal = u.rows[0].titulo || nuevoTitulo;

  await client.query(
    'UPDATE usuarios SET xp = $1, nivel = $2, titulo = $3 WHERE id = $4',
    [xpTotal, nivelDespues, tituloFinal, userId]
  );
  if (fichasBonus > 0) {
    await client.query('UPDATE usuarios SET chips = chips + $1 WHERE id = $2', [fichasBonus, userId]);
  }

  const prog = progresoNivel(xpTotal);

  return {
    type: 'progreso',
    xpGanada,
    xpTotal,
    nivel: nivelDespues,
    nivelAntes,
    subioNivel: nivelDespues > nivelAntes,
    xpEnNivel: prog.xpEnNivel,
    xpParaSiguiente: prog.xpParaSiguiente,
    pct: prog.pct,
    nuevosLogros,
    fichasBonus,
    nuevoTitulo,
    titulo: tituloFinal,
  };
}

module.exports = {
  LOGROS,
  xpPartida,
  xpAcumuladaParaNivel,
  xpParaSubir,
  calcularNivel,
  progresoNivel,
  tituloNivel,
  seedLogros,
  aplicarLogrosPartida,
};
