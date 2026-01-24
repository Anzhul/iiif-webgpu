
import { IIIFImage } from './iiif-image';
import { Viewport } from './iiif-view';
import { TileManager } from './iiif-tile';
import { WebGPURenderer } from './iiif-webgpu';
import { WebGLRenderer } from './iiif-webgl';
import type { IIIFRenderer, WorldTileRenderData } from './iiif-renderer';
import { ToolBar } from './iiif-toolbar';
import { AnnotationManager } from './iiif-annotations'
import { Camera } from './iiif-camera';
import { IIIFOverlayManager } from './iiif-overlay';
import { IIIFManifestParser, type ManifestInfo } from './iiif-manifest';
import { LayoutManager, type LayoutMode, type LayoutOptions } from './iiif-layout';

// Re-export overlay and annotation types for convenience
export type { OverlayElement } from './iiif-overlay';
export type { Annotation } from './iiif-annotations';
export { IIIFOverlayManager } from './iiif-overlay';

// Re-export manifest and layout types
export { IIIFManifestParser } from './iiif-manifest';
export type { ManifestInfo, CanvasInfo, ImageService } from './iiif-manifest';
export { LayoutManager } from './iiif-layout';
export type { LayoutMode, LayoutOptions, LayoutResult } from './iiif-layout';

// Re-export overlay component factories
export * from './iiif-overlay-components';

export class IIIFViewer {
    container: HTMLElement;
    manifests: any[];
    images: Map<string, IIIFImage>;
    tiles: Map<string, TileManager>;
    viewport: Viewport;
    camera: Camera;
    renderer?: IIIFRenderer;
    toolbar?: ToolBar;
    annotationManager?: AnnotationManager;
    overlayManager?: IIIFOverlayManager;
    private overlayContainer?: HTMLElement;
    private eventListeners: { event: string, handler: EventListener }[];
    private renderLoopActive: boolean = false;
    private animationFrameId?: number;
    private cachedContainerRect: DOMRect;

    // Multi-image unified canvas state
    private manifestInfo?: ManifestInfo;
    private layoutMode: LayoutMode = 'horizontal';
    private layoutGap: number = 50;

    constructor(container: HTMLElement, options: any = {}) {
        this.container = container;
        this.manifests = [];
        this.images = new Map();
        this.tiles = new Map();
        this.viewport = new Viewport(container.clientWidth, container.clientHeight);
        this.toolbar = new ToolBar(container, options.toolbar);
        this.camera = new Camera(this.viewport, this.images, this.tiles);

        this.eventListeners = [];

        // Cache the container's bounding rect
        this.cachedContainerRect = container.getBoundingClientRect();

        // Set up overlay container and manager if enabled
        if (options.enableOverlays !== false) {
            this.setupOverlayContainer();
        }

        // Initialize annotation manager with overlay manager
        this.annotationManager = new AnnotationManager(this.overlayManager);

        // Set up resize observer to update cached rect and viewport
        this.setupResizeHandler();

        // Check if webGPU is supported and initialize renderer
        // This operation is asynchronous so must be in another function
        this.initializeRenderer();
    }

    private setupOverlayContainer() {
        // Create a div that overlays the canvas
        this.overlayContainer = document.createElement('div');
        this.overlayContainer.style.position = 'absolute';
        this.overlayContainer.style.top = '0';
        this.overlayContainer.style.left = '0';
        this.overlayContainer.style.width = '100%';
        this.overlayContainer.style.height = '100%';
        this.overlayContainer.style.pointerEvents = 'none';
        this.overlayContainer.style.zIndex = '11'; // Above canvas (which is z-index: 10)

        this.container.appendChild(this.overlayContainer);

        // Initialize overlay manager
        this.overlayManager = new IIIFOverlayManager(
            this.overlayContainer,
            this.viewport,
            this.images
        );
    }

    private async initializeRenderer() {
        if (await this.isWebGPUAvailable()) {
            try {
                console.log('Initializing WebGPU renderer');
                this.renderer = new WebGPURenderer(this.container);
                await this.renderer.initialize();

                // Set renderer for all existing TileManagers
                for (const tileManager of this.tiles.values()) {
                    tileManager.setRenderer(this.renderer);
                }
            } catch (error) {
                console.error('Failed to initialize WebGPU renderer:', error);
                this.renderer = undefined;
                // Try WebGL fallback
                await this.initializeWebGLFallback();
            }
        } else {
            // WebGPU not available, use WebGL fallback
            console.warn('WebGPU is not available in this browser, using WebGL fallback');
            await this.initializeWebGLFallback();
        }
    }

