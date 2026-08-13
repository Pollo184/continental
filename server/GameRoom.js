'use strict';
const { GameEngine } = require('./GameEngine');
const { randomUUID } = require('crypto');
const pool = require('./db');
const { aplicarLogrosPartida } = require('./logros');

const ROOM_TIMEOUT_MS  = 6 * 60 * 60 * 1000;
const ANTE_MIN_JOIN    = 100;

class GameRoom {
  constructor({ code, host, mode = 'realtime', maxPlayers = 5, publicRoom = false, conApuesta = false }) {
    this.code       = code;
    this.mode       = mode;
    this.maxPlayers = maxPlayers;
    this.public     = Boolean(publicRoom);
    this.conApuesta = Boolean(conApuesta);
    this.status     = 'lobby';
    this.players    = [];
    this.readyAcks  = new Set();
    this.engine     = null;
    this.createdAt  = Date.now();
    this.host       = host;
    this._partidaRegistrada = false;

    this.addPlayer(host.id, host.nombre, host.ws, host.badge || null, host.skin || 'clasico', host.rol || 'jugador', host.userId || null, host.chips);
  }

  addPlayer(id, nombre, ws, badge = null, skin = 'clasico', rol = 'jugador', userId = null, chips = null) {
    if (this.players.find(p => p.id === id)) {
      const p = this.players.find(p => p.id === id);
      p.ws = ws;
      p.conectado = true;
      p.badge = badge;
      p.skin = skin;
      p.rol = rol;
      p.userId = userId || p.userId;
      p.chips = Number.isInteger(chips) ? chips : p.chips;
      if (this.engine) {
        const enginePlayer = this.engine._findPlayer(id);
        if (enginePlayer) {
          enginePlayer.conectado = true;
          enginePlayer.badge = badge;
          enginePlayer.skin = skin;
        }
      }
      this.broadcast({ type: 'player_reconnected', nombre, lobbyState: this.lobbyState() }, id);
      if (this.engine) {
        this._broadcastState('player_connection_changed', { playerId: id, conectado: true });
      }
      return p;
    }
    const sameSocketPlayer = this.players.find(p => p.ws === ws);
    if (sameSocketPlayer) {
      return sameSocketPlayer;
    }
    if (this.players.length >= this.maxPlayers) return null;
    if (this.status !== 'lobby') return null;
    const player = { id, nombre, badge, skin, rol, userId, chips: Number.isInteger(chips) ? chips : null, ws, conectado: true, seatToken: randomUUID() };
    this.players.push(player);
    this.broadcast({ type: 'player_joined', nombre, count: this.players.length, lobbyState: this.lobbyState() }, id);
    return player;
  }

  refreshPlayerProfile(nombre, { badge = null, skin = 'clasico' } = {}) {
    let changed = false;

    this.players.forEach(player => {
      if (player.nombre !== nombre) return;
      player.badge = badge;
      player.skin = skin;
      changed = true;
    });

    if (this.host?.nombre === nombre) {
      this.host.badge = badge;
      this.host.skin = skin;
    }

    if (this.engine) {
      this.engine.jugadores.forEach(player => {
        if (player.nombre !== nombre) return;
        player.badge = badge;
        player.skin = skin;
        changed = true;
      });
    }

    if (!changed) return false;

    if (this.engine) {
      this._broadcastState('profile_updated', { nombre, badge, skin });
    } else {
      this.broadcast({ type: 'lobby_state_updated', lobbyState: this.lobbyState() });
    }
    return true;
  }

  removePlayer(id, closingWs = null) {
    const p = this.players.find(p => p.id === id);
    if (!p) return;
    if (closingWs && p.ws && p.ws !== closingWs) {
      console.log('[ROOM]', this.code, 'ignore stale close', {
        player: p.nombre,
        closingSocketId: closingWs._socketId || null,
        activeSocketId: p.ws._socketId || null,
      });
      return;
    }
    p.ws = null;
    p.conectado = false;
    if (this.engine) {
      const ej = this.engine._findPlayer(id);
      if (ej) ej.conectado = false;
    }
    this.broadcast({ type: 'player_disconnected', nombre: p.nombre, lobbyState: this.lobbyState() });
    if (this.engine) {
      this._broadcastState('player_connection_changed', { playerId: id, conectado: false });
    }
  }

