'use strict';
const express  = require('express');
const bcrypt   = require('bcrypt');
const pool     = require('./db');

const router = express.Router();
const { middleware: rateLimit, rateLimitHit, isRateLimited } = require('./rate-limit');
const { signUserToken, verifyAuthorized, incrementTokenVersion } = require('./jwt-utils');
const { progresoNivel, tituloNivel } = require('./logros');

const NAME_RE  = /^[A-Za-z0-9áéíóúÁÉÍÓÚñÑüÜ ]{2,18}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const CHIPS_INICIALES = 10000;

// ── POST /api/register ──────────────────────────────────────────
router.post('/register', rateLimit({ max: 5, windowMs: 10 * 60 * 1000, message: 'Demasiados registros desde tu IP. Espera unos minutos.' }), async (req, res) => {
  try {
    const { nombre, email, password } = req.body;

    // Validaciones
    if (!nombre || !NAME_RE.test(nombre.trim()))
      return res.status(400).json({ error: 'Nombre inválido (2-18 letras/números).' });
    if (!email || !EMAIL_RE.test(email.trim()))
      return res.status(400).json({ error: 'Email inválido.' });
    if (!password || password.length < 8)
      return res.status(400).json({ error: 'La contraseña debe tener al menos 8 caracteres.' });
    if (!/[A-Z]/.test(password))
      return res.status(400).json({ error: 'La contraseña debe tener al menos una mayúscula.' });
    if (!/[!@#$%^&*()\-_=+\[\]{};':"\|,.<>/?`~]/.test(password))
      return res.status(400).json({ error: 'La contraseña debe tener al menos un carácter especial.' });

    const safeNombre = nombre.trim();
    const safeEmail  = email.trim().toLowerCase();

    // Verificar si ya existe
    const existe = await pool.query(
      'SELECT id FROM usuarios WHERE nombre = $1 OR email = $2',
      [safeNombre, safeEmail]
    );
    if (existe.rows.length > 0)
      return res.status(409).json({ error: 'El nombre de usuario o email ya está en uso.' });

    // Hashear contraseña
    const hash = await bcrypt.hash(password, 12);

    // Insertar usuario
    const result = await pool.query(
      'INSERT INTO usuarios (nombre, email, password) VALUES ($1, $2, $3) RETURNING id, nombre, badge, titulo, rol, skin, chips',
      [safeNombre, safeEmail, hash]
    );
    const usuario = result.rows[0];

    // Generar token
    const token = signUserToken(usuario);

    res.json({ token, usuario: { id: usuario.id, nombre: usuario.nombre, badge: usuario.badge, titulo: usuario.titulo || null, rol: usuario.rol, skin: usuario.skin || 'clasico', chips: Number(usuario.chips ?? CHIPS_INICIALES) } });

  } catch (err) {
    console.error('[register]', err.message);
    res.status(500).json({ error: 'Error interno del servidor.' });
  }
});

// ── POST /api/login ─────────────────────────────────────────────
router.post('/login', rateLimit({ max: 20, windowMs: 15 * 60 * 1000, message: 'Demasiados intentos de inicio de sesión. Espera unos minutos.' }), async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password)
      return res.status(400).json({ error: 'Email y contraseña son requeridos.' });

    const safeEmail = email.trim().toLowerCase();

    const LOCK_MAX = 5;
    const LOCK_WIN = 15 * 60 * 1000;
    if (isRateLimited(`login:${safeEmail}`, LOCK_MAX, LOCK_WIN))
      return res.status(429).json({ error: 'Cuenta temporalmente bloqueada por demasiados intentos. Espera unos minutos.' });

    // Buscar usuario
    const result = await pool.query(
      'SELECT id, nombre, password, badge, titulo, rol, skin, chips, token_version FROM usuarios WHERE email = $1',
      [safeEmail]
    );
    if (result.rows.length === 0) {
      rateLimitHit(`login:${safeEmail}`, LOCK_WIN);
      return res.status(401).json({ error: 'Email o contraseña incorrectos.' });
    }

    const usuario = result.rows[0];

    // Verificar contraseña
    const ok = await bcrypt.compare(password, usuario.password);
    if (!ok) {
      rateLimitHit(`login:${safeEmail}`, LOCK_WIN);
      return res.status(401).json({ error: 'Email o contraseña incorrectos.' });
    }

    // Generar token
    const token = signUserToken(usuario);

    res.json({ token, usuario: { id: usuario.id, nombre: usuario.nombre, badge: usuario.badge, titulo: usuario.titulo || null, rol: usuario.rol, skin: usuario.skin || 'clasico', chips: Number(usuario.chips ?? CHIPS_INICIALES) } });

  } catch (err) {
    console.error('[login]', err.message);
    res.status(500).json({ error: 'Error interno del servidor.' });
  }
});