    private async initializeWebGLFallback() {
        try {
            console.log('Initializing WebGL renderer');
            this.renderer = new WebGLRenderer(this.container);
            await this.renderer.initialize();

            // Set renderer for all existing TileManagers
            for (const tileManager of this.tiles.values()) {
                tileManager.setRenderer(this.renderer);
            }
        } catch (error) {
            console.error('Failed to initialize WebGL renderer:', error);
            this.renderer = undefined;
        }
    }

    private async isWebGPUAvailable(): Promise<boolean> {
        if (!navigator.gpu) {
            return false;
        }
        try {
            const adapter = await navigator.gpu.requestAdapter();
            return adapter !== null;
        } catch (error) {
            console.error('Error checking WebGPU availability:', error);
            return false;
        }
    }

    private setupResizeHandler() {
        const resizeHandler = () => {
            this.handleResize();
        };

        window.addEventListener('resize', resizeHandler);
        this.eventListeners.push({ event: 'resize', handler: resizeHandler as EventListener });
    }

    private handleResize() {
        // Update cached rect
        this.cachedContainerRect = this.container.getBoundingClientRect();

        // Update viewport dimensions
        this.viewport.containerWidth = this.container.clientWidth;
        this.viewport.containerHeight = this.container.clientHeight;

        // Update renderer canvas size if available
        if (this.renderer) {
            this.renderer.resize();
        }

        // Request new tiles for all images with updated viewport
        for (const tileManager of this.tiles.values()) {
            tileManager.requestTilesForViewport(this.viewport);
        }

        // Update overlay positions after resize
        if (this.overlayManager) {
            this.overlayManager.updateAllOverlays();
        }
    }

    async addImage(id: string, url: string, focus: boolean = false, skipTileRequest: boolean = false) {
        const iiifImage = new IIIFImage(id, url);
        await iiifImage.loadManifest(url);
        this.images.set(id, iiifImage);

        // Pass renderer to TileManager if available
        // distanceDetail: Lower = more detail from further away (0.3-0.5 recommended)
        // 0.30 = slightly more detail, 0.35 = balanced, 0.40 = conservative
        const tileManager = new TileManager(id, iiifImage, 500, this.renderer, 0.35);

        if (focus) {
            this.viewport.fitToWidth(iiifImage);
        }
        this.tiles.set(id, tileManager);

        // Skip tile requests during batch loading (will be done after layout)
        if (!skipTileRequest) {
            // Request initial tiles for the viewport
            tileManager.requestTilesForViewport(this.viewport);

            // Load low-resolution thumbnail for background
            await tileManager.loadThumbnail();
        }
    }

    /**
     * Load a IIIF manifest (Presentation API) or info.json (Image API)
     * Automatically detects the type and loads all images
     * @param url - URL to manifest.json or info.json
     * @param options - Layout options for multi-image display
     */
    async loadManifest(url: string, options: {
        layout?: LayoutMode;
        gap?: number;
        gridColumns?: number;
        maxConcurrentLoads?: number;
    } = {}): Promise<ManifestInfo> {
        // Parse the manifest (handles both Presentation and Image API)
        this.manifestInfo = await IIIFManifestParser.parse(url);

        // Store layout preferences
        this.layoutMode = options.layout || 'horizontal';
        this.layoutGap = options.gap ?? 50;

        // Enable world space mode for multi-image viewing
        if (this.manifestInfo.canvases.length > 1) {
            this.viewport.enableWorldSpace();
        }

        // Collect all canvas info for loading
        const canvasesToLoad: Array<{ index: number; imageId: string; infoUrl: string; label: string }> = [];

        for (let i = 0; i < this.manifestInfo.canvases.length; i++) {
            const canvas = this.manifestInfo.canvases[i];

            // Use first image service from canvas
            const imageService = canvas.imageServices[0];
            if (!imageService) {
                console.warn(`Canvas ${canvas.id} has no image service, skipping`);
                continue;
            }

            const imageId = `canvas_${i}`;
            const infoUrl = imageService.id.endsWith('/info.json')
                ? imageService.id
                : `${imageService.id}/info.json`;

            canvasesToLoad.push({
                index: i,
                imageId,
                infoUrl,
                label: canvas.label || `Page ${i + 1}`
            });
        }

        // Load images in batches to prevent overwhelming the browser
        // skipTileRequest=true: don't load tiles yet, wait until layout is done
        const batchSize = options.maxConcurrentLoads || 4;

        for (let i = 0; i < canvasesToLoad.length; i += batchSize) {
            const batch = canvasesToLoad.slice(i, i + batchSize);

            await Promise.all(batch.map(async (item) => {
                try {
                    // Skip tile requests during batch loading - will load after layout
                    await this.addImage(item.imageId, item.infoUrl, false, true);
                    const image = this.images.get(item.imageId);
                    if (image) {
                        image.label = item.label;
                    }
                } catch (error) {
                    console.warn(`Failed to load canvas ${item.index}:`, error);
                }
            }));

            console.log(`Loaded ${Math.min(i + batchSize, canvasesToLoad.length)}/${canvasesToLoad.length} images`);
        }

        // Layout the images (sets worldX/worldY positions)
        this.layoutImages();

        // Fit viewport to show all images
        this.fitToAllImages();

        // Set up world space event listeners for multi-image panning/zooming
        if (this.manifestInfo.canvases.length > 1) {
            this.listenWorldSpace();
        }

        return this.manifestInfo;
    }

