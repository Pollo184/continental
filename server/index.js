'use strict';
require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const express  = require('express');
const http     = require('http');
const { WebSocketServer } = require('ws');
const path     = require('path');
const { randomUUID } = require('crypto');
const { GameRoom } = require('./GameRoom');
const { ANTE_DEFAULT, ANTE_MIN, ANTE_MAX } = require('./GameEngine');
const pool         = require('./db');
const { rateLimitHit, isRateLimited } = require('./rate-limit');
const { verifyAuthorized } = require('./jwt-utils');

const PORT = process.env.PORT || 3000;
const app  = express();
const srv  = http.createServer(app);
const wss  = new WebSocketServer({ server: srv });

app.use(express.json());
app.use(express.static(path.join(__dirname, '../client'), {
  etag: true,
  setHeaders: (res) => {
    // Forzar revalidación de assets para no servir versiones viejas en caché
    res.setHeader('Cache-Control', 'no-cache');
  }
}));

// Rutas auth, feedback y admin
const authRouter     = require('./auth');
const feedbackRouter = require('./feedback');
app.use('/api', authRouter);
app.use('/api', feedbackRouter);

app.get('/',         (_, res) => res.sendFile(path.join(__dirname, '../client/index.html')));
app.get('/login',    (_, res) => res.sendFile(path.join(__dirname, '../client/login.html')));
app.get('/register', (_, res) => res.sendFile(path.join(__dirname, '../client/register.html')));
app.get('/game',     (_, res) => res.sendFile(path.join(__dirname, '../client/game.html')));
app.get('/admin',    (_, res) => res.sendFile(path.join(__dirname, '../client/admin.html')));
app.get('/perfil',   (_, res) => res.sendFile(path.join(__dirname, '../client/perfil.html')));

const rooms   = new Map();
const clients = new Map();
let socketSeq = 0;