  // Salida voluntaria: libera el asiento por completo (no solo desconexión)
  removeSeat(id) {
    const idx = this.players.findIndex(p => p.id === id);
    if (idx === -1) return;
    const [p] = this.players.splice(idx, 1);
    if (this.engine) {
      const ej = this.engine._findPlayer(id);
      if (ej) ej.conectado = false;
    }
    console.log('[ROOM]', this.code, 'asiento liberado', { player: p.nombre });
    this.broadcast({ type: 'player_left', nombre: p.nombre, lobbyState: this.lobbyState() });
  }

  startGame() {
    if (this.status !== 'lobby') return { ok: false, error: 'Partida ya iniciada.' };
    if (this.players.length < 2) return { ok: false, error: 'Se necesitan al menos 2 jugadores.' };

    if (this.conApuesta) {
      const sinFichas = this.players.filter(p => !Number.isInteger(p.chips) || p.chips < ANTE_MIN_JOIN);
      if (sinFichas.length) {
        return { ok: false, error: `${sinFichas.map(p => p.nombre).join(', ')} no tiene suficientes fichas para esta mesa.` };
      }
    }

    this.engine = new GameEngine(
      this.players.map(p => ({
        id: p.id,
        nombre: p.nombre,
        badge: p.badge || null,
        skin: p.skin || 'clasico',
        userId: p.userId || null,
        fichas: this.conApuesta ? p.chips : 0,
      })),
      { conApuesta: this.conApuesta }
    );
    this.engine.repartir();
    this.engine._cobrarAnte();
    this.status = 'playing';
    return { ok: true };
  }

  handleAction(playerId, msg) {
    if (!this.engine) return { ok: false, error: 'Partida no iniciada.' };

    let result;
    const actor = this.players.find(p => p.id === playerId);

    console.log('[ROOM]', this.code, 'accion:start', {
      player: actor?.nombre || playerId,
      type: msg.type,
      estado: this.engine.estado,
      turno: this.engine.turno,
      turnoJugador: this.engine.jActivo?.nombre || null,
      castigo_idx: this.engine.castigo_idx,
      data: msg.type === 'castigo' ? { acepta: msg.acepta } : undefined,
    });

    try {
      switch (msg.type) {
        case 'tomar_fondo':
          result = this.engine.acTomarFondo(playerId);
          break;
        case 'tomar_mazo':
          result = this.engine.acTomarMazo(playerId);
          break;
        case 'castigo':
          result = this.engine.acCastigo(playerId, msg.acepta);
          break;
        case 'bajar':
          result = this.engine.acBajar(playerId, msg.jugadas);
          break;
        case 'pagar':
          result = this.engine.acPagar(playerId, msg.cartaId);
          break;
        case 'acomodar':
          result = this.engine.acAcomodar(
            playerId,
            msg.cartaId,
            msg.destJugadorIdx,
            msg.destJugadaIdx,
            msg.posicion || null
          );
          break;
        case 'reordenar':
          result = this.engine.acReordenarMano(playerId, msg.order);
          break;
        case 'intercambiar_comodin':
          result = this.engine.acIntercambiarComodin(
            playerId,
            msg.cartaId,
            msg.origenJugadorIdx,
            msg.origenJugadaIdx,
            msg.jugadasEnSlots
          );
          break;
        case 'ack_fin_ronda':
          return this._handleAckFinRonda(playerId);
        default:
          return { ok: false, error: `Acción desconocida: ${msg.type}` };
      }
    } catch (err) {
      // Capturar cualquier excepción inesperada del engine para que no
      // derribe el servidor ni desconecte al jugador
      console.error('[GameRoom] Error en handleAction', msg.type, err);
      return { ok: false, error: 'Error interno procesando la acción.' };
    }

    if (!result || !result.ok) {
      console.warn('[ROOM]', this.code, 'accion:error', {
        player: actor?.nombre || playerId,
        type: msg.type,
        estado: this.engine.estado,
        turno: this.engine.turno,
        turnoJugador: this.engine.jActivo?.nombre || null,
        castigo_idx: this.engine.castigo_idx,
        error: result?.error || 'Sin resultado.',
      });
      return result || { ok: false, error: 'Sin resultado.' };
    }

    console.log('[ROOM]', this.code, 'accion:ok', {
      player: actor?.nombre || playerId,
      type: msg.type,
      event: result.event,
      estado: this.engine.estado,
      turno: this.engine.turno,
      turnoJugador: this.engine.jActivo?.nombre || null,
      castigo_idx: this.engine.castigo_idx,
    });

    if (this.engine._pendingReinicio) {
      this.engine._pendingReinicio = false;
      this._broadcastState('nueva_ronda', { ronda: this.engine.ronda, reinicio: true });
      return result;
    }

    if (result.broadcast !== false) {
      this._broadcastState(result.event, result.data);
    } else {
      const p = this.players.find(p => p.id === playerId);
      this._send(p, {
        type: 'state_update',
        event: result.event,
        state: this.engine.stateFor(playerId, { includeLog: p?.rol === 'owner' })
      });
    }

      if (result.event === 'fin_juego') { this._persistirFichas(); this._registrarPartida(); }

    return result;
  }