// ── GET /api/me ─────────────────────────────────────────────────
router.get('/me', async (req, res) => {
  try {
    const payload = await verifyAuthorized(req.headers.authorization);

    const result = await pool.query(
      'SELECT id, nombre, badge, titulo, rol, skin, chips, xp, nivel, created_at FROM usuarios WHERE id = $1',
      [payload.id]
    );
    if (result.rows.length === 0)
      return res.status(404).json({ error: 'Usuario no encontrado.' });

    const u = result.rows[0];
    if (u.chips != null) u.chips = Number(u.chips);
    const prog = progresoNivel(u.xp);
    u.xp = Number(u.xp || 0);
    u.nivel = u.nivel || prog.nivel;
    u.xpEnNivel = prog.xpEnNivel;
    u.xpParaSiguiente = prog.xpParaSiguiente;
    u.tituloNivel = tituloNivel(u.nivel);
    res.json({ usuario: u });

  } catch (err) {
    res.status(err.status || 401).json({ error: err.message || 'Token inválido o expirado.' });
  }
});

// ── POST /api/me/fichas ──────────────────────────────────────────
// Recarga de fichas en la beta: reinicia el saldo a 10,000 con cooldown.
const CHIPS_RECHARGE_COOLDOWN_MS = Number(process.env.CHIPS_RECHARGE_COOLDOWN_MS) || 30 * 60 * 1000;

router.post('/me/fichas', rateLimit({ max: 10, windowMs: 10 * 60 * 1000, message: 'Demasiadas recargas. Espera unos minutos.' }), async (req, res) => {
  try {
    const payload = await verifyAuthorized(req.headers.authorization);

    const actual = await pool.query(
      `SELECT id,
              EXTRACT(EPOCH FROM (NOW() - last_reload_at)) AS elapsed_sec
         FROM usuarios
        WHERE id = $1`,
      [payload.id]
    );
    if (!actual.rows[0]) return res.status(404).json({ error: 'Usuario no encontrado.' });

    const elapsedSec = actual.rows[0].elapsed_sec;
    if (elapsedSec != null && elapsedSec * 1000 < CHIPS_RECHARGE_COOLDOWN_MS) {
      const falta = CHIPS_RECHARGE_COOLDOWN_MS - elapsedSec * 1000;
      return res.status(429).json({
        error: 'Ya recargaste fichas hace poco.',
        retryAfterMs: falta,
        retryAfter: Math.ceil(falta / 60000),
      });
    }

    const result = await pool.query(
      `UPDATE usuarios
          SET chips = $1,
              last_reload_at = NOW()
        WHERE id = $2
        RETURNING id, nombre, badge, rol, skin, chips`,
      [CHIPS_INICIALES, payload.id]
    );
    const usuario = result.rows[0];
    if (!usuario) return res.status(404).json({ error: 'Usuario no encontrado.' });
    if (usuario.chips != null) usuario.chips = Number(usuario.chips);

    res.json({ ok: true, usuario });

  } catch (err) {
    console.error('[fichas]', err.message);
    res.status(err.status || 500).json({ error: err.message || 'Error interno.' });
  }
});