    /**
     * Layout all loaded images according to current layout mode
     */
    layoutImages(): void {
        const imageArray = Array.from(this.images.values());

        if (imageArray.length === 0) return;

        const layoutOptions: LayoutOptions = {
            mode: this.layoutMode,
            gap: this.layoutGap,
            alignToTallest: true,
            alignToWidest: true
        };

        // Apply layout (this sets worldX/worldY on each image)
        LayoutManager.layout(imageArray, layoutOptions);

        // Request tiles for visible images
        this.requestTilesForAllVisibleImages();
    }

    /**
     * Change the layout mode and re-layout images
     */
    setLayout(mode: LayoutMode, gap?: number): void {
        this.layoutMode = mode;
        if (gap !== undefined) {
            this.layoutGap = gap;
        }
        this.layoutImages();
        this.fitToAllImages();
    }

    /**
     * Fit viewport to show all images
     */
    fitToAllImages(padding: number = 50): void {
        const bounds = LayoutManager.getBounds(Array.from(this.images.values()));

        if (bounds.width === 0 || bounds.height === 0) return;

        this.viewport.fitToBounds(
            bounds.minX,
            bounds.minY,
            bounds.maxX,
            bounds.maxY,
            padding
        );

        // Load thumbnails and request tiles for visible images
        this.loadThumbnailsForVisibleImages();
        this.requestTilesForAllVisibleImages();
    }

    /**
     * Load thumbnails for all visible images (lazy loading)
     */
    private async loadThumbnailsForVisibleImages(): Promise<void> {
        const visibleImages: Array<{ imageId: string; tileManager: TileManager }> = [];

        for (const [imageId, image] of this.images) {
            if (this.viewport.isImageVisible(image)) {
                const tileManager = this.tiles.get(imageId);
                if (tileManager && !tileManager.getThumbnail()) {
                    visibleImages.push({ imageId, tileManager });
                }
            }
        }

        // Load thumbnails in batches of 2 with delay between batches
        // This prevents overwhelming the server and avoids decode errors
        for (let i = 0; i < visibleImages.length; i += 2) {
            const batch = visibleImages.slice(i, i + 2);
            await Promise.all(batch.map(item => item.tileManager.loadThumbnail()));

            // Small delay between batches to avoid rate limiting
            if (i + 2 < visibleImages.length) {
                await new Promise(resolve => setTimeout(resolve, 50));
            }
        }
    }

    /**
     * Request tiles for all images visible in the current viewport
     */
    private requestTilesForAllVisibleImages(): void {
        if (!this.viewport.useWorldSpace) {
            // Single image mode - use original method
            for (const tileManager of this.tiles.values()) {
                tileManager.requestTilesForViewport(this.viewport);
            }
            return;
        }

        // World space mode - only request tiles for visible images
        for (const [imageId, image] of this.images) {
            if (this.viewport.isImageVisible(image)) {
                const tileManager = this.tiles.get(imageId);
                if (tileManager) {
                    tileManager.requestTilesForWorldViewport(this.viewport);
                }
            }
        }
    }

    /**
     * Render all images in world space (unified canvas mode)
     */
    private renderMultiImage(): void {
        if (!this.renderer?.renderMultiImage) {
            console.warn('Renderer does not support multi-image rendering');
            return;
        }

        // Collect tiles from all visible images
        const allTiles: WorldTileRenderData[] = [];

        for (const [imageId, image] of this.images) {
            // Skip images outside viewport
            if (!this.viewport.isImageVisible(image)) {
                continue;
            }

            const tileManager = this.tiles.get(imageId);
            if (!tileManager) continue;

            // Get tiles with world offsets
            const tiles = tileManager.getWorldSpaceTiles(this.viewport);
            allTiles.push(...tiles);
        }

        // Render all tiles
        this.renderer.renderMultiImage(this.viewport, allTiles);
    }