  _handleAckFinRonda(playerId) {
    this.readyAcks.add(playerId);
    const connectedPlayers = this.players.filter(p => p.conectado);
    const connected = connectedPlayers.map(p => p.id);
    if (connected.every(id => this.readyAcks.has(id))) {
      this.readyAcks.clear();
      const result = this.engine.finalizarRonda();
      this._broadcastState(result.event, result.data);
    if (result.event === 'fin_juego') { this._persistirFichas(); this._registrarPartida(); }
    } else {
      const readyPlayerIds = connected.filter(id => this.readyAcks.has(id));
      this._broadcastState('esperando_siguiente_ronda', {
        readyCount: readyPlayerIds.length,
        totalCount: connected.length,
        readyPlayerIds,
        waitingNames: connectedPlayers
          .filter(p => !this.readyAcks.has(p.id))
          .map(p => p.nombre),
      });
    }
    return { ok: true };
  }

  // Guarda los saldos finales de fichas en la base de datos.
  async _persistirFichas() {
    if (!this.engine || !this.conApuesta) return;
    for (const j of this.engine.jugadores) {
      if (!j.userId) continue;
      try {
        await pool.query('UPDATE usuarios SET chips = $1 WHERE id = $2', [j.fichas, j.userId]);
      } catch (e) {
        console.error('[ROOM]', this.code, 'error persistiendo fichas de', j.nombre, e.message);
      }
    }
  }

