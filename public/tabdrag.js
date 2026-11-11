// Dragging tabs in the tab list on the left: reorder within the list, or pull one out (right past the
// list or outside the window) to move it to another window / a new window, like Chrome.
//
// The web view does not always report the mouse release when it happens outside the window, so
// a drag can also be ended from outside: the native app calls endDrag() on every mouse-up, and
// losing pointer capture ends it too. Ending is idempotent.

const DETACH_PX = 40; // this far right of the tab list counts as "pulled out"
let drag = null;
let suppressClick = false;

export const isDragging = () => !!drag;
/** True once right after a drag, so the tab's click handler can ignore the release. */
export function consumeDragClick() { const s = suppressClick; suppressClick = false; return s; }

function pulledOut(e, bar) {
  const r = bar.getBoundingClientRect();
  return e.clientX > r.right + DETACH_PX || e.clientY < 2 || e.clientX < 2 || e.clientX > innerWidth - 2 || e.clientY > innerHeight - 2;
}

/**
 * Finish the current drag, if any. `outside`: the mouse was released outside the window (known
 * to the native app even when the page saw no event). `cancel`: just clean up.
 */
export function endDrag({ outside = false, cancel = false } = {}) {
  if (!drag) return;
  const d = drag;
  drag = null;
  if (!d.moved) return; // plain click
  suppressClick = true;
  setTimeout(() => { suppressClick = false; }, 0);
  d.ghost?.remove();
  d.el.classList.remove('dragging');
  document.body.classList.remove('tab-detaching');
  d.h.onOut?.(null);
  if (!cancel) {
    // `inside`: released over this window's page (not outside it), with the pointer position.
    if (d.out || outside) d.h.onDetach(d.el.dataset.id, outside ? null : { x: d.x, y: d.y });
    else d.h.onReorder([...d.h.bar.children].map((t) => t.dataset.id));
  }
  d.h.onDone();
}

/**
 * @param {HTMLElement} el the tab element (needs data-id)
 * @param {{ bar: HTMLElement, onReorder: (ids: string[]) => void, onDone: () => void,
 *           onDetach: (id: string, at: {x: number, y: number} | null) => void,
 *           onOut?: (at: {x: number, y: number} | null) => void }} h
 *   onDetach `at`: where it was released inside this window, or null if released outside it.
 *   onOut: the pointer while the tab is pulled out of the bar (null when it goes back or the drag ends).
 */
export function attachTabDrag(el, h) {
  el.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || e.target.closest('button')) return;
    endDrag({ cancel: true }); // a stale drag that never got its release
    drag = { el, h, x0: e.clientX, y0: e.clientY, dx: 0, moved: false, ghost: null, out: false };
    el.setPointerCapture(e.pointerId);
  });

  el.addEventListener('pointermove', (e) => {
    if (!drag || drag.el !== el) return;
    if (!(e.buttons & 1)) { endDrag(); return; } // button already up: we missed the release
    if (!drag.moved) {
      if (Math.hypot(e.clientX - drag.x0, e.clientY - drag.y0) < 6) return;
      drag.moved = true;
      const r = el.getBoundingClientRect();
      drag.dx = drag.x0 - r.left; drag.dy = drag.y0 - r.top;
      drag.ghost = el.cloneNode(true);
      drag.ghost.classList.add('tab-ghost');
      drag.ghost.style.width = r.width + 'px';
      document.body.append(drag.ghost);
      el.classList.add('dragging');
    }
    drag.ghost.style.transform = `translate(${e.clientX - drag.dx}px, ${e.clientY - drag.dy}px)`;
    drag.out = pulledOut(e, h.bar);
    drag.x = e.clientX; drag.y = e.clientY;
    document.body.classList.toggle('tab-detaching', drag.out);
    h.onOut?.(drag.out ? { x: e.clientX, y: e.clientY } : null);
    if (drag.out) return;
    // Reorder: move the tab before/after whichever tab the pointer is over.
    for (const t of h.bar.children) {
      if (t === el) continue;
      const r = t.getBoundingClientRect();
      if (e.clientY >= r.top && e.clientY <= r.bottom) {
        h.bar.insertBefore(el, e.clientY < r.top + r.height / 2 ? t : t.nextSibling);
        break;
      }
    }
  });

  el.addEventListener('pointerup', () => { if (drag?.el === el) endDrag(); });
  el.addEventListener('lostpointercapture', () => { if (drag?.el === el) endDrag(); });
  el.addEventListener('pointercancel', () => { if (drag?.el === el) endDrag({ cancel: true }); });
}
