import { IIIFImage } from './core/iiif-image';
import { Viewport } from './core/iiif-view';
import { TileManager } from './iiif-tile';
import { WebGPURenderer } from './rendering/iiif-webgpu';
import { WebGLRenderer } from './rendering/iiif-webgl';
import { Canvas2DRenderer } from './rendering/iiif-canvas2d';
import type { IIIFRenderer, TileRenderData } from './rendering/iiif-renderer';
import { AnnotationManager } from './features/iiif-annotations';
import { Camera } from './core/iiif-camera';
import { IIIFOverlayManager } from './features/iiif-overlay';
import { World, WorldImage } from './core/iiif-world';
import type { WorldPlacement } from './core/iiif-world';
import { parseIIIFUrl, fetchAnnotationList } from './iiif-parser';
import type { ParsedManifest, ParsedImageService } from './iiif-parser';
import { PANEL_CLASS_MAP, PANEL_HIDE_CLASS, PER_INSTANCE_PANELS } from './config';
import type { IIIFViewerOptions, IIIFViewerPanels, LayoutState, CanvasInfo, LookAtOptions } from './types';
import { ViewerUI } from './ui/iiif-viewer-ui';
import type { ViewerUICallbacks } from './ui/iiif-viewer-ui';

// Dynamic import types (for lazy loading modules)
import type { ComparisonController } from './features/iiif-compare';

// Re-export newly extracted modules for library consumers
export { PanelManager } from './ui/iiif-panel-manager';
export { setupInputHandlers } from './features/iiif-input-handlers';

import './ui/iiif-styles.css';

