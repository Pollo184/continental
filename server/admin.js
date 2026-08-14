'use strict';
const express    = require('express');
const pool       = require('./db');
const { verifyAuthorized } = require('./jwt-utils');
const { middleware: rateLimit } = require('./rate-limit');

const BADGES = {
  'owner':         { label: 'Owner',         emoji: '👑' },
  'beta_tester':   { label: 'Beta Tester',   emoji: '🧪' },
  'early_adopter': { label: 'Early Adopter', emoji: '🎖️' },
  'vip':           { label: 'VIP',           emoji: '⭐' },
};

// Middleware — solo owner
async function requireOwner(req, res, next) {
  try {
    const payload = await verifyAuthorized(req.headers.authorization);
    if (payload.rol !== 'owner')
      return res.status(403).json({ error: 'Acceso denegado.' });
    req.user = payload;
    next();
  } catch (err) {
    res.status(err.status || 401).json({ error: err.message || 'Token inválido.' });
  }
}

function serializeRoom(room) {
  return {
    code: room.code,
    status: room.status,
    mode: room.mode,
    maxPlayers: room.maxPlayers,
    tableColor: room.tableColor || 'green',
    createdAt: room.createdAt,
    playerCount: room.players.length,
    connectedCount: room.players.filter(player => player.conectado).length,
    host: room.players[0]?.nombre || room.host?.nombre || 'Sin host',
    players: room.players.map(player => ({
      id: player.id,
      nombre: player.nombre,
      conectado: player.conectado,
    })),
    ronda: room.engine?.ronda || null,
    turnoJugador: room.engine?.jActivo?.nombre || null,
  };
}

function sendSocketMessage(ws, msg) {
  try {
    if (ws?.readyState === 1) ws.send(JSON.stringify(msg));
  } catch (_) {}
}

function createAdminRouter({ rooms, clients }) {
  const router = express.Router();

  // ── GET /api/admin/usuarios ─────────────────────────────────────
  router.get('/admin/usuarios', requireOwner, async (req, res) => {
    try {
      const result = await pool.query(
        'SELECT id, nombre, email, badge, rol, created_at FROM usuarios ORDER BY created_at DESC'
      );
      res.json({ usuarios: result.rows });
    } catch (err) {
      console.error('[admin]', err.message);
      res.status(500).json({ error: 'Error interno.' });
    }
  });

  // ── POST /api/admin/badge ───────────────────────────────────────
  router.post('/admin/badge', requireOwner, rateLimit({ max: 60, windowMs: 60 * 1000, message: 'Demasiadas peticiones. Espera un momento.' }), async (req, res) => {
    try {
      const { usuarioId, badge } = req.body;
      if (!usuarioId) return res.status(400).json({ error: 'usuarioId requerido.' });

      // badge null = quitar badge
      if (badge !== null && badge !== undefined && !BADGES[badge])
        return res.status(400).json({ error: 'Badge inválido.' });

      const update = await pool.query(
        `UPDATE usuarios
            SET badge = $1
          WHERE id = $2
        RETURNING id, nombre, badge, rol, skin`,
        [badge || null, usuarioId]
      );
      const usuario = update.rows[0];
      if (!usuario) return res.status(404).json({ error: 'Usuario no encontrado.' });

      Array.from(rooms.values()).forEach(room => {
        room.refreshPlayerProfile(usuario.nombre, {
          badge: usuario.badge || null,
          skin: usuario.skin || 'clasico',
        });
      });

      for (const [ws, ctx] of clients) {
        const sameUser = String(ctx?.userId || '') === String(usuario.id) || ctx?.nombre === usuario.nombre;
        if (!sameUser) continue;
        sendSocketMessage(ws, {
          type: 'profile_updated',
          profile: {
            id: usuario.id,
            nombre: usuario.nombre,
            badge: usuario.badge || null,
            rol: usuario.rol,
            skin: usuario.skin || 'clasico',
          },
        });
      }

      res.json({ ok: true, usuario });
    } catch (err) {
      console.error('[admin badge]', err.message);
      res.status(500).json({ error: 'Error interno.' });
    }
  });

  // ── GET /api/admin/badges ───────────────────────────────────────
  router.get('/admin/badges', requireOwner, async (req, res) => {
    res.json({ badges: BADGES });
  });

  // ── GET /api/admin/mesas ────────────────────────────────────────
  router.get('/admin/mesas', requireOwner, async (req, res) => {
    const mesas = Array.from(rooms.values())
      .map(serializeRoom)
      .sort((left, right) => right.createdAt - left.createdAt);

    res.json({ mesas });
  });

  // ── POST /api/admin/mesas/:code/cerrar ─────────────────────────
  router.post('/admin/mesas/:code/cerrar', requireOwner, rateLimit({ max: 30, windowMs: 60 * 1000, message: 'Demasiadas peticiones. Espera un momento.' }), async (req, res) => {
    const code = String(req.params.code || '').trim().toUpperCase();
    const room = rooms.get(code);
    if (!room) return res.status(404).json({ error: 'Mesa no encontrada.' });

    room.forceClose('Mesa cerrada por el owner desde admin.');
    rooms.delete(code);

    res.json({ ok: true, code });
  });

  return router;
}

module.exports = createAdminRouter;