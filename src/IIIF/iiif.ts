
import { IIIFImage } from './iiif-image';
import { Viewport } from './iiif-view';
import { TileManager } from './iiif-tile';
import { WebGPURenderer } from './iiif-webgpu';
import { ToolBar } from './iiif-toolbar';
import { AnnotationManager } from './iiif-annotations'
import { GestureHandler } from './iiif-gesture';
import type { EasingFunction } from './easing';
import { easeOutQuart, interpolate } from './easing';

interface ViewportTransform {
    scale: number;
    centerX: number;
    centerY: number;
}

interface Animation {
    type: 'transform' | 'pan' | 'zoom';
    startTime: number;
    duration: number;
    startTransform: ViewportTransform;
    targetTransform: ViewportTransform;
    easing: EasingFunction;
    imageId: string;
    // For zoom animations - store the canvas point for anchor
    zoomCanvasX?: number;
    zoomCanvasY?: number;
}

interface PanState {
    isDragging: boolean;
    // Anchor point approach: track which image point should stay under cursor
    anchorImageX?: number;  // The image point (in image pixels) we're anchored to
    anchorImageY?: number;
    targetCanvasX: number;  // Where the anchor should appear (in canvas pixels)
    targetCanvasY: number;
    currentCanvasX: number; // Smoothly interpolated position
    currentCanvasY: number;
    imageId?: string;
}

export class IIIFViewer {
    container: HTMLElement;
    manifests: any[];
    images: Map<string, IIIFImage>;
    tiles: Map<string, TileManager>;
    viewport: Viewport;
    renderer?: WebGPURenderer;
    toolbar?: ToolBar;
    annotationManager?: AnnotationManager;
    gestureHandler?: GestureHandler;
    gsap?: any;
    private eventListeners: { event: string, handler: EventListener }[];
    private renderLoopActive: boolean = false;
    private animationFrameId?: number;
    private animations = new Map<string, Animation>();
    private cachedContainerRect: DOMRect;
    private panState: PanState = {
        isDragging: false,
        targetCanvasX: 0,
        targetCanvasY: 0,
        currentCanvasX: 0,
        currentCanvasY: 0
    };
    private lastTileRequestTime: number = 0;
    private readonly TILE_REQUEST_THROTTLE = 100; // Request tiles max once per 100ms
    private lastZoomTime: number = 0;
    private readonly ZOOM_THROTTLE = 80; // Minimum ms between zoom events
    private readonly PAN_TRAILING_FACTOR = 0.15; // Lower = more trailing/lag (0.1-0.3 recommended)