// ── POST /api/me/nombre ─────────────────────────────────────────
router.post('/me/nombre', rateLimit({ max: 10, windowMs: 10 * 60 * 1000, message: 'Demasiados cambios de nombre. Espera unos minutos.' }), async (req, res) => {
  try {
    const payload = await verifyAuthorized(req.headers.authorization);
    const { nombre } = req.body;
    const safeNombre = String(nombre || '').trim();

    if (!safeNombre || !NAME_RE.test(safeNombre))
      return res.status(400).json({ error: 'Nombre inválido (2-18 letras/números).' });

    const existe = await pool.query(
      'SELECT id FROM usuarios WHERE nombre = $1 AND id <> $2',
      [safeNombre, payload.id]
    );
    if (existe.rows.length > 0)
      return res.status(409).json({ error: 'Ese nombre ya está en uso.' });

    const result = await pool.query(
      `UPDATE usuarios
          SET nombre = $1
        WHERE id = $2
        RETURNING id, nombre, badge, titulo, rol, skin`,
      [safeNombre, payload.id]
    );
    const usuario = result.rows[0];
    if (!usuario) return res.status(404).json({ error: 'Usuario no encontrado.' });

    res.json({ ok: true, usuario });

  } catch (err) {
    console.error('[nombre]', err.message);
    res.status(err.status || 500).json({ error: err.message || 'Error interno.' });
  }
});

// ── POST /api/me/skin ────────────────────────────────────────────
const SKINS_LIBRES     = ['clasico', 'rojo', 'obsidiana', 'esmeralda', 'plata', 'bronce', 'zafiro'];
const SKINS_EXCLUSIVOS = {
  'dorado': ['owner'],
  'neon':   ['owner', 'vip', 'beta_tester'],
  'imperial': ['owner'],
  'arcoiris': ['owner'],
  'amatista': ['vip'],
  'cobalto': ['beta_tester'],
  'marfil': ['early_adopter'],
};

router.post('/me/skin', rateLimit({ max: 20, windowMs: 10 * 60 * 1000, message: 'Demasiados cambios de skin. Espera unos minutos.' }), async (req, res) => {
  try {
    const payload = await verifyAuthorized(req.headers.authorization);
    const { skin } = req.body;

    const todosLosSkins = [...SKINS_LIBRES, ...Object.keys(SKINS_EXCLUSIVOS)];
    if (!todosLosSkins.includes(skin))
      return res.status(400).json({ error: 'Skin inválido.' });

    // Verificar acceso a skins exclusivos
    if (SKINS_EXCLUSIVOS[skin]) {
      const r = await pool.query('SELECT rol, badge FROM usuarios WHERE id = $1', [payload.id]);
      const u = r.rows[0];
      if (u?.rol === 'owner') {
        await pool.query('UPDATE usuarios SET skin = $1 WHERE id = $2', [skin, payload.id]);
        return res.json({ ok: true, skin });
      }
      const permitidos = SKINS_EXCLUSIVOS[skin];
      if (!permitidos.includes(u?.rol) && !permitidos.includes(u?.badge))
        return res.status(403).json({ error: 'No tienes acceso a este skin.' });
    }

    await pool.query('UPDATE usuarios SET skin = $1 WHERE id = $2', [skin, payload.id]);
    res.json({ ok: true, skin });

  } catch (err) {
    console.error('[skin]', err.message);
    res.status(err.status || 500).json({ error: err.message || 'Error interno.' });
  }
});

