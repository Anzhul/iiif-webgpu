import { IIIFImage } from './iiif-image';
import { Viewport } from './iiif-view';
import { TileManager } from './iiif-tile';
import { WebGPURenderer } from './iiif-webgpu';
import { WebGLRenderer } from './iiif-webgl';
import { Canvas2DRenderer } from './iiif-canvas2d';
import type { IIIFRenderer, TileRenderData } from './iiif-renderer';
import { AnnotationManager, MOTIVATION_COLORS, DEFAULT_MOTIVATION_COLOR } from './iiif-annotations';
import { Camera } from './iiif-camera';
import { IIIFOverlayManager } from './iiif-overlay';
import { World, WorldImage } from './iiif-world';
import type { WorldPlacement } from './iiif-world';
import { parseIIIFUrl, fetchAnnotationList } from './iiif-parser';
import type { ParsedManifest, ParsedImageService, ParsedRange, ParsedCanvas } from './iiif-parser';
import { EYE_SVG } from './icons';
import { PANEL_CLASS_MAP, PANEL_HIDE_CLASS, PER_INSTANCE_PANELS } from './config';
import type { IIIFViewerOptions, IIIFViewerPanels, LayoutState, CanvasInfo } from './types';

// Dynamic import types (for lazy loading modules)
import type { CVController } from './iiif-cv';
import type { ComparisonController } from './iiif-compare';

// Re-export newly extracted modules for library consumers
export { PanelManager } from './iiif-panel-manager';
export { setupInputHandlers } from './iiif-input-handlers';

import './iiif-styles.css';

// Re-export types for convenience
export type { OverlayElement } from './iiif-overlay';
export type { CustomAnnotation, Annotation, IIIFAnnotation } from './iiif-annotations';
export { IIIFOverlayManager } from './iiif-overlay';
export type { WorldPlacement } from './iiif-world';
export type { ParsedRange, ParsedManifestMetadata, ParsedMetadataItem } from './iiif-parser';
export type { IIIFViewerOptions, IIIFViewerPanels, LayoutState } from './types';

/*
IIIFViewer - Main viewer class orchestrating all components

    Design principles:
 * - Render-on-demand with dirty flag pattern (only render when needed)
 * - Proper resource cleanup with destroy methods
 * - Centralized configuration
 * - Type-safe event handling
 * - Efficient viewport change detection
 * - Lazy loading and caching where possible

*/

// Types are now imported from './types' and re-exported above

export class IIIFViewer {
    // Core components
    container: HTMLElement;
    world: World;
    viewport: Viewport;
    camera: Camera;
    renderer?: IIIFRenderer;
    annotationManager?: AnnotationManager;
    overlayManager?: IIIFOverlayManager;

    // Viewport change callback (used by ComparisonController for camera sync)
    onViewportChange?: (centerX: number, centerY: number, cameraZ: number) => void;

    // UI elements
    private overlayContainer?: HTMLElement;
    private canvasNavContainer?: HTMLElement;
    private canvasNavList?: HTMLElement;
    private tocContainer?: HTMLElement;
    private tocList?: HTMLElement;
    private metadataPanelBody?: HTMLElement;
    private annotationPanel?: HTMLDivElement;
    private annotationPanelBody?: HTMLDivElement;
    private cvPanel?: HTMLDivElement;
    private cvPanelBody?: HTMLDivElement;
    private cvVideo?: HTMLVideoElement;
    private cvDisplayCanvas?: HTMLCanvasElement;

    private cvStatusEl?: HTMLSpanElement;
    private cvToggleBtn?: HTMLButtonElement;
    private cvGestureBtn?: HTMLButtonElement;
    private cvController?: CVController;

    private comparePanel?: HTMLDivElement;
    private settingsPanel?: HTMLDivElement;
    private settingsPanelBody?: HTMLDivElement;
    private docks: Map<string, HTMLDivElement> = new Map();
    private fullscreenBtn?: HTMLButtonElement;
    private colorInput?: HTMLInputElement;
    private settingsCheckboxes: Map<string, HTMLInputElement> = new Map();

    // State
    private manifest?: ParsedManifest;
    private currentLoadedUrl?: string;
    private currentCanvasIndex: number = -1;
    private canvasIdToIndex: Map<string, number> = new Map();
    private renderLoopActive: boolean = false;
    private animationFrameId?: number;
    private needsRender: boolean = true;
    private comparisonController?: ComparisonController;
    private compareAddedEntries: Array<{ url: string; label: string }> = [];
    private customAnnotationSpecs: Array<{
        x: number; y: number; width: number; height: number;
        text?: string;
        popupText?: string;
        /** When set, only replay on entries matching this manifest URL */
        targetUrl?: string;
        /** When set, only replay on entries matching this canvas index */
        targetPage?: number;
        options?: {
            id?: string; type?: string; color?: string;
            style?: Record<string, string | undefined>;
            scaleWithZoom?: boolean; activeClass?: string; inactiveClass?: string;
            popup?: string | HTMLElement;
            popupPosition?: { x: number; y: number };
        };
    }> = [];
    private hiddenAnnotationTypes: Set<string> = new Set();

    // Cached values for performance
    private cachedContainerRect: DOMRect;
    private lastViewportState = {
        centerX: NaN,
        centerY: NaN,
        scale: NaN
    };

    // Touch gesture state
    private touchState = {
        activeTouches: new Map<number, { x: number; y: number }>(),
        lastPinchDistance: 0,
        isPinching: false,
        lastTapTime: 0,
        lastTapX: 0,
        lastTapY: 0,
    };

    // Event tracking
    private eventHandlers: Map<Element | Document, Map<string, EventListener>> = new Map();
    private abortController: AbortController = new AbortController();

    // Panel z-index management
    private panelZIndexCounter: number = 100;

    // Configuration
    private readonly CONFIG: IIIFViewerOptions;
    private readonly panels: IIIFViewerPanels;

    constructor(container: HTMLElement, options: IIIFViewerOptions = {}) {
        this.container = container;
        this.CONFIG = {
            renderer: options.renderer ?? 'auto',
            enableOverlays: options.enableOverlays ?? true,
            enableToolbar: options.enableToolbar ?? true,
            enableCompare: options.enableCompare ?? true,
            enablePanels: options.enablePanels ?? true,
            maxCacheSize: options.maxCacheSize ?? 500,
            toolbar: options.toolbar,
            panels: options.panels,
            suppressNavigation: options.suppressNavigation ?? false,
            suppressSettings: options.suppressSettings ?? false,
        };

        // Panels: mentioned = available, omitted = not created
        this.panels = options.panels ?? {};

        // Initialize core components
        this.world = new World();
        this.viewport = new Viewport(container.clientWidth, container.clientHeight);
        this.camera = new Camera(this.viewport, this.world);

        // Cache container rect
        this.cachedContainerRect = container.getBoundingClientRect();

        // Set up UI components
        if (this.CONFIG.enableOverlays) {
            this.setupOverlayContainer();
        }
        this.annotationManager = new AnnotationManager(this.overlayManager);

        // Create docks before any panels so dock assignments work
        this.setupDocks();

        if (this.panels.pages !== undefined) this.setupCanvasNav();
        if (this.panels.navigation !== undefined) this.setupTOC();
        this.setupNavigationPanel();
        if (this.panels.settings !== undefined) this.setupSettingsPanel();
        if (this.panels.annotations !== undefined) this.setupAnnotationPanel();
        if (this.panels.manifest !== undefined) this.setupManifestPanel();
        if (this.panels.gesture !== undefined && !this.isMobileOrTablet()) this.setupCVPanel();
        if (this.panels.compare !== undefined) this.setupComparePanel();

        // Set up handlers
        this.setupResizeHandler();
        this.initializeRenderer();
    }

    private isMobileOrTablet(): boolean {
        return /Android|iPhone|iPad|iPod/i.test(navigator.userAgent) ||
            (navigator.maxTouchPoints > 1 && !matchMedia('(pointer: fine)').matches);
    }

    // ============================================================
    // INITIALIZATION
    // ============================================================

    private setupOverlayContainer() {
        this.overlayContainer = document.createElement('div');
        Object.assign(this.overlayContainer.style, {
            position: 'absolute',
            top: '0',
            left: '0',
            width: '100%',
            height: '100%',
            pointerEvents: 'none',
            zIndex: '11'
        });

        this.container.appendChild(this.overlayContainer);
        this.overlayManager = new IIIFOverlayManager(this.overlayContainer, this.viewport);
    }

