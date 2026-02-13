import { IIIFImage } from './iiif-image';
import { Viewport } from './iiif-view';
import { TileManager } from './iiif-tile';
import { WebGPURenderer } from './iiif-webgpu';
import { WebGLRenderer } from './iiif-webgl';
import { Canvas2DRenderer } from './iiif-canvas2d';
import type { IIIFRenderer, TileRenderData } from './iiif-renderer';
import { ToolBar } from './iiif-toolbar';
import { AnnotationManager } from './iiif-annotations';
import { Camera } from './iiif-camera';
import { IIIFOverlayManager } from './iiif-overlay';
import { World, WorldImage } from './iiif-world';
import type { WorldPlacement } from './iiif-world';
import { parseIIIFUrl, fetchAnnotationList } from './iiif-parser';
import type { ParsedManifest, ParsedImageService, ParsedAnnotationPage } from './iiif-parser';

// Re-export types for convenience
export type { OverlayElement } from './iiif-overlay';
export type { CustomAnnotation, Annotation, IIIFAnnotation } from './iiif-annotations';
export { IIIFOverlayManager } from './iiif-overlay';
export type { WorldPlacement } from './iiif-world';

/**
 * IIIFViewer - Main viewer class orchestrating all components
 *
 * Design principles:
 * - Render-on-demand with dirty flag pattern (only render when needed)
 * - Proper resource cleanup with destroy methods
 * - Centralized configuration
 * - Type-safe event handling
 * - Efficient viewport change detection
 * - Lazy loading and caching where possible
 */

export interface IIIFViewerOptions {
    renderer?: 'webgpu' | 'webgl' | 'canvas2d' | 'auto';
    enableOverlays?: boolean;
    enableToolbar?: boolean;
    maxCacheSize?: number;
    toolbar?: any;
}

interface CanvasInfo {
    width: number;
    height: number;
    annotations: ParsedAnnotationPage[];
    annotationListUrls: string[];
}

export class IIIFViewer {
    // Core components
    container: HTMLElement;
    world: World;
    viewport: Viewport;
    camera: Camera;
    renderer?: IIIFRenderer;
    toolbar?: ToolBar;
    annotationManager?: AnnotationManager;
    overlayManager?: IIIFOverlayManager;

    // UI elements
    private overlayContainer?: HTMLElement;
    private canvasNavContainer?: HTMLElement;
    private canvasNavList?: HTMLElement;

    // State
    private manifest?: ParsedManifest;
    private currentCanvasIndex: number = -1;
    private renderLoopActive: boolean = false;
    private animationFrameId?: number;
    private needsRender: boolean = true;

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
    private eventHandlers: Map<Element, Map<string, EventListener>> = new Map();
    private abortController: AbortController = new AbortController();

    // Configuration
    private readonly CONFIG: IIIFViewerOptions;

    constructor(container: HTMLElement, options: IIIFViewerOptions = {}) {
        this.container = container;
        this.CONFIG = {
            renderer: options.renderer ?? 'auto',
            enableOverlays: options.enableOverlays ?? true,
            enableToolbar: options.enableToolbar ?? true,
            maxCacheSize: options.maxCacheSize ?? 500,
            toolbar: options.toolbar
        };

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
        this.setupCanvasNav();

        if (this.CONFIG.enableToolbar) {
            this.toolbar = new ToolBar(container, this.CONFIG.toolbar);
        }

        // Set up handlers
        this.setupResizeHandler();
        this.initializeRenderer();
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

    private setupCanvasNav() {
        this.canvasNavContainer = document.createElement('div');
        this.canvasNavContainer.className = 'iiif-canvas-nav';
        this.canvasNavContainer.style.display = 'none';

        const header = document.createElement('div');
        header.className = 'iiif-canvas-nav-header';

        const label = document.createElement('span');
        label.textContent = 'Pages';
        header.appendChild(label);

        const collapseBtn = document.createElement('button');
        collapseBtn.className = 'iiif-canvas-nav-collapse';
        collapseBtn.textContent = '−';
        header.appendChild(collapseBtn);

        this.canvasNavContainer.appendChild(header);

        this.canvasNavList = document.createElement('div');
        this.canvasNavList.className = 'iiif-canvas-nav-list';
        this.canvasNavContainer.appendChild(this.canvasNavList);

        this.addEventListener(collapseBtn, 'click', () => {
            this.canvasNavList!.classList.toggle('collapsed');
            collapseBtn.textContent = this.canvasNavList!.classList.contains('collapsed') ? '+' : '−';
        });

        this.container.appendChild(this.canvasNavContainer);
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
        element: Element,
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
            event.preventDefault();

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
            1.0,  // distanceDetail
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
        const result = await parseIIIFUrl(url);

        if (result.type === 'image-service-2' || result.type === 'image-service-3') {
            this.clearWorld();
            this.manifest = undefined;
            this.currentCanvasIndex = -1;

            const svc = result as ParsedImageService;
            const infoUrl = svc.id.replace(/\/$/, '') + '/info.json';
            await this.addImage('image-0', infoUrl, focus);
            this.updateCanvasNav();
        } else {
            this.clearWorld();
            this.manifest = result as ParsedManifest;
            this.updateCanvasNav();
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

    private createCanvasNavItem(canvas: any, index: number): HTMLElement {
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
     * Add an annotation to the viewer
     */
    addAnnotation(annotation: {
        id: string;
        fixed: boolean;
        x: number;
        y: number;
        width: number;
        height: number;
        style?: Record<string, string | undefined>;
        content?: {
            element?: HTMLElement;
            text?: string;
            width?: number;
            height?: number;
        };
        scaleWithZoom?: boolean;
    }): void {
        if (!this.annotationManager) {
            console.error('Annotation manager not initialized.');
            return;
        }
        this.annotationManager.addAnnotation(annotation);
    }

    // ============================================================
    // RENDERING
    // ============================================================

    private markDirty() {
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

        // Collect tiles from all visible images
        const allTiles: TileRenderData[] = [];
        let thumbnail: TileRenderData | undefined;

        for (const worldImage of visibleImages) {
            const tiles = worldImage.tileManager.getLoadedTilesForRender(this.viewport);
            allTiles.push(...tiles);

            if (!thumbnail) {
                thumbnail = worldImage.tileManager.getThumbnail();
            }
        }

        // Sort by z-depth for proper layering
        allTiles.sort((a, b) => a.z - b.z);

        // Render
        this.renderer.render(this.viewport, allTiles, thumbnail);

        // Update overlays only if viewport changed
        if (viewportChanged) {
            this.overlayManager?.updateAllOverlays();
            this.updateViewportState();
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
        this.overlayManager = undefined;
        this.annotationManager = undefined;
        this.toolbar = undefined;
    }
}
