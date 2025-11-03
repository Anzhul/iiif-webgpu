
import { IIIFImage } from './iiif-image';
import { Viewport } from './iiif-view';
import { TileManager } from './iiif-tile';
import { WebGPURenderer } from './iiif-webgpu';
import { ToolBar } from './iiif-toolbar';
import { AnnotationManager } from './iiif-annotations'
import { GestureHandler } from './iiif-gesture';

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
    private eventListeners: { event: string, handler: EventListener }[];
    private rendererReady: Promise<void>;
    private renderLoopActive: boolean = false;
    private animationFrameId?: number;

    constructor(container: HTMLElement, /*options: any = {}*/) {
        this.container = container;
        this.manifests = [];
        this.images = new Map();
        this.tiles = new Map();
        this.viewport = new Viewport(container.clientWidth, container.clientHeight);
        this.toolbar = new ToolBar(container);
        this.annotationManager = new AnnotationManager();
        this.eventListeners = [];

        // Check if webGPU is supported and initialize renderer
        this.rendererReady = this.initializeRenderer();
    }

    private async initializeRenderer() {
        if (await this.isWebGPUAvailable()) {
            try {
                this.renderer = new WebGPURenderer(this.container);
                await this.renderer.initialize();
                console.log('WebGPU renderer fully initialized');

                // Set renderer for all existing TileManagers
                for (const tileManager of this.tiles.values()) {
                    tileManager.setRenderer(this.renderer);
                }
            } catch (error) {
                console.error('Failed to initialize WebGPU renderer:', error);
                this.renderer = undefined;
            }
        } else {
            console.warn('WebGPU is not available in this browser');
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
        console.log('addImage: Starting to load image...');
        const iiifImage = new IIIFImage(id, url);
        await iiifImage.loadManifest(url);
        console.log('addImage: Manifest loaded');
        this.images.set(id, iiifImage);

        // Pass renderer to TileManager if available
        const tileManager = new TileManager(id, iiifImage, 500, this.renderer);

        this.viewport.fitToWidth(iiifImage);
        this.viewport.getImageBounds(iiifImage);
        this.tiles.set(id, tileManager);
        this.tiles.get(id)?.getOptimalZoomLevel(this.viewport.scale);
        this.viewport.fitToContainer(iiifImage);
        this.tiles.get(id)?.getTilesForViewport(this.viewport);
        console.log('addImage: Complete');
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

    zoom(newScale: number, imageX: number, imageY: number, id: string) {
        const image = this.images.get(id);
        console.log(`Zoom request to scale ${newScale} at (${imageX}, ${imageY}) for image ID ${id}`);
        if (image) {
            this.viewport.zoom(newScale, imageX, imageY, image);
            const tiles = this.tiles.get(id);
            if (tiles) {
                tiles.getTilesForViewport(this.viewport);
                
            }
        } else {
            console.warn(`Image with ID ${id} not found for zooming.`);
        }
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
                const zoomFactor = 1.1;
                const rect = this.container.getBoundingClientRect();
                const imageX = event.clientX - rect.left;
                const imageY = event.clientY - rect.top;
                const newScale = event.deltaY < 0 ? this.viewport.scale * zoomFactor : this.viewport.scale / zoomFactor;
                ids.forEach(id => this.zoom(newScale, imageX, imageY, id));
                console.log(zoomFactor);
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

        // Render with WebGPU
        this.renderer.render(this.viewport, image, tiles);
    }

    startRenderLoop(imageId?: string) {
        if (this.renderLoopActive) {
            console.log('Render loop already active');
            return;
        }

        this.renderLoopActive = true;
        console.log('Starting render loop for image:', imageId);

        const loop = async () => {
            if (!this.renderLoopActive) {
                console.log('Render loop stopped');
                return;
            }

            await this.render(imageId);
            this.animationFrameId = requestAnimationFrame(loop);
        };

        console.log('Calling initial loop()');
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