    private updateAnimations() {
        // Only update interactive animations if Camera is not running programmatic animations
        // This prevents conflicts between programmatic camera animations and interactive movements
        if (!this.camera.isAnimating()) {
            this.camera.updateInteractiveAnimation();
        }
    }

    /**
     * Zoom to a specific scale value
     * @param targetScale - The target scale to zoom to (same as ViewportController)
     * @param imageId - ID of the image
     * @param duration - Animation duration in milliseconds
     */
    zoom(targetScale: number, imageId: string, duration = 500) {
        this.camera.zoom(targetScale, imageId, duration);
    }

    /**
     * Zoom by a factor
     * @param factor - Zoom factor (>1 = zoom in, <1 = zoom out)
     * @param imageId - ID of the image
     * @param duration - Animation duration in milliseconds
     */
    zoomByFactor(factor: number, imageId: string, duration = 500) {
        this.camera.zoomByFactor(factor, imageId, duration);
    }

    /**
     * Pan by delta amounts in image pixel coordinates
     * @param deltaX - X delta in image pixels
     * @param deltaY - Y delta in image pixels
     * @param imageId - ID of the image
     * @param duration - Animation duration in milliseconds
     */
    pan(deltaX: number, deltaY: number, imageId: string, duration = 500) {
        this.camera.pan(deltaX, deltaY, imageId, duration);
    }

    /**
     * Navigate to a specific position in the image
     * @param imageX - X coordinate in image pixel space
     * @param imageY - Y coordinate in image pixel space
     * @param imageZ - Camera Z distance from image plane
     * @param imageId - ID of the image
     * @param duration - Animation duration in milliseconds
     */
    to(imageX: number, imageY: number, imageZ: number, imageId: string, duration = 500) {
        this.camera.to(imageX, imageY, imageZ, imageId, duration);
    }