// Re-export types for convenience
export type { OverlayElement } from './features/iiif-overlay';
export type { CustomAnnotation, Annotation, IIIFAnnotation } from './features/iiif-annotations';
export { IIIFOverlayManager } from './features/iiif-overlay';
export type { WorldPlacement } from './core/iiif-world';
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
    private ui: ViewerUI;

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

    // Event cleanup
    private abortController: AbortController = new AbortController();

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

        // Create ViewerUI with callbacks
        const uiCallbacks: ViewerUICallbacks = {
            markDirty: () => this.markDirty(),
            fitToWorld: () => this.fitToWorld(),
            loadCanvas: (index) => this.loadCanvas(index),
            previousCanvas: () => this.previousCanvas(),
            nextCanvas: () => this.nextCanvas(),
            springZoomByFactor: (factor) => this.camera.springZoomByFactor(factor),
            springPan: (dx, dy) => this.camera.springPan(dx, dy),
            enterCompareMode: () => this.enterCompareMode(),
            exitCompareMode: () => this.exitCompareMode(),
            saveLayout: () => this.saveLayout(),
            loadLayout: (state) => this.loadLayout(state),
            getViewportScale: () => this.viewport.scale,
            getRenderer: () => this.renderer as any,
            getAnnotationManager: () => this.annotationManager,
            getOverlayManager: () => this.overlayManager,
            getManifest: () => this.manifest,
            getCurrentCanvasIndex: () => this.currentCanvasIndex,
            getCurrentLoadedUrl: () => this.currentLoadedUrl,
            getCustomAnnotationSpecs: () => this.customAnnotationSpecs,
            getHiddenAnnotationTypes: () => this.hiddenAnnotationTypes,
            setHiddenAnnotationType: (type, hidden) => {
                if (hidden) this.hiddenAnnotationTypes.add(type);
                else this.hiddenAnnotationTypes.delete(type);
            },
            getComparisonController: () => this.comparisonController as any,
            isMobileOrTablet: () => this.isMobileOrTablet(),
            getCanvasIdToIndex: () => this.canvasIdToIndex,
        };

        this.ui = new ViewerUI(container, this.panels, this.CONFIG, this.abortController, uiCallbacks);
        this.ui.setupAll();

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
        const listener = handler as EventListener;
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
                            this.ui.fullscreenBtn?.classList.add('active');
                        } else {
                            document.exitFullscreen();
                            this.ui.fullscreenBtn?.classList.remove('active');
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
            this.ui.updateCanvasNav();
            this.ui.updateTOC();
            this.ui.updateManifestPanel();
            this.ui.updateComparePanel();
            this.ui.updateAnnotationPanel();
        } else {
            this.clearWorld();
            this.manifest = result as ParsedManifest;

            // Build canvas ID -> index lookup for range navigation
            this.canvasIdToIndex.clear();
            for (let i = 0; i < this.manifest.canvases.length; i++) {
                this.canvasIdToIndex.set(this.manifest.canvases[i].id, i);
            }

            this.ui.updateCanvasNav();
            this.ui.updateTOC();
            this.ui.updateManifestPanel();
            this.ui.updateComparePanel();
            await this.loadCanvas(0, focus);
        }
    }

    /**
     * Load a JSON configuration object or string.
     * Supports loading multiple images, settings, viewport, and annotations.
     *
     * @example
     * ```typescript
     * await viewer.loadConfig({
     *   images: [
     *     { url: 'https://example.org/iiif/image/info.json', label: 'My Image' }
     *   ],
     *   settings: { backgroundColor: '#000', theme: 'dark' },
     *   viewport: { centerX: 500, centerY: 500, zoom: 2 },
     *   annotations: [
     *     { x: 100, y: 200, content: 'Note', type: 'Notes', color: '#ff0' }
     *   ]
     * });
     * ```
     */
    async loadConfig(config: import('./types').ViewerConfig | string): Promise<void> {
        // Parse string input
        const cfg: import('./types').ViewerConfig = typeof config === 'string'
            ? JSON.parse(config)
            : config;

        // Apply settings first
        if (cfg.settings) {
            if (cfg.settings.backgroundColor) {
                const hex = cfg.settings.backgroundColor;
                if (this.ui.colorInput) {
                    this.ui.colorInput.value = hex;
                }
                // Parse hex color to RGB
                const r = parseInt(hex.slice(1, 3), 16) / 255;
                const g = parseInt(hex.slice(3, 5), 16) / 255;
                const b = parseInt(hex.slice(5, 7), 16) / 255;
                this.renderer?.setClearColor(r, g, b);
            }
            if (cfg.settings.theme) {
                this.container.classList.toggle('theme-light', cfg.settings.theme === 'light');
            }
        }

        // Load manifest URL if provided
        if (cfg.manifestUrl) {
            await this.loadUrl(cfg.manifestUrl, false);
            if (cfg.canvasIndex !== undefined && cfg.canvasIndex >= 0) {
                await this.loadCanvas(cfg.canvasIndex, false);
            }
        }
        // Or load individual images
        else if (cfg.images && cfg.images.length > 0) {
            this.clearWorld();
            this.manifest = undefined;
            this.currentCanvasIndex = -1;

            for (let i = 0; i < cfg.images.length; i++) {
                const img = cfg.images[i];
                const placement: WorldPlacement | undefined = img.placement
                    ? {
                        worldX: img.placement.x,
                        worldY: img.placement.y,
                        worldWidth: img.placement.width ?? 0,
                        worldHeight: img.placement.height ?? 0
                    }
                    : undefined;

                await this.addImage(`config-image-${i}`, img.url, false, placement);
            }

            this.ui.updateCanvasNav();
            this.ui.updateTOC();
            this.ui.updateManifestPanel();
            this.ui.updateComparePanel();
            this.ui.updateAnnotationPanel();
        }

        // Apply viewport settings
        if (cfg.viewport) {
            if (cfg.viewport.centerX !== undefined) {
                this.viewport.centerX = cfg.viewport.centerX;
            }
            if (cfg.viewport.centerY !== undefined) {
                this.viewport.centerY = cfg.viewport.centerY;
            }
            if (cfg.viewport.zoom !== undefined) {
                this.viewport.cameraZ = cfg.viewport.zoom;
            }
            this.markDirty();
        } else {
            // Default: fit to world
            this.fitToWorld();
        }

        // Add annotations
        if (cfg.annotations && cfg.annotations.length > 0) {
            for (const ann of cfg.annotations) {
                this.addAnnotation(
                    ann.x,
                    ann.y,
                    ann.width ?? 0,
                    ann.height ?? 0,
                    ann.content,
                    {
                        type: ann.type,
                        color: ann.color,
                        scaleWithZoom: ann.scaleWithZoom,
                        style: ann.style,
                        popup: ann.popup
                    }
                );
            }
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
        this.ui.updateCanvasNavActiveState();

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
        this.ui.updateCustomAnnotationVisibility();
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

        this.ui.updateAnnotationPanel();
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

    /**
     * Smoothly pan and zoom to look at a specific point in image coordinates.
     *
     * @param x - X coordinate in image pixels
     * @param y - Y coordinate in image pixels
     * @param options - Optional configuration
     * @param options.zoom - Target zoom level (scale). 1 = 1:1 pixels, 2 = 2x magnification, 0.5 = zoomed out
     * @param options.duration - Animation duration in milliseconds (default: 500)
     *
     * @example
     * // Pan to point (800, 600) keeping current zoom
     * viewer.lookAt(800, 600);
     *
     * // Pan to point and zoom to 2x magnification
     * viewer.lookAt(800, 600, { zoom: 2 });
     *
     * // Quick pan with custom duration
     * viewer.lookAt(800, 600, { duration: 200 });
     *
     * // Use from annotation click or external button:
     * document.getElementById('goto-detail').onclick = () => {
     *     viewer.lookAt(1200, 400, { zoom: 3, duration: 600 });
     * };
     */
    lookAt(x: number, y: number, options?: LookAtOptions) {
        const zoom = options?.zoom;
        const duration = options?.duration ?? 500;

        // Calculate target cameraZ from zoom (scale)
        let targetZ: number;
        if (zoom !== undefined) {
            // zoom is scale (CSS pixels per world unit)
            // cameraZ = containerHeight / (2 * scale * tan(fov/2))
            targetZ = this.viewport.containerHeight / (2 * zoom * this.viewport.getTanHalfFov());
            // Clamp to valid range
            targetZ = Math.max(this.viewport.minZ, Math.min(this.viewport.maxZ, targetZ));
        } else {
            // Keep current zoom
            targetZ = this.viewport.cameraZ;
        }

        this.camera.to(x, y, targetZ, duration);
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
                for (const [pos, dock] of this.ui.docks) {
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
                backgroundColor: this.ui.colorInput?.value ?? '#1a1a1a',
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
                if (collapseBtn) collapseBtn.textContent = panelState.collapsed ? '+' : '\u2212';
            }

            // Restore dock/float position
            if (panelState.dockPosition) {
                const dock = this.ui.docks.get(panelState.dockPosition);
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
                const checkbox = this.ui.settingsCheckboxes.get(hideClass);
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
        if (state.settings.backgroundColor && this.ui.colorInput) {
            this.ui.colorInput.value = state.settings.backgroundColor;
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
            this.ui.updateAnnotationPanel();
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

        this.ui.updateAnnotationPanel();

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

        const { ComparisonController } = await import('./features/iiif-compare');

        // Hide panels that don't apply in compare mode
        if (this.ui.tocContainer) this.ui.tocContainer.style.display = 'none';

        // Add compare-active class for expanded styling
        if (this.ui.comparePanel) {
            this.ui.comparePanel.classList.add('compare-active');
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
                for (const [pos, dock] of this.ui.docks) {
                    if (parent === dock) return pos;
                }
            }
            return null;
        };
        if (this.ui.settingsPanel) {
            universalPanels.push({ element: this.ui.settingsPanel, dockPosition: getDockPosition(this.ui.settingsPanel) });
        }
        if (this.ui.comparePanel) {
            universalPanels.push({ element: this.ui.comparePanel, dockPosition: getDockPosition(this.ui.comparePanel) });
        }
        if (this.ui.cvPanel) {
            universalPanels.push({ element: this.ui.cvPanel, dockPosition: getDockPosition(this.ui.cvPanel) });
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
            listPanel: this.ui.comparePanel?.querySelector('.iiif-panel-body') as HTMLDivElement,
            universalPanels,
            initialBackgroundColor: this.ui.colorInput ? (() => {
                const hex = this.ui.colorInput!.value;
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
                for (const dock of this.ui.docks.values()) {
                    dock.style.display = 'none';
                }
            },
            onResumeParent: () => {
                this.container.classList.remove('iiif-compare-active');
                if (this.renderer?.canvas) this.renderer.canvas.style.display = '';
                if (this.overlayContainer) this.overlayContainer.style.display = '';
                // Restore main docks
                for (const dock of this.ui.docks.values()) {
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
        for (const dock of this.ui.docks.values()) {
            dock.style.display = '';
        }

        // Restore panels based on manifest data (they set their own display)
        this.ui.updateCanvasNav();
        this.ui.updateTOC();

        // Reset compare panel to original state
        if (this.ui.comparePanel) {
            this.ui.comparePanel.classList.remove('compare-active', 'active');
            // Collapse the body and reset toggle button
            const body = this.ui.comparePanel.querySelector('.iiif-panel-body');
            body?.classList.add('collapsed');
            const toggleBtn = this.ui.comparePanel.querySelector('.iiif-compare-panel-collapse');
            if (toggleBtn) toggleBtn.textContent = '+';
            const closeBtn = this.ui.comparePanel.querySelector('.iiif-compare-panel-close') as HTMLElement;
            if (closeBtn) closeBtn.style.display = 'none';
        }
        this.ui.updateComparePanel();

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
        this.ui.cvController?.destroy();
        this.overlayManager = undefined;
        this.annotationManager = undefined;
    }
}