// ── POST /api/me/titulo ───────────────────────────────────────────
// Equipa/quita un título de logro desbloqueado. Solo permite títulos
// que el jugador haya ganado (los badges especiales son solo del admin).
router.post('/me/titulo', rateLimit({ max: 20, windowMs: 10 * 60 * 1000, message: 'Demasiados cambios de título. Espera unos minutos.' }), async (req, res) => {
  try {
    const payload = await verifyAuthorized(req.headers.authorization);
    const { titulo } = req.body;
    const safeTitulo = titulo ? String(titulo).trim() : '';

    if (safeTitulo) {
      const r = await pool.query(
        'SELECT 1 FROM usuarios_titulos WHERE user_id = $1 AND titulo = $2',
        [payload.id, safeTitulo]
      );
      if (r.rows.length === 0)
        return res.status(403).json({ error: 'No tienes ese título desbloqueado.' });
    }

    const result = await pool.query(
      `UPDATE usuarios
          SET titulo = $1
        WHERE id = $2
        RETURNING id, nombre, badge, titulo, rol, skin`,
      [safeTitulo || null, payload.id]
    );
    const usuario = result.rows[0];
    if (!usuario) return res.status(404).json({ error: 'Usuario no encontrado.' });

    res.json({ ok: true, usuario });

  } catch (err) {
    console.error('[titulo]', err.message);
    res.status(err.status || 500).json({ error: err.message || 'Error interno.' });
  }
});

// ── POST /api/refresh ────────────────────────────────────────────
// Renueva el token (aunque esté expirado) si la sesión no fue revocada.
router.post('/refresh', rateLimit({ max: 20, windowMs: 15 * 60 * 1000, message: 'Demasiadas peticiones. Espera unos minutos.' }), async (req, res) => {
  try {
    const payload = await verifyAuthorized(req.headers.authorization, { ignoreExpiration: true });

    const result = await pool.query(
      'SELECT id, nombre, badge, titulo, rol, skin, chips, token_version FROM usuarios WHERE id = $1',
      [payload.id]
    );
    const usuario = result.rows[0];
    if (!usuario) return res.status(404).json({ error: 'Usuario no encontrado.' });

    const token = signUserToken(usuario);
    res.json({ token, usuario: { id: usuario.id, nombre: usuario.nombre, badge: usuario.badge, titulo: usuario.titulo || null, rol: usuario.rol, skin: usuario.skin || 'clasico', chips: Number(usuario.chips ?? CHIPS_INICIALES) } });
  } catch (err) {
    res.status(err.status || 401).json({ error: err.message || 'Token inválido o expirado.' });
  }
});

// ── POST /api/me/revocar ─────────────────────────────────────────
// Revoca todas las sesiones activas (invalida los tokens emitidos antes).
router.post('/me/revocar', rateLimit({ max: 5, windowMs: 10 * 60 * 1000, message: 'Demasiadas peticiones. Espera unos minutos.' }), async (req, res) => {
  try {
    const payload = await verifyAuthorized(req.headers.authorization);
    await incrementTokenVersion(payload.id);
    res.json({ ok: true, msg: 'Sesiones revocadas. Vuelve a iniciar sesión.' });
  } catch (err) {
    res.status(err.status || 401).json({ error: err.message || 'No autorizado.' });
  }
});

// ── GET /api/stats ───────────────────────────────────────────────
// Estadísticas acumuladas del usuario autenticado + historial reciente.
router.get('/stats', async (req, res) => {
  try {
    const payload = await verifyAuthorized(req.headers.authorization);
    const stats = await pool.query(`
      SELECT
        COUNT(*)::int                                     AS partidas,
        COUNT(*) FILTER (WHERE p.con_apuesta)::int        AS con_apuesta,
        COALESCE(SUM(pj.ganancia), 0)::int                AS ganancia_total,
        COALESCE(SUM(pj.pts_totales), 0)::int             AS pts_totales,
        COUNT(*) FILTER (WHERE pj.posicion = 1)::int      AS victorias,
        MAX(p.finished_at)                                AS ultima_partida
      FROM partidas_jugadores pj
      JOIN partidas p ON p.id = pj.partida_id
      WHERE pj.user_id = $1
    `, [payload.id]);
    const historial = await pool.query(`
      SELECT p.id, p.codigo, p.con_apuesta, p.ronda, p.finished_at,
             pj.posicion, pj.pts_totales, pj.ganancia
        FROM partidas_jugadores pj
        JOIN partidas p ON p.id = pj.partida_id
       WHERE pj.user_id = $1
       ORDER BY p.finished_at DESC
       LIMIT 15
    `, [payload.id]);
    res.json({ ...stats.rows[0], historial: historial.rows });
  } catch (err) {
    res.status(err.status || 401).json({ error: err.message || 'No autorizado.' });
  }
});