  // Registra el resultado final de una partida para estadísticas, ranking,
  // XP y logros. Corre en una transacción y guarda una sola vez por partida.
  async _registrarPartida() {
    if (this._partidaRegistrada) return;
    if (!this.engine || !this.engine.jugadores.length) return;
    this._partidaRegistrada = true;

    const jugadores = this.engine.jugadores;
    const posiciones = [...jugadores]
      .sort((a, b) => (a.pts_t - b.pts_t) || ((b.fichas - b.fichasInicio) - (a.fichas - a.fichasInicio)))
      .map(j => j.id);

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const { rows } = await client.query(
        'INSERT INTO partidas (codigo, con_apuesta, ronda) VALUES ($1, $2, $3) RETURNING id',
        [this.code, this.conApuesta, this.engine.ronda]
      );
      const partidaId = rows[0].id;

      for (const j of jugadores) {
        await client.query(
          `INSERT INTO partidas_jugadores
             (partida_id, user_id, nombre, posicion, pts_totales, fichas_inicio, fichas_final, ganancia,
              bajo_tercia, bajo_corrida, castigos, se_castigo)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
          [partidaId, j.userId || null, j.nombre, posiciones.indexOf(j.id) + 1, j.pts_t,
           j.fichasInicio, j.fichas, j.fichas - j.fichasInicio,
           Boolean(j.bajoTercia), Boolean(j.bajoCorrida), j.fuePenalizado ? 1 : 0,
           Boolean(j.seCastigo)]
        );
      }

      const progresos = new Map();
      for (const j of jugadores) {
        if (!j.userId) continue;
        try {
          const prog = await aplicarLogrosPartida(client, partidaId, j.userId, {
            posicion: posiciones.indexOf(j.id) + 1,
            ronda: this.engine.ronda,
            conApuesta: this.conApuesta,
          });
          progresos.set(j.userId, prog);
        } catch (e) {
          console.error('[ROOM]', this.code, 'error aplicando logros de', j.nombre, e.message);
        }
      }

      // Marcar la partida como registrada UNA vez, después de aplicar a todos
      // los jugadores (no dentro del loop: xp_awarded es por partida).
      await client.query('UPDATE partidas SET xp_awarded = TRUE WHERE id = $1', [partidaId]);

      await client.query('COMMIT');

      for (const j of jugadores) {
        const prog = progresos.get(j.userId);
        if (!prog) continue;
        const player = this.players.find(p => p.userId === j.userId);
        this._send(player, prog);
      }

      console.log('[ROOM]', this.code, 'partida registrada id', partidaId, 'jugadores', jugadores.length);
    } catch (e) {
      await client.query('ROLLBACK');
      this._partidaRegistrada = false;
      console.error('[ROOM]', this.code, 'error registrando partida', e.message);
    } finally {
      client.release();
    }
  }

  _broadcastState(event, data = {}) {
    this.players.forEach(p => {
      if (!p.ws || !p.conectado) return;
      const state = this.engine ? this.engine.stateFor(p.id, { includeLog: p.rol === 'owner' }) : null;
      this._send(p, { type: 'state_update', event, data, state, tableColor: this.tableColor || 'green' });
    });
  }

  broadcast(msg, excludeId = null) {
    this.players.forEach(p => {
      if (p.id === excludeId || !p.ws || !p.conectado) return;
      this._send(p, msg);
    });
  }

  _send(player, msg) {
    try {
      if (player && player.ws && player.ws.readyState === 1)
        player.ws.send(JSON.stringify(msg));
    } catch (_) {}
  }

  sendToPlayer(playerId, msg) {
    const p = this.players.find(p => p.id === playerId);
    if (p) this._send(p, msg);
  }

  forceClose(reason = 'Mesa cerrada por administración.') {
    this.players.forEach(player => {
      if (!player.ws) return;
      this._send(player, { type: 'room_closed', code: this.code, msg: reason });
      try {
        if (player.ws.readyState === 1 || player.ws.readyState === 0) {
          player.ws.close(4001, reason.slice(0, 120));
        }
      } catch (_) {}
      player.ws = null;
      player.conectado = false;
    });

    if (this.engine) {
      this.engine.jugadores.forEach(player => {
        player.conectado = false;
      });
    }
  }

  isExpired() { return Date.now() - this.createdAt > ROOM_TIMEOUT_MS; }
  isEmpty()   { return this.players.every(p => !p.conectado); }

  setTableColor(color) {
    const valid = ['green', 'navy', 'wine', 'black'];
    if (!valid.includes(color)) return;
    this.tableColor = color;
  }

  lobbyState() {
    return {
      code: this.code,
      mode: this.mode,
      status: this.status,
      public: this.public,
      conApuesta: this.conApuesta,
      players: this.players.map(p => ({ id: p.id, nombre: p.nombre, badge: p.badge || null, skin: p.skin || 'clasico', conectado: p.conectado })),
      maxPlayers: this.maxPlayers,
      tableColor: this.tableColor || 'green',
    };
  }
}

module.exports = { GameRoom };