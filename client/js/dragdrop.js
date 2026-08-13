'use strict';

const DragDrop = (() => {
  let ghost = null;
  let draggingFromSlot = false;
  let originalSlotIndex = null;

  function getPoint(e) {
    if (e.touches?.length) return { x: e.touches[0].clientX, y: e.touches[0].clientY };
    if (e.changedTouches?.length) return { x: e.changedTouches[0].clientX, y: e.changedTouches[0].clientY };
    return { x: e.clientX, y: e.clientY };
  }

  function mkGhost(el, pt) {
    const rect = el.getBoundingClientRect();
    const g = el.cloneNode(true);
    g.id = 'drag-ghost';
    g.removeAttribute('data-id');
    g.style.cssText += ';position:fixed;z-index:9999;pointer-events:none;opacity:0.85;';
    g.style.width = rect.width + 'px';
    g.style.height = rect.height + 'px';
    g.style.left = (pt.x - rect.width / 2) + 'px';
    g.style.top = (pt.y - rect.height / 2) + 'px';
    document.body.appendChild(g);
    return { g, rect };
  }

  function moveGhost(pt) {
    if (!ghost) return;
    ghost.g.style.left = (pt.x - ghost.rect.width / 2) + 'px';
    ghost.g.style.top = (pt.y - ghost.rect.height / 2) + 'px';
  }

  function showHandInsertGhost(mx, my) {
    const hz = document.getElementById('discard-zone');
    if (!hz) return;
    hz.querySelectorAll('.insert-ghost').forEach(g => g.remove());
    const hr = hz.getBoundingClientRect();

    // Auto-scroll mientras arrastras cerca de los bordes
    const edge = 36;
    if (mx < hr.left + edge) hz.scrollLeft -= 10;
    else if (mx > hr.right - edge) hz.scrollLeft += 10;

    if (mx < hr.left || mx > hr.right || my < hr.top || my > hr.bottom) {
      hz.classList.remove('drag-over');
      return;
    }
    hz.classList.add('drag-over');
    const cards = [...hz.querySelectorAll('.card:not(.dragging)')];
    let before = null;
    for (const c of cards) {
      const r = c.getBoundingClientRect();
      if (mx < r.left + r.width / 2) { before = c; break; }
    }
    const ig = document.createElement('div');
    ig.className = 'insert-ghost';
    if (before) hz.insertBefore(ig, before);
    else hz.appendChild(ig);
  }

  function showSlotInsertIndicator(mx, my) {
    document.querySelectorAll('.building-slot-cards').forEach(container => {
      container.querySelectorAll('.insert-ghost').forEach(g => g.remove());
      const r = container.getBoundingClientRect();
      if (mx < r.left || mx > r.right || my < r.top || my > r.bottom) return;
      const cards = [...container.querySelectorAll('.card:not(.dragging)')];
      let before = null;
      for (const c of cards) {
        const cr = c.getBoundingClientRect();
        if (mx < cr.left + cr.width / 2) { before = c; break; }
      }
      const ig = document.createElement('div');
      ig.className = 'insert-ghost';
      if (before) container.insertBefore(ig, before);
      else container.appendChild(ig);
    });
  }

  function clearSlotInsertIndicators() {
    document.querySelectorAll('.building-slot-cards .insert-ghost').forEach(g => g.remove());
  }

  function highlightDropZones(mx, my, isPayable) {
    document.querySelectorAll('.building-slot').forEach(slot => {
      const r = slot.getBoundingClientRect();
      slot.classList.toggle('drop-target', mx >= r.left && mx <= r.right && my >= r.top && my <= r.bottom);
    });
    document.querySelectorAll('.bajada-pile').forEach(p => {
      const r = p.getBoundingClientRect();
      p.classList.toggle('drop-target', mx >= r.left && mx <= r.right && my >= r.top && my <= r.bottom);
    });
    const fw = document.getElementById('fondo-wrap');
    if (fw && isPayable) {
      const r = fw.getBoundingClientRect();
      const over = mx >= r.left && mx <= r.right && my >= r.top && my <= r.bottom;
      fw.style.outline = over ? '2px solid var(--red-hi)' : '';
      fw.style.borderRadius = over ? 'var(--r)' : '';
    }
    if (draggingFromSlot) {
      const hz = document.getElementById('discard-zone');
      if (hz) {
        const hr = hz.getBoundingClientRect();
        const overDiscard = mx >= hr.left && mx <= hr.right && my >= hr.top && my <= hr.bottom;
        hz.classList.toggle('drop-target-sobrantes', overDiscard);
        if (overDiscard) hz.setAttribute('data-hint', 'Suelta para devolver a la mano');
        else hz.removeAttribute('data-hint');
      }
    }
  }

  function cleanDropZones() {
    const hz = document.getElementById('discard-zone');
    if (hz) {
      hz.querySelectorAll('.insert-ghost').forEach(g => g.remove());
      hz.classList.remove('drag-over', 'drop-target-sobrantes');
      hz.removeAttribute('data-hint');
    }
    clearSlotInsertIndicators();
    document.querySelectorAll('.bajada-pile').forEach(p => p.classList.remove('drop-target'));
    document.querySelectorAll('.building-slot').forEach(s => s.classList.remove('drop-target'));
    const fw = document.getElementById('fondo-wrap');
    if (fw) { fw.style.outline = ''; fw.style.borderRadius = ''; }
  }

  function getSlotInsertIndex(slotEl, mx) {
    const container = slotEl.querySelector('.building-slot-cards');
    if (!container) return 0;
    const cards = [...container.querySelectorAll('.card:not(.dragging)')];
    for (let i = 0; i < cards.length; i++) {
      const r = cards[i].getBoundingClientRect();
      if (mx < r.left + r.width / 2) return i;
    }
    return cards.length;
  }

  function startHandDrag(e, el, cid, callbacks) {
    if (e.type === 'touchstart') e.preventDefault();

    draggingFromSlot = el?.hasAttribute('data-slot');
    originalSlotIndex = draggingFromSlot ? parseInt(el.dataset.slot) : null;

    ghost = mkGhost(el, getPoint(e));
    el.classList.add('dragging');
    if (draggingFromSlot) el.style.visibility = 'hidden';

    const onMove = ev => {
      ev.preventDefault();
      const pt = getPoint(ev);
      moveGhost(pt);
      showHandInsertGhost(pt.x, pt.y);
      if (draggingFromSlot) showSlotInsertIndicator(pt.x, pt.y);
      highlightDropZones(pt.x, pt.y, callbacks.isPayable?.());
    };

    const onUp = ev => {
      const pt = getPoint(ev);
      if (ghost) { ghost.g.remove(); ghost = null; }
      cleanDropZones();
      el.classList.remove('dragging');
      el.style.visibility = '';
      _endHandDrag(pt, cid, callbacks);
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      document.removeEventListener('touchmove', onMove);
      document.removeEventListener('touchend', onUp);
    };

    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    document.addEventListener('touchmove', onMove, { passive: false });
    document.addEventListener('touchend', onUp);
  }

  function _endHandDrag(pt, cid, cbs) {
    const hz = document.getElementById('discard-zone');

    function rectHit(el) {
      if (!el) return false;
      const r = el.getBoundingClientRect();
      return pt.x >= r.left && pt.x <= r.right && pt.y >= r.top && pt.y <= r.bottom;
    }

    const isOverDiscard = hz && rectHit(hz);

    let buildingSlot = null;
    document.querySelectorAll('.building-slot').forEach(slot => {
      if (rectHit(slot)) buildingSlot = slot;
    });

    let bajadaPile = null;
    document.querySelectorAll('.bajada-pile').forEach(p => {
      if (rectHit(p)) bajadaPile = p;
    });

    const fw = document.getElementById('fondo-wrap');
    const isOverFondo = fw && rectHit(fw);

    // ==========================
    // CASO 1: VIENE DE UN SLOT
    // ==========================
    if (draggingFromSlot && originalSlotIndex !== null) {

      if (isOverDiscard) {
        cbs.onReturnToHand?.(cid, originalSlotIndex);
        draggingFromSlot = false; originalSlotIndex = null;
        return;
      }

      if (buildingSlot) {
        const destSlotIndex = parseInt(buildingSlot.dataset.slotIndex);
        const insertIdx = getSlotInsertIndex(buildingSlot, pt.x);

        if (destSlotIndex === originalSlotIndex) {
          cbs.onReorderWithinSlot?.(cid, originalSlotIndex, insertIdx);
        } else {
          cbs.onMoveBetweenSlots?.(cid, originalSlotIndex, destSlotIndex, buildingSlot.dataset.slotType, insertIdx);
        }
        draggingFromSlot = false; originalSlotIndex = null;
        return;
      }

      // Lugar inválido — carta queda en su slot
      draggingFromSlot = false; originalSlotIndex = null;
      return;
    }

    // ==========================
    // CASO 2: VIENE DE LA MANO
    // ==========================
    if (buildingSlot) {
      const insertIdx = getSlotInsertIndex(buildingSlot, pt.x);
      cbs.onBuildingDrop?.(cid, buildingSlot.dataset.slotIndex, buildingSlot.dataset.slotType, insertIdx);
      return;
    }
    if (bajadaPile) {
      cbs.onAcomodar?.(cid, parseInt(bajadaPile.dataset.pi), parseInt(bajadaPile.dataset.ji));
      return;
    }
    if (isOverFondo && cbs.isPayable?.()) {
      cbs.onPagar?.(cid);
      return;
    }
    if (isOverDiscard) {
      const cards = [...hz.querySelectorAll('.card:not(.dragging)')];
      let insertIdx = cards.length;
      for (let i = 0; i < cards.length; i++) {
        const r = cards[i].getBoundingClientRect();
        if (pt.x < r.left + r.width / 2) { insertIdx = i; break; }
      }
      cbs.onReorder?.(cid, insertIdx);
      return;
    }

    draggingFromSlot = false; originalSlotIndex = null;
  }

  function startFondoDrag(e, cardEl, callbacks) {
    if (e.type === 'touchstart') e.preventDefault();
    draggingFromSlot = false;
    originalSlotIndex = null;
    ghost = mkGhost(cardEl, getPoint(e));
    cardEl.style.opacity = '.2';
    const onMove = ev => {
      ev.preventDefault();
      const pt = getPoint(ev);
      moveGhost(pt);
      showHandInsertGhost(pt.x, pt.y);
    };
    const onUp = ev => {
      const pt = getPoint(ev);
      if (ghost) { ghost.g.remove(); ghost = null; }
      cleanDropZones();
      cardEl.style.opacity = '';
      _endFondoDrag(pt, callbacks);
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      document.removeEventListener('touchmove', onMove);
      document.removeEventListener('touchend', onUp);
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    document.addEventListener('touchmove', onMove, { passive: false });
    document.addEventListener('touchend', onUp);
  }

  function _endFondoDrag(pt, cbs) {
    const hz = document.getElementById('discard-zone');
    if (!hz) return;
    const hr = hz.getBoundingClientRect();
    if (pt.x >= hr.left && pt.x <= hr.right && pt.y >= hr.top && pt.y <= hr.bottom) {
      cbs.onTakeFondo?.();
    }
  }

  return { startHandDrag, startFondoDrag };
})();