// ── GET /api/ranking ─────────────────────────────────────────────
// Top de jugadores por victorias / ganancia + la posición del usuario.
router.get('/ranking', async (req, res) => {
  try {
    const payload = await verifyAuthorized(req.headers.authorization);
    const top = await pool.query(`
      SELECT u.id, u.nombre, u.badge, u.skin, u.nivel,
             COUNT(pj.id)::int                                        AS partidas,
             COUNT(pj.id) FILTER (WHERE pj.posicion = 1)::int         AS victorias,
             COALESCE(SUM(pj.ganancia), 0)::int                       AS ganancia_total,
             COALESCE(SUM(pj.pts_totales), 0)::int                    AS pts_totales
        FROM usuarios u
        LEFT JOIN partidas_jugadores pj ON pj.user_id = u.id
       GROUP BY u.id, u.nombre, u.badge, u.skin, u.nivel
      HAVING COUNT(pj.id) > 0
       ORDER BY victorias DESC, ganancia_total DESC, pts_totales ASC
       LIMIT 20
    `);
    const yo = await pool.query(`
      SELECT COUNT(*)::int AS partidas,
             COUNT(*) FILTER (WHERE pj.posicion = 1)::int AS victorias,
             COALESCE(SUM(pj.ganancia), 0)::int AS ganancia_total
        FROM partidas_jugadores pj
       WHERE pj.user_id = $1
    `, [payload.id]);
    res.json({ ranking: top.rows, yo: { ...yo.rows[0], id: payload.id } });
  } catch (err) {
    res.status(err.status || 401).json({ error: err.message || 'No autorizado.' });
  }
});

// ── GET /api/logros ─────────────────────────────────────────────
// Nivel del usuario + catálogo de logros con su progreso personal.
router.get('/logros', async (req, res) => {
  try {
    const payload = await verifyAuthorized(req.headers.authorization);

    const u = await pool.query('SELECT xp, nivel, titulo FROM usuarios WHERE id = $1', [payload.id]);
    if (!u.rows[0]) return res.status(404).json({ error: 'Usuario no encontrado.' });

    const nivelData = progresoNivel(u.rows[0].xp);

    const titulosDesbloqueados = await pool.query(
      'SELECT titulo FROM usuarios_titulos WHERE user_id = $1 ORDER BY titulo',
      [payload.id]
    );

    const logros = await pool.query(
      'SELECT id, clave, nombre, descripcion, tipo, meta, icono, xp, fichas, titulo, orden FROM logros ORDER BY orden'
    );
    const userProg = await pool.query(
      'SELECT logro_id, progreso, completado, completado_at FROM logros_usuario WHERE user_id = $1',
      [payload.id]
    );
    const progMap = new Map(userProg.rows.map(r => [r.logro_id, r]));

    const lista = logros.rows.map(l => {
      const p = progMap.get(l.id);
      return {
        clave: l.clave,
        nombre: l.nombre,
        descripcion: l.descripcion,
        tipo: l.tipo,
        meta: l.meta,
        icono: l.icono,
        xp: l.xp,
        fichas: l.fichas,
        titulo: l.titulo,
        orden: l.orden,
        progreso: p?.progreso ?? 0,
        completado: p?.completado ?? false,
        completado_at: p?.completado_at ?? null,
      };
    });

    res.json({
      nivel: nivelData.nivel,
      titulo: tituloNivel(nivelData.nivel),
      tituloEquipado: u.rows[0].titulo || null,
      titulos: titulosDesbloqueados.rows.map(r => r.titulo),
      xpTotal: nivelData.xpTotal,
      xpEnNivel: nivelData.xpEnNivel,
      xpParaSiguiente: nivelData.xpParaSiguiente,
      pct: nivelData.pct,
      logros: lista,
    });
  } catch (err) {
    res.status(err.status || 401).json({ error: err.message || 'No autorizado.' });
  }
});

module.exports = router;