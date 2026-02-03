
import { IIIFImage } from './iiif-image';
import { Viewport } from './iiif-view';
import { TileManager } from './iiif-tile';
import { WebGPURenderer } from './iiif-webgpu';
import { WebGLRenderer } from './iiif-webgl';
import type { IIIFRenderer, TileRenderData } from './iiif-renderer';
import { ToolBar } from './iiif-toolbar';
import { AnnotationManager } from './iiif-annotations'
import { Camera } from './iiif-camera';
import { IIIFOverlayManager } from './iiif-overlay';
import { World, WorldImage } from './iiif-world';
import type { WorldPlacement } from './iiif-world';

// Re-export overlay and annotation types for convenience
export type { OverlayElement } from './iiif-overlay';
export type { Annotation } from './iiif-annotations';
export { IIIFOverlayManager } from './iiif-overlay';
export type { WorldPlacement } from './iiif-world';

export class IIIFViewer {
    container: HTMLElement;
    manifests: any[];
    world: World;
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

    constructor(container: HTMLElement, options: any = {}) {
        this.container = container;
        this.manifests = [];
        this.world = new World();
        this.viewport = new Viewport(container.clientWidth, container.clientHeight);
        this.toolbar = new ToolBar(container, options.toolbar);
        this.camera = new Camera(this.viewport, this.world);

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
        this.overlayContainer.style.zIndex = '11';

        this.container.appendChild(this.overlayContainer);

        // Initialize overlay manager
        this.overlayManager = new IIIFOverlayManager(
            this.overlayContainer,
            this.viewport
        );
    }

