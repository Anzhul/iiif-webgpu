
import { IIIFImage } from './iiif-image';
import { Viewport } from './iiif-view';
import { TileManager } from './iiif-tile';
import { WebGPURenderer } from './iiif-webgpu';
import { ToolBar } from './iiif-toolbar';
import { AnnotationManager } from './iiif-annotations'
import { GestureHandler } from './iiif-gesture';
import { ViewportController } from './iiif-viewport-controller';
import { Camera } from './iiif-camera';

export class IIIFViewer {
    container: HTMLElement;
    manifests: any[];
    images: Map<string, IIIFImage>;
    tiles: Map<string, TileManager>;
    viewport: Viewport;
    camera: Camera;
    viewportController: ViewportController;
    renderer?: WebGPURenderer;
    toolbar?: ToolBar;
    annotationManager?: AnnotationManager;
    gestureHandler?: GestureHandler;
    gsap?: any;
    private eventListeners: { event: string, handler: EventListener }[];
    private renderLoopActive: boolean = false;
    private animationFrameId?: number;
    private cachedContainerRect: DOMRect;

    constructor(container: HTMLElement, options: any = {}) {
        this.container = container;
        this.manifests = [];
        this.images = new Map();
        this.tiles = new Map();
        this.viewport = new Viewport(container.clientWidth, container.clientHeight);
        this.toolbar = new ToolBar(container, options.toolbar);
        this.camera = new Camera(this.viewport, this.images, this.tiles);
        this.gsap = options.gsap || undefined;

        this.annotationManager = new AnnotationManager();
        this.eventListeners = [];

        // Initialize viewport controller with camera for unified zoom/pan
        this.viewportController = new ViewportController(this.viewport, this.images, this.tiles, this.camera);

        // Cache the container's bounding rect
        this.cachedContainerRect = container.getBoundingClientRect();

        // Set up resize observer to update cached rect and viewport
        this.setupResizeHandler();

        // Check if webGPU is supported and initialize renderer
        // This operation is asynchronous so must be in another function
        this.initializeRenderer();
    }

    private async initializeRenderer() {
        if (await this.isWebGPUAvailable()) {
            try {
                this.renderer = new WebGPURenderer(this.container);
                await this.renderer.initialize();

                // Set renderer for all existing TileManagers
                for (const tileManager of this.tiles.values()) {
                    tileManager.setRenderer(this.renderer);
                }
            } catch (error) {
                console.error('Failed to initialize WebGPU renderer:', error);
                this.renderer = undefined;
            }
        } else {
            // Add a fallback webGL renderer here later
            console.warn('WebGPU is not available in this browser, defaulting to WebGL (not implemented yet)');
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
    }

    async addImage(id: string, url: string, focus: boolean = false) {
        const iiifImage = new IIIFImage(id, url);
        await iiifImage.loadManifest(url);
        this.images.set(id, iiifImage);

        // Pass renderer to TileManager if available
        const tileManager = new TileManager(id, iiifImage, 500, this.renderer, 0.35);

        if (focus) {
            this.viewport.fitToWidth(iiifImage);
        }
        this.tiles.set(id, tileManager);

        // Request initial tiles for the viewport
        tileManager.requestTilesForViewport(this.viewport);

        // Load low-resolution thumbnail for background
        await tileManager.loadThumbnail();
    }

    async removeImage(id: string) {
        const index = this.images.has(id) ? Array.from(this.images.keys()).indexOf(id) : -1;
        if (index !== -1) {
            this.images.delete(id);
            this.tiles.delete(id);
            console.log(`Image with ID ${id} removed.`);
        } else {
            console.warn(`Image with ID ${id} not found.`);
        }
    }


    private updateAnimations() {
        // Only update ViewportController animations if Camera is not animating
        // This prevents conflicts between programmatic camera animations and interactive viewport animations
        if (!this.camera.isAnimating()) {
            this.viewportController.updateAnimations();
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
    
    listen(...ids: string[]) {
        const mousedownHandler = (event: MouseEvent) => {
            event.preventDefault();

            const image = this.images.get(ids[0]);
            if (!image) return;

            // Calculate canvas-relative coordinates
            const canvasX = event.clientX - this.cachedContainerRect.left;
            const canvasY = event.clientY - this.cachedContainerRect.top;

            // Start pan via controller
            this.viewportController.startPan(canvasX, canvasY, ids[0]);

            let prevCanvasX = canvasX;
            let prevCanvasY = canvasY;

            const onMouseMove = (moveEvent: MouseEvent) => {
                // Update target canvas position
                const newCanvasX = moveEvent.clientX - this.cachedContainerRect.left;
                const newCanvasY = moveEvent.clientY - this.cachedContainerRect.top;

                // Calculate incremental delta from previous position
                const deltaX = newCanvasX - prevCanvasX;
                const deltaY = newCanvasY - prevCanvasY;

                // Update pan via controller
                this.viewportController.updatePan(newCanvasX, newCanvasY, deltaX, deltaY);

                // Update previous position for next move event
                prevCanvasX = newCanvasX;
                prevCanvasY = newCanvasY;
            };

            const onMouseUp = () => {
                // End pan via controller
                this.viewportController.endPan();

                this.container.removeEventListener('mousemove', onMouseMove);
                this.container.removeEventListener('mouseup', onMouseUp);
            };

            this.container.addEventListener('mousemove', onMouseMove);
            this.container.addEventListener('mouseup', onMouseUp);
        };

        const wheelHandler = (event: WheelEvent) => {
            const canvasX = event.clientX - this.cachedContainerRect.left;
            const canvasY = event.clientY - this.cachedContainerRect.top;

            // Handle wheel via controller
            this.viewportController.handleWheel(event, canvasX, canvasY, ids);
        };

        this.container.addEventListener('mousedown', mousedownHandler);
        this.container.addEventListener('wheel', wheelHandler);

        this.eventListeners.push(
            { event: 'mousedown', handler: mousedownHandler as EventListener },
            { event: 'wheel', handler: wheelHandler as EventListener }
        );
    }

    unlisten() {
        this.eventListeners.forEach(({ event, handler }) => {
            if (event === 'resize') {
                window.removeEventListener(event, handler);
            } else {
                this.container.removeEventListener(event, handler);
            }
        });
        this.eventListeners = [];
    }


    render(imageId?: string) {
        // Update animations first (this modifies viewport state)
        this.updateAnimations();

        // Check renderer availability synchronously
        if (!this.renderer) {
            return;
        }

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

        // Get thumbnail for background layer
        const thumbnail = tileManager.getThumbnail();

        // Render with WebGPU
        this.renderer.render(this.viewport, image, tiles, thumbnail);
    }

    startRenderLoop(imageId?: string) {
        if (this.renderLoopActive) {
            console.log('Render loop already active');
            return;
        }

        this.renderLoopActive = true;
        console.log('Starting render loop for image:', imageId);

        if (this.gsap) {
            // Use GSAP ticker for the render loop
            const gsapLoop = () => {
                if (!this.renderLoopActive) {
                    this.gsap!.ticker.remove(gsapLoop);
                    return;
                }
                this.render(imageId);
            };
            this.gsap.ticker.add(gsapLoop);
        } else {
            // Fallback to requestAnimationFrame
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