    /**
     * Add an overlay element to the viewer
     * @param overlay - Overlay configuration
     */
    addOverlay(overlay: {
        id: string;
        element: HTMLElement;
        imageX: number;
        imageY: number;
        imageWidth: number;
        imageHeight: number;
        imageId: string;
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
     * @param annotation - Annotation configuration
     */
    addAnnotation(annotation: {
        id: string;
        imageId: string;
        fixed: boolean;
        x: number;
        y: number;
        width: number;
        height: number;
        style?: {
            border?: string;
            backgroundColor?: string;
            borderRadius?: string;
            opacity?: string;
            [key: string]: string | undefined;
        };
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

    listen(...ids: string[]) {
        const mousedownHandler = (event: MouseEvent) => {
            event.preventDefault();

            const image = this.images.get(ids[0]);
            if (!image) return;

            // Calculate canvas-relative coordinates
            const canvasX = event.clientX - this.cachedContainerRect.left;
            const canvasY = event.clientY - this.cachedContainerRect.top;

            // Start pan via camera
            this.camera.startInteractivePan(canvasX, canvasY, ids[0]);

            const onMouseMove = (moveEvent: MouseEvent) => {
                // Update target canvas position
                const newCanvasX = moveEvent.clientX - this.cachedContainerRect.left;
                const newCanvasY = moveEvent.clientY - this.cachedContainerRect.top;

                // Update pan via camera
                this.camera.updateInteractivePan(newCanvasX, newCanvasY);
            };

            const cleanup = () => {
                // End pan via camera
                this.camera.endInteractivePan();

                // Remove all drag-related listeners
                document.removeEventListener('mousemove', onMouseMove);
                document.removeEventListener('mouseup', cleanup);
                document.removeEventListener('mouseleave', cleanup);
            };

            // Listen on document to catch mouse events outside the container
            document.addEventListener('mousemove', onMouseMove);
            document.addEventListener('mouseup', cleanup);
            // Also listen for mouse leaving the page entirely
            document.addEventListener('mouseleave', cleanup);
        };

        const wheelHandler = (event: WheelEvent) => {
            const canvasX = event.clientX - this.cachedContainerRect.left;
            const canvasY = event.clientY - this.cachedContainerRect.top;

            // Handle wheel via camera
            this.camera.handleWheel(event, canvasX, canvasY, ids);
        };

        this.container.addEventListener('mousedown', mousedownHandler);
        this.container.addEventListener('wheel', wheelHandler);

        this.eventListeners.push(
            { event: 'mousedown', handler: mousedownHandler as EventListener },
            { event: 'wheel', handler: wheelHandler as EventListener }
        );
    }

    /**
     * Set up event listeners for world space mode (multi-image panning/zooming)
     */
    listenWorldSpace() {
        const mousedownHandler = (event: MouseEvent) => {
            event.preventDefault();

            // Calculate canvas-relative coordinates
            const canvasX = event.clientX - this.cachedContainerRect.left;
            const canvasY = event.clientY - this.cachedContainerRect.top;

            // Start world space pan via camera
            this.camera.startWorldSpacePan(canvasX, canvasY);

            const onMouseMove = (moveEvent: MouseEvent) => {
                // Update target canvas position
                const newCanvasX = moveEvent.clientX - this.cachedContainerRect.left;
                const newCanvasY = moveEvent.clientY - this.cachedContainerRect.top;

                // Update pan via camera (same method works for world space)
                this.camera.updateInteractivePan(newCanvasX, newCanvasY);
            };

            const cleanup = () => {
                // End pan via camera
                this.camera.endInteractivePan();

                // Remove all drag-related listeners
                document.removeEventListener('mousemove', onMouseMove);
                document.removeEventListener('mouseup', cleanup);
                document.removeEventListener('mouseleave', cleanup);
            };

            // Listen on document to catch mouse events outside the container
            document.addEventListener('mousemove', onMouseMove);
            document.addEventListener('mouseup', cleanup);
            document.addEventListener('mouseleave', cleanup);
        };

        const wheelHandler = (event: WheelEvent) => {
            const canvasX = event.clientX - this.cachedContainerRect.left;
            const canvasY = event.clientY - this.cachedContainerRect.top;

            // Handle wheel for world space zooming
            this.camera.handleWorldSpaceWheel(event, canvasX, canvasY);
        };

        this.container.addEventListener('mousedown', mousedownHandler);
        this.container.addEventListener('wheel', wheelHandler);

        this.eventListeners.push(
            { event: 'mousedown', handler: mousedownHandler as EventListener },
            { event: 'wheel', handler: wheelHandler as EventListener }
        );
    }



    render(imageId?: string) {
        // Update animations first (this modifies viewport state)
        this.updateAnimations();

        // Check renderer availability synchronously
        if (!this.renderer) {
            return;
        }

        // Use multi-image rendering if in world space mode with multiple images
        if (this.viewport.useWorldSpace && this.images.size > 1) {
            this.renderMultiImage();

            // Request tiles for visible images
            this.requestTilesForAllVisibleImages();

            // Update overlay positions
            if (this.overlayManager) {
                this.overlayManager.updateAllOverlays();
            }
            return;
        }

        // Single image rendering mode
        // If imageId is provided, render only that image, otherwise render first image
        const id = imageId || Array.from(this.images.keys())[0];
        if (!id) {
            console.warn('No image to render');
            return;
        }

        const image = this.images.get(id);
        const tileManager = this.tiles.get(id);

        if (!image || !tileManager) {
            console.warn(`Image or TileManager not found for id: ${id}`);
            return;
        }

        // Get loaded tiles for rendering
        const tiles = tileManager.getLoadedTilesForRender(this.viewport);

        // Get thumbnail for background rendering
        const thumbnail = tileManager.getThumbnail();

        // Render with WebGPU
        this.renderer.render(this.viewport, image, tiles, thumbnail);

        // Update overlay positions to match camera transformations
        if (this.overlayManager) {
            this.overlayManager.updateAllOverlays();
        }
    }

    startRenderLoop(imageId?: string) {
        if (this.renderLoopActive) {
            console.log('Render loop already active');
            return;
        }

        this.renderLoopActive = true;
        console.log('Starting render loop for image:', imageId);

        const loop = () => {
            if (!this.renderLoopActive) {
                console.log('Render loop stopped');
                return;
            }
            this.render(imageId);
            this.animationFrameId = requestAnimationFrame(loop);
        };
        loop();
    }

    stopRenderLoop() {
        console.log('Stopping render loop');
        this.renderLoopActive = false;
        if (this.animationFrameId !== undefined) {
            cancelAnimationFrame(this.animationFrameId);
            this.animationFrameId = undefined;
        }
    }

}

//const viewer = new IIIFViewer(document.getElementById('iiif-container')!);
//viewer.addImage('id', 'https://iiif.harvardartmuseums.org/manifests/object/299843');
//viewer.