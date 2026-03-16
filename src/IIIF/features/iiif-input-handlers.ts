/**
 * Input Handlers - Mouse, touch, and keyboard event handling for the IIIF viewer.
 *
 * Extracted from IIIFViewer to reduce file size and improve maintainability.
 */

import { CAMERA_CONFIG, TOUCH_CONFIG, NON_PAN_SELECTORS } from '../config';
import type { TouchState, CameraInterface, ViewportInterface } from '../types';

export interface InputHandlerCallbacks {
    markDirty: () => void;
    loadCanvas: (index: number) => Promise<void>;
    fitToWorld: () => void;
    previousCanvas: () => Promise<void>;
    nextCanvas: () => Promise<void>;
    getCanvasCount: () => number;
    hasManifest: () => boolean;
    requestFullscreen: () => Promise<void>;
    exitFullscreen: () => void;
    isFullscreen: () => boolean;
    updateFullscreenButton: (active: boolean) => void;
}

/**
 * Sets up all input event listeners for the viewer.
 * Returns the touch state object for external access if needed.
 */
export function setupInputHandlers(
    container: HTMLElement,
    camera: CameraInterface,
    viewport: ViewportInterface,
    cachedContainerRect: DOMRect,
    abortController: AbortController,
    callbacks: InputHandlerCallbacks
): TouchState {
    const touchState: TouchState = {
        activeTouches: new Map(),
        lastPinchDistance: 0,
        isPinching: false,
        lastTapTime: 0,
        lastTapX: 0,
        lastTapY: 0,
    };

    const addEventListener = <K extends keyof HTMLElementEventMap>(
        element: Element | Document,
        type: K,
        handler: (event: HTMLElementEventMap[K]) => void,
        options?: { passive?: boolean }
    ) => {
        const listener = handler as EventListener;
        element.addEventListener(type, listener, { signal: abortController.signal, ...options });
    };

    // Mouse events
    addEventListener(container, 'mousedown', (event: MouseEvent) => {
        if ((event.target as HTMLElement).closest(NON_PAN_SELECTORS)) return;

        event.preventDefault();
        event.stopPropagation();

        const canvasX = event.clientX - cachedContainerRect.left;
        const canvasY = event.clientY - cachedContainerRect.top;

        camera.startInteractivePan(canvasX, canvasY);

        const onMouseMove = (moveEvent: MouseEvent) => {
            const newCanvasX = moveEvent.clientX - cachedContainerRect.left;
            const newCanvasY = moveEvent.clientY - cachedContainerRect.top;
            camera.updateInteractivePan(newCanvasX, newCanvasY);
        };

        const cleanup = () => {
            camera.endInteractivePan();
            document.removeEventListener('mousemove', onMouseMove);
            document.removeEventListener('mouseup', cleanup);
            document.removeEventListener('mouseleave', cleanup);
        };

        document.addEventListener('mousemove', onMouseMove, { signal: abortController.signal });
        document.addEventListener('mouseup', cleanup, { signal: abortController.signal });
        document.addEventListener('mouseleave', cleanup, { signal: abortController.signal });
    });

    addEventListener(container, 'wheel', (event: WheelEvent) => {
        const canvasX = event.clientX - cachedContainerRect.left;
        const canvasY = event.clientY - cachedContainerRect.top;
        camera.handleWheel(event, canvasX, canvasY);
    }, { passive: false });

    // Touch events
    addEventListener(container, 'touchstart', (event: TouchEvent) => {
        if ((event.target as HTMLElement).closest(NON_PAN_SELECTORS)) return;

        event.preventDefault();
        event.stopPropagation();

        const rect = cachedContainerRect;
        for (let i = 0; i < event.changedTouches.length; i++) {
            const t = event.changedTouches[i];
            touchState.activeTouches.set(t.identifier, {
                x: t.clientX - rect.left,
                y: t.clientY - rect.top
            });
        }

        const touchCount = touchState.activeTouches.size;

        if (touchCount === 1) {
            const touch = event.changedTouches[0];
            const canvasX = touch.clientX - rect.left;
            const canvasY = touch.clientY - rect.top;

            // Double-tap detection
            const now = performance.now();
            const dt = now - touchState.lastTapTime;
            const dx = canvasX - touchState.lastTapX;
            const dy = canvasY - touchState.lastTapY;

            if (dt < TOUCH_CONFIG.DOUBLE_TAP_THRESHOLD_MS && (dx * dx + dy * dy) < TOUCH_CONFIG.DOUBLE_TAP_DISTANCE_SQ) {
                camera.handleDoubleTap(canvasX, canvasY);
                touchState.lastTapTime = 0;
                return;
            }

            touchState.lastTapTime = now;
            touchState.lastTapX = canvasX;
            touchState.lastTapY = canvasY;

            camera.startInteractivePan(canvasX, canvasY);
        }

        if (touchCount === 2) {
            camera.endInteractivePan();

            const touches = Array.from(touchState.activeTouches.values());
            const dx = touches[1].x - touches[0].x;
            const dy = touches[1].y - touches[0].y;
            touchState.lastPinchDistance = Math.sqrt(dx * dx + dy * dy);
            touchState.isPinching = true;
        }
    }, { passive: false });

    addEventListener(container, 'touchmove', (event: TouchEvent) => {
        if ((event.target as HTMLElement).closest(NON_PAN_SELECTORS)) return;
        event.preventDefault();

        const rect = cachedContainerRect;
        for (let i = 0; i < event.changedTouches.length; i++) {
            const t = event.changedTouches[i];
            touchState.activeTouches.set(t.identifier, {
                x: t.clientX - rect.left,
                y: t.clientY - rect.top
            });
        }

        const touchCount = touchState.activeTouches.size;

        if (touchCount === 1 && !touchState.isPinching) {
            const touch = event.changedTouches[0];
            const canvasX = touch.clientX - rect.left;
            const canvasY = touch.clientY - rect.top;
            camera.updateInteractivePan(canvasX, canvasY);
        }

        if (touchCount >= 2 && touchState.isPinching) {
            const touches = Array.from(touchState.activeTouches.values());
            const dx = touches[1].x - touches[0].x;
            const dy = touches[1].y - touches[0].y;
            const newDistance = Math.sqrt(dx * dx + dy * dy);
            const centerX = (touches[0].x + touches[1].x) / 2;
            const centerY = (touches[0].y + touches[1].y) / 2;

            if (touchState.lastPinchDistance > 0) {
                const scaleFactor = newDistance / touchState.lastPinchDistance;
                camera.handlePinchZoom(scaleFactor, centerX, centerY);
            }

            touchState.lastPinchDistance = newDistance;
        }
    }, { passive: false });

    const onTouchEnd = (event: TouchEvent) => {
        if ((event.target as HTMLElement).closest(NON_PAN_SELECTORS)) return;
        event.preventDefault();

        for (let i = 0; i < event.changedTouches.length; i++) {
            touchState.activeTouches.delete(event.changedTouches[i].identifier);
        }

        const remaining = touchState.activeTouches.size;

        if (remaining < 2 && touchState.isPinching) {
            touchState.isPinching = false;

            if (remaining === 1) {
                const touch = Array.from(touchState.activeTouches.values())[0];
                camera.startInteractivePan(touch.x, touch.y);
            } else {
                camera.endInteractivePan();
            }
        }

        if (remaining === 0 && !touchState.isPinching) {
            camera.endInteractivePan();
        }
    };

    addEventListener(container, 'touchend', onTouchEnd, { passive: false });
    addEventListener(container, 'touchcancel', onTouchEnd, { passive: false });

    // Keyboard navigation
    if (!container.hasAttribute('tabindex')) {
        container.tabIndex = 0;
        container.style.outline = 'none';
    }

    addEventListener(container, 'click', (event: MouseEvent) => {
        const tag = (event.target as HTMLElement).tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
        container.focus();
    });

    const heldArrows = new Set<string>();

    addEventListener(container, 'keyup', (event: KeyboardEvent) => {
        heldArrows.delete(event.key);
    });

    addEventListener(container, 'blur', () => {
        heldArrows.clear();
    });

    addEventListener(container, 'keydown', (event: KeyboardEvent) => {
        if ((event.target as HTMLElement).tagName === 'INPUT' || (event.target as HTMLElement).tagName === 'TEXTAREA') return;

        const isArrow = event.key === 'ArrowLeft' || event.key === 'ArrowRight' ||
                        event.key === 'ArrowUp' || event.key === 'ArrowDown';

        if (isArrow) {
            event.preventDefault();
            heldArrows.add(event.key);

            let dx = 0, dy = 0;
            if (heldArrows.has('ArrowLeft')) dx -= 1;
            if (heldArrows.has('ArrowRight')) dx += 1;
            if (heldArrows.has('ArrowUp')) dy -= 1;
            if (heldArrows.has('ArrowDown')) dy += 1;

            if (dx !== 0 || dy !== 0) {
                const panAmount = 100 / viewport.scale;
                const len = Math.sqrt(dx * dx + dy * dy);
                camera.springPan((dx / len) * panAmount, (dy / len) * panAmount);
                callbacks.markDirty();
            }
            return;
        }

        switch (event.key) {
            case '+':
            case '=':
                event.preventDefault();
                camera.springZoomByFactor(CAMERA_CONFIG.ZOOM_FACTOR);
                callbacks.markDirty();
                break;
            case '-':
                event.preventDefault();
                camera.springZoomByFactor(1 / CAMERA_CONFIG.ZOOM_FACTOR);
                callbacks.markDirty();
                break;

            case '0':
                event.preventDefault();
                callbacks.fitToWorld();
                break;

            case 'PageUp':
            case '[':
                event.preventDefault();
                callbacks.previousCanvas();
                break;
            case 'PageDown':
            case ']':
                event.preventDefault();
                callbacks.nextCanvas();
                break;

            case 'Home':
                event.preventDefault();
                if (callbacks.hasManifest() && callbacks.getCanvasCount() > 0) {
                    callbacks.loadCanvas(0);
                }
                break;
            case 'End':
                event.preventDefault();
                if (callbacks.hasManifest() && callbacks.getCanvasCount() > 0) {
                    callbacks.loadCanvas(callbacks.getCanvasCount() - 1);
                }
                break;

            case 'f':
                if (!event.ctrlKey && !event.metaKey) {
                    event.preventDefault();
                    if (!callbacks.isFullscreen()) {
                        callbacks.requestFullscreen().catch(() => {});
                        callbacks.updateFullscreenButton(true);
                    } else {
                        callbacks.exitFullscreen();
                        callbacks.updateFullscreenButton(false);
                    }
                }
                break;
        }
    });

    return touchState;
}
