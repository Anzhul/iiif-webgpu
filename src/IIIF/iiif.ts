
import { IIIFImage } from './iiif-image';
import { Viewport } from './iiif-view';
import { TileManager } from './iiif-tile';
import { WebGPURenderer } from './iiif-webgpu';
import { ToolBar } from './iiif-toolbar';
import { AnnotationManager } from './iiif-annotations'
import { GestureHandler } from './iiif-gesture';
import type { EasingFunction } from './easing';
import { easeOutCubic, interpolate } from './easing';

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
    // For zoom animations - store the canvas point and the image point it maps to
    zoomCanvasX?: number;
    zoomCanvasY?: number;
    zoomImagePointX?: number;
    zoomImagePointY?: number;
}

interface PanState {
    isDragging: boolean;
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
        isDragging: false
    };
    private lastTileRequestTime: number = 0;
    private readonly TILE_REQUEST_THROTTLE = 100; // Request tiles max once per 100ms

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

        // Apply zoom animation (if exists)
        const zoomAnim = this.animations.get('zoom');
        if (zoomAnim) {
            const elapsed = now - zoomAnim.startTime;
            const progress = Math.min(elapsed / zoomAnim.duration, 1);
            const easedProgress = zoomAnim.easing(progress);

            // Store the current center and scale before zoom (may have been updated by pan or direct drag)
            const preZoomCenterX = this.viewport.centerX;
            const preZoomCenterY = this.viewport.centerY;
            const preZoomScale = this.viewport.scale;

            // Interpolate scale
            const newScale = interpolate(
                zoomAnim.startTransform.scale,
                zoomAnim.targetTransform.scale,
                easedProgress
            );

            // Apply scale
            this.viewport.scale = newScale;

            // Adjust center to keep the zoom point fixed
            if (zoomAnim.zoomCanvasX !== undefined && zoomAnim.zoomCanvasY !== undefined) {
                const image = this.images.get(zoomAnim.imageId);
                if (image) {
                    // Cache viewport dimensions to avoid redundant calculations
                    const containerWidth = this.viewport.containerWidth;
                    const containerHeight = this.viewport.containerHeight;
                    const imageWidth = image.width;
                    const imageHeight = image.height;

                    // Recalculate which image point is currently under the zoom canvas point
                    // Using the pre-zoom center and scale to account for any panning
                    const preZoomViewportWidth = containerWidth / preZoomScale;
                    const preZoomViewportHeight = containerHeight / preZoomScale;
                    const boundsLeft = (preZoomCenterX * imageWidth) - (preZoomViewportWidth / 2);
                    const boundsTop = (preZoomCenterY * imageHeight) - (preZoomViewportHeight / 2);

                    // What image point is currently under the canvas zoom point?
                    const currentImagePointX = boundsLeft + (zoomAnim.zoomCanvasX / preZoomScale);
                    const currentImagePointY = boundsTop + (zoomAnim.zoomCanvasY / preZoomScale);

                    // Now calculate center that keeps THIS point under the canvas point at new scale
                    const newViewportWidth = containerWidth / newScale;
                    const newViewportHeight = containerHeight / newScale;

                    this.viewport.centerX = (currentImagePointX - (zoomAnim.zoomCanvasX / newScale) + (newViewportWidth / 2)) / imageWidth;
                    this.viewport.centerY = (currentImagePointY - (zoomAnim.zoomCanvasY / newScale) + (newViewportHeight / 2)) / imageHeight;
                }
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

        // Calculate which point in the image is currently at the mouse position
        const scaledWidth = this.viewport.containerWidth / currentScale;
        const scaledHeight = this.viewport.containerHeight / currentScale;
        const boundsLeft = (currentCenterX * image.width) - (scaledWidth / 2);
        const boundsTop = (currentCenterY * image.height) - (scaledHeight / 2);

        const imagePointX = boundsLeft + (imageX / currentScale);
        const imagePointY = boundsTop + (imageY / currentScale);

        // Clamp new scale
        newScale = Math.max(this.viewport.minScale, Math.min(this.viewport.maxScale, newScale));

        // Create zoom animation (can coexist with pan animation)
        this.animations.set('zoom', {
            type: 'zoom',
            startTime: performance.now(),
            duration: 800,
            startTransform: {
                scale: currentScale,
                centerX: currentCenterX,
                centerY: currentCenterY
            },
            targetTransform: {
                scale: newScale,
                centerX: currentCenterX, // Will be recalculated in updateAnimations
                centerY: currentCenterY  // Will be recalculated in updateAnimations
            },
            easing: easeOutCubic,
            imageId: id,
            // Store zoom anchor point for recalculation
            zoomCanvasX: imageX,
            zoomCanvasY: imageY,
            zoomImagePointX: imagePointX,
            zoomImagePointY: imagePointY
        });
    }

    pan(deltaX: number, deltaY: number, id: string) {
        const image = this.images.get(id);
        if (!image) {
            console.warn(`Image with ID ${id} not found for panning.`);
            return;
        }

        const currentScale = this.viewport.scale;

        // Direct viewport update
        this.viewport.centerX -= (deltaX / (currentScale * image.width));
        this.viewport.centerY -= (deltaY / (currentScale * image.height));

        // Request tiles for new viewport position
        const tiles = this.tiles.get(id);
        if (tiles) {
            tiles.requestTilesForViewport(this.viewport);
        }
    }



    listen(...ids: string[]) {
        const mousedownHandler = (event: MouseEvent) => {
            event.preventDefault();

            this.panState.isDragging = true;

            const startX = event.clientX;
            const startY = event.clientY;

            // Store initial viewport state
            const initialCenterX = this.viewport.centerX;
            const initialCenterY = this.viewport.centerY;

            // Cache image dimensions and scale once (only support first image)
            const image = this.images.get(ids[0]);
            if (!image) return;

            const currentScale = this.viewport.scale;
            const imageWidth = image.width;
            const imageHeight = image.height;

            // Track latest mouse position
            let latestDeltaX = 0;
            let latestDeltaY = 0;
            let rafId: number | null = null;

            const onMouseMove = (moveEvent: MouseEvent) => {
                // Just store the latest delta, don't update viewport yet
                latestDeltaX = moveEvent.clientX - startX;
                latestDeltaY = moveEvent.clientY - startY;

                // Schedule update on next frame if not already scheduled
                if (rafId === null) {
                    rafId = requestAnimationFrame(() => {
                        // Update viewport with latest delta
                        this.viewport.centerX = initialCenterX - (latestDeltaX / (currentScale * imageWidth));
                        this.viewport.centerY = initialCenterY - (latestDeltaY / (currentScale * imageHeight));

                        rafId = null; // Ready for next frame
                    });
                }
            };

            const onMouseUp = () => {
                this.panState.isDragging = false;

                // Cancel any pending frame
                if (rafId !== null) {
                    cancelAnimationFrame(rafId);
                }

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
                const zoomFactor = 1.38;
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