    private async initializeRenderer() {
        if (await this.isWebGPUAvailable()) {
            try {
                console.log('Initializing WebGPU renderer');
                this.renderer = new WebGPURenderer(this.container);
                await this.renderer.initialize();

                // Set renderer for all existing TileManagers
                for (const wi of this.world.worldImages.values()) {
                    wi.tileManager.setRenderer(this.renderer);
                }
            } catch (error) {
                console.error('Failed to initialize WebGPU renderer:', error);
                this.renderer = undefined;
                await this.initializeWebGLFallback();
            }
        } else {
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
            for (const wi of this.world.worldImages.values()) {
                wi.tileManager.setRenderer(this.renderer);
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

        // Request new tiles for all visible images
        const bounds = this.viewport.getWorldBounds();
        const visibleImages = this.world.getVisibleImages(bounds.left, bounds.top, bounds.right, bounds.bottom);
        for (const wi of visibleImages) {
            wi.tileManager.requestTilesForViewport(this.viewport);
        }

        // Update overlay positions after resize
        if (this.overlayManager) {
            this.overlayManager.updateAllOverlays();
        }
    }

    /**
     * Add an image to the viewer
     * @param id - Unique identifier for the image
     * @param url - IIIF Image API info.json URL
     * @param focus - Whether to fit viewport to this image
     * @param placement - Optional world placement (defaults to origin with image dimensions)
     */
    async addImage(id: string, url: string, focus: boolean = false, placement?: WorldPlacement) {
        const iiifImage = new IIIFImage(id, url);
        await iiifImage.loadManifest(url);

        // Default placement: origin at (0,0) with world dimensions = image dimensions
        const worldPlacement: WorldPlacement = placement || {
            worldX: 0,
            worldY: 0,
            worldWidth: iiifImage.width,
            worldHeight: iiifImage.height
        };

        // Create TileManager
        const tileManager = new TileManager(id, iiifImage, 500, this.renderer, 0.35);

        // Create WorldImage and add to world
        const worldImage = new WorldImage(iiifImage, tileManager, worldPlacement);
        tileManager.setWorldImage(worldImage);
        this.world.addImage(id, worldImage);

        if (focus) {
            this.viewport.fitToWorld(this.world.worldWidth, this.world.worldHeight);
        }

        // Request initial tiles for the viewport
        tileManager.requestTilesForViewport(this.viewport);

        // Load low-resolution thumbnail for background
        await tileManager.loadThumbnail();
    }

    private updateAnimations() {
        if (!this.camera.isAnimating()) {
            this.camera.updateInteractiveAnimation();
        }
    }

    /**
     * Zoom to a specific scale value
     * @param targetScale - The target scale to zoom to
     * @param duration - Animation duration in milliseconds
     */
    zoom(targetScale: number, duration = 500) {
        this.camera.zoom(targetScale, duration);
    }

    /**
     * Zoom by a factor
     * @param factor - Zoom factor (>1 = zoom in, <1 = zoom out)
     * @param duration - Animation duration in milliseconds
     */
    zoomByFactor(factor: number, duration = 500) {
        this.camera.zoomByFactor(factor, duration);
    }

    /**
     * Pan by delta amounts in world coordinates
     * @param deltaX - X delta in world units
     * @param deltaY - Y delta in world units
     * @param duration - Animation duration in milliseconds
     */
    pan(deltaX: number, deltaY: number, duration = 500) {
        this.camera.pan(deltaX, deltaY, duration);
    }

    /**
     * Navigate to a specific position in world coordinates
     * @param worldX - X coordinate in world space
     * @param worldY - Y coordinate in world space
     * @param cameraZ - Camera Z distance
     * @param duration - Animation duration in milliseconds
     */
    to(worldX: number, worldY: number, cameraZ: number, duration = 500) {
        this.camera.to(worldX, worldY, cameraZ, duration);
    }

    /**
     * Add an overlay element to the viewer
     * @param overlay - Overlay configuration with world coordinates
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
     * @param annotation - Annotation configuration with world coordinates
     */
    addAnnotation(annotation: {
        id: string;
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

    listen() {
        const mousedownHandler = (event: MouseEvent) => {
            event.preventDefault();

            // Calculate canvas-relative coordinates
            const canvasX = event.clientX - this.cachedContainerRect.left;
            const canvasY = event.clientY - this.cachedContainerRect.top;

            // Start pan via camera (world-space, no imageId needed)
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

            document.addEventListener('mousemove', onMouseMove);
            document.addEventListener('mouseup', cleanup);
            document.addEventListener('mouseleave', cleanup);
        };

        const wheelHandler = (event: WheelEvent) => {
            const canvasX = event.clientX - this.cachedContainerRect.left;
            const canvasY = event.clientY - this.cachedContainerRect.top;
            this.camera.handleWheel(event, canvasX, canvasY);
        };

        this.container.addEventListener('mousedown', mousedownHandler);
        this.container.addEventListener('wheel', wheelHandler);

        this.eventListeners.push(
            { event: 'mousedown', handler: mousedownHandler as EventListener },
            { event: 'wheel', handler: wheelHandler as EventListener }
        );
    }

    render() {
        // Update animations first (this modifies viewport state)
        this.updateAnimations();

        if (!this.renderer) {
            return;
        }

        // Get visible world bounds
        const bounds = this.viewport.getWorldBounds();
        const visibleImages = this.world.getVisibleImages(bounds.left, bounds.top, bounds.right, bounds.bottom);

        if (visibleImages.length === 0) {
            return;
        }

        // Collect all tiles from all visible images
        const allTiles: TileRenderData[] = [];
        let thumbnail: TileRenderData | undefined;

        for (const worldImage of visibleImages) {
            const tiles = worldImage.tileManager.getLoadedTilesForRender(this.viewport);
            allTiles.push(...tiles);

            // Use first available thumbnail
            if (!thumbnail) {
                thumbnail = worldImage.tileManager.getThumbnail();
            }
        }

        // Sort by z for proper layering
        allTiles.sort((a, b) => a.z - b.z);

        // Render all tiles in a single pass
        this.renderer.render(this.viewport, allTiles, thumbnail);

        // Update overlay positions
        if (this.overlayManager) {
            this.overlayManager.updateAllOverlays();
        }
    }

    startRenderLoop() {
        if (this.renderLoopActive) {
            console.log('Render loop already active');
            return;
        }

        this.renderLoopActive = true;
        console.log('Starting render loop');

        const loop = () => {
            if (!this.renderLoopActive) {
                console.log('Render loop stopped');
                return;
            }
            this.render();
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
