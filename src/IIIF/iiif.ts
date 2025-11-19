
import { IIIFImage } from './iiif-image';
import { Viewport } from './iiif-view';
import { TileManager } from './iiif-tile';
import { WebGPURenderer } from './iiif-webgpu';
import { ToolBar } from './iiif-toolbar';
import { AnnotationManager } from './iiif-annotations'
import { GestureHandler } from './iiif-gesture';
import type { EasingFunction } from './easing';
import { easeOutCubic, interpolate } from './easing';

interface Animation {
    type: 'zoom' | 'pan' | 'panX' | 'panY';
    startTime: number;
    duration: number;
    startValue: number;
    targetValue: number;
    easing: EasingFunction;
    imageId: string;
    // For zoom animations - store the canvas point and the image point it maps to
    zoomCanvasX?: number;
    zoomCanvasY?: number;
    zoomImagePointX?: number;
    zoomImagePointY?: number;
}

export class IIIFViewer {
    returnManifest(): any {
        throw new Error('Method not implemented.');
    }
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
    private rendererReady: Promise<void>;
    private renderLoopActive: boolean = false;
    private animationFrameId?: number;
    private animations = new Map<string, Animation>();

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

        // Check if webGPU is supported and initialize renderer
        // This operation is asynchronous so must be in another function
        this.rendererReady = this.initializeRenderer();
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

    async addImage(id: string, url: string) {
        const iiifImage = new IIIFImage(id, url);
        await iiifImage.loadManifest(url);
        this.images.set(id, iiifImage);

        // Pass renderer to TileManager if available
        const tileManager = new TileManager(id, iiifImage, 500, this.renderer, 0.35);

        this.viewport.fitToWidth(iiifImage);
        this.tiles.set(id, tileManager);
        this.tiles.get(id)?.getTilesForViewport(this.viewport);

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

        for (const [key, anim] of this.animations) {
            const elapsed = now - anim.startTime;
            const progress = Math.min(elapsed / anim.duration, 1);
            const easedProgress = anim.easing(progress);

            const currentValue = interpolate(
                anim.startValue,
                anim.targetValue,
                easedProgress
            );

            // Apply animation based on type
            if (anim.type === 'zoom') {
                this.viewport.scale = currentValue;

                // Recalculate center to keep the zoom point stationary
                if (anim.zoomCanvasX !== undefined && anim.zoomCanvasY !== undefined &&
                    anim.zoomImagePointX !== undefined && anim.zoomImagePointY !== undefined) {
                    const image = this.images.get(anim.imageId);
                    if (image) {
                        // Calculate where the center should be to keep the image point under the canvas point
                        // Use currentValue (the animated scale) for consistency
                        const newViewportWidth = this.viewport.containerWidth / currentValue;
                        const newViewportHeight = this.viewport.containerHeight / currentValue;

                        this.viewport.centerX = (anim.zoomImagePointX - (anim.zoomCanvasX / currentValue) + (newViewportWidth / 2)) / image.width;
                        this.viewport.centerY = (anim.zoomImagePointY - (anim.zoomCanvasY / currentValue) + (newViewportHeight / 2)) / image.height;
                    }
                }

                // Update tiles for this image
                const tiles = this.tiles.get(anim.imageId);
                if (tiles) {
                    tiles.getTilesForViewport(this.viewport);
                }
            } else if (anim.type === 'panX') {
                this.viewport.centerX = currentValue;

                const tiles = this.tiles.get(anim.imageId);
                if (tiles) {
                    tiles.getTilesForViewport(this.viewport);
                }
            } else if (anim.type === 'panY') {
                this.viewport.centerY = currentValue;

                const tiles = this.tiles.get(anim.imageId);
                if (tiles) {
                    tiles.getTilesForViewport(this.viewport);
                }
            }

            // Mark completed animations
            if (progress >= 1) {
                completedKeys.push(key);
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

        // Calculate which point in the image is currently at the mouse position
        // Use unclamped bounds values to get the correct image point
        const scaledWidth = this.viewport.containerWidth / this.viewport.scale;
        const scaledHeight = this.viewport.containerHeight / this.viewport.scale;
        const boundsLeft = (this.viewport.centerX * image.width) - (scaledWidth / 2);
        const boundsTop = (this.viewport.centerY * image.height) - (scaledHeight / 2);

        const imagePointX = boundsLeft + (imageX / this.viewport.scale);
        const imagePointY = boundsTop + (imageY / this.viewport.scale);

        // Clamp new scale
        newScale = Math.max(this.viewport.minScale, Math.min(this.viewport.maxScale, newScale));

        // Store the canvas point and the image point it maps to
        this.animations.set('zoom', {
            type: 'zoom',
            startTime: performance.now(),
            duration: 800,
            startValue: this.viewport.scale,
            targetValue: newScale,
            easing: easeOutCubic,
            imageId: id,
            zoomCanvasX: imageX,
            zoomCanvasY: imageY,
            zoomImagePointX: imagePointX,
            zoomImagePointY: imagePointY
        });
    }

    pan(deltaX: number, deltaY: number, id: string) {
        const image = this.images.get(id);
        if (image) {
            this.viewport.pan(deltaX, deltaY, image);
            const tiles = this.tiles.get(id);
            if (tiles) {
                tiles.getTilesForViewport(this.viewport);
            }
        } else {
            console.warn(`Image with ID ${id} not found for panning.`);
        }
    }

    listen(...ids: string[]) {
        const mousedownHandler = (event: MouseEvent) => {
            event.preventDefault();
            const startX = event.clientX;
            const startY = event.clientY;
            const onMouseMove = (moveEvent: MouseEvent) => {
                const deltaX = moveEvent.clientX - startX;
                const deltaY = moveEvent.clientY - startY;
                ids.forEach(id => this.pan(deltaX, deltaY, id));
                //console.log('Mouse move to', moveEvent.clientX, moveEvent.clientY, 'Delta:', deltaX, deltaY);
            };
            const onMouseUp = () => {
                this.container.removeEventListener('mousemove', onMouseMove);
                this.container.removeEventListener('mouseup', onMouseUp);
            };
            //this.container.addEventListener('mousemove', onMouseMove);
            //this.container.addEventListener('mouseup', onMouseUp);
        };

        const wheelHandler = (event: WheelEvent) => {
            //alt or shift key pressed
            if (event.altKey || event.shiftKey) {
                event.preventDefault();
                const zoomFactor = 1.35;
                const rect = this.container.getBoundingClientRect();
                const imageX = event.clientX - rect.left;
                const imageY = event.clientY - rect.top;
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
            this.container.removeEventListener(event, handler);
        });
        this.eventListeners = [];
    }


    async render(imageId?: string) {
        // Update animations first (this modifies viewport state)
        this.updateAnimations();

        // Wait for renderer to be ready
        await this.rendererReady;

        if (!this.renderer) {
            console.warn('Renderer not available');
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
            const loop = async () => {
                if (!this.renderLoopActive) {
                    console.log('Render loop stopped');
                    return;
                }
                await this.render(imageId);
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