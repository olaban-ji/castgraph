import { useEffect } from 'react';

/** Pixels of movement before a pan click is treated as a drag, so a
 *  stationary ⌘/ctrl click does not swallow the following click. */
const DRAG_SLOP = 4;

/** ⌘/ctrl + primary button. Trackpad clicks arrive as mouse pointers;
 *  finger touches stay native so a phone can still scroll. */
export function isDragPanStart(ev: {
  button: number;
  ctrlKey: boolean;
  metaKey: boolean;
  pointerType?: string;
}): boolean {
  if (ev.pointerType === 'touch') return false;
  return ev.button === 0 && (ev.ctrlKey || ev.metaKey);
}

/** Search, zoom, and other chrome keep their own clicks. */
export function isDragPanChrome(target: EventTarget | null): boolean {
  return target instanceof Element && !!target.closest('.mc-header, .mc-zoom, .mc-deep');
}

/** ⌘/ctrl + primary click-drag pans the map. Once the drag starts,
 *  releasing the modifier does not abort it. */
export function useDragPan() {
  useEffect(() => {
    const root = document.documentElement;
    let dragging = false;
    let pointerId = 0;
    let lastX = 0;
    let lastY = 0;
    let moved = 0;
    let swallowClick = false;
    // ctrl-click's context menu arrives after pointerup; keep it blocked
    // until that event (or the next tick) has had a chance to fire.
    let suppressMenu = false;

    const setReady = (on: boolean) => {
      root.classList.toggle('mc-pan-ready', on);
    };

    const endDrag = (ev: PointerEvent) => {
      if (!dragging || ev.pointerId !== pointerId) return;
      dragging = false;
      swallowClick = moved > DRAG_SLOP;
      root.classList.remove('mc-panning');
      setReady(ev.metaKey || ev.ctrlKey);
      if (root.hasPointerCapture(ev.pointerId)) {
        root.releasePointerCapture(ev.pointerId);
      }
      window.setTimeout(() => {
        suppressMenu = false;
      }, 0);
    };

    const onDown = (ev: PointerEvent) => {
      if (dragging || !isDragPanStart(ev) || isDragPanChrome(ev.target)) return;
      ev.preventDefault();
      dragging = true;
      swallowClick = false;
      suppressMenu = true;
      moved = 0;
      pointerId = ev.pointerId;
      lastX = ev.clientX;
      lastY = ev.clientY;
      root.classList.add('mc-panning');
      root.classList.remove('mc-pan-ready');
      try {
        root.setPointerCapture(ev.pointerId);
      } catch {
        // Capture needs an active pointer; window listeners still pan.
      }
    };

    const onMove = (ev: PointerEvent) => {
      if (!dragging) {
        if (!root.classList.contains('mc-panning')) {
          setReady((ev.metaKey || ev.ctrlKey) && !isDragPanChrome(ev.target));
        }
        return;
      }
      if (ev.pointerId !== pointerId) return;
      if ((ev.buttons & 1) === 0) {
        endDrag(ev);
        return;
      }
      ev.preventDefault();
      const dx = ev.clientX - lastX;
      const dy = ev.clientY - lastY;
      lastX = ev.clientX;
      lastY = ev.clientY;
      moved += Math.abs(dx) + Math.abs(dy);
      window.scrollBy({ left: -dx, top: -dy, behavior: 'instant' });
    };

    const onKey = (ev: KeyboardEvent) => {
      if (dragging) return;
      setReady(ev.metaKey || ev.ctrlKey);
    };

    const onBlur = () => {
      setReady(false);
    };

    const onContextMenu = (ev: MouseEvent) => {
      if (!dragging && !suppressMenu) return;
      ev.preventDefault();
      suppressMenu = false;
    };

    const onClick = (ev: MouseEvent) => {
      if (!swallowClick) return;
      swallowClick = false;
      ev.preventDefault();
      ev.stopPropagation();
    };

    const onSelectStart = (ev: Event) => {
      if (dragging) ev.preventDefault();
    };

    const onDragStart = (ev: Event) => {
      if (dragging) ev.preventDefault();
    };

    const opts: AddEventListenerOptions = { capture: true };
    const downOpts: AddEventListenerOptions = { capture: true, passive: false };
    window.addEventListener('pointerdown', onDown, downOpts);
    window.addEventListener('pointermove', onMove, downOpts);
    window.addEventListener('pointerup', endDrag, opts);
    window.addEventListener('pointercancel', endDrag, opts);
    window.addEventListener('keydown', onKey);
    window.addEventListener('keyup', onKey);
    window.addEventListener('blur', onBlur);
    window.addEventListener('contextmenu', onContextMenu, opts);
    window.addEventListener('click', onClick, opts);
    window.addEventListener('selectstart', onSelectStart, opts);
    window.addEventListener('dragstart', onDragStart, opts);
    return () => {
      root.classList.remove('mc-panning', 'mc-pan-ready');
      window.removeEventListener('pointerdown', onDown, downOpts);
      window.removeEventListener('pointermove', onMove, downOpts);
      window.removeEventListener('pointerup', endDrag, opts);
      window.removeEventListener('pointercancel', endDrag, opts);
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('keyup', onKey);
      window.removeEventListener('blur', onBlur);
      window.removeEventListener('contextmenu', onContextMenu, opts);
      window.removeEventListener('click', onClick, opts);
      window.removeEventListener('selectstart', onSelectStart, opts);
      window.removeEventListener('dragstart', onDragStart, opts);
    };
  }, []);
}
