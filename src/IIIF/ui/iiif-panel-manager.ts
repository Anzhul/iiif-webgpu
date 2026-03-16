/**
 * PanelManager - Handles panel creation, dragging, resizing, and docking.
 *
 * Extracted from IIIFViewer to reduce file size and improve maintainability.
 * Manages the dock system and panel interactions.
 */

import { PANEL_CONFIG } from '../config';
import type { DockPosition, PanelOptions, PanelElements } from '../types';

export class PanelManager {
    private container: HTMLElement;
    private docks: Map<string, HTMLDivElement> = new Map();
    private panelZIndexCounter: number = PANEL_CONFIG.INITIAL_Z_INDEX;
    private abortController: AbortController;

    constructor(container: HTMLElement, abortController: AbortController) {
        this.container = container;
        this.abortController = abortController;
    }

    /**
     * Get the docks map for external access
     */
    getDocks(): Map<string, HTMLDivElement> {
        return this.docks;
    }

    /**
     * Create dock containers in the viewer
     */
    setupDocks(): void {
        const dockPositions: DockPosition[] = [
            'top-right', 'top-left', 'bottom-right', 'bottom-left', 'top-center', 'bottom-center'
        ];
        for (const pos of dockPositions) {
            const dock = document.createElement('div');
            dock.className = `iiif-dock iiif-dock-${pos}`;
            this.docks.set(pos, dock);
            this.container.appendChild(dock);
        }
    }

    /**
     * Create a standard panel with header, collapse button, and body.
     */
    createPanel(options: PanelOptions): PanelElements {
        const panel = document.createElement('div');
        panel.className = `iiif-panel ${options.className}`;
        if (options.hidden) panel.style.display = 'none';

        const header = document.createElement('div');
        header.className = `iiif-panel-header ${options.className}-header`;

        const title = document.createElement('span');
        title.textContent = options.title;
        header.appendChild(title);

        const collapseBtn = document.createElement('button');
        collapseBtn.className = `iiif-panel-collapse ${options.className}-collapse`;
        collapseBtn.textContent = options.initiallyCollapsed ? '+' : '−';
        header.appendChild(collapseBtn);

        panel.appendChild(header);

        const body = document.createElement('div');
        body.className = `iiif-panel-body ${options.className}-body`;
        if (options.initiallyCollapsed) body.classList.add('collapsed');
        panel.appendChild(body);

        this.addEventListener(collapseBtn, 'click', () => {
            const isCollapsing = !body.classList.contains('collapsed');
            if (isCollapsing) {
                if (panel.style.height) {
                    panel.dataset.resizedHeight = panel.style.height;
                }
                panel.style.height = '';
            } else {
                if (panel.dataset.resizedHeight) {
                    panel.style.height = panel.dataset.resizedHeight;
                }
            }
            body.classList.toggle('collapsed');
            collapseBtn.textContent = body.classList.contains('collapsed') ? '+' : '−';
        });

        // Bring panel to front when clicked
        this.addEventListener(panel, 'mousedown', () => {
            this.bringPanelToFront(panel);
        });
        this.addEventListener(panel, 'touchstart', () => {
            this.bringPanelToFront(panel);
        }, { passive: true });

        if (options.draggable !== false) {
            this.makePanelDraggable(panel, header);
        }

        if (options.resizable !== false) {
            this.makePanelResizable(panel);
        }

        if (options.dock) {
            const dock = this.docks.get(options.dock);
            if (dock) {
                dock.appendChild(panel);
            } else {
                this.container.appendChild(panel);
            }
        } else {
            (options.parent ?? this.container).appendChild(panel);
        }

        return { panel, header, body, collapseBtn };
    }

    /**
     * Bring a panel to the front by updating its z-index
     */
    bringPanelToFront(panel: HTMLElement): void {
        this.panelZIndexCounter++;
        const zIndex = String(this.panelZIndexCounter);
        panel.style.zIndex = zIndex;

        const parentDock = panel.parentElement;
        if (parentDock?.classList.contains('iiif-dock')) {
            parentDock.style.zIndex = zIndex;
        }
    }

    /**
     * Apply FLIP animation given pre-captured rects. Call AFTER the DOM change.
     */
    flipAnimate(firstRects: Map<HTMLElement, DOMRect>): void {
        const moved: HTMLElement[] = [];
        for (const [child, firstRect] of firstRects) {
            if (!child.isConnected) continue;
            const lastRect = child.getBoundingClientRect();
            const dy = firstRect.top - lastRect.top;
            if (Math.abs(dy) < 1) continue;
            child.style.transition = 'none';
            child.style.transform = `translateY(${dy}px)`;
            moved.push(child);
        }
        requestAnimationFrame(() => {
            for (const child of moved) {
                child.style.transition = 'transform 0.2s ease';
                child.style.transform = '';
                const onEnd = () => {
                    child.style.transition = '';
                    child.removeEventListener('transitionend', onEnd);
                };
                child.addEventListener('transitionend', onEnd);
            }
        });
    }

    /**
     * Make a panel draggable by its header
     */
    makePanelDraggable(panel: HTMLElement, header: HTMLElement): void {
        let startX = 0;
        let startY = 0;
        let startLeft = 0;
        let startTop = 0;
        let panelHeight = 0;

        let spacer: HTMLDivElement | null = null;
        let spacerDock: HTMLElement | null = null;

        const getDocks = (): HTMLElement[] => {
            return Array.from(this.container.querySelectorAll('.iiif-dock')) as HTMLElement[];
        };

        const hitTestDock = (clientX: number, clientY: number): HTMLElement | null => {
            const panelRect = panel.getBoundingClientRect();
            for (const dock of getDocks()) {
                const rect = dock.getBoundingClientRect();
                if (rect.width === 0 && rect.height === 0) continue;
                const margin = PANEL_CONFIG.DOCK_HIT_MARGIN;
                const testTop = Math.min(clientY, panelRect.top);
                const testBottom = Math.max(clientY, panelRect.bottom);
                if (
                    clientX >= rect.left - margin &&
                    clientX <= rect.right + margin &&
                    testBottom >= rect.top - margin &&
                    testTop <= rect.bottom + margin
                ) {
                    return dock;
                }
            }
            return null;
        };

        const isReversedDock = (dock: HTMLElement): boolean => {
            return dock.classList.contains('iiif-dock-bottom-right') ||
                dock.classList.contains('iiif-dock-bottom-left') ||
                dock.classList.contains('iiif-dock-bottom-center');
        };

        const findInsertIndex = (dock: HTMLElement, clientY: number): number => {
            const children = Array.from(dock.children).filter(c => c !== spacer) as HTMLElement[];
            if (children.length === 0) return 0;

            if (isReversedDock(dock)) {
                for (let i = children.length - 1; i >= 0; i--) {
                    const childRect = children[i].getBoundingClientRect();
                    if (clientY < childRect.top + childRect.height / 2) {
                        return i + 1;
                    }
                }
                return 0;
            }

            for (let i = 0; i < children.length; i++) {
                const childRect = children[i].getBoundingClientRect();
                if (clientY < childRect.top + childRect.height / 2) {
                    return i;
                }
            }
            return children.length;
        };

        const ensureSpacer = () => {
            if (!spacer) {
                spacer = document.createElement('div');
                spacer.className = 'iiif-dock-spacer';
                spacer.style.height = '0px';
                spacer.style.transition = 'height 0.2s ease';
                spacer.style.overflow = 'hidden';
                spacer.style.pointerEvents = 'none';
            }
        };

        const insertSpacerAt = (dock: HTMLElement, index: number) => {
            ensureSpacer();
            const children = Array.from(dock.children).filter(c => c !== spacer) as HTMLElement[];
            const firstRects = new Map<HTMLElement, DOMRect>();
            for (const child of children) {
                firstRects.set(child, child.getBoundingClientRect());
            }

            if (index < children.length) {
                dock.insertBefore(spacer!, children[index]);
            } else {
                dock.appendChild(spacer!);
            }
            spacerDock = dock;

            this.flipAnimate(firstRects);
            requestAnimationFrame(() => {
                if (spacer) spacer.style.height = `${panelHeight}px`;
            });
        };

        const removeSpacer = () => {
            if (spacer && spacer.parentElement) {
                spacer.style.height = '0px';
                const s = spacer;
                const onEnd = () => {
                    s.removeEventListener('transitionend', onEnd);
                    s.remove();
                };
                s.addEventListener('transitionend', onEnd);
            }
            spacerDock = null;
        };

        const removeSpacerImmediate = () => {
            if (spacer && spacer.parentElement) {
                spacer.remove();
            }
            spacerDock = null;
        };

        let isPointerDown = false;
        let hasUndocked = false;

        const undockPanel = () => {
            hasUndocked = true;
            panel.classList.add('dragging');

            const rect = panel.getBoundingClientRect();
            const containerRect = this.container.getBoundingClientRect();
            startLeft = rect.left - containerRect.left;
            startTop = rect.top - containerRect.top;
            panelHeight = rect.height;

            const parentDock = panel.parentElement;
            if (parentDock && parentDock !== this.container) {
                if (parentDock.classList.contains('iiif-dock')) {
                    ensureSpacer();
                    parentDock.insertBefore(spacer!, panel);
                    spacer!.style.height = `${panelHeight}px`;
                    spacerDock = parentDock;
                }
                this.container.appendChild(panel);
            }

            panel.style.position = 'absolute';
            panel.style.right = 'auto';
            panel.style.bottom = 'auto';
            panel.style.transform = 'none';
            panel.style.left = `${startLeft}px`;
            panel.style.top = `${startTop}px`;
        };

        const onPointerDown = (clientX: number, clientY: number) => {
            isPointerDown = true;
            hasUndocked = false;
            startX = clientX;
            startY = clientY;
            this.bringPanelToFront(panel);
        };

        const onPointerMove = (clientX: number, clientY: number) => {
            if (!isPointerDown) return;

            const dx = clientX - startX;
            const dy = clientY - startY;

            if (!hasUndocked) {
                if (Math.abs(dx) < PANEL_CONFIG.DRAG_THRESHOLD && Math.abs(dy) < PANEL_CONFIG.DRAG_THRESHOLD) return;
                undockPanel();
            }

            const newLeft = startLeft + dx;
            const newTop = startTop + dy;

            const containerRect = this.container.getBoundingClientRect();
            const panelRect = panel.getBoundingClientRect();

            const maxLeft = containerRect.width - panelRect.width;
            const maxTop = containerRect.height - panelRect.height;

            panel.style.left = `${Math.max(0, Math.min(newLeft, maxLeft))}px`;
            panel.style.top = `${Math.max(0, Math.min(newTop, maxTop))}px`;

            const targetDock = hitTestDock(clientX, clientY);
            for (const dock of getDocks()) {
                dock.classList.toggle('dock-highlight', dock === targetDock);
            }

            if (targetDock) {
                const insertIdx = findInsertIndex(targetDock, clientY);
                const currentChildren = Array.from(targetDock.children).filter(c => c !== spacer);
                const spacerCurrentIdx = spacer?.parentElement === targetDock
                    ? Array.from(targetDock.children).indexOf(spacer!)
                    : -1;
                const spacerLogicalIdx = spacerCurrentIdx >= 0
                    ? currentChildren.filter((_, i) => {
                        const domIdx = Array.from(targetDock.children).indexOf(currentChildren[i]);
                        return domIdx < spacerCurrentIdx;
                    }).length
                    : -1;

                if (spacerDock !== targetDock || spacerLogicalIdx !== insertIdx) {
                    if (spacerDock && spacerDock !== targetDock) {
                        removeSpacerImmediate();
                    }
                    insertSpacerAt(targetDock, insertIdx);
                }
            } else if (spacerDock) {
                removeSpacer();
            }
        };

        const onPointerUp = (clientX: number, clientY: number) => {
            if (!isPointerDown) return;
            isPointerDown = false;

            if (!hasUndocked) return;

            panel.classList.remove('dragging');

            for (const dock of getDocks()) {
                dock.classList.remove('dock-highlight');
            }

            const targetDock = hitTestDock(clientX, clientY);
            if (targetDock && spacer?.parentElement === targetDock) {
                panel.style.position = '';
                panel.style.left = '';
                panel.style.top = '';
                panel.style.right = '';
                panel.style.bottom = '';
                panel.style.transform = '';

                targetDock.insertBefore(panel, spacer);
                spacer.remove();
                spacerDock = null;
            } else {
                removeSpacerImmediate();
            }
        };

        // Mouse events
        this.addEventListener(header, 'mousedown', ((e: MouseEvent) => {
            if ((e.target as HTMLElement).closest('button')) return;
            e.stopPropagation();
            e.preventDefault();
            onPointerDown(e.clientX, e.clientY);
        }) as EventListener);
        this.addEventListener(document.body, 'mousemove', ((e: MouseEvent) => {
            onPointerMove(e.clientX, e.clientY);
        }) as EventListener);
        this.addEventListener(document.body, 'mouseup', ((e: MouseEvent) => {
            onPointerUp(e.clientX, e.clientY);
        }) as EventListener);

        // Touch events
        this.addEventListener(header, 'touchstart', ((e: TouchEvent) => {
            if ((e.target as HTMLElement).closest('button')) return;
            if (e.touches.length !== 1) return;
            e.stopPropagation();
            e.preventDefault();
            const t = e.touches[0];
            onPointerDown(t.clientX, t.clientY);
        }) as EventListener, { passive: false });
        this.addEventListener(document.body, 'touchmove', ((e: TouchEvent) => {
            if (!isPointerDown || e.touches.length !== 1) return;
            e.preventDefault();
            const t = e.touches[0];
            onPointerMove(t.clientX, t.clientY);
        }) as EventListener, { passive: false });
        this.addEventListener(document.body, 'touchend', ((e: TouchEvent) => {
            if (!isPointerDown) return;
            const t = e.changedTouches[0];
            onPointerUp(t.clientX, t.clientY);
        }) as EventListener);
    }