    /**
     * FLIP animation for dock children: records positions before a DOM change,
     * then after the change animates children from old to new positions.
     */
    /** Apply FLIP animation given pre-captured rects. Call AFTER the DOM change. */
    private flipAnimate(firstRects: Map<HTMLElement, DOMRect>): void {
        // Synchronously read new positions and apply invert (before browser paints)
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
        // Play: animate to new position in next frame
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

    /** Bring a panel to the front by updating its z-index */
    private bringPanelToFront(panel: HTMLElement): void {
        this.panelZIndexCounter++;
        const zIndex = String(this.panelZIndexCounter);
        panel.style.zIndex = zIndex;

        // If panel is inside a dock, also bring the dock to front
        const parentDock = panel.parentElement;
        if (parentDock?.classList.contains('iiif-dock')) {
            parentDock.style.zIndex = zIndex;
        }
    }

    /** Make a panel draggable by its header */
    private makePanelDraggable(panel: HTMLElement, header: HTMLElement): void {
        let startX = 0;
        let startY = 0;
        let startLeft = 0;
        let startTop = 0;
        let panelHeight = 0;

        // Spacer element that opens a gap in the dock during drag
        let spacer: HTMLDivElement | null = null;
        let spacerDock: HTMLElement | null = null;

        const getDocks = (): HTMLElement[] => {
            // Query all docks in the container tree — includes wrapper docks
            // and child viewer instance docks during compare mode
            return Array.from(this.container.querySelectorAll('.iiif-dock')) as HTMLElement[];
        };

        const hitTestDock = (clientX: number, clientY: number): HTMLElement | null => {
            const panelRect = panel.getBoundingClientRect();
            for (const dock of getDocks()) {
                const rect = dock.getBoundingClientRect();
                // Skip hidden/collapsed docks (display:none → zero-size rect)
                if (rect.width === 0 && rect.height === 0) continue;
                const margin = 40;
                // Test both cursor position and panel edges against the dock zone.
                // For bottom docks the panel bottom arrives first; for top docks the top does.
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
                // column-reverse: iterate visually top to bottom (reverse DOM order)
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
            // Capture positions before DOM change
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

            // Synchronous invert + rAF play
            this.flipAnimate(firstRects);
            // Trigger spacer height transition
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
        const DRAG_THRESHOLD = 5;

        const undockPanel = () => {
            hasUndocked = true;
            panel.classList.add('dragging');

            const rect = panel.getBoundingClientRect();
            const containerRect = this.container.getBoundingClientRect();
            startLeft = rect.left - containerRect.left;
            startTop = rect.top - containerRect.top;
            panelHeight = rect.height;

            // Reparent to main container for free dragging
            const parentDock = panel.parentElement;
            if (parentDock && parentDock !== this.container) {
                if (parentDock.classList.contains('iiif-dock')) {
                    // Insert spacer at panel's position to hold the space
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
            // Bring panel to front when starting to drag
            this.bringPanelToFront(panel);
        };

        const onPointerMove = (clientX: number, clientY: number) => {
            if (!isPointerDown) return;

            const dx = clientX - startX;
            const dy = clientY - startY;

            // Only undock after exceeding drag threshold
            if (!hasUndocked) {
                if (Math.abs(dx) < DRAG_THRESHOLD && Math.abs(dy) < DRAG_THRESHOLD) return;
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

            // Highlight dock and manage spacer
            const targetDock = hitTestDock(clientX, clientY);
            for (const dock of getDocks()) {
                dock.classList.toggle('dock-highlight', dock === targetDock);
            }

            if (targetDock) {
                const insertIdx = findInsertIndex(targetDock, clientY);
                const currentChildren = Array.from(targetDock.children).filter(c => c !== spacer);
                // Determine where spacer currently is (among non-spacer children)
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
                    // Different dock or different position — reinsert
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

            // Click without drag — do nothing
            if (!hasUndocked) return;

            panel.classList.remove('dragging');

            for (const dock of getDocks()) {
                dock.classList.remove('dock-highlight');
            }

            const targetDock = hitTestDock(clientX, clientY);
            if (targetDock && spacer?.parentElement === targetDock) {
                // Replace spacer with the actual panel
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
                // Dropped outside any dock — just remove spacer
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

    /** Make a panel resizable via edge and corner handles */
    private makePanelResizable(panel: HTMLElement): void {
        panel.classList.add('resizable');

        // Create resize handles for all edges and corners
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

        const MIN_WIDTH = 100;
        const MIN_HEIGHT = 60;

        // Get cursor class based on resize direction
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

            // Add cursor class to body to maintain cursor during drag
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

            // Apply explicit dimensions BEFORE adding resized class to prevent flicker
            panel.style.width = `${startWidth}px`;
            panel.style.height = `${startHeight}px`;

            // Mark panel as resized and bring to front
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

            // Handle horizontal resize
            if (direction.includes('e')) {
                newWidth = Math.max(MIN_WIDTH, startWidth + dx);
            }
            if (direction.includes('w')) {
                const widthChange = Math.min(dx, startWidth - MIN_WIDTH);
                newWidth = startWidth - widthChange;
                newLeft = startLeft + widthChange;
            }

            // Handle vertical resize
            if (direction.includes('s')) {
                newHeight = Math.max(MIN_HEIGHT, startHeight + dy);
            }
            if (direction.includes('n')) {
                const heightChange = Math.min(dy, startHeight - MIN_HEIGHT);
                newHeight = startHeight - heightChange;
                newTop = startTop + heightChange;
            }

            // Apply new dimensions
            panel.style.width = `${newWidth}px`;
            panel.style.height = `${newHeight}px`;

            // If panel is floating (absolute positioned), also update position for n/w resizes
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
            // Remove all cursor classes from body
            document.body.classList.remove(
                'iiif-resizing-ew',
                'iiif-resizing-ns',
                'iiif-resizing-nwse',
                'iiif-resizing-nesw'
            );
            currentHandle = null;
        };

        // Attach mouse events to each handle
        for (const handle of handleElements) {
            this.addEventListener(handle, 'mousedown', ((e: MouseEvent) => {
                onPointerDown(e, handle);
            }) as EventListener);

            this.addEventListener(handle, 'touchstart', ((e: TouchEvent) => {
                if (e.touches.length !== 1) return;
                onPointerDown(e, handle);
            }) as EventListener, { passive: false });
        }

        // Global move/up handlers
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
     * Create a standard panel with header, collapse button, and body.
     * Returns { panel, header, body, collapseBtn } for further customization.
     */
    private createPanel(options: {
        className: string;
        title: string;
        initiallyCollapsed?: boolean;
        hidden?: boolean;
        parent?: HTMLElement;
        draggable?: boolean;
        resizable?: boolean;
        dock?: 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right' | 'top-center' | 'bottom-center';
    }): { panel: HTMLDivElement; header: HTMLDivElement; body: HTMLDivElement; collapseBtn: HTMLButtonElement } {
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
                // Store current height before collapsing
                if (panel.style.height) {
                    panel.dataset.resizedHeight = panel.style.height;
                }
                panel.style.height = '';
            } else {
                // Restore height when expanding
                if (panel.dataset.resizedHeight) {
                    panel.style.height = panel.dataset.resizedHeight;
                }
            }
            body.classList.toggle('collapsed');
            collapseBtn.textContent = body.classList.contains('collapsed') ? '+' : '−';
        });

        // Bring panel to front when clicked anywhere on it
        this.addEventListener(panel, 'mousedown', () => {
            this.bringPanelToFront(panel);
        });
        this.addEventListener(panel, 'touchstart', () => {
            this.bringPanelToFront(panel);
        }, { passive: true });

        if (options.draggable !== false) {
            this.makePanelDraggable(panel, header);
        }

        // Add resize handles if resizable (default to true)
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

    private setupCanvasNav() {
        const { panel, body } = this.createPanel({
            className: 'iiif-canvas-nav',
            title: 'Pages',
            initiallyCollapsed: this.panels.pages === 'hide' || this.panels.pages === 'show-closed',
            dock: 'bottom-left',
        });
        this.canvasNavContainer = panel;
        this.canvasNavList = body;
        this.canvasNavList.classList.add('iiif-canvas-nav-list');
    }

    private setupNavigationPanel() {
        const wrapper = document.createElement('div');
        wrapper.className = 'iiif-navigation-wrapper';

        const bar = document.createElement('div');
        bar.className = 'iiif-navigation-bar';

        const zoomIn = document.createElement('button');
        zoomIn.className = 'iiif-nav-zoom-btn';
        zoomIn.title = 'Zoom In';
        zoomIn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 13 13"><rect width="13" height="2.5" rx="1" y="5.25" fill="currentColor"/><rect width="13" height="2.5" rx="1" transform="translate(7.75 0) rotate(90)" fill="currentColor"/></svg>`;
        zoomIn.addEventListener('click', () => { this.camera.springZoomByFactor(1.5); this.markDirty(); });

        const zoomOut = document.createElement('button');
        zoomOut.className = 'iiif-nav-zoom-btn';
        zoomOut.title = 'Zoom Out';
        zoomOut.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="10" height="2" viewBox="0 0 13 3"><rect width="13" height="2.5" rx="1" fill="currentColor"/></svg>`;
        zoomOut.addEventListener('click', () => { this.camera.springZoomByFactor(1 / 1.5); this.markDirty(); });

        const resetBtn = document.createElement('button');
        resetBtn.className = 'iiif-nav-zoom-btn';
        resetBtn.title = 'Reset View';
        resetBtn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg>`;
        resetBtn.addEventListener('click', () => { this.fitToWorld(); });

        bar.appendChild(zoomIn);
        bar.appendChild(zoomOut);
        bar.appendChild(resetBtn);

        const dragHandle = document.createElement('div');
        dragHandle.className = 'iiif-navigation-drag-handle';

        wrapper.appendChild(bar);
        wrapper.appendChild(dragHandle);

        this.makePanelDraggable(wrapper, dragHandle);

        const dock = this.docks.get('bottom-center');
        if (dock) {
            dock.appendChild(wrapper);
        } else {
            this.container.appendChild(wrapper);
        }
    }

    private setupTOC() {
        const { panel, body } = this.createPanel({
            className: 'iiif-toc',
            title: 'Contents',
            initiallyCollapsed: this.panels.navigation === 'hide' || this.panels.navigation === 'show-closed',
            dock: 'top-right',
        });
        this.tocContainer = panel;
        this.tocList = body;
        this.tocList.classList.add('iiif-toc-list');
    }

    private setupManifestPanel() {
        const { body } = this.createPanel({
            className: 'iiif-manifest-panel',
            title: 'Manifest',
            initiallyCollapsed: this.panels.manifest === 'hide' || this.panels.manifest === 'show-closed',
            dock: 'top-right',
        });
        this.metadataPanelBody = body;
    }

    private setupAnnotationPanel() {
        const { panel, body } = this.createPanel({
            className: 'iiif-annotation-panel',
            title: 'Annotations',
            initiallyCollapsed: this.panels.annotations === 'hide' || this.panels.annotations === 'show-closed',
            dock: 'top-right',
        });
        this.annotationPanel = panel;
        this.annotationPanelBody = body;
    }

    private setupCVPanel() {
        const { panel, body } = this.createPanel({
            className: 'iiif-cv-panel',
            title: 'Gesture',
            initiallyCollapsed: this.panels.gesture === 'hide' || this.panels.gesture === 'show-closed',
            dock: 'top-left',
        });
        this.cvPanel = panel;
        this.cvPanelBody = body;

        // Hidden video element — data source only, not displayed.
        // We render to a canvas instead (see below) to bypass Chrome's video
        // compositor, which can be throttled on certain hardware/driver combos.
        this.cvVideo = document.createElement('video');
        this.cvVideo.setAttribute('playsinline', '');
        this.cvVideo.setAttribute('autoplay', '');
        this.cvVideo.muted = true;
        // Must stay in DOM and rendered (not display:none) or Chrome won't start the source.
        // Make it 1x1px offscreen so it doesn't affect layout.
        Object.assign(this.cvVideo.style, {
            position: 'absolute', width: '1px', height: '1px', opacity: '0', pointerEvents: 'none',
        });
        this.cvPanelBody.appendChild(this.cvVideo);

        // Display canvas — webcam feed drawn here via drawImage()
        this.cvDisplayCanvas = document.createElement('canvas');
        this.cvDisplayCanvas.className = 'iiif-cv-panel-video';
        this.cvPanelBody.appendChild(this.cvDisplayCanvas);

        this.cvStatusEl = document.createElement('span');
        this.cvStatusEl.className = 'iiif-cv-panel-status';
        this.cvStatusEl.textContent = 'Ready';
        this.cvPanelBody.appendChild(this.cvStatusEl);

        this.cvToggleBtn = document.createElement('button');
        this.cvToggleBtn.className = 'iiif-cv-panel-toggle';
        this.cvToggleBtn.textContent = 'Start';
        this.cvPanelBody.appendChild(this.cvToggleBtn);

        this.cvGestureBtn = document.createElement('button');
        this.cvGestureBtn.className = 'iiif-cv-panel-toggle';
        this.cvGestureBtn.textContent = 'Gestures: ON';
        this.cvGestureBtn.style.display = 'none';
        this.cvPanelBody.appendChild(this.cvGestureBtn);

        this.addEventListener(this.cvGestureBtn!, 'click', () => {
            if (!this.cvController) return;
            this.cvController.gesturesEnabled = !this.cvController.gesturesEnabled;
            this.cvGestureBtn!.textContent = this.cvController.gesturesEnabled ? 'Gestures: ON' : 'Gestures: OFF';
            this.cvGestureBtn!.classList.toggle('active', this.cvController.gesturesEnabled);
        });

        this.addEventListener(this.cvToggleBtn, 'click', async () => {
            if (this.cvController?.running) {
                this.cvController.stop();
                this.cvToggleBtn!.textContent = 'Start';
                this.cvToggleBtn!.classList.remove('active');
                this.cvGestureBtn!.style.display = 'none';
                return;
            }

            try {
                if (!this.cvController) {
                    const { CVController } = await import('./iiif-cv');
                    this.cvController = new CVController(this.cvVideo!, {
                        onStatusChange: (status: string) => {
                            if (this.cvStatusEl) this.cvStatusEl.textContent = status;
                        },
                        onPan: (dx: number, dy: number) => {
                            this.camera.springPan(dx / this.viewport.scale, dy / this.viewport.scale);
                            this.markDirty();
                        },
                        onZoom: (factor: number) => {
                            this.camera.springZoomByFactor(factor);
                            this.markDirty();
                        },
                    }, 800, this.cvDisplayCanvas);
                    await this.cvController.init();
                }

                await this.cvController.start();
                this.cvToggleBtn!.textContent = 'Stop';
                this.cvToggleBtn!.classList.add('active');
                this.cvGestureBtn!.style.display = '';
            } catch (err) {
                console.error('CV start failed:', err);
                if (this.cvStatusEl) this.cvStatusEl.textContent = 'Error';
            }
        });

    }

    private setupComparePanel() {
        const { panel, collapseBtn } = this.createPanel({
            className: 'iiif-compare-panel',
            title: 'Compare',
            initiallyCollapsed: true, // Always collapsed — expanding enters compare mode
            dock: 'bottom-right',
        });
        this.comparePanel = panel;

        // Override collapse button: use capture phase so this fires BEFORE
        // the default handler from createPanel (which is in bubble phase).
        collapseBtn.addEventListener('click', (e) => {
            e.stopImmediatePropagation();
            if (this.comparisonController) {
                // Toggle collapse state - don't exit compare mode
                const body = this.comparePanel!.querySelector('.iiif-panel-body');
                const isCollapsed = body?.classList.toggle('collapsed') ?? false;
                collapseBtn.textContent = isCollapsed ? '+' : '−';
            } else {
                // Enter compare mode
                this.enterCompareMode();
                collapseBtn.textContent = '−';
                this.comparePanel!.classList.add('active');
                const body = this.comparePanel!.querySelector('.iiif-panel-body');
                body?.classList.remove('collapsed');
            }
        }, { capture: true, signal: this.abortController.signal });
    }

    private setupDocks() {
        const dockPositions = ['top-right', 'top-left', 'bottom-right', 'bottom-left', 'top-center', 'bottom-center'] as const;
        for (const pos of dockPositions) {
            const dock = document.createElement('div');
            dock.className = `iiif-dock iiif-dock-${pos}`;
            this.docks.set(pos, dock);
            this.container.appendChild(dock);
        }
    }

    private setupSettingsPanel() {
        // Create fullscreen button
        this.fullscreenBtn = document.createElement('button');
        this.fullscreenBtn.className = 'iiif-fullscreen-btn';
        this.fullscreenBtn.title = 'Toggle Fullscreen';
        this.fullscreenBtn.innerHTML = `
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3m0 18h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3"/>
            </svg>
        `;
        this.addEventListener(this.fullscreenBtn, 'click', () => {
            if (!document.fullscreenElement) {
                this.container.requestFullscreen().catch(() => {});
                this.fullscreenBtn!.classList.add('active');
            } else {
                document.exitFullscreen();
                this.fullscreenBtn!.classList.remove('active');
            }
        });

        this.addEventListener(document, 'fullscreenchange', () => {
            if (!document.fullscreenElement) {
                this.fullscreenBtn!.classList.remove('active');
            }
        });

        // Create tools panel
        this.settingsPanel = document.createElement('div');
        this.settingsPanel.className = 'iiif-panel iiif-settings-panel';

        const header = document.createElement('div');
        header.className = 'iiif-panel-header iiif-settings-panel-header';

        const title = document.createElement('span');
        title.textContent = 'Settings';
        header.appendChild(title);

        const collapseBtn = document.createElement('button');
        collapseBtn.className = 'iiif-panel-collapse iiif-settings-panel-collapse';
        collapseBtn.textContent = '+';
        header.appendChild(collapseBtn);

        this.settingsPanel.appendChild(header);

        this.settingsPanelBody = document.createElement('div');
        this.settingsPanelBody.className = 'iiif-panel-body iiif-settings-panel-body collapsed';

        // Only show toggles for panels that are included
        const panelConfigs: { label: string; defaultVisible: boolean; containerClass: string }[] = [];
        if (this.panels.navigation !== undefined) panelConfigs.push({ label: 'Navigation', defaultVisible: this.panels.navigation !== 'hide', containerClass: 'hide-navigation' });
        if (this.panels.pages !== undefined) panelConfigs.push({ label: 'Pages', defaultVisible: this.panels.pages !== 'hide', containerClass: 'hide-pages' });
        if (this.panels.manifest !== undefined) panelConfigs.push({ label: 'Manifest', defaultVisible: this.panels.manifest !== 'hide', containerClass: 'hide-manifest' });
        if (this.panels.annotations !== undefined) panelConfigs.push({ label: 'Annotations', defaultVisible: this.panels.annotations !== 'hide', containerClass: 'hide-annotations' });
        if (this.panels.gesture !== undefined && !this.isMobileOrTablet()) panelConfigs.push({ label: 'Gesture', defaultVisible: this.panels.gesture !== 'hide', containerClass: 'hide-vision' });
        if (this.panels.compare !== undefined) panelConfigs.push({ label: 'Compare', defaultVisible: this.panels.compare !== 'hide', containerClass: 'hide-compare' });

        for (const config of panelConfigs) {
            const item = document.createElement('label');
            item.className = 'iiif-settings-panel-item';

            const checkbox = document.createElement('input');
            checkbox.type = 'checkbox';
            checkbox.className = 'iiif-settings-panel-checkbox';
            checkbox.checked = config.defaultVisible;

            const labelText = document.createElement('span');
            labelText.textContent = config.label;

            item.appendChild(checkbox);
            item.appendChild(labelText);
            this.settingsCheckboxes.set(config.containerClass, checkbox);

            // Apply initial state using container class
            if (!config.defaultVisible) {
                this.container.classList.add(config.containerClass);
            }

            this.addEventListener(checkbox, 'change', () => {
                // Toggle container class for global effect
                if (checkbox.checked) {
                    this.container.classList.remove(config.containerClass);
                } else {
                    this.container.classList.add(config.containerClass);
                }
            });

            this.settingsPanelBody.appendChild(item);
        }

        // --- Divider ---
        const divider = document.createElement('div');
        divider.className = 'iiif-settings-divider';
        this.settingsPanelBody.appendChild(divider);

        // --- Background color picker ---
        const colorItem = document.createElement('label');
        colorItem.className = 'iiif-settings-panel-item iiif-settings-color-item';

        const colorLabel = document.createElement('span');
        colorLabel.textContent = 'Background';

        this.colorInput = document.createElement('input');
        this.colorInput.type = 'color';
        this.colorInput.className = 'iiif-settings-color-input';
        this.colorInput.value = '#1a1a1a';
        const colorInput = this.colorInput;

        this.addEventListener(colorInput, 'input', () => {
            const hex = colorInput.value;
            const r = parseInt(hex.slice(1, 3), 16) / 255;
            const g = parseInt(hex.slice(3, 5), 16) / 255;
            const b = parseInt(hex.slice(5, 7), 16) / 255;
            if (this.renderer) {
                this.renderer.setClearColor(r, g, b);
            }
            // Also update compare instance viewers
            if (this.comparisonController) {
                this.comparisonController.setBackgroundColor(r, g, b);
            }
        });

        colorItem.appendChild(colorLabel);
        colorItem.appendChild(colorInput);
        this.settingsPanelBody.appendChild(colorItem);

        this.settingsPanel.appendChild(this.settingsPanelBody);

        // --- Icon button row at bottom of panel ---
        const btnRow = document.createElement('div');
        btnRow.className = 'iiif-settings-btn-row';

        // Light/dark theme toggle (lightbulb icon)
        const themeBtn = document.createElement('button');
        themeBtn.className = 'iiif-settings-icon-btn';
        themeBtn.title = 'Toggle Light Theme';
        themeBtn.innerHTML = `
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M9 18h6"/>
                <path d="M10 22h4"/>
                <path d="M12 2a7 7 0 0 0-4 12.7V17h8v-2.3A7 7 0 0 0 12 2z"/>
            </svg>
        `;
        this.addEventListener(themeBtn, 'click', () => {
            const isLight = this.container.classList.toggle('theme-light');
            themeBtn.classList.toggle('active', isLight);
        });

        // Fullscreen button
        this.fullscreenBtn.classList.add('iiif-settings-icon-btn');

        // Save layout button (download icon)
        const saveBtn = document.createElement('button');
        saveBtn.className = 'iiif-settings-icon-btn';
        saveBtn.title = 'Save Layout';
        saveBtn.innerHTML = `
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
                <polyline points="7 10 12 15 17 10"/>
                <line x1="12" y1="15" x2="12" y2="3"/>
            </svg>
        `;
        this.addEventListener(saveBtn, 'click', () => {
            const state = this.saveLayout();
            const json = JSON.stringify(state, null, 2);
            const blob = new Blob([json], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = 'layout.json';
            a.click();
            URL.revokeObjectURL(url);
        });

        // Load layout button (upload icon)
        const loadBtn = document.createElement('button');
        loadBtn.className = 'iiif-settings-icon-btn';
        loadBtn.title = 'Load Layout';
        loadBtn.innerHTML = `
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
                <polyline points="17 8 12 3 7 8"/>
                <line x1="12" y1="3" x2="12" y2="15"/>
            </svg>
        `;
        const fileInput = document.createElement('input');
        fileInput.type = 'file';
        fileInput.accept = '.json';
        fileInput.style.display = 'none';
        fileInput.addEventListener('change', () => {
            const file = fileInput.files?.[0];
            if (!file) return;
            const reader = new FileReader();
            reader.onload = () => {
                try {
                    const state = JSON.parse(reader.result as string) as LayoutState;
                    if (state.version !== 1) {
                        console.warn('Unknown layout version:', state.version);
                        return;
                    }
                    this.loadLayout(state);
                } catch (err) {
                    console.error('Failed to parse layout file:', err);
                }
                fileInput.value = '';
            };
            reader.readAsText(file);
        });
        this.addEventListener(loadBtn, 'click', () => {
            fileInput.click();
        });

        // Append: save + load on left, spacer, theme + fullscreen on right
        btnRow.appendChild(saveBtn);
        btnRow.appendChild(loadBtn);
        const btnSpacer = document.createElement('div');
        btnSpacer.style.flex = '1';
        btnRow.appendChild(btnSpacer);
        btnRow.appendChild(themeBtn);
        btnRow.appendChild(this.fullscreenBtn);

        this.settingsPanel.appendChild(btnRow);

        this.addEventListener(collapseBtn, 'click', () => {
            this.settingsPanelBody!.classList.toggle('collapsed');
            collapseBtn.textContent = this.settingsPanelBody!.classList.contains('collapsed') ? '+' : '−';
        });

        // Make settings panel draggable
        this.makePanelDraggable(this.settingsPanel, header);

        // Settings panel in top-right dock
        this.docks.get('top-right')!.appendChild(this.settingsPanel);
    }

    private updateComparePanel() {
        if (!this.comparePanel) return;

        // Always show the compare panel — even single images can compare via URL input
        this.comparePanel.style.display = 'flex';

        // Auto-enter compare mode for 'show' option
        if (this.panels.compare === 'show' && !this.comparisonController && this.currentLoadedUrl) {
            this.enterCompareMode();
            const body = this.comparePanel.querySelector('.iiif-panel-body');
            body?.classList.remove('collapsed');
            const collapseBtn = this.comparePanel.querySelector('.iiif-compare-panel-collapse');
            if (collapseBtn) collapseBtn.textContent = '−';
        }
    }

    private updateAnnotationPanel() {
        if (!this.annotationPanelBody || !this.annotationManager) return;

        this.annotationPanelBody.innerHTML = '';
        const pages = this.annotationManager.getAnnotationPages();
        const customGroups = this.annotationManager.getCustomAnnotationGroups();

        // Always show the panel; display "None" when empty
        if (this.annotationPanel) this.annotationPanel.style.display = 'flex';

        if (pages.length === 0 && customGroups.length === 0) {
            const none = document.createElement('div');
            none.className = 'iiif-panel-empty';
            none.textContent = 'None';
            this.annotationPanelBody.appendChild(none);
            return;
        }

        // --- IIIF annotation pages ---
        for (const page of pages) {
            const item = document.createElement('div');
            item.className = 'iiif-annotation-panel-item';

            const label = document.createElement('div');
            label.className = 'iiif-annotation-panel-item-label';

            // Color swatch from the page's dominant motivation
            const firstAnn = this.annotationManager!.getAllIIIFAnnotations()
                .find(a => page.overlayIds.some(id => id.includes(a.parsed.id || '')));
            const motivation = firstAnn?.parsed.motivation || '';
            const swatchColor = (MOTIVATION_COLORS[motivation] || DEFAULT_MOTIVATION_COLOR).border;

            const swatch = document.createElement('span');
            swatch.className = 'iiif-annotation-panel-swatch';
            swatch.style.display = 'inline-block';
            swatch.style.width = '8px';
            swatch.style.height = '8px';
            swatch.style.borderRadius = '50%';
            swatch.style.backgroundColor = swatchColor;
            swatch.style.marginRight = '6px';
            swatch.style.flexShrink = '0';
            label.appendChild(swatch);

            label.appendChild(document.createTextNode(page.label));
            item.appendChild(label);

            const eyeBtn = document.createElement('button');
            eyeBtn.className = 'iiif-eye-btn iiif-annotation-panel-eye';
            if (page.visible) eyeBtn.classList.add('active');
            eyeBtn.innerHTML = EYE_SVG;
            eyeBtn.title = 'Toggle visibility';
            eyeBtn.addEventListener('click', () => {
                const newVisible = !page.visible;
                this.annotationManager!.setPageVisible(page.pageId, newVisible);
                eyeBtn.classList.toggle('active', newVisible);
            });
            item.appendChild(eyeBtn);

            this.annotationPanelBody.appendChild(item);
        }

        // --- Custom annotation type groups (filtered by current canvas) ---
        // Build set of annotation IDs valid for the current canvas
        // When there's no manifest (single image), skip targetPage filtering
        const hasPages = this.manifest !== undefined;
        const idsForCurrentCanvas = new Set<string>();
        for (const spec of this.customAnnotationSpecs) {
            const id = spec.options?.id;
            if (!id) continue;
            if (hasPages && spec.targetPage !== undefined && spec.targetPage !== this.currentCanvasIndex) continue;
            idsForCurrentCanvas.add(id);
        }

        for (const group of customGroups) {
            const filteredIds = group.ids.filter(id => idsForCurrentCanvas.has(id));
            if (filteredIds.length === 0) continue;

            const item = document.createElement('div');
            item.className = 'iiif-annotation-panel-item';

            const label = document.createElement('div');
            label.className = 'iiif-annotation-panel-item-label';

            const swatch = document.createElement('span');
            swatch.className = 'iiif-annotation-panel-swatch';
            swatch.style.display = 'inline-block';
            swatch.style.width = '8px';
            swatch.style.height = '8px';
            swatch.style.borderRadius = '50%';
            swatch.style.backgroundColor = group.color;
            swatch.style.marginRight = '6px';
            swatch.style.flexShrink = '0';
            label.appendChild(swatch);

            label.appendChild(document.createTextNode(`${group.type} (${filteredIds.length})`));
            item.appendChild(label);

            const eyeBtn = document.createElement('button');
            eyeBtn.className = 'iiif-eye-btn iiif-annotation-panel-eye';
            if (group.visible) eyeBtn.classList.add('active');
            eyeBtn.innerHTML = EYE_SVG;
            eyeBtn.title = 'Toggle visibility';
            eyeBtn.addEventListener('click', () => {
                group.visible = !group.visible;
                if (group.visible) {
                    this.hiddenAnnotationTypes.delete(group.type);
                } else {
                    this.hiddenAnnotationTypes.add(group.type);
                }
                this.annotationManager!.setCustomTypeVisible(group.type, group.visible);
                eyeBtn.classList.toggle('active', group.visible);
            });
            item.appendChild(eyeBtn);

            this.annotationPanelBody.appendChild(item);
        }

        // Show "None" if no annotations are visible for this canvas
        if (this.annotationPanelBody.children.length === 0) {
            const none = document.createElement('div');
            none.className = 'iiif-panel-empty';
            none.textContent = 'None';
            this.annotationPanelBody.appendChild(none);
        }
    }

    private async initializeRenderer() {
        const rendererType = this.CONFIG.renderer;

        if (rendererType === 'webgl') {
            await this.initializeWebGL();
            return;
        }

        if (rendererType === 'webgpu') {
            await this.initializeWebGPU();
            return;
        }

        if (rendererType === 'canvas2d') {
            await this.initializeCanvas2D();
            return;
        }

        // Auto mode: try WebGPU → WebGL → Canvas 2D
        if (await this.isWebGPUAvailable()) {
            const success = await this.initializeWebGPU();
            if (!success) {
                console.warn('WebGPU initialization failed, falling back to WebGL');
                const webglSuccess = await this.initializeWebGL();
                if (!webglSuccess) {
                    console.warn('WebGL initialization failed, falling back to Canvas 2D');
                    await this.initializeCanvas2D();
                }
            }
        } else {
            console.log('WebGPU not available, trying WebGL');
            const webglSuccess = await this.initializeWebGL();
            if (!webglSuccess) {
                console.warn('WebGL initialization failed, falling back to Canvas 2D');
                await this.initializeCanvas2D();
            }
        }

        // If tiles were loaded before the renderer was ready, ensure they get uploaded and rendered
        if (this.renderer) {
            this.requestTilesForAllVisibleImages();
            this.markDirty();
        }
    }

    private async initializeWebGPU(): Promise<boolean> {
        try {
            console.log('Initializing WebGPU renderer');
            this.renderer = new WebGPURenderer(this.container);
            await this.renderer.initialize();
            this.updateRendererForAllTileManagers();
            return true;
        } catch (error) {
            console.error('Failed to initialize WebGPU renderer:', error);
            this.renderer = undefined;
            return false;
        }
    }

    private async initializeWebGL(): Promise<boolean> {
        try {
            console.log('Initializing WebGL renderer');
            this.renderer = new WebGLRenderer(this.container);
            await this.renderer.initialize();
            this.updateRendererForAllTileManagers();
            return true;
        } catch (error) {
            console.error('Failed to initialize WebGL renderer:', error);
            this.renderer = undefined;
            return false;
        }
    }

    private async initializeCanvas2D(): Promise<boolean> {
        try {
            console.log('Initializing Canvas 2D renderer');
            this.renderer = new Canvas2DRenderer(this.container);
            await this.renderer.initialize();
            this.updateRendererForAllTileManagers();
            return true;
        } catch (error) {
            console.error('Failed to initialize Canvas 2D renderer:', error);
            this.renderer = undefined;
            return false;
        }
    }

    private async isWebGPUAvailable(): Promise<boolean> {
        if (!navigator.gpu) return false;
        try {
            const adapter = await navigator.gpu.requestAdapter();
            return adapter !== null;
        } catch {
            return false;
        }
    }

    private updateRendererForAllTileManagers() {
        if (!this.renderer) return;
        for (const wi of this.world.worldImages.values()) {
            wi.tileManager.setRenderer(this.renderer);
        }
    }

    private setupResizeHandler() {
        const resizeObserver = new ResizeObserver(() => {
            this.handleResize();
        });
        resizeObserver.observe(this.container);
    }

    private handleResize() {
        this.cachedContainerRect = this.container.getBoundingClientRect();
        this.viewport.containerWidth = this.container.clientWidth;
        this.viewport.containerHeight = this.container.clientHeight;
        this.viewport.updateScale(); // Recalculate scale for new container dimensions

        this.renderer?.resize();
        this.requestTilesForAllVisibleImages();
        this.overlayManager?.updateAllOverlays();
        this.markDirty();
    }

    // ============================================================
    // EVENT HANDLING
    // ============================================================

    private addEventListener<K extends keyof HTMLElementEventMap>(
        element: Element | Document,
        type: K,
        handler: (event: HTMLElementEventMap[K]) => void,
        options?: { passive?: boolean }
    ) {
        if (!this.eventHandlers.has(element)) {
            this.eventHandlers.set(element, new Map());
        }
        const listener = handler as EventListener;
        this.eventHandlers.get(element)!.set(type, listener);
        element.addEventListener(type, listener, { signal: this.abortController.signal, ...options });
    }

    /**
     * Set up mouse/wheel event listeners for interactive navigation
     */
    listen() {
        this.addEventListener(this.container, 'mousedown', (event: MouseEvent) => {
            // Don't start pan when clicking toolbar/UI elements
            if ((event.target as HTMLElement).closest('.iiif-toolbar, .iiif-canvas-nav, .iiif-navigation-wrapper, .iiif-toc, .iiif-metadata-panel, .iiif-canvas-list, .iiif-compare-control-bar, .iiif-panel')) return;

            event.preventDefault();
            event.stopPropagation();

            const canvasX = event.clientX - this.cachedContainerRect.left;
            const canvasY = event.clientY - this.cachedContainerRect.top;

            this.camera.startInteractivePan(canvasX, canvasY);

            const onMouseMove = (moveEvent: MouseEvent) => {
                const newCanvasX = moveEvent.clientX - this.cachedContainerRect.left;
                const newCanvasY = moveEvent.clientY - this.cachedContainerRect.top;
                this.camera.updateInteractivePan(newCanvasX, newCanvasY);
            };

            const cleanup = () => {
                this.camera.endInteractivePan();
                document.removeEventListener('mousemove', onMouseMove);
                document.removeEventListener('mouseup', cleanup);
                document.removeEventListener('mouseleave', cleanup);
            };

            document.addEventListener('mousemove', onMouseMove, { signal: this.abortController.signal });
            document.addEventListener('mouseup', cleanup, { signal: this.abortController.signal });
            document.addEventListener('mouseleave', cleanup, { signal: this.abortController.signal });
        });

        this.addEventListener(this.container, 'wheel', (event: WheelEvent) => {
            const canvasX = event.clientX - this.cachedContainerRect.left;
            const canvasY = event.clientY - this.cachedContainerRect.top;
            this.camera.handleWheel(event, canvasX, canvasY);
        }, { passive: false });

        // Touch events for mobile/tablet
        this.addEventListener(this.container, 'touchstart', (event: TouchEvent) => {
            if ((event.target as HTMLElement).closest('.iiif-toolbar, .iiif-canvas-nav, .iiif-navigation-wrapper, .iiif-toc, .iiif-metadata-panel, .iiif-canvas-list, .iiif-compare-control-bar, .iiif-panel')) return;

            event.preventDefault();
            event.stopPropagation();

            const rect = this.cachedContainerRect;
            for (let i = 0; i < event.changedTouches.length; i++) {
                const t = event.changedTouches[i];
                this.touchState.activeTouches.set(t.identifier, {
                    x: t.clientX - rect.left,
                    y: t.clientY - rect.top
                });
            }

            const touchCount = this.touchState.activeTouches.size;

            if (touchCount === 1) {
                const touch = event.changedTouches[0];
                const canvasX = touch.clientX - rect.left;
                const canvasY = touch.clientY - rect.top;

                // Double-tap detection
                const now = performance.now();
                const dt = now - this.touchState.lastTapTime;
                const dx = canvasX - this.touchState.lastTapX;
                const dy = canvasY - this.touchState.lastTapY;

                if (dt < 300 && (dx * dx + dy * dy) < 900) {
                    this.camera.handleDoubleTap(canvasX, canvasY);
                    this.touchState.lastTapTime = 0;
                    return;
                }

                this.touchState.lastTapTime = now;
                this.touchState.lastTapX = canvasX;
                this.touchState.lastTapY = canvasY;

                this.camera.startInteractivePan(canvasX, canvasY);
            }

            if (touchCount === 2) {
                // End single-finger pan, start pinch
                this.camera.endInteractivePan();

                const touches = Array.from(this.touchState.activeTouches.values());
                const dx = touches[1].x - touches[0].x;
                const dy = touches[1].y - touches[0].y;
                this.touchState.lastPinchDistance = Math.sqrt(dx * dx + dy * dy);
                this.touchState.isPinching = true;
            }
        }, { passive: false });

        this.addEventListener(this.container, 'touchmove', (event: TouchEvent) => {
            if ((event.target as HTMLElement).closest('.iiif-toolbar, .iiif-canvas-nav, .iiif-navigation-wrapper, .iiif-toc, .iiif-metadata-panel, .iiif-canvas-list, .iiif-compare-control-bar, .iiif-panel')) return;
            event.preventDefault();

            const rect = this.cachedContainerRect;
            for (let i = 0; i < event.changedTouches.length; i++) {
                const t = event.changedTouches[i];
                this.touchState.activeTouches.set(t.identifier, {
                    x: t.clientX - rect.left,
                    y: t.clientY - rect.top
                });
            }

            const touchCount = this.touchState.activeTouches.size;

            if (touchCount === 1 && !this.touchState.isPinching) {
                const touch = event.changedTouches[0];
                const canvasX = touch.clientX - rect.left;
                const canvasY = touch.clientY - rect.top;
                this.camera.updateInteractivePan(canvasX, canvasY);
            }

            if (touchCount >= 2 && this.touchState.isPinching) {
                const touches = Array.from(this.touchState.activeTouches.values());
                const dx = touches[1].x - touches[0].x;
                const dy = touches[1].y - touches[0].y;
                const newDistance = Math.sqrt(dx * dx + dy * dy);
                const centerX = (touches[0].x + touches[1].x) / 2;
                const centerY = (touches[0].y + touches[1].y) / 2;

                if (this.touchState.lastPinchDistance > 0) {
                    const scaleFactor = newDistance / this.touchState.lastPinchDistance;
                    this.camera.handlePinchZoom(scaleFactor, centerX, centerY);
                }

                this.touchState.lastPinchDistance = newDistance;
            }
        }, { passive: false });

        const onTouchEnd = (event: TouchEvent) => {
            if ((event.target as HTMLElement).closest('.iiif-toolbar, .iiif-canvas-nav, .iiif-navigation-wrapper, .iiif-toc, .iiif-metadata-panel, .iiif-canvas-list, .iiif-compare-control-bar, .iiif-panel')) return;
            event.preventDefault();

            for (let i = 0; i < event.changedTouches.length; i++) {
                this.touchState.activeTouches.delete(event.changedTouches[i].identifier);
            }

            const remaining = this.touchState.activeTouches.size;

            if (remaining < 2 && this.touchState.isPinching) {
                this.touchState.isPinching = false;

                if (remaining === 1) {
                    // One finger still down: resume single-finger pan
                    const touch = Array.from(this.touchState.activeTouches.values())[0];
                    this.camera.startInteractivePan(touch.x, touch.y);
                } else {
                    this.camera.endInteractivePan();
                }
            }

            if (remaining === 0 && !this.touchState.isPinching) {
                this.camera.endInteractivePan();
            }
        };

        this.addEventListener(this.container, 'touchend', onTouchEnd, { passive: false });
        this.addEventListener(this.container, 'touchcancel', onTouchEnd, { passive: false });

        // Keyboard navigation — make container focusable
        if (!this.container.hasAttribute('tabindex')) {
            this.container.tabIndex = 0;
            this.container.style.outline = 'none';
        }

        // Focus container on click so keyboard events work
        this.addEventListener(this.container, 'click', (event: MouseEvent) => {
            const tag = (event.target as HTMLElement).tagName;
            if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
            this.container.focus();
        });

        // Track held arrow keys for diagonal movement
        const heldArrows = new Set<string>();

        this.addEventListener(this.container, 'keyup', (event: KeyboardEvent) => {
            heldArrows.delete(event.key);
        });

        this.addEventListener(this.container, 'blur', () => {
            heldArrows.clear();
        });

        this.addEventListener(this.container, 'keydown', (event: KeyboardEvent) => {
            // Don't intercept keys when typing in an input
            if ((event.target as HTMLElement).tagName === 'INPUT' || (event.target as HTMLElement).tagName === 'TEXTAREA') return;

            // Arrow keys: combine held keys for diagonal panning
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
                    const panAmount = 100 / this.viewport.scale;
                    // Normalize so diagonal has same per-event magnitude as cardinal
                    const len = Math.sqrt(dx * dx + dy * dy);
                    this.camera.springPan((dx / len) * panAmount, (dy / len) * panAmount);
                    this.markDirty();
                }
                return;
            }

            switch (event.key) {
                // Zoom with +/- or =/- (spring-based, same feel as mouse wheel)
                case '+':
                case '=':
                    event.preventDefault();
                    this.camera.springZoomByFactor(1.5);
                    this.markDirty();
                    break;
                case '-':
                    event.preventDefault();
                    this.camera.springZoomByFactor(1 / 1.5);
                    this.markDirty();
                    break;

                // Fit to view
                case '0':
                    event.preventDefault();
                    this.fitToWorld();
                    break;

                // Canvas navigation with Page Up/Down or [ ]
                case 'PageUp':
                case '[':
                    event.preventDefault();
                    this.previousCanvas();
                    break;
                case 'PageDown':
                case ']':
                    event.preventDefault();
                    this.nextCanvas();
                    break;

                // Home/End for first/last canvas
                case 'Home':
                    event.preventDefault();
                    if (this.manifest && this.canvasCount > 0) {
                        this.loadCanvas(0);
                    }
                    break;
                case 'End':
                    event.preventDefault();
                    if (this.manifest && this.canvasCount > 0) {
                        this.loadCanvas(this.canvasCount - 1);
                    }
                    break;

                // Fullscreen toggle
                case 'f':
                    if (!event.ctrlKey && !event.metaKey) {
                        event.preventDefault();
                        if (!document.fullscreenElement) {
                            this.container.requestFullscreen().catch(() => {});
                            this.fullscreenBtn?.classList.add('active');
                        } else {
                            document.exitFullscreen();
                            this.fullscreenBtn?.classList.remove('active');
                        }
                    }
                    break;
            }
        });
    }

    // ============================================================
    // IMAGE MANAGEMENT
    // ============================================================

    /**
     * Add an image to the viewer
     */
    async addImage(
        id: string,
        url: string,
        focus: boolean = false,
        placement?: WorldPlacement
    ): Promise<void> {
        const iiifImage = new IIIFImage(id, url);
        await iiifImage.loadManifest(url);

        const worldPlacement: WorldPlacement = placement ?? {
            worldX: 0,
            worldY: 0,
            worldWidth: iiifImage.width,
            worldHeight: iiifImage.height
        };

        const tileManager = new TileManager(
            id,
            iiifImage,
            this.CONFIG.maxCacheSize,
            this.renderer,
            0.65,  // distanceDetail
            () => this.markDirty()  // onTileLoaded callback
        );

        const worldImage = new WorldImage(iiifImage, tileManager, worldPlacement);
        tileManager.setWorldImage(worldImage);
        this.world.addImage(id, worldImage);

        if (focus) {
            this.viewport.fitToWorld(this.world.worldWidth, this.world.worldHeight);
        }

        tileManager.requestTilesForViewport(this.viewport);
        await tileManager.loadThumbnail();
        this.markDirty();
    }

    /**
     * Clear all images and free GPU resources
     */
    clearWorld() {
        // Collect IDs first to avoid modifying Map during iteration
        const imageIds = Array.from(this.world.worldImages.keys());
        for (const id of imageIds) {
            const wi = this.world.worldImages.get(id);
            if (wi) {
                for (const tileId of wi.tileManager.getLoadedTileIds()) {
                    this.renderer?.destroyTexture(tileId);
                }
            }
            this.world.removeImage(id);
        }
        this.annotationManager?.clearIIIFAnnotations();
        this.markDirty();
    }

    // ============================================================
    // IIIF MANIFEST LOADING
    // ============================================================

    /**
     * Load any IIIF URL (image service, bare URL, or manifest)
     */
    async loadUrl(url: string, focus: boolean = true): Promise<void> {
        this.currentLoadedUrl = url;
        const result = await parseIIIFUrl(url);

        if (result.type === 'image-service-2' || result.type === 'image-service-3') {
            this.clearWorld();
            this.manifest = undefined;
            this.currentCanvasIndex = -1;

            const svc = result as ParsedImageService;
            const infoUrl = svc.id.replace(/\/$/, '') + '/info.json';
            await this.addImage('image-0', infoUrl, focus);
            this.canvasIdToIndex.clear();
            this.updateCanvasNav();
            this.updateTOC();
            this.updateManifestPanel();
            this.updateComparePanel();
            this.updateAnnotationPanel();
        } else {
            this.clearWorld();
            this.manifest = result as ParsedManifest;

            // Build canvas ID -> index lookup for range navigation
            this.canvasIdToIndex.clear();
            for (let i = 0; i < this.manifest.canvases.length; i++) {
                this.canvasIdToIndex.set(this.manifest.canvases[i].id, i);
            }

            this.updateCanvasNav();
            this.updateTOC();
            this.updateManifestPanel();
            this.updateComparePanel();
            await this.loadCanvas(0, focus);
        }
    }

    /**
     * Load a specific canvas from the current manifest
     */
    async loadCanvas(index: number, focus: boolean = true): Promise<void> {
        if (!this.manifest) {
            throw new Error('No manifest loaded. Call loadUrl() with a manifest URL first.');
        }
        if (index < 0 || index >= this.manifest.canvases.length) {
            throw new Error(`Canvas index ${index} out of range (0-${this.manifest.canvases.length - 1})`);
        }

        this.clearWorld();
        this.currentCanvasIndex = index;
        this.updateCanvasNavActiveState();

        const canvas = this.manifest.canvases[index];
        let loadedCount = 0;

        for (let i = 0; i < canvas.images.length; i++) {
            const img = canvas.images[i];
            const infoUrl = img.imageServiceUrl.replace(/\/$/, '') + '/info.json';

            const placement: WorldPlacement | undefined = img.target
                ? {
                    worldX: img.target.x,
                    worldY: img.target.y,
                    worldWidth: img.target.w,
                    worldHeight: img.target.h
                }
                : undefined;

            try {
                const shouldFocus = focus && i === canvas.images.length - 1;
                await this.addImage(`canvas-${index}-img-${i}`, infoUrl, shouldFocus, placement);
                loadedCount++;
            } catch (err) {
                console.warn(`Failed to load image ${i} for canvas ${index}:`, err);
            }
        }

        if (focus && loadedCount > 0 && this.world.worldImages.size > 0) {
            this.viewport.fitToWorld(this.world.worldWidth, this.world.worldHeight);
        }

        await this.loadIIIFAnnotationsForCanvas(canvas);
        this.updateCustomAnnotationVisibility();
    }

    /** Show/hide custom annotations based on targetPage matching current canvas */
    private updateCustomAnnotationVisibility(): void {
        if (!this.overlayManager) return;
        const hasPages = this.manifest !== undefined;
        for (const spec of this.customAnnotationSpecs) {
            const id = spec.options?.id;
            if (!id) continue;
            const overlay = this.overlayManager.getOverlay(id);
            if (!overlay) continue;

            // Hidden if on wrong page OR user toggled the type off
            // Skip page check when there's no manifest (single image)
            const wrongPage = hasPages && spec.targetPage !== undefined && spec.targetPage !== this.currentCanvasIndex;
            const typeHidden = this.hiddenAnnotationTypes.has(spec.options?.type || 'Custom');
            overlay.hidden = wrongPage || typeHidden;
            this.overlayManager.updateOverlay(id);
        }
    }

    private async loadIIIFAnnotationsForCanvas(canvas: CanvasInfo): Promise<void> {
        if (!this.annotationManager) return;

        this.annotationManager.clearIIIFAnnotations();

        const allPages = [...canvas.annotations];

        for (const listUrl of canvas.annotationListUrls) {
            try {
                const page = await fetchAnnotationList(listUrl);
                if (page && page.annotations && page.annotations.length > 0) {
                    allPages.push(page);
                }
            } catch {
                console.warn(`Failed to fetch annotation list: ${listUrl}`);
            }
        }

        if (allPages.length > 0) {
            this.annotationManager.loadIIIFAnnotations(allPages, canvas.width, canvas.height);
        }

        this.updateAnnotationPanel();
    }

    /**
     * Navigate to next canvas
     */
    async nextCanvas(): Promise<void> {
        if (!this.manifest || this.currentCanvasIndex >= this.manifest.canvases.length - 1) {
            return;
        }
        await this.loadCanvas(this.currentCanvasIndex + 1);
    }

    /**
     * Navigate to previous canvas
     */
    async previousCanvas(): Promise<void> {
        if (!this.manifest || this.currentCanvasIndex <= 0) {
            return;
        }
        await this.loadCanvas(this.currentCanvasIndex - 1);
    }

    /** Number of canvases in the loaded manifest */
    get canvasCount(): number {
        return this.manifest?.canvases.length ?? 0;
    }

    /** Current canvas index */
    get currentCanvas(): number {
        return this.currentCanvasIndex;
    }

    // ============================================================
    // CANVAS NAVIGATION UI
    // ============================================================

    private updateCanvasNav() {
        if (!this.canvasNavContainer || !this.canvasNavList) return;

        if (!this.manifest || this.manifest.canvases.length <= 1) {
            this.canvasNavContainer.style.display = 'none';
            return;
        }

        this.canvasNavContainer.style.display = 'flex';
        this.canvasNavList.innerHTML = '';

        for (let i = 0; i < this.manifest.canvases.length; i++) {
            const canvas = this.manifest.canvases[i];
            const item = this.createCanvasNavItem(canvas, i);
            this.canvasNavList.appendChild(item);
        }
    }

    private createCanvasNavItem(canvas: ParsedCanvas, index: number): HTMLElement {
        const item = document.createElement('div');
        item.className = 'iiif-canvas-nav-item';
        if (index === this.currentCanvasIndex) {
            item.classList.add('active');
        }

        if (canvas.images.length > 0) {
            const serviceUrl = canvas.images[0].imageServiceUrl.replace(/\/$/, '');
            const thumbUrl = `${serviceUrl}/full/!120,120/0/default.jpg`;

            const img = document.createElement('img');
            img.className = 'iiif-canvas-nav-item-img';
            img.src = thumbUrl;
            img.alt = canvas.label || `Canvas ${index + 1}`;
            img.loading = 'lazy';
            img.onerror = () => {
                img.style.display = 'none';
            };
            item.appendChild(img);
        }

        const labelEl = document.createElement('div');
        labelEl.className = 'iiif-canvas-nav-item-label';
        labelEl.textContent = canvas.label || `${index + 1}`;
        item.appendChild(labelEl);

        item.addEventListener('click', () => {
            this.loadCanvas(index);
        });

        return item;
    }

    private updateCanvasNavActiveState() {
        if (!this.canvasNavList) return;
        const items = this.canvasNavList.querySelectorAll('.iiif-canvas-nav-item');
        items.forEach((item, i) => {
            item.classList.toggle('active', i === this.currentCanvasIndex);
        });
    }

    // ============================================================
    // TABLE OF CONTENTS
    // ============================================================

    private updateTOC() {
        if (!this.tocContainer || !this.tocList) return;

        const ranges = this.manifest?.ranges;
        if (!ranges || ranges.length === 0) {
            this.tocContainer.style.display = 'none';
            return;
        }

        this.tocContainer.style.display = 'flex';
        this.tocList.innerHTML = '';

        for (const range of ranges) {
            this.tocList.appendChild(this.createTOCNode(range, 0));
        }
    }

    private createTOCNode(range: ParsedRange, depth: number): HTMLElement {
        const node = document.createElement('div');
        node.className = 'iiif-toc-node';

        const row = document.createElement('div');
        row.className = 'iiif-toc-row';
        row.style.paddingLeft = `${8 + depth * 14}px`;

        if (range.children.length > 0) {
            const toggle = document.createElement('span');
            toggle.className = 'iiif-toc-toggle';
            toggle.textContent = '\u25BC';
            toggle.addEventListener('click', (e) => {
                e.stopPropagation();
                const childContainer = node.querySelector(':scope > .iiif-toc-children') as HTMLElement;
                if (childContainer) {
                    const isCollapsed = childContainer.style.display === 'none';
                    childContainer.style.display = isCollapsed ? 'block' : 'none';
                    toggle.textContent = isCollapsed ? '\u25BC' : '\u25B6';
                }
            });
            row.appendChild(toggle);
        } else {
            const spacer = document.createElement('span');
            spacer.className = 'iiif-toc-toggle-spacer';
            row.appendChild(spacer);
        }

        const labelEl = document.createElement('span');
        labelEl.className = 'iiif-toc-label';
        labelEl.textContent = range.label || 'Untitled';
        row.appendChild(labelEl);

        // Click navigates to the first canvas in this range (or first child's canvas)
        const firstCanvasIndex = this.findFirstCanvasIndex(range);
        if (firstCanvasIndex !== undefined) {
            row.classList.add('iiif-toc-clickable');
            row.addEventListener('click', () => {
                this.loadCanvas(firstCanvasIndex);
            });
        }

        node.appendChild(row);

        if (range.children.length > 0) {
            const childContainer = document.createElement('div');
            childContainer.className = 'iiif-toc-children';
            for (const child of range.children) {
                childContainer.appendChild(this.createTOCNode(child, depth + 1));
            }
            node.appendChild(childContainer);
        }

        return node;
    }

    private findFirstCanvasIndex(range: ParsedRange): number | undefined {
        // Check direct canvas refs first
        for (const canvasId of range.canvasIds) {
            const index = this.canvasIdToIndex.get(canvasId);
            if (index !== undefined) return index;
        }
        // Recurse into children
        for (const child of range.children) {
            const index = this.findFirstCanvasIndex(child);
            if (index !== undefined) return index;
        }
        return undefined;
    }

    // ============================================================
    // MANIFEST PANEL
    // ============================================================

    private updateManifestPanel() {
        if (!this.metadataPanelBody) return;
        this.metadataPanelBody.innerHTML = '';

        const meta = this.manifest?.metadata;
        if (!meta) {
            const none = document.createElement('div');
            none.className = 'iiif-panel-empty';
            none.textContent = 'None';
            this.metadataPanelBody.appendChild(none);
            return;
        }

        if (this.manifest?.label) {
            this.appendManifestField('Title', this.manifest.label);
        }

        if (meta.description) {
            this.appendManifestField('Description', meta.description);
        }

        if (meta.attribution) {
            this.appendManifestField(meta.attributionLabel || 'Attribution', meta.attribution);
        }

        if (meta.rights) {
            const link = document.createElement('a');
            link.href = meta.rights;
            link.target = '_blank';
            link.rel = 'noopener';
            link.textContent = meta.rights;
            this.appendManifestFieldElement('Rights', link);
        }

        if (meta.logo) {
            const img = document.createElement('img');
            img.src = meta.logo;
            img.className = 'iiif-manifest-panel-logo';
            img.alt = 'Logo';
            this.appendManifestFieldElement('Logo', img);
        }

        if (meta.metadata.length > 0) {
            const separator = document.createElement('div');
            separator.className = 'iiif-manifest-panel-separator';
            this.metadataPanelBody.appendChild(separator);

            for (const item of meta.metadata) {
                this.appendManifestField(item.label, item.value);
            }
        }
    }

    private appendManifestField(label: string, value: string) {
        const row = document.createElement('div');
        row.className = 'iiif-manifest-panel-row';

        const labelEl = document.createElement('div');
        labelEl.className = 'iiif-manifest-panel-label';
        labelEl.textContent = label;

        const valueEl = document.createElement('div');
        valueEl.className = 'iiif-manifest-panel-value';
        valueEl.textContent = value;

        row.appendChild(labelEl);
        row.appendChild(valueEl);
        this.metadataPanelBody!.appendChild(row);
    }

    private appendManifestFieldElement(label: string, element: HTMLElement) {
        const row = document.createElement('div');
        row.className = 'iiif-manifest-panel-row';

        const labelEl = document.createElement('div');
        labelEl.className = 'iiif-manifest-panel-label';
        labelEl.textContent = label;

        const valueEl = document.createElement('div');
        valueEl.className = 'iiif-manifest-panel-value';
        valueEl.appendChild(element);

        row.appendChild(labelEl);
        row.appendChild(valueEl);
        this.metadataPanelBody!.appendChild(row);
    }

    // ============================================================
    // NAVIGATION API
    // ============================================================

    /**
     * Zoom to a specific scale value
     */
    zoom(targetScale: number, duration = 500) {
        this.camera.zoom(targetScale, duration);
        this.markDirty();
    }

    /**
     * Zoom by a factor
     */
    zoomByFactor(factor: number, duration = 500) {
        this.camera.zoomByFactor(factor, duration);
        this.markDirty();
    }

    /**
     * Pan by delta amounts in world coordinates
     */
    pan(deltaX: number, deltaY: number, duration = 500) {
        this.camera.pan(deltaX, deltaY, duration);
        this.markDirty();
    }

    /**
     * Navigate to a specific position
     */
    to(worldX: number, worldY: number, cameraZ: number, duration = 500) {
        this.camera.to(worldX, worldY, cameraZ, duration);
        this.markDirty();
    }

    /**
     * Fit the view to show the entire world
     */
    fitToWorld() {
        const ww = this.world.worldWidth;
        const wh = this.world.worldHeight;
        const targetScale = Math.min(
            this.viewport.containerWidth / ww,
            this.viewport.containerHeight / wh,
        );
        const targetZ = this.viewport.containerHeight / (2 * targetScale * this.viewport.getTanHalfFov());
        this.camera.to(ww / 2, wh / 2, targetZ);
        this.markDirty();
    }

    // ============================================================
    // LAYOUT SAVE / RESTORE
    // ============================================================

    saveLayout(): LayoutState {
        const containerRect = this.container.getBoundingClientRect();

        // Build reverse map: className → panelKey
        const classToKey: Record<string, string> = {};
        for (const [key, cls] of Object.entries(PANEL_CLASS_MAP)) {
            classToKey[cls] = key;
        }

        const panels: LayoutState['panels'] = {};
        const panelEls = this.container.querySelectorAll<HTMLElement>('.iiif-panel');

        for (const el of panelEls) {
            // Identify panel by its className
            let panelKey: string | undefined;
            for (const [cls, key] of Object.entries(classToKey)) {
                if (el.classList.contains(cls)) {
                    panelKey = key;
                    break;
                }
            }
            if (!panelKey) continue;

            const body = el.querySelector('.iiif-panel-body');
            const collapsed = body ? body.classList.contains('collapsed') : false;

            // Check visibility via container hide classes
            const hideClass = PANEL_HIDE_CLASS[panelKey];
            const visible = hideClass ? !this.container.classList.contains(hideClass) : true;

            // Determine dock position
            const parent = el.parentElement;
            let dockPosition: string | null = null;
            let dockIndex = 0;

            if (parent?.classList.contains('iiif-dock')) {
                for (const [pos, dock] of this.docks) {
                    if (dock === parent) {
                        dockPosition = pos;
                        break;
                    }
                }
                // Index among sibling panels in this dock
                const siblings = Array.from(parent.querySelectorAll<HTMLElement>('.iiif-panel'));
                dockIndex = siblings.indexOf(el);
            }

            const entry: LayoutState['panels'][string] = {
                visible,
                collapsed,
                dockPosition,
                dockIndex,
            };

            // If floating (not docked), store position as % of container
            if (!dockPosition && el.style.position === 'absolute') {
                const left = parseFloat(el.style.left) || 0;
                const top = parseFloat(el.style.top) || 0;
                entry.floatPosition = {
                    left: (left / containerRect.width) * 100,
                    top: (top / containerRect.height) * 100,
                };
            }

            // Save custom dimensions if panel has been resized
            if (el.classList.contains('resized')) {
                const rect = el.getBoundingClientRect();
                entry.dimensions = {
                    width: rect.width,
                    height: rect.height,
                };
            }

            panels[panelKey] = entry;
        }

        // Annotation page visibility
        const annotations: LayoutState['annotations'] = [];
        if (this.annotationManager) {
            for (const page of this.annotationManager.getAnnotationPages()) {
                annotations.push({ pageId: page.pageId, visible: page.visible });
            }
        }

        return {
            version: 1,
            manifestUrl: this.currentLoadedUrl ?? '',
            canvasIndex: this.currentCanvasIndex,
            viewport: {
                centerX: this.viewport.centerX,
                centerY: this.viewport.centerY,
                cameraZ: this.viewport.cameraZ,
            },
            panels,
            settings: {
                backgroundColor: this.colorInput?.value ?? '#1a1a1a',
                theme: this.container.classList.contains('theme-light') ? 'light' : 'dark',
            },
            annotations,
        };
    }

    async loadLayout(state: LayoutState): Promise<void> {
        // Load manifest + canvas if needed
        if (state.manifestUrl && state.manifestUrl !== this.currentLoadedUrl) {
            await this.loadUrl(state.manifestUrl, false);
            if (state.canvasIndex >= 0) {
                await this.loadCanvas(state.canvasIndex, false);
            }
        } else if (state.canvasIndex >= 0 && state.canvasIndex !== this.currentCanvasIndex) {
            await this.loadCanvas(state.canvasIndex, false);
        }

        // Restore viewport (instant, no animation)
        this.camera.to(
            state.viewport.centerX,
            state.viewport.centerY,
            state.viewport.cameraZ,
            0,
        );

        // Restore panel states
        const containerRect = this.container.getBoundingClientRect();

        for (const [panelKey, panelState] of Object.entries(state.panels)) {
            const cls = PANEL_CLASS_MAP[panelKey];
            if (!cls) continue;
            const el = this.container.querySelector<HTMLElement>(`.${cls}`);
            if (!el) continue;

            // Restore collapsed state
            const body = el.querySelector('.iiif-panel-body');
            const collapseBtn = el.querySelector('.iiif-panel-collapse');
            if (body) {
                body.classList.toggle('collapsed', panelState.collapsed);
                if (collapseBtn) collapseBtn.textContent = panelState.collapsed ? '+' : '−';
            }

            // Restore dock/float position
            if (panelState.dockPosition) {
                const dock = this.docks.get(panelState.dockPosition);
                if (dock) {
                    // Clear floating styles
                    el.style.position = '';
                    el.style.left = '';
                    el.style.top = '';
                    el.style.right = '';
                    el.style.bottom = '';
                    el.style.transform = '';

                    // Insert at correct index
                    const siblings = Array.from(dock.querySelectorAll<HTMLElement>('.iiif-panel'));
                    if (panelState.dockIndex < siblings.length) {
                        dock.insertBefore(el, siblings[panelState.dockIndex]);
                    } else {
                        dock.appendChild(el);
                    }
                }
            } else if (panelState.floatPosition) {
                // Float at saved position
                el.style.position = 'absolute';
                el.style.left = `${(panelState.floatPosition.left / 100) * containerRect.width}px`;
                el.style.top = `${(panelState.floatPosition.top / 100) * containerRect.height}px`;
                el.style.right = 'auto';
                el.style.bottom = 'auto';
                el.style.transform = 'none';
                if (el.parentElement !== this.container) {
                    this.container.appendChild(el);
                }
            }

            // Restore visibility via container class + checkbox
            const hideClass = PANEL_HIDE_CLASS[panelKey];
            if (hideClass) {
                this.container.classList.toggle(hideClass, !panelState.visible);
                const checkbox = this.settingsCheckboxes.get(hideClass);
                if (checkbox) checkbox.checked = panelState.visible;
            }

            // Restore custom dimensions if panel was resized
            if (panelState.dimensions) {
                el.classList.add('resized');
                el.style.width = `${panelState.dimensions.width}px`;
                el.style.height = `${panelState.dimensions.height}px`;
            } else {
                // Clear any explicit dimensions
                el.classList.remove('resized');
                el.style.width = '';
                el.style.height = '';
            }
        }

        // Restore background color
        if (state.settings.backgroundColor && this.colorInput) {
            this.colorInput.value = state.settings.backgroundColor;
            const hex = state.settings.backgroundColor;
            const r = parseInt(hex.slice(1, 3), 16) / 255;
            const g = parseInt(hex.slice(3, 5), 16) / 255;
            const b = parseInt(hex.slice(5, 7), 16) / 255;
            this.renderer?.setClearColor(r, g, b);
        }

        // Restore theme
        const wantLight = state.settings.theme === 'light';
        this.container.classList.toggle('theme-light', wantLight);

        // Restore annotation visibility
        if (this.annotationManager && state.annotations.length > 0) {
            for (const ann of state.annotations) {
                this.annotationManager.setPageVisible(ann.pageId, ann.visible);
            }
            this.updateAnnotationPanel();
        }

        this.markDirty();
    }

    // ============================================================
    // OVERLAYS & ANNOTATIONS
    // ============================================================

    /**
     * Add an overlay element to the viewer
     */
    addOverlay(overlay: {
        id: string;
        element: HTMLElement;
        worldX: number;
        worldY: number;
        worldWidth: number;
        worldHeight: number;
        scaleWithZoom?: boolean;
    }): void {
        if (!this.overlayManager) {
            console.error('Overlay manager not initialized. Enable overlays in viewer options.');
            return;
        }
        this.overlayManager.addOverlay(overlay);
    }

    /**
     * Add a custom annotation to the viewer.
     * Returns the annotation ID (auto-generated if not provided).
     *
     * @example
     * // Simple element annotation
     * const id = viewer.addAnnotation(100, 200, 300, 150, myElement);
     *
     * // With options
     * const id = viewer.addAnnotation(100, 200, 300, 150, myElement, {
     *     id: 'my-annotation',
     *     style: { border: '3px solid red' },
     *     scaleWithZoom: false,
     * });
     */
    addAnnotation(
        x: number,
        y: number,
        width: number,
        height: number,
        element?: HTMLElement | string,
        options?: {
            id?: string;
            type?: string;
            color?: string;
            style?: Record<string, string | undefined>;
            scaleWithZoom?: boolean;
            activeClass?: string;
            inactiveClass?: string;
            /** When set, only replay on compare entries matching this manifest URL */
            targetUrl?: string;
            /** When set, only replay on compare entries matching this canvas index */
            targetPage?: number;
            /** Popup content shown when the annotation is clicked */
            popup?: string | HTMLElement;
            /** Popup position offset in screen pixels from the annotation's top-left corner */
            popupPosition?: { x: number; y: number };
        }
    ): string | undefined {
        if (!this.annotationManager) {
            console.error('Annotation manager not initialized.');
            return undefined;
        }

        const id = options?.id ?? `custom-ann-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

        const content: { element?: HTMLElement; text?: string } = {};
        if (typeof element === 'string') {
            content.text = element;
        } else if (element) {
            content.element = element;
        }

        // Store spec for replay (e.g. in compare mode child viewers)
        // Only store text-based content — DOM elements can't be cloned across viewers
        this.customAnnotationSpecs.push({
            x, y, width, height,
            text: typeof element === 'string' ? element : undefined,
            popupText: typeof options?.popup === 'string' ? options.popup : undefined,
            targetUrl: options?.targetUrl,
            targetPage: options?.targetPage,
            options: { ...options, id },
        });

        this.annotationManager.addAnnotation({
            id,
            type: options?.type,
            color: options?.color,
            fixed: true,
            x,
            y,
            width,
            height,
            style: options?.style,
            content: Object.keys(content).length > 0 ? content : undefined,
            scaleWithZoom: options?.scaleWithZoom,
            activeClass: options?.activeClass,
            inactiveClass: options?.inactiveClass,
            popup: options?.popup,
            popupPosition: options?.popupPosition,
        });

        this.updateAnnotationPanel();

        return id;
    }

    /**
     * Remove a custom annotation by ID.
     */
    removeAnnotation(id: string): void {
        if (!this.annotationManager) return;
        this.annotationManager.removeAnnotation(id);
    }

    /**
     * Clear all custom annotations (does not affect IIIF annotations).
     */
    clearAnnotations(): void {
        if (!this.annotationManager) return;
        this.annotationManager.clearCustomAnnotations();
    }

    /**
     * Get stored custom annotation specs (for replaying on child viewers).
     */
    getCustomAnnotationSpecs() {
        return this.customAnnotationSpecs;
    }

    /**
     * Replay custom annotation specs (e.g. from a parent viewer).
     */
    replayAnnotationSpecs(specs: typeof this.customAnnotationSpecs): void {
        for (const spec of specs) {
            const opts = spec.popupText
                ? { ...spec.options, popup: spec.popupText }
                : spec.options;
            this.addAnnotation(spec.x, spec.y, spec.width, spec.height, spec.text, opts);
        }
    }

    // ============================================================
    // RENDERING
    // ============================================================

    markDirty() {
        this.needsRender = true;
    }

    private hasViewportChanged(): boolean {
        // Check for uninitialized state (NaN values)
        if (isNaN(this.lastViewportState.centerX)) {
            return true;
        }

        return (
            this.viewport.centerX !== this.lastViewportState.centerX ||
            this.viewport.centerY !== this.lastViewportState.centerY ||
            this.viewport.scale !== this.lastViewportState.scale
        );
    }

    private updateViewportState() {
        this.lastViewportState.centerX = this.viewport.centerX;
        this.lastViewportState.centerY = this.viewport.centerY;
        this.lastViewportState.scale = this.viewport.scale;
    }

    private requestTilesForAllVisibleImages() {
        const bounds = this.viewport.getWorldBounds();
        const visibleImages = this.world.getVisibleImages(
            bounds.left,
            bounds.top,
            bounds.right,
            bounds.bottom
        );
        for (const wi of visibleImages) {
            wi.tileManager.requestTilesForViewport(this.viewport);
        }
    }

    /**
     * Render a single frame
     */
    render() {
        // Update animations (may modify viewport)
        const animationResult = this.camera.updateInteractiveAnimation();
        if (animationResult.needsUpdate) {
            this.markDirty();
        }

        // Check if we need to render
        const viewportChanged = this.hasViewportChanged();
        if (!this.needsRender && !viewportChanged) {
            return;
        }

        if (!this.renderer) {
            return;
        }

        const bounds = this.viewport.getWorldBounds();
        const visibleImages = this.world.getVisibleImages(
            bounds.left,
            bounds.top,
            bounds.right,
            bounds.bottom
        );

        if (visibleImages.length === 0) {
            return;
        }

        // Collect tiles from all visible images (including thumbnails)
        const allTiles: TileRenderData[] = [];

        for (const worldImage of visibleImages) {
            const tiles = worldImage.tileManager.getLoadedTilesForRender(this.viewport);
            allTiles.push(...tiles);

            // Only include thumbnail when no regular tiles cover this image —
            // prevents blurry flash when transitioning between zoom levels
            if (tiles.length === 0) {
                const thumbnail = worldImage.tileManager.getThumbnail();
                if (thumbnail) {
                    allTiles.push(thumbnail);
                }
            }
        }

        // Single sort by z-depth for proper layering
        allTiles.sort((a, b) => a.z - b.z);

        // Render (tiles are pre-sorted, no thumbnail param needed)
        this.renderer.render(this.viewport, allTiles);

        // Update overlays only if viewport changed
        if (viewportChanged) {
            this.overlayManager?.updateAllOverlays();
            this.updateViewportState();
            if (this.onViewportChange) {
                this.onViewportChange(this.viewport.centerX, this.viewport.centerY, this.viewport.cameraZ);
            }
        }

        this.needsRender = false;
    }

    /**
     * Start continuous render loop
     */
    startRenderLoop() {
        if (this.renderLoopActive) {
            return;
        }

        this.renderLoopActive = true;
        console.log('Starting render loop');

        const loop = () => {
            if (!this.renderLoopActive) {
                return;
            }
            this.render();
            this.animationFrameId = requestAnimationFrame(loop);
        };
        loop();
    }

    /**
     * Stop render loop
     */
    stopRenderLoop() {
        this.renderLoopActive = false;
        if (this.animationFrameId !== undefined) {
            cancelAnimationFrame(this.animationFrameId);
            this.animationFrameId = undefined;
        }
    }

    // ============================================================
    // COMPARISON MODE
    // ============================================================

    /**
     * Enter comparison mode. Shows the canvas list panel alongside
     * the current viewer. The parent viewer keeps running until
     * additional canvases are toggled on.
     */
    async enterCompareMode(): Promise<void> {
        if (this.comparisonController) return;
        if (!this.currentLoadedUrl) return;

        const { ComparisonController } = await import('./iiif-compare');

        // Hide panels that don't apply in compare mode
        if (this.tocContainer) this.tocContainer.style.display = 'none';

        // Add compare-active class for expanded styling
        if (this.comparePanel) {
            this.comparePanel.classList.add('compare-active');
        }

        // Build canvas entries — works for both manifests and single images
        let canvases: Array<{ label: string; index: number; thumbnailServiceUrl?: string }>;
        if (this.manifest && this.manifest.canvases.length > 0) {
            const currentCanvas = this.manifest.canvases[this.currentCanvasIndex];
            canvases = [{
                label: currentCanvas?.label || `Canvas ${this.currentCanvasIndex + 1}`,
                index: this.currentCanvasIndex,
                thumbnailServiceUrl: currentCanvas?.images[0]?.imageServiceUrl,
            }];
        } else {
            // Single image — derive label from URL
            let label: string;
            try {
                const u = new URL(this.currentLoadedUrl);
                const parts = u.pathname.split('/').filter(Boolean);
                label = parts[parts.length - 1] || u.hostname;
            } catch {
                label = 'Image';
            }
            canvases = [{ label, index: 0 }];
        }

        // Build per-instance panels config for child viewers
        const childPanels: IIIFViewerPanels = {};
        for (const key of PER_INSTANCE_PANELS) {
            const val = this.panels[key as keyof IIIFViewerPanels];
            if (val !== undefined) {
                (childPanels as any)[key] = val;
            }
        }

        // Collect universal panels with their current dock positions
        const universalPanels: { element: HTMLElement; dockPosition: string | null }[] = [];
        const getDockPosition = (el: HTMLElement): string | null => {
            const parent = el.parentElement;
            if (parent) {
                for (const [pos, dock] of this.docks) {
                    if (parent === dock) return pos;
                }
            }
            return null;
        };
        if (this.settingsPanel) {
            universalPanels.push({ element: this.settingsPanel, dockPosition: getDockPosition(this.settingsPanel) });
        }
        if (this.comparePanel) {
            universalPanels.push({ element: this.comparePanel, dockPosition: getDockPosition(this.comparePanel) });
        }
        if (this.cvPanel) {
            universalPanels.push({ element: this.cvPanel, dockPosition: getDockPosition(this.cvPanel) });
        }

        this.comparisonController = new ComparisonController(this.container, {
            viewerOptions: {
                enableOverlays: this.CONFIG.enableOverlays,
                maxCacheSize: this.CONFIG.maxCacheSize,
                enableToolbar: true,
                enableCompare: false,
                suppressSettings: true,
                toolbar: { zoom: true },
                panels: childPanels,
            },
            manifestUrl: this.currentLoadedUrl!,
            canvases,
            currentCanvasIndex: this.currentCanvasIndex,
            savedEntries: this.compareAddedEntries,
            customAnnotationSpecs: this.customAnnotationSpecs,
            listPanel: this.comparePanel?.querySelector('.iiif-panel-body') as HTMLDivElement,
            universalPanels,
            initialBackgroundColor: this.colorInput ? (() => {
                const hex = this.colorInput!.value;
                return {
                    r: parseInt(hex.slice(1, 3), 16) / 255,
                    g: parseInt(hex.slice(3, 5), 16) / 255,
                    b: parseInt(hex.slice(5, 7), 16) / 255,
                };
            })() : undefined,
            onExit: () => {
                this.exitCompareMode();
            },
            onSuspendParent: () => {
                this.stopRenderLoop();
                this.container.classList.add('iiif-compare-active');
                if (this.renderer?.canvas) this.renderer.canvas.style.display = 'none';
                if (this.overlayContainer) this.overlayContainer.style.display = 'none';
                // Hide main docks (universal panels will be in wrapper docks)
                for (const dock of this.docks.values()) {
                    dock.style.display = 'none';
                }
            },
            onResumeParent: () => {
                this.container.classList.remove('iiif-compare-active');
                if (this.renderer?.canvas) this.renderer.canvas.style.display = '';
                if (this.overlayContainer) this.overlayContainer.style.display = '';
                // Restore main docks
                for (const dock of this.docks.values()) {
                    dock.style.display = '';
                }
                this.startRenderLoop();
                this.markDirty();
            },
        });
    }

    /**
     * Exit comparison mode and resume the single viewer.
     */
    exitCompareMode(): void {
        if (!this.comparisonController) return;

        // Save manually-added URLs so they persist across compare sessions
        this.compareAddedEntries = this.comparisonController.getAddedEntries();

        this.comparisonController.destroy();
        this.comparisonController = undefined;

        // Ensure viewer is fully visible (handles both single-parent and env mode exit)
        this.container.classList.remove('iiif-compare-active');
        if (this.renderer?.canvas) this.renderer.canvas.style.display = '';
        if (this.overlayContainer) this.overlayContainer.style.display = '';
        // Restore main docks
        for (const dock of this.docks.values()) {
            dock.style.display = '';
        }

        // Restore panels based on manifest data (they set their own display)
        this.updateCanvasNav();
        this.updateTOC();

        // Reset compare panel to original state
        if (this.comparePanel) {
            this.comparePanel.classList.remove('compare-active', 'active');
            // Collapse the body and reset toggle button
            const body = this.comparePanel.querySelector('.iiif-panel-body');
            body?.classList.add('collapsed');
            const toggleBtn = this.comparePanel.querySelector('.iiif-compare-panel-collapse');
            if (toggleBtn) toggleBtn.textContent = '+';
            const closeBtn = this.comparePanel.querySelector('.iiif-compare-panel-close') as HTMLElement;
            if (closeBtn) closeBtn.style.display = 'none';
        }
        this.updateComparePanel();

        // Ensure render loop is running
        if (!this.renderLoopActive) {
            this.startRenderLoop();
        }
        this.markDirty();
    }

    // ============================================================
    // CLEANUP
    // ============================================================

    /**
     * Destroy the viewer and free all resources
     */
    destroy() {
        this.stopRenderLoop();
        this.abortController.abort();
        this.clearWorld();
        this.renderer?.destroy();
        this.cvController?.destroy();
        this.cvController = undefined;
        this.overlayManager = undefined;
        this.annotationManager = undefined;
    }
}
