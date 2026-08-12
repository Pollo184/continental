// animations.js - Control de movimientos de cartas con técnica FLIP

'use strict';

const Anim = (() => {
  function wait(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  function getMotionProfile() {
    const width = window.innerWidth || 1280;
    const reduced = typeof window.matchMedia === 'function'
      && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const coarse = typeof window.matchMedia === 'function'
      && window.matchMedia('(pointer: coarse)').matches;

    if (reduced) {
      return { speed: 0.72, reveal: 0.78, distance: 0.82, particles: 0.45, shuffleReps: 2 };
    }
    if (width <= 575 || coarse) {
      return { speed: 0.84, reveal: 0.88, distance: 0.9, particles: 0.65, shuffleReps: 2 };
    }
    if (width <= 991) {
      return { speed: 0.93, reveal: 0.95, distance: 0.96, particles: 0.8, shuffleReps: 3 };
    }
    if (width >= 1600) {
      return { speed: 1.08, reveal: 1.04, distance: 1.05, particles: 1.08, shuffleReps: 4 };
    }
    return { speed: 1, reveal: 1, distance: 1, particles: 1, shuffleReps: 3 };
  }

  function scaleMs(value, factor) {
    return Math.max(0, Math.round(value * factor));
  }

  // Obtener clase de skin del jugador local
  function getMySkin() {
    try {
      const u = JSON.parse(localStorage.getItem('usuario') || '{}');
      const skin = u.skin || 'clasico';
      return skin !== 'clasico' ? `skin-${skin}` : '';
    } catch { return ''; }
  }

  // Guarda las posiciones de elementos antes de un cambio en el DOM
  function revealCard(targetEl, opts = {}) {
    if (!targetEl) return;
    const motion = getMotionProfile();
    const {
      opacityDuration = 80,
      scaleDuration = 200,
      scaleFrom = 1.06,
      rotateYFrom = 68,
      easing = 'cubic-bezier(.22,1,.36,1)',
      settleDelay = 60,
    } = opts;

    const opacityMs = scaleMs(opacityDuration, motion.reveal);
    const scaleMsValue = scaleMs(scaleDuration, motion.reveal);
    const settleMs = scaleMs(settleDelay, motion.reveal);

    targetEl.style.transition = `opacity ${opacityMs}ms ease, transform ${scaleMsValue}ms ${easing}`;
    targetEl.style.opacity = '1';
    targetEl.style.transform = `perspective(560px) rotateY(${rotateYFrom}deg) scale(${scaleFrom})`;
    setTimeout(() => {
      targetEl.style.transform = 'perspective(560px) rotateY(0deg) scale(1)';
      setTimeout(() => {
        targetEl.style.transition = '';
        targetEl.style.transform = '';
      }, scaleMsValue + 50);
    }, settleMs);
  }

  async function transferGhostToTarget(sourceEl, targetEl, opts = {}) {
    if (!sourceEl || !targetEl) return;

    const motion = getMotionProfile();

    const {
      templateEl = null,
      useBackSkin = false,
      duration = 320,
      hold = null,
      preScale = 1.05,
      rotateStart = 0,
      rotateEnd = (Math.random() - .5) * 6,
      rotateYStart = 0,
      rotateYEnd = 0,
      perspective = null,
      zIndex = 9999,
      borderRadius = 'var(--r)',
      startBoxShadow = '0 8px 28px rgba(0,0,0,.6)',
      endBoxShadow = null,
      extraClassName = '',
      extraStyle = '',
    } = opts;

    const durationMs = scaleMs(duration, motion.speed);
    const holdMs = hold == null ? null : scaleMs(hold, motion.speed);

    const src = sourceEl.getBoundingClientRect();
    const dst = targetEl.getBoundingClientRect();
    const ghost = templateEl
      ? templateEl.cloneNode(true)
      : document.createElement('div');

    if (!templateEl) {
      ghost.className = useBackSkin
        ? `cback ${getMySkin()} ${extraClassName}`.trim()
        : extraClassName.trim();
    } else if (extraClassName) {
      ghost.classList.add(...extraClassName.trim().split(/\s+/).filter(Boolean));
    }

    const persp = perspective != null ? `perspective(${perspective}px) ` : '';
    ghost.style.cssText = `
      position:fixed; z-index:${zIndex}; pointer-events:none;
      width:${src.width}px; height:${src.height}px;
      left:${src.left}px; top:${src.top}px;
      border-radius:${borderRadius};
      box-shadow:${startBoxShadow};
      transform:${persp}scale(${preScale}) rotateY(${rotateYStart}deg) rotate(${rotateStart}deg);
      will-change:transform;
      transition:none;
      ${extraStyle}
    `;
    document.body.appendChild(ghost);

    await wait(16);

    const dx = dst.left - src.left;
    const dy = dst.top - src.top;
    const arc = Math.max(34, Math.min(120, Math.hypot(dx, dy) * 0.28));

    // Escala para llegar al tamaño del destino SIN animar width/height
    // (las dimensiones del ghost quedan fijas; solo se compone transform).
    const sx = src.width > 0 ? dst.width / src.width : 1;
    const sy = src.height > 0 ? dst.height / src.height : 1;
    const s = (sx + sy) / 2;
    const midScale = (preScale + s) / 2;

    if (typeof ghost.animate === 'function') {
      // Vuelo con arco (Web Animations API) — solo transform/opacity.
      const midRotateY = rotateYStart + (rotateYEnd - rotateYStart) * 0.5;
      const midRotate = rotateStart + (rotateEnd - rotateStart) * 0.5;
      ghost.animate([
        {
          transform: `${persp}translate(0,0) scale(${preScale}) rotateY(${rotateYStart}deg) rotate(${rotateStart}deg)`,
          opacity: 1,
        },
        {
          transform: `${persp}translate(${dx / 2}px, ${dy / 2 - arc}px) scale(${midScale}) rotateY(${midRotateY}deg) rotate(${midRotate}deg)`,
          opacity: 1,
          offset: 0.5,
        },
        {
          transform: `${persp}translate(${dx}px, ${dy}px) scale(${s}) rotateY(${rotateYEnd}deg) rotate(${rotateEnd}deg)`,
          opacity: 1,
        },
      ], { duration: durationMs, easing: 'cubic-bezier(.28,.6,.4,1)', fill: 'forwards' });
    } else {
      ghost.style.transition = `transform ${durationMs}ms cubic-bezier(.22,1,.36,1)`;
      ghost.style.transform = `${persp}translate(${dx}px, ${dy}px) scale(${s}) rotateY(${rotateYEnd}deg) rotate(${rotateEnd}deg)`;
    }

    await wait(holdMs ?? Math.max(durationMs - 20, 0));
    ghost.remove();
  }

  // Un rival "lanza" una carta al fondo (animación de pago)
  async function rivalPaysToFondo(oppEl, fondoEl, cardSmEl) {
    if (!oppEl || !fondoEl) return;
    const motion = getMotionProfile();
    
    const src = oppEl.getBoundingClientRect();
    const dst = fondoEl.getBoundingClientRect();

    const ghost = document.createElement('div');
    ghost.className = `cback ${getMySkin()}`;
    ghost.style.cssText = `
      position: fixed; 
      z-index: 9999; 
      pointer-events: none;
      width: var(--cw); 
      height: var(--ch);
      left: ${src.left + src.width/2 - 31}px;
      top: ${src.top + src.height/2 - 45}px;
      transition: none;
      transform: scale(.7) rotate(-10deg);
    `;
    document.body.appendChild(ghost);
    
    await new Promise(r => setTimeout(r, 10));

    const dx = dst.left - src.left + dst.width/2 - 31;
    const dy = dst.top - src.top + dst.height/2 - 45;
    
    const flightMs = scaleMs(420, motion.speed);
    const flipMs = scaleMs(210, motion.speed);

    ghost.style.transition = `transform ${flightMs}ms cubic-bezier(.22,1,.36,1)`;
    ghost.style.transform = `translate(${dx}px, ${dy}px) rotate(15deg) scale(1)`;

    // A mitad del recorrido, voltea para mostrar el frente
    setTimeout(() => {
      if (cardSmEl) {
        ghost.innerHTML = cardSmEl.innerHTML;
        ghost.style.background = '';
        ghost.className = 'card';
      }
    }, flipMs);

    await wait(flightMs);
    ghost.remove();

    // Feedback al aterrizar en el fondo: sonido + partículas + anillo dorado
    if (typeof SFX !== 'undefined' && SFX.play) { try { SFX.play('pagar'); } catch (e) {} }
    if (fondoEl) {
      bumpElement(fondoEl, 1.06, 240);
      const fr = fondoEl.getBoundingClientRect();
      const cx = fr.left + fr.width / 2;
      const cy = fr.top + fr.height / 2;
      spawnParticles(cx, cy, 8);
      const ring = document.createElement('div');
      ring.style.cssText = `
        position: fixed; pointer-events: none; z-index: 9998;
        left: ${cx}px; top: ${cy}px;
        width: 10px; height: 10px; margin: -5px 0 0 -5px;
        border-radius: 50%;
        border: 2px solid rgba(200,160,69,.8);
        box-shadow: 0 0 12px rgba(200,160,69,.6);
        animation: pagoRing .45s cubic-bezier(.22,1,.36,1) forwards;
      `;
      document.body.appendChild(ring);
      setTimeout(() => ring.remove(), 500);
    }
  }

  // Efecto de barajeo en el mazo antes de repartir
  function shuffleAnim(mazoEl) {
    return new Promise(resolve => {
      if (!mazoEl) { 
        resolve(); 
        return; 
      }
      const motion = getMotionProfile();
      
      const layers = mazoEl.querySelectorAll('.cback');
      let delay = 0;
      
      for (let rep = 0; rep < motion.shuffleReps; rep++) {
        for (const layer of layers) {
          setTimeout(() => {
            layer.style.transition = `transform ${scaleMs(120, motion.speed)}ms ease-in-out`;
            layer.style.transform = `translateX(${(Math.random()-.5)*10}px) rotate(${(Math.random()-.5)*6}deg)`;
            setTimeout(() => { 
              layer.style.transform = ''; 
            }, scaleMs(130, motion.speed));
          }, delay);
          delay += scaleMs(60, motion.speed);
        }
      }
      setTimeout(resolve, delay + scaleMs(150, motion.speed));
    });
  }

  // Animación de repartir: las cartas vuelan del mazo a cada mano
  async function dealAnim(mazoEl, handZoneEl, cards, startDelay = 0, opts = {}) {
    if (!mazoEl || !handZoneEl) return;
    const motion = getMotionProfile();

    const {
      stepDelay = 90,
      duration = 320,
      hold = 300,
      preScale = 1.05,
      endBoxShadow = null,
      revealOptions = {},
    } = opts;

    const startDelayMs = scaleMs(startDelay, motion.speed);
    const stepDelayMs = scaleMs(stepDelay, motion.speed);

    // Ocultar las cartas reales mientras animamos
    const cardEls = handZoneEl.querySelectorAll('.card');
    cardEls.forEach(el => { el.style.opacity = '0'; });

    for (let i = 0; i < cards.length; i++) {
      await wait(startDelayMs + (i * stepDelayMs));

      const targetCard = handZoneEl.querySelectorAll('.card')[i];
      await transferGhostToTarget(mazoEl, targetCard || handZoneEl, {
        useBackSkin: true,
        duration,
        hold,
        preScale,
        endBoxShadow,
      });
      if (targetCard) revealCard(targetCard, revealOptions);
    }
  }

  // Fichas que vuelan desde cada asiento al pozo central (mesas con apuesta).
  // Se usa antes del reparto para "cobrar" el ante visualmente.
  function betChipsToPot({ seats = [], potEl = null, chipsPerSeat = 2, stagger = 90, flight = 540 }) {
    return new Promise(resolve => {
      if (!potEl || !seats.length) { resolve(); return; }
      const motion = getMotionProfile();
      if (!document.querySelector('#chipAnimCss')) {
        document.head.insertAdjacentHTML('beforeend', `
          <style id="chipAnimCss">
            .chip-ghost {
              position:fixed; z-index:9998; pointer-events:none;
              width:22px; height:22px; border-radius:50%;
              background:radial-gradient(circle at 35% 30%, #fff, #f0cd7e 38%, #c8a045 62%, #8a6a1f);
              border:2px dashed rgba(244,212,136,.85);
              box-shadow:0 3px 9px rgba(0,0,0,.5), inset 0 0 4px rgba(255,255,255,.55);
            }
          </style>
        `);
      }

      const dst = potEl.getBoundingClientRect();
      const dstX = dst.left + dst.width / 2;
      const dstY = dst.top + dst.height / 2;
      let pending = seats.length * chipsPerSeat;
      let resolved = false;
      const flyMs = scaleMs(flight, motion.speed);

      const land = () => {
        if (resolved) return;
        spawnParticles(dstX, dstY, 5);
        bumpElement(potEl, 1.06, 240);
        if (--pending <= 0) {
          resolved = true;
          clearTimeout(safety);
          if (typeof SFX !== 'undefined') {
            SFX.play('chips');
            setTimeout(() => SFX.play('chips'), 130);
          }
          const v = potEl.querySelector('.pot-value');
          if (v) {
            v.animate([
              { transform: 'scale(1)', color: '#c8a045' },
              { transform: 'scale(1.4)', color: '#ffe9a3' },
              { transform: 'scale(1)', color: '#c8a045' },
            ], { duration: 420, easing: 'cubic-bezier(.34,1.56,.64,1)' });
          }
          setTimeout(resolve, 240);
        }
      };

      // Red de seguridad: nunca dejar colgado el await del reparto
      const safety = setTimeout(() => { if (!resolved) { resolved = true; resolve(); } },
        seats.length * stagger + chipsPerSeat * 70 + 60 + flyMs + 900);

      seats.forEach((seat, si) => {
        if (!seat) { pending -= chipsPerSeat; return; }
        const src = seat.getBoundingClientRect();
        const srcX = src.left + src.width / 2;
        const srcY = src.top + src.height / 2;
        for (let c = 0; c < chipsPerSeat; c++) {
          const delay = si * stagger + c * 70 + Math.random() * 40;
          setTimeout(() => {
            const chip = document.createElement('div');
            chip.className = 'chip-ghost';
            chip.style.left = `${srcX - 11}px`;
            chip.style.top = `${srcY - 11}px`;
            chip.style.transform = 'scale(.4)';
            chip.style.opacity = '0';
            document.body.appendChild(chip);
            let chipDone = false;
            let flyFallback = null;
            const cleanup = () => {
              if (chipDone) return;
              chipDone = true;
              if (flyFallback) clearTimeout(flyFallback);
              chip.remove();
              land();
            };
            requestAnimationFrame(() => {
              requestAnimationFrame(() => {
                try {
                  const anim = chip.animate([
                    { opacity: 1, transform: 'translate(0,0) scale(.5)', offset: 0 },
                    { transform: `translate(${(dstX - srcX) / 2}px, ${(dstY - srcY) / 2 - 80}px) scale(.9)`, opacity: 1, offset: 0.55 },
                    { transform: `translate(${dstX - srcX}px, ${dstY - srcY}px) scale(1.05)`, opacity: 1, offset: 1 },
                  ], { duration: flyMs, easing: 'cubic-bezier(.25,.6,.35,1)', fill: 'forwards' });
                  anim.addEventListener('finish', cleanup);
                } catch { cleanup(); }
              });
            });
            flyFallback = setTimeout(cleanup, flyMs + 300);
          }, delay);
        }
      });
    });
  }

  // Muestra números flotantes de puntuación (+15, -0, etc.) al finalizar ronda
  function floatScore(el, pts, isGain = false) {
    if (!el) return;
    const motion = getMotionProfile();
    
    const rect = el.getBoundingClientRect();
    const num = document.createElement('div');
    num.textContent = (pts > 0 ? '+' : '') + pts;
    num.style.cssText = `
      position: fixed;
      left: ${rect.left + rect.width/2}px;
      top: ${rect.top}px;
      transform: translate(-50%, 0);
      font-family: 'Cormorant Garamond', serif;
      font-size: 1.4rem; 
      font-weight: 700;
      color: ${pts > 0 ? 'var(--red-hi)' : '#4de88a'};
      text-shadow: 0 2px 8px rgba(0,0,0,.5);
      pointer-events: none;
      z-index: 500;
      animation: floatUp ${scaleMs(900, motion.speed)}ms cubic-bezier(.22,1,.36,1) both;
    `;
    
    // Inyecta la animación si no existe
    if (!document.querySelector('#floatUpAnim')) {
      document.head.insertAdjacentHTML('beforeend', `
        <style id="floatUpAnim">
          @keyframes floatUp {
            from { opacity:1; transform: translate(-50%,0); }
            to { opacity:0; transform: translate(-50%,-50px); }
          }
        </style>
      `);
    }
    
    document.body.appendChild(num);
    setTimeout(() => num.remove(), scaleMs(950, motion.speed));
  }

  // Bump (rebote) one-shot sobre un elemento al aterrizar
  function bumpElement(el, scale = 1.06, ms = 220) {
    if (!el) return;
    let base = '';
    try {
      const cs = getComputedStyle(el).transform;
      if (cs && cs !== 'none' && cs !== 'matrix(1, 0, 0, 1, 0, 0)') base = `${cs} `;
    } catch { /* noop */ }
    try {
      el.animate([
        { transform: `${base}scale(1)` },
        { transform: `${base}scale(${scale})`, offset: 0.5 },
        { transform: `${base}scale(1)` },
      ], { duration: ms, easing: 'cubic-bezier(.22,1,.36,1)' });
    } catch { /* noop */ }
  }

  // Partículas doradas al aterrizar
  function spawnParticles(x, y, count = 12) {
    const colors = ['#c8a045', '#ffe066', '#fff4c2', '#f0c040', '#ffffff'];
    for (let i = 0; i < count; i++) {
      const p = document.createElement('div');
      const angle  = (Math.PI * 2 / count) * i + (Math.random() - .5) * .5;
      const speed  = 40 + Math.random() * 60;
      const size   = 4 + Math.random() * 5;
      const color  = colors[Math.floor(Math.random() * colors.length)];
      const dur    = 500 + Math.random() * 300;
      p.style.cssText = `
        position:fixed; z-index:10000; pointer-events:none;
        width:${size}px; height:${size}px;
        border-radius:${Math.random() > .5 ? '50%' : '2px'};
        background:${color};
        left:${x}px; top:${y}px;
        transform:translate(-50%,-50%);
        box-shadow: 0 0 4px ${color};
      `;
      document.body.appendChild(p);
      const tx = Math.cos(angle) * speed;
      const ty = Math.sin(angle) * speed;
      p.animate([
        { transform: 'translate(-50%,-50%) scale(1)', opacity: 1 },
        { transform: `translate(calc(-50% + ${tx}px), calc(-50% + ${ty}px)) scale(0)`, opacity: 0 },
      ], { duration: dur, easing: 'cubic-bezier(.22,1,.36,1)', fill: 'forwards' });
      setTimeout(() => p.remove(), dur + 50);
    }
  }

  return { 
    revealCard,
    transferGhostToTarget,
    rivalPaysToFondo, 
    shuffleAnim, 
    dealAnim, 
    betChipsToPot,
    floatScore, 
    spawnParticles,
    bumpElement
  };
})();

window.Anim = Anim;