    constructor(container: HTMLElement, options: any = {}) {
        this.container = container;
        this.manifests = [];
        this.images = new Map();
        this.tiles = new Map();
        this.viewport = new Viewport(container.clientWidth, container.clientHeight);
        this.toolbar = new ToolBar(container, options.toolbar);
        this.gsap = options.gsap || undefined;

        this.annotationManager = new AnnotationManager();
        this.eventListeners = [];

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

    async addImage(id: string, url: string) {
        const iiifImage = new IIIFImage(id, url);
        await iiifImage.loadManifest(url);
        this.images.set(id, iiifImage);

        // Pass renderer to TileManager if available
        const tileManager = new TileManager(id, iiifImage, 500, this.renderer, 0.35);

        this.viewport.fitToWidth(iiifImage);
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
        const now = performance.now();
        const completedKeys: string[] = [];
        let needsTileUpdate = false;
        let imageId: string | undefined;

        // Handle interactive pan with trailing effect
        if (this.panState.isDragging ||
            Math.abs(this.panState.targetCanvasX - this.panState.currentCanvasX) > 0.5 ||
            Math.abs(this.panState.targetCanvasY - this.panState.currentCanvasY) > 0.5) {

            // Smoothly interpolate current canvas position towards target
            this.panState.currentCanvasX += (this.panState.targetCanvasX - this.panState.currentCanvasX) * this.PAN_TRAILING_FACTOR;
            this.panState.currentCanvasY += (this.panState.targetCanvasY - this.panState.currentCanvasY) * this.PAN_TRAILING_FACTOR;

            // Update viewport using matrix-based transformation
            if (this.panState.anchorImageX !== undefined &&
                this.panState.anchorImageY !== undefined &&
                this.panState.imageId) {

                const image = this.images.get(this.panState.imageId);
                if (image) {
                    // Set viewport center so that anchorImagePoint appears at currentCanvasPoint
                    this.viewport.setCenterFromImagePoint(
                        this.panState.anchorImageX,
                        this.panState.anchorImageY,
                        this.panState.currentCanvasX,
                        this.panState.currentCanvasY,
                        image
                    );

                    needsTileUpdate = true;
                    imageId = this.panState.imageId;
                }
            }
        }

        // Apply zoom animation (if exists)
        const zoomAnim = this.animations.get('zoom');
        if (zoomAnim) {
            const elapsed = now - zoomAnim.startTime;
            const progress = Math.min(elapsed / zoomAnim.duration, 1);
            const easedProgress = zoomAnim.easing(progress);

            // Interpolate scale
            const newScale = interpolate(
                zoomAnim.startTransform.scale,
                zoomAnim.targetTransform.scale,
                easedProgress
            );

            // Adjust center to keep the zoom point fixed using matrix-based transformation
            if (zoomAnim.zoomCanvasX !== undefined && zoomAnim.zoomCanvasY !== undefined) {
                const image = this.images.get(zoomAnim.imageId);
                if (image) {
                    // Get the image point currently under the zoom canvas point
                    const currentImagePoint = this.viewport.canvasToImagePoint(
                        zoomAnim.zoomCanvasX,
                        zoomAnim.zoomCanvasY,
                        image
                    );

                    // Update scale first
                    this.viewport.scale = newScale;

                    // Now set center so that the same image point stays under the canvas point at new scale
                    this.viewport.setCenterFromImagePoint(
                        currentImagePoint.x,
                        currentImagePoint.y,
                        zoomAnim.zoomCanvasX,
                        zoomAnim.zoomCanvasY,
                        image
                    );
                }
            } else {
                // If no zoom point specified, just update scale
                this.viewport.scale = newScale;
            }

            needsTileUpdate = true;
            imageId = zoomAnim.imageId;

            if (progress >= 1) {
                completedKeys.push('zoom');
            }
        }

        // Request tiles with throttling, or immediately if animation is completing
        const isAnimationCompleting = completedKeys.length > 0;

        if (needsTileUpdate && imageId) {
            const timeSinceLastRequest = now - this.lastTileRequestTime;

            // Request tiles if: throttle window passed OR animation is completing
            if (isAnimationCompleting || timeSinceLastRequest > this.TILE_REQUEST_THROTTLE) {
                const tiles = this.tiles.get(imageId);
                if (tiles) {
                    tiles.requestTilesForViewport(this.viewport);
                    this.lastTileRequestTime = now;
                }
            }
        }

        // Remove completed animations
        completedKeys.forEach(key => this.animations.delete(key));
    }

    zoom(newScale: number, imageX: number, imageY: number, id: string) {
        const image = this.images.get(id);

        if (!image) {
            console.warn(`Image with ID ${id} not found for zooming.`);
            return;
        }

        // Get current viewport state (might be mid-animation)
        const currentScale = this.viewport.scale;
        const currentCenterX = this.viewport.centerX;
        const currentCenterY = this.viewport.centerY;

        // Clamp new scale
        newScale = Math.max(this.viewport.minScale, Math.min(this.viewport.maxScale, newScale));

        // Calculate adaptive duration based on zoom distance
        const zoomRatio = Math.abs(Math.log(newScale / currentScale));
        const baseDuration = 700; // Base duration in ms
        const maxDuration = 1000; // Maximum duration in ms
        const duration = Math.min(baseDuration + (zoomRatio * 300), maxDuration);

        // Create zoom animation (can coexist with pan animation)
        this.animations.set('zoom', {
            type: 'zoom',
            startTime: performance.now(),
            duration: duration,
            startTransform: {
                scale: currentScale,
                centerX: currentCenterX,
                centerY: currentCenterY
            },
            targetTransform: {
                scale: newScale,
                centerX: currentCenterX,
                centerY: currentCenterY
            },
            easing: easeOutQuart,
            imageId: id,
            zoomCanvasX: imageX,
            zoomCanvasY: imageY
        });
    }

    pan(deltaX: number, deltaY: number, imageId: string) {
        const image = this.images.get(imageId);
        if (!image) {
            console.warn(`Image with ID ${imageId} not found for panning.`);
            return;
        }

        // Convert delta to normalized coordinates
        const normalizedDx = (deltaX / this.viewport.scale) / image.width;
        const normalizedDy = (deltaY / this.viewport.scale) / image.height;

        // Update viewport center
        this.viewport.centerX += normalizedDx;
        this.viewport.centerY += normalizedDy;
        this.viewport.constrainCenter(image);

        // Request new tiles after panning
        const tiles = this.tiles.get(imageId);
        if (tiles) {
            tiles.requestTilesForViewport(this.viewport);
        }
    }
    
    listen(...ids: string[]) {
        const mousedownHandler = (event: MouseEvent) => {
            event.preventDefault();

            const image = this.images.get(ids[0]);
            if (!image) return;

            this.panState.isDragging = true;
            this.panState.imageId = ids[0];

            // Calculate canvas-relative coordinates
            const canvasX = event.clientX - this.cachedContainerRect.left;
            const canvasY = event.clientY - this.cachedContainerRect.top;

            // Convert to image coordinates to establish anchor point
            const imagePoint = this.viewport.canvasToImagePoint(canvasX, canvasY, image);
            this.panState.anchorImageX = imagePoint.x;
            this.panState.anchorImageY = imagePoint.y;

            // Initialize both target and current to the starting position
            this.panState.targetCanvasX = canvasX;
            this.panState.targetCanvasY = canvasY;
            this.panState.currentCanvasX = canvasX;
            this.panState.currentCanvasY = canvasY;

            const onMouseMove = (moveEvent: MouseEvent) => {
                // Update target canvas position
                const newCanvasX = moveEvent.clientX - this.cachedContainerRect.left;
                const newCanvasY = moveEvent.clientY - this.cachedContainerRect.top;

                this.panState.targetCanvasX = newCanvasX;
                this.panState.targetCanvasY = newCanvasY;
            };

            const onMouseUp = () => {
                this.panState.isDragging = false;

                // Let the animation continue to catch up to target position
                // The updateAnimations loop will stop automatically when caught up

                // Request tiles for final position
                const tiles = this.tiles.get(ids[0]);
                if (tiles) {
                    tiles.requestTilesForViewport(this.viewport);
                }

                this.container.removeEventListener('mousemove', onMouseMove);
                this.container.removeEventListener('mouseup', onMouseUp);
            };

            this.container.addEventListener('mousemove', onMouseMove);
            this.container.addEventListener('mouseup', onMouseUp);
        };

        const wheelHandler = (event: WheelEvent) => {
            //alt or shift key pressed
            if (event.altKey || event.shiftKey) {
                event.preventDefault();

                // Throttle zoom events for smoother experience
                const now = performance.now();
                if (now - this.lastZoomTime < this.ZOOM_THROTTLE) {
                    return;
                }
                this.lastZoomTime = now;

                // Use smaller zoom factor for smoother incremental zooming
                const zoomFactor = 1.35; 
                const imageX = event.clientX - this.cachedContainerRect.left;
                const imageY = event.clientY - this.cachedContainerRect.top;
                const newScale = event.deltaY < 0 ? this.viewport.scale * zoomFactor : this.viewport.scale / zoomFactor;
                ids.forEach(id => this.zoom(newScale, imageX, imageY, id));
            }
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