    /**
     * Make a panel resizable via edge and corner handles
     */
    makePanelResizable(panel: HTMLElement): void {
        panel.classList.add('resizable');

        const handles = ['n', 's', 'e', 'w', 'nw', 'ne', 'sw', 'se'];
        const handleElements: HTMLElement[] = [];

        for (const direction of handles) {
            const handle = document.createElement('div');
            handle.className = `iiif-resize-handle iiif-resize-handle-${direction}`;
            handle.dataset.direction = direction;
            panel.appendChild(handle);
            handleElements.push(handle);
        }

        let isResizing = false;
        let currentHandle: HTMLElement | null = null;
        let startX = 0;
        let startY = 0;
        let startWidth = 0;
        let startHeight = 0;
        let startLeft = 0;
        let startTop = 0;

        const getCursorClass = (direction: string): string => {
            if (direction === 'e' || direction === 'w') return 'iiif-resizing-ew';
            if (direction === 'n' || direction === 's') return 'iiif-resizing-ns';
            if (direction === 'nw' || direction === 'se') return 'iiif-resizing-nwse';
            if (direction === 'ne' || direction === 'sw') return 'iiif-resizing-nesw';
            return '';
        };

        const onPointerDown = (e: MouseEvent | TouchEvent, handle: HTMLElement) => {
            e.preventDefault();
            e.stopPropagation();

            isResizing = true;
            currentHandle = handle;

            const direction = handle.dataset.direction || '';
            const cursorClass = getCursorClass(direction);
            if (cursorClass) document.body.classList.add(cursorClass);

            const clientX = 'touches' in e ? e.touches[0].clientX : e.clientX;
            const clientY = 'touches' in e ? e.touches[0].clientY : e.clientY;

            startX = clientX;
            startY = clientY;

            const rect = panel.getBoundingClientRect();
            const containerRect = this.container.getBoundingClientRect();
            startWidth = rect.width;
            startHeight = rect.height;
            startLeft = rect.left - containerRect.left;
            startTop = rect.top - containerRect.top;

            panel.style.width = `${startWidth}px`;
            panel.style.height = `${startHeight}px`;

            panel.classList.add('resized');
            this.bringPanelToFront(panel);
        };

        const onPointerMove = (clientX: number, clientY: number) => {
            if (!isResizing || !currentHandle) return;

            const direction = currentHandle.dataset.direction || '';
            const dx = clientX - startX;
            const dy = clientY - startY;

            let newWidth = startWidth;
            let newHeight = startHeight;
            let newLeft = startLeft;
            let newTop = startTop;

            if (direction.includes('e')) {
                newWidth = Math.max(PANEL_CONFIG.MIN_WIDTH, startWidth + dx);
            }
            if (direction.includes('w')) {
                const widthChange = Math.min(dx, startWidth - PANEL_CONFIG.MIN_WIDTH);
                newWidth = startWidth - widthChange;
                newLeft = startLeft + widthChange;
            }

            if (direction.includes('s')) {
                newHeight = Math.max(PANEL_CONFIG.MIN_HEIGHT, startHeight + dy);
            }
            if (direction.includes('n')) {
                const heightChange = Math.min(dy, startHeight - PANEL_CONFIG.MIN_HEIGHT);
                newHeight = startHeight - heightChange;
                newTop = startTop + heightChange;
            }

            panel.style.width = `${newWidth}px`;
            panel.style.height = `${newHeight}px`;

            if (panel.style.position === 'absolute') {
                if (direction.includes('w')) {
                    panel.style.left = `${newLeft}px`;
                }
                if (direction.includes('n')) {
                    panel.style.top = `${newTop}px`;
                }
            }
        };

        const onPointerUp = () => {
            if (!isResizing) return;
            isResizing = false;
            document.body.classList.remove(
                'iiif-resizing-ew',
                'iiif-resizing-ns',
                'iiif-resizing-nwse',
                'iiif-resizing-nesw'
            );
            currentHandle = null;
        };

        for (const handle of handleElements) {
            this.addEventListener(handle, 'mousedown', ((e: MouseEvent) => {
                onPointerDown(e, handle);
            }) as EventListener);

            this.addEventListener(handle, 'touchstart', ((e: TouchEvent) => {
                if (e.touches.length !== 1) return;
                onPointerDown(e, handle);
            }) as EventListener, { passive: false });
        }

        this.addEventListener(document.body, 'mousemove', ((e: MouseEvent) => {
            if (isResizing) {
                e.preventDefault();
                onPointerMove(e.clientX, e.clientY);
            }
        }) as EventListener);
        this.addEventListener(document.body, 'mouseup', (() => {
            onPointerUp();
        }) as EventListener);

        this.addEventListener(document.body, 'touchmove', ((e: TouchEvent) => {
            if (!isResizing || e.touches.length !== 1) return;
            e.preventDefault();
            onPointerMove(e.touches[0].clientX, e.touches[0].clientY);
        }) as EventListener, { passive: false });
        this.addEventListener(document.body, 'touchend', (() => {
            onPointerUp();
        }) as EventListener);
    }

    /**
     * Helper to add event listeners with automatic cleanup
     */
    private addEventListener<K extends keyof HTMLElementEventMap>(
        element: Element | Document,
        type: K,
        handler: (event: HTMLElementEventMap[K]) => void,
        options?: { passive?: boolean }
    ): void {
        const listener = handler as EventListener;
        element.addEventListener(type, listener, { signal: this.abortController.signal, ...options });
    }
}