async function ensureDatabaseSchema() {
  // Tablas base (sin esto el arranque fallaría en una BD nueva):
  // los ALTER de abajo asumen que "usuarios" ya existe.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS usuarios (
      id          SERIAL PRIMARY KEY,
      nombre      VARCHAR(30)  NOT NULL UNIQUE,
      email       VARCHAR(100) NOT NULL UNIQUE,
      password    VARCHAR(255) NOT NULL,
      badge       VARCHAR(50)  DEFAULT NULL,
      rol         VARCHAR(20)  DEFAULT 'jugador',
      skin        VARCHAR(50)  DEFAULT 'clasico',
      chips       BIGINT       NOT NULL DEFAULT 10000,
      created_at  TIMESTAMP    DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS feedback (
      id          SERIAL PRIMARY KEY,
      usuario_id  INTEGER REFERENCES usuarios(id) ON DELETE SET NULL,
      nombre      VARCHAR(30),
      mensaje     TEXT NOT NULL,
      rating      SMALLINT CHECK (rating BETWEEN 1 AND 5),
      created_at  TIMESTAMP DEFAULT NOW()
    )
  `);

  await pool.query(`
    ALTER TABLE usuarios
    ADD COLUMN IF NOT EXISTS skin VARCHAR(50) DEFAULT 'clasico'
  `);

  await pool.query(`
    ALTER TABLE usuarios
    ADD COLUMN IF NOT EXISTS chips BIGINT NOT NULL DEFAULT 10000
  `);

  await pool.query(`
    ALTER TABLE usuarios
    ADD COLUMN IF NOT EXISTS last_reload_at TIMESTAMP
  `);

  await pool.query(`
    ALTER TABLE usuarios
    ADD COLUMN IF NOT EXISTS token_version INTEGER NOT NULL DEFAULT 0
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS partidas (
      id            SERIAL PRIMARY KEY,
      codigo        VARCHAR(5),
      con_apuesta   BOOLEAN DEFAULT FALSE,
      ronda         SMALLINT DEFAULT 7,
      created_at    TIMESTAMP DEFAULT NOW(),
      finished_at   TIMESTAMP DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS partidas_jugadores (
      id             SERIAL PRIMARY KEY,
      partida_id     INTEGER REFERENCES partidas(id) ON DELETE CASCADE,
      user_id        INTEGER REFERENCES usuarios(id) ON DELETE CASCADE,
      nombre         VARCHAR(30),
      posicion       SMALLINT,
      pts_totales    INTEGER,
      fichas_inicio  BIGINT,
      fichas_final   BIGINT,
      ganancia       BIGINT
    )
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_pj_user    ON partidas_jugadores(user_id)
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_pj_partida ON partidas_jugadores(partida_id)
  `);

  await pool.query(`
    ALTER TABLE usuarios
    ADD COLUMN IF NOT EXISTS xp BIGINT NOT NULL DEFAULT 0
  `);

  await pool.query(`
    ALTER TABLE usuarios
    ADD COLUMN IF NOT EXISTS nivel INTEGER NOT NULL DEFAULT 1
  `);

  await pool.query(`
    ALTER TABLE partidas
    ADD COLUMN IF NOT EXISTS xp_awarded BOOLEAN NOT NULL DEFAULT FALSE
  `);

  await pool.query(`
    ALTER TABLE partidas_jugadores
    ADD COLUMN IF NOT EXISTS bajo_tercia BOOLEAN NOT NULL DEFAULT FALSE
  `);

  await pool.query(`
    ALTER TABLE partidas_jugadores
    ADD COLUMN IF NOT EXISTS bajo_corrida BOOLEAN NOT NULL DEFAULT FALSE
  `);

  await pool.query(`
    ALTER TABLE partidas_jugadores
    ADD COLUMN IF NOT EXISTS castigos INTEGER NOT NULL DEFAULT 0
  `);

  await pool.query(`
    ALTER TABLE partidas_jugadores
    ADD COLUMN IF NOT EXISTS se_castigo BOOLEAN NOT NULL DEFAULT FALSE
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS logros (
      id          SERIAL PRIMARY KEY,
      clave       VARCHAR(40)  NOT NULL UNIQUE,
      nombre      VARCHAR(60)  NOT NULL,
      descripcion TEXT         NOT NULL,
      tipo        VARCHAR(10)  NOT NULL DEFAULT 'contador',
      meta        INTEGER      NOT NULL DEFAULT 1,
      icono       VARCHAR(40)  DEFAULT 'award',
      xp          INTEGER      NOT NULL DEFAULT 0,
      fichas      BIGINT       NOT NULL DEFAULT 0,
      titulo      VARCHAR(30),
      orden       INTEGER      NOT NULL DEFAULT 0
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS logros_usuario (
      user_id       INTEGER REFERENCES usuarios(id) ON DELETE CASCADE,
      logro_id      INTEGER REFERENCES logros(id)   ON DELETE CASCADE,
      progreso      INTEGER NOT NULL DEFAULT 0,
      completado    BOOLEAN NOT NULL DEFAULT FALSE,
      completado_at TIMESTAMP,
      PRIMARY KEY (user_id, logro_id)
    )
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_logros_usuario ON logros_usuario(user_id)
  `);

  const { seedLogros } = require('./logros');
  await seedLogros(pool);

  await pool.query(`
    UPDATE usuarios
    SET skin = 'clasico'
    WHERE skin IS NULL OR skin = ''
  `);
}

const createAdminRouter = require('./admin');
app.use('/api', createAdminRouter({ rooms, clients }));

function logWs(...args) {
  console.log('[WS]', ...args);
}

function genCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let c = '';
  for (let i = 0; i < 5; i++) c += chars[Math.floor(Math.random() * chars.length)];
  return c;
}

const NAME_RE = /^[A-Za-z0-9áéíóúÁÉÍÓÚñÑüÜ ]{2,18}$/;
const CODE_RE = /^[A-Z0-9]{4,5}$/;

async function fetchPlayerProfile(userId, nombre) {
  if (!userId) return { badge: null, skin: 'clasico', rol: 'jugador', chips: null };
  try {
    const r = await pool.query('SELECT badge, skin, rol, chips FROM usuarios WHERE id = $1', [userId]);
    const raw = r.rows[0] || {};
    return {
      badge: raw.badge || null,
      skin:  raw.skin  || 'clasico',
      rol:   raw.rol   || 'jugador',
      chips: raw.chips != null ? Number(raw.chips) : null,
    };
  } catch (e) {
    console.error('[badge] profile error:', e.message);
    return { badge: null, skin: 'clasico', rol: 'jugador', chips: null };
  }
}

function validateNombre(nombre) {
  if (typeof nombre !== 'string') return 'Nombre inválido.';
  const v = nombre.trim();
  if (!v)            return 'El nombre no puede estar vacío.';
  if (v.length < 2)  return 'El nombre debe tener al menos 2 caracteres.';
  if (v.length > 18) return 'El nombre no puede superar los 18 caracteres.';
  if (!NAME_RE.test(v)) return 'El nombre solo puede contener letras, números y espacios.';
  return null;
}

function validateCode(code) {
  if (typeof code !== 'string') return 'Código inválido.';
  const v = code.trim().toUpperCase();
  if (!v)               return 'El código no puede estar vacío.';
  if (!CODE_RE.test(v)) return 'El código solo puede contener letras y números (4-5 caracteres).';
  return null;
}

// Valida el ante recibido del cliente. Devuelve el entero válido (par, 2..10000)
// o null si es inválido (el creador debe corregirlo).
function sanitizeAnte(v) {
  const n = Math.floor(Number(v));
  if (Number.isFinite(n) && n >= ANTE_MIN && n <= ANTE_MAX && n % 2 === 0) return n;
  return null;
}

function serializePublicRoom (room) {
  return {
    code:        room.code,
    hot:         room.maxPlayers === 5,
    conApuesta:  Boolean(room.conApuesta),
    ante:        room.conApuesta ? room.ante : 0,
    maxPlayers:  room.maxPlayers,
    playerCount: room.players.length,
    tableColor:  room.tableColor || 'green',
    host:        room.players[0]?.nombre || room.host?.nombre || 'Anfitrión',
  };
}

function publicRoomsList () {
  const list = [];
  for (const room of rooms.values()) {
    if (!room.public || room.status !== 'lobby' || room.players.length === 0) continue;
    list.push(serializePublicRoom(room));
  }
  return list.sort((a, b) => b.hot - a.hot || b.playerCount - a.playerCount);
}

function broadcastRoomsList () {
  const list = publicRoomsList();
  for (const ws of clients.keys()) send(ws, { type: 'rooms_list', rooms: list });
}

// Limpia salas expiradas: >6h, terminadas hace más de 10 min (ventana de
// revancha) o vacías en lobby. Corre cada 60s.
setInterval(() => {
  for (const [code, room] of rooms) {
    if (room.isExpired() || room.isFinishedExpired() || (room.isEmpty() && room.status === 'lobby')) {
      room.forceClose('Mesa cerrada por inactividad.');
      rooms.delete(code);
      if (room.public) broadcastRoomsList();
    }
  }
}, 60 * 1000);

// Ping nativo del servidor a todos los clientes cada 15s
// Esto mantiene viva la conexión a través del proxy de Railway
const serverPingInterval = setInterval(() => {
  wss.clients.forEach(client => {
    if (client.readyState !== 1) return; // no OPEN
    // Sin pong en el ciclo anterior → socket muerto, lo cerramos.
    if (client.isAlive === false) return client.terminate();
    client.isAlive = false;
    client.lastServerPingAt = Date.now();
    client.ping();
  });
}, 15000);

wss.on('connection', (ws, req) => {
  ws._socketId = ++socketSeq;
  ws._remoteAddress = req?.headers?.['x-forwarded-for'] || req?.socket?.remoteAddress || 'unknown';
  logWs(`socket#${ws._socketId} conectado desde ${ws._remoteAddress}`);
  // Responder a pongs para saber que el cliente sigue vivo
  ws.on('pong', () => {
    ws.isAlive = true;
    ws.lastPongAt = Date.now();
    const ctx = clients.get(ws);
    logWs(`socket#${ws._socketId} pong`, {
      room: ctx?.roomCode || null,
      player: ctx?.nombre || null,
      msSincePing: ws.lastServerPingAt ? Date.now() - ws.lastServerPingAt : null,
    });
  });
  ws.isAlive = true;
  ws.lastPongAt = Date.now();
  clients.set(ws, { playerId: null, roomCode: null, nombre: null, auth: null });

  ws.on('message', (raw) => {
    // Cola por socket: los mensajes se procesan en orden. El `auth` es async
    // (verifica el JWT contra la BD); sin esta cola, mensajes posteriores
    // (create_room / join_room) podían ejecutarse antes de completar el auth
    // y quedar con ctx.userId = null, degradando skin/badge a 'clasico'.
    const queue = ws._msgQueue || Promise.resolve();
    ws._msgQueue = queue
      .then(() => handleWsMessage(ws, raw))
      .catch(err => console.error('[index] error en cola ws.message', err));
  });

  async function handleWsMessage(ws, raw) {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    const ctx = clients.get(ws);
    if (msg.type !== 'ping') {
      logWs(`socket#${ws._socketId} -> ${msg.type}`, {
        room: ctx?.roomCode || null,
        player: ctx?.nombre || null,
      });
    }

    try {
      switch (msg.type) {

        case 'auth': {
          const token = typeof msg.token === 'string' ? msg.token : null;
          if (!token) {
            ctx.auth = null;
            send(ws, { type: 'auth_ok', usuario: null });
            break;
          }
          try {
            const payload = await verifyAuthorized(`Bearer ${token}`);
            ctx.auth = { id: payload.id, nombre: payload.nombre, rol: payload.rol || 'jugador' };
            send(ws, { type: 'auth_ok', usuario: { id: payload.id, nombre: payload.nombre, rol: payload.rol || 'jugador' } });
          } catch (e) {
            ctx.auth = null;
            send(ws, { type: 'auth_denied' });
          }
          break;
        }

        case 'identify': {
          if (msg.nombre) ctx.nombre = String(msg.nombre).trim();
          break;
        }

        case 'create_room': {
          if (isRateLimited(`ws-create:${ws._remoteAddress}`, 10, 10 * 60 * 1000))
            return send(ws, { type: 'error', msg: 'Creaste muchas salas. Espera unos minutos.' });
          rateLimitHit(`ws-create:${ws._remoteAddress}`, 10 * 60 * 1000);
          const { nombre, mode = 'realtime', maxPlayers = 5, public: publicRoom = false, conApuesta = false, ante } = msg;
          const nameErr = validateNombre(nombre);
          if (nameErr) return send(ws, { type: 'error', msg: nameErr });

          const quiereApuesta = Boolean(conApuesta);
          const anteVal = sanitizeAnte(ante);
          if (quiereApuesta && anteVal === null) {
            return send(ws, { type: 'error', msg: `La apuesta por ronda debe ser un múltiplo de 2 entre ${ANTE_MIN} y ${ANTE_MAX} (la mitad va al ganador de ronda y la otra mitad a la banca).` });
          }

          const safeNombre = nombre.trim();
          let code;
          do { code = genCode(); } while (rooms.has(code));

          const playerId = randomUUID();
          ctx.playerId = playerId;
          ctx.roomCode = code;
          ctx.nombre   = safeNombre;
          ctx.userId   = ctx.auth?.id ?? null;

          const { badge: hostBadge, skin: hostSkin, rol: hostRole, chips: hostChips } = await fetchPlayerProfile(ctx.userId, safeNombre);

          if (quiereApuesta && (!Number.isInteger(hostChips) || hostChips < anteVal)) {
            return send(ws, { type: 'error', msg: `Necesitas al menos ${anteVal} fichas para crear una mesa con apuesta de ${anteVal}/ronda.` });
          }

          const room = new GameRoom({
            code,
            host: { id: playerId, nombre: safeNombre, badge: hostBadge, skin: hostSkin, rol: hostRole, userId: ctx.userId, chips: hostChips, ws },
            mode,
            maxPlayers: Math.min(Math.max(Number(maxPlayers) || 4, 2), 5),
            publicRoom,
            conApuesta: quiereApuesta,
            ante: quiereApuesta ? anteVal : ANTE_DEFAULT,
          });
          rooms.set(code, room);
          logWs(`socket#${ws._socketId} creó sala ${code}`, {
            host: safeNombre,
            mode,
            maxPlayers: room.maxPlayers,
            public: room.public,
            conApuesta: room.conApuesta,
            ante: room.ante,
          });
          const hostPlayer = room.players.find(p => p.id === playerId);
          send(ws, { type: 'room_created', code, playerId, seatToken: hostPlayer?.seatToken, lobbyState: room.lobbyState() });
          if (room.public) broadcastRoomsList();
          break;
        }

        case 'list_rooms': {
          send(ws, { type: 'rooms_list', rooms: publicRoomsList() });
          break;
        }

        case 'join_room': {
          if (isRateLimited(`ws-join:${ws._remoteAddress}`, 40, 10 * 60 * 1000))
            return send(ws, { type: 'error', msg: 'Entraste a muchas salas. Espera unos minutos.' });
          rateLimitHit(`ws-join:${ws._remoteAddress}`, 10 * 60 * 1000);
          const { nombre, code, playerId: existingId } = msg;
          const nameErr = validateNombre(nombre);
          if (nameErr) return send(ws, { type: 'error', msg: nameErr });
          const codeErr = validateCode(code);
          if (codeErr) return send(ws, { type: 'error', msg: codeErr });

          const safeCode   = code.trim().toUpperCase();
          const safeNombre = nombre.trim();

          const room = rooms.get(safeCode);
          if (!room) return send(ws, { type: 'error', msg: 'Sala no encontrada.' });

          const existingSeat = existingId ? room.players.find(p => p.id === existingId) : null;
          if (existingId && !existingSeat)
            return send(ws, { type: 'error', msg: 'Asiento no encontrado. Entra de nuevo a la sala.' });
          if (existingSeat && existingSeat.seatToken !== msg.seatToken)
            return send(ws, { type: 'error', msg: 'No puedes retomar ese asiento.' });

          const wasReconnecting = !!existingSeat;

          const playerId = existingSeat ? existingSeat.id : randomUUID();
          ctx.roomCode = safeCode;
          ctx.nombre   = safeNombre;
          ctx.userId   = ctx.auth?.id ?? null;

          const { badge: joinBadge, skin: joinSkin, rol: joinRole, chips: joinChips } = await fetchPlayerProfile(ctx.userId, safeNombre);

          const effectiveChips = ctx.userId ? joinChips : (existingSeat ? existingSeat.chips : null);
          if (room.conApuesta && (!Number.isInteger(effectiveChips) || effectiveChips < room.ante)) {
            return send(ws, { type: 'error', msg: `Necesitas al menos ${room.ante} fichas para entrar a esta mesa (apuesta de ${room.ante}/ronda).` });
          }

          // Si el cliente no viene autenticado (ctx.userId null) pero retoma un
          // asiento existente, conservar su perfil (skin/badge/rol) en lugar de
          // degradarlo a 'clasico'.
          const player = room.addPlayer(
            playerId,
            safeNombre,
            ws,
            ctx.userId ? joinBadge : (existingSeat ? existingSeat.badge : null),
            ctx.userId ? joinSkin  : (existingSeat ? existingSeat.skin  : 'clasico'),
            ctx.userId ? joinRole  : (existingSeat ? existingSeat.rol   : 'jugador'),
            ctx.userId,
            ctx.userId ? joinChips : (existingSeat ? existingSeat.chips : null)
          );
          if (!player) return send(ws, { type: 'error', msg: 'Sala llena o ya iniciada.' });

          ctx.playerId = player.id;

          logWs(`socket#${ws._socketId} join_room ${safeCode}`, {
            player: safeNombre,
            playerId: player.id,
            reconnect: wasReconnecting,
            roomStatus: room.status,
            players: room.players.map(p => ({ nombre: p.nombre, conectado: p.conectado })),
          });

          send(ws, { type: 'room_joined', code: safeCode, playerId: player.id, seatToken: player.seatToken, lobbyState: room.lobbyState() });
          if (room.public) broadcastRoomsList();

          if (room.engine && wasReconnecting) {
            const reconnectState = room.engine.stateFor(player.id, { includeLog: player.rol === 'owner' });
            reconnectState.turnDeadlineAt = room._turnDeadlineAt ?? null;
            send(ws, {
              type: 'state_update',
              event: 'reconnect',
              state: reconnectState,
              tableColor: room.tableColor || 'green'
            });
          }
          break;
        }

        case 'start_game': {
          const room = rooms.get(ctx.roomCode);
          if (!room) return send(ws, { type: 'error', msg: 'Sala no encontrada.' });
          if (room.players[0]?.id !== ctx.playerId)
            return send(ws, { type: 'error', msg: 'Solo el host puede iniciar.' });

          const result = room.startGame();
          if (!result.ok) return send(ws, { type: 'error', msg: result.error });
          room._broadcastState('game_started', {});
          if (room.public) broadcastRoomsList();
          break;
        }

        case 'reaction': {
          const room = rooms.get(ctx.roomCode);
          if (!room || !ctx.playerId) return;
          const safeMsg = {
            type:   'reaction',
            tipo:   ['emoji', 'msg', 'golpe'].includes(msg.tipo) ? msg.tipo : 'msg',
            texto:  String(msg.texto  || '').slice(0, 60),
            nombre: String(msg.nombre || ctx.nombre || '').slice(0, 18),
          };
          room.broadcast(safeMsg, ctx.playerId);
          break;
        }

        case 'chat': {
          const room = rooms.get(ctx.roomCode);
          if (!room || !ctx.playerId) return;
          const texto = String(msg.texto || '').trim().slice(0, 200);
          if (!texto) return;
          room.broadcast({
            type:   'chat',
            texto,
            nombre: String(ctx.nombre || '').slice(0, 18),
          }, ctx.playerId);
          break;
        }

        case 'rematch': {
          const room = rooms.get(ctx.roomCode);
          if (!room) return send(ws, { type: 'error', msg: 'Sala no encontrada.' });
          if (room.players[0]?.id !== ctx.playerId)
            return send(ws, { type: 'error', msg: 'Solo el host puede iniciar la revancha.' });
          const result = room.rematch();
          if (!result.ok) return send(ws, { type: 'error', msg: result.error });
          room._broadcastState('game_started', { rematch: true });
          if (room.public) broadcastRoomsList();
          break;
        }

        case 'ping':
          logWs(`socket#${ws._socketId} ping cliente`, {
            room: ctx?.roomCode || null,
            player: ctx?.nombre || null,
          });
          send(ws, { type: 'pong' });
          break;

        case 'set_table_color': {
          const room = rooms.get(ctx.roomCode);
          if (!room || !ctx.playerId) return;
          if (room.players[0]?.id !== ctx.playerId) return;
          const validColors = ['green', 'navy', 'wine', 'black'];
          const color = validColors.includes(msg.color) ? msg.color : 'green';
          room.setTableColor(color);
          room.broadcast({ type: 'table_color_changed', color, lobbyState: room.lobbyState() });
          break;
        }

        case 'close_room': {
          const room = rooms.get(ctx.roomCode);
          if (!room) return send(ws, { type: 'error', msg: 'Sala no encontrada.' });
          if (room.players[0]?.id !== ctx.playerId)
            return send(ws, { type: 'error', msg: 'Solo el host puede cerrar la mesa.' });

          room.forceClose('Mesa cerrada por el host para iniciar una nueva partida.');
          rooms.delete(ctx.roomCode);
          broadcastRoomsList();
          break;
        }

        case 'leave_room': {
          const room = rooms.get(ctx.roomCode);
          if (!room || !ctx.playerId)
            return send(ws, { type: 'error', msg: 'No estás en una sala.' });
          const code = ctx.roomCode;
          const wasPublic = room.public;
          room.removeSeat(ctx.playerId);
          ctx.roomCode = null;
          ctx.playerId = null;
          send(ws, { type: 'room_left' });
          if (room.isEmpty() && room.status === 'lobby') {
            rooms.delete(code);
            if (wasPublic) broadcastRoomsList();
          } else if (wasPublic) {
            broadcastRoomsList();
          }
          break;
        }

        default: {
          const room = rooms.get(ctx.roomCode);
          if (!room || !ctx.playerId)
            return send(ws, { type: 'error', msg: 'No estás en una sala.' });

          const result = room.handleAction(ctx.playerId, msg);
          if (result && !result.ok) send(ws, { type: 'error', msg: result.error });
          break;
        }

      }
    } catch (err) {
      console.error('[index] Excepción no capturada en ws.message, tipo:', msg?.type, err);
      try { send(ws, { type: 'error', msg: 'Error interno del servidor.' }); } catch (_) {}
    }
  }

  ws.on('close', (code, reason) => {
    const ctx = clients.get(ws);
    logWs(`socket#${ws._socketId} desconexión`, {
      player: ctx?.nombre || 'unknown',
      room: ctx?.roomCode || null,
      code,
      reason: reason?.toString() || 'none',
      msSincePong: ws.lastPongAt ? Date.now() - ws.lastPongAt : null,
    });
    if (ctx?.roomCode) {
      const room = rooms.get(ctx.roomCode);
      if (room) {
        const wasPublic = room.public;
        room.removePlayer(ctx.playerId, ws);
        if (room.isEmpty() && room.status === 'lobby') {
          rooms.delete(ctx.roomCode);
          if (wasPublic) broadcastRoomsList();
        }
      }
    }
    clients.delete(ws);
  });

  ws.on('error', (err) => {
    const ctx = clients.get(ws);
    console.error('[WS] Error socket', {
      socketId: ws._socketId,
      player: ctx?.nombre || 'unknown',
      room: ctx?.roomCode || null,
      message: err.message,
    });
    ws.terminate();
  });
});

function send(ws, msg) {
  try { if (ws.readyState === 1) ws.send(JSON.stringify(msg)); } catch (_) {}
}

app.get('/health', (_, res) => res.json({ ok: true, rooms: rooms.size, clients: clients.size }));

ensureDatabaseSchema()
  .then(() => {
    srv.listen(PORT, () => console.log(`🃏 Continental server on port ${PORT}`));
  })
  .catch(err => {
    console.error('❌ Error preparando la base de datos:', err.message);
    process.exit(1);
  });