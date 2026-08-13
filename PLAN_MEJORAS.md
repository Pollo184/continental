# Plan de mejoras — Continental beta

Alcance acordado: **P0 + P1** (bugs + calidad de vida). Features de contenido
(skins/sonidos/tutorial/estadísticas finas) quedan para después de estabilizar.

## Fase 1 — Bugs que bloquean partidas (P0)

1. **Timer de turno + auto-jugada**
   - Archivos: `server/GameEngine.js`, `server/GameRoom.js`, `client/js/game.js`
   - Al empezar cada estado de turno (`esperando_robo`, `fase_castigo`, `esperando_accion/pago`) se arranca un timer de ~45s.
   - Al vencer, el motor ejecuta solo: `esperando_robo` → `acTomarMazo` + `acPagar` carta de mayor riesgo; `fase_castigo` → pasa; `esperando_accion/pago` → paga carta más alta.
   - Cliente muestra cuenta regresiva (`timeLeft` en el state). Se resetea con cada acción.
   - Desbloquea partidas trabadas por desconexión.

2. **Host transfer**
   - Archivos: `server/index.js:490-539`, `server/GameRoom.js`
   - Si el host se desconecta >30s, el host pasa al siguiente jugador conectado (iniciar/cerrar/color de mesa).
   - `start_game`/`close_room` solo requieren host conectado.

3. **Timeout de ack de ronda**
   - Archivo: `server/GameRoom.js:273-294`
   - Si alguien no confirma `ack_fin_ronda` en ~20s, se auto-confirma.

4. **Reaping de sockets muertos**
   - Archivo: `server/index.js:288-311`
   - En el intervalo de ping, cerrar sockets sin pong (`isAlive`/`lastPongAt` ya se registran pero no se usan). Al cerrar, el player queda `conectado=false` conservando el asiento.

## Fase 2 — Calidad de vida (P1)

5. **Chat por sala**
   - Archivos: `server/index.js`, `server/GameRoom.js`, `client/game.html`/`client/js/game.js`
   - Nuevo mensaje WS `chat` por sala (historial en memoria ~50 msgs), reusa `#chat-panel`.

6. **Rematch**
   - Archivos: `server/GameRoom.js`, `client/js/game.js`
   - Botón "Revancha" (host) al `fin_juego`: reset del engine con los mismos asientos.

7. **Espectadores** *(el más grande de P1)*
   - Archivos: `server/index.js`, `server/GameRoom.js`, `client/js/game.js`
   - `join_room` con `spectate` en mesas públicas: `stateFor` con manos ocultas, sin acciones. Alternativa recortada: solo ver el lobby.

8. **Limpieza de salas terminadas**
   - Archivo: `server/index.js:279-284`
   - Tras `fin_juego`, cerrar la sala a los ~10 min (ventana de revancha) en vez de 6h.

9. **Persistencia de fichas por ronda**
   - Archivo: `server/GameRoom.js:297`
   - Guardar saldos en cada `fin_ronda` (no solo `fin_juego`) para no perder ante/pozo en un crash.

## Decisiones pendientes

- Timer: ¿45s con auto-jugada para todos, o solo para desconectados?
- Espectadores: ¿completo o recortado?
- Chat: ¿solo en partida, o también lobby?

## P2 — Futuro (seguridad/robustez)

- Fix `acBajar` (misma carta en dos jugadas) y `acAcomodar` (validar estado).
- JWT fallback hardcodeado (`server/jwt-utils.js:5`) y límites de tamaño/rate de WS.
- Rol admin horneado en JWT → requiere re-login al cambiar.
