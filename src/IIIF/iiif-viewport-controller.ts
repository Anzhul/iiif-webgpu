import { Viewport } from './iiif-view';
import { IIIFImage } from './iiif-image';
import { TileManager } from './iiif-tile';
import { Camera } from './iiif-camera';

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

export class ViewportController {
    private viewport: Viewport;
    private images: Map<string, IIIFImage>;
    private tiles: Map<string, TileManager>;
    private camera: Camera;
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

    constructor(
        viewport: Viewport,
        images: Map<string, IIIFImage>,
        tiles: Map<string, TileManager>,
        camera: Camera
    ) {
        this.viewport = viewport;
        this.images = images;
        this.tiles = tiles;
        this.camera = camera;
    }

    /**
     * Update all active animations and pan state
     * Should be called every frame
     * Returns true if tiles need to be updated
     *
     * Note: Zoom animations are now handled by Camera class.
     * This only handles interactive pan with trailing effect.
     */
    updateAnimations(): { needsUpdate: boolean; imageId?: string } {
        const now = performance.now();
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
                    let panTrailingDeltaX = this.panState.targetCanvasX - this.panState.currentCanvasX;
                    let panTrailingDeltaY = this.panState.targetCanvasY - this.panState.currentCanvasY;
                    if (panTrailingDeltaX < 0.5 && panTrailingDeltaX > -0.5) { panTrailingDeltaX = 0; }
                    if (panTrailingDeltaY < 0.5 && panTrailingDeltaY > -0.5) { panTrailingDeltaY = 0; }

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

            // Request tiles with throttling for pan updates
            if (needsTileUpdate && imageId) {
                const timeSinceLastRequest = now - this.lastTileRequestTime;
                if (timeSinceLastRequest > this.TILE_REQUEST_THROTTLE) {
                    const tiles = this.tiles.get(imageId);
                    if (tiles) {
                        tiles.requestTilesForViewport(this.viewport);
                        this.lastTileRequestTime = now;
                    }
                }
            }
        }

        return { needsUpdate: needsTileUpdate, imageId };
    }

    /**
     * Start a zoom animation to a new scale, anchored at a specific canvas point
     * Now delegates to Camera for unified zoom behavior
     */
    zoom(newScale: number, canvasX: number, canvasY: number, imageId: string) {
        const image = this.images.get(imageId);

        if (!image) {
            console.warn(`Image with ID ${imageId} not found for zooming.`);
            return;
        }

        // Calculate adaptive duration based on zoom distance
        const zoomRatio = Math.abs(Math.log(newScale / this.viewport.scale));
        const baseDuration = 700;
        const maxDuration = 1000;
        const duration = Math.min(baseDuration + (zoomRatio * 300), maxDuration);

        // Delegate to Camera for actual zoom with anchor point
        this.camera.zoom(newScale, imageId, duration, undefined, canvasX, canvasY);
    }

    /**
     * Pan the viewport by a delta amount
     */
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

    /**
     * Start an interactive pan (mouse down)
     */
    startPan(canvasX: number, canvasY: number, imageId: string) {
        const image = this.images.get(imageId);
        if (!image) return;

        this.panState.isDragging = true;
        this.panState.imageId = imageId;

        // Convert to image coordinates to establish anchor point
        const imagePoint = this.viewport.canvasToImagePoint(canvasX, canvasY, image);
        this.panState.anchorImageX = imagePoint.x;
        this.panState.anchorImageY = imagePoint.y;

        // Initialize both target and current to the starting position
        this.panState.targetCanvasX = canvasX;
        this.panState.targetCanvasY = canvasY;
        this.panState.currentCanvasX = canvasX;
        this.panState.currentCanvasY = canvasY;
    }

    /**
     * Update pan target position (mouse move during drag)
     */
    updatePan(canvasX: number, canvasY: number, deltaX: number, deltaY: number) {
        if (!this.panState.isDragging) return;

        // Update target canvas position
        this.panState.targetCanvasX = canvasX;
        this.panState.targetCanvasY = canvasY;
    }

    /**
     * End interactive pan (mouse up)
     */
    endPan() {
        this.panState.isDragging = false;

        // Let the animation continue to catch up to target position
        // The updateAnimations loop will stop automatically when caught up

        // Request tiles for final position
        if (this.panState.imageId) {
            const tiles = this.tiles.get(this.panState.imageId);
            if (tiles) {
                tiles.requestTilesForViewport(this.viewport);
            }
        }
    }

    /**
     * Handle wheel event for zooming
     */
    handleWheel(event: WheelEvent, canvasX: number, canvasY: number, imageIds: string[]) {
        // alt or shift key pressed
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
            const newScale = event.deltaY < 0 ? this.viewport.scale * zoomFactor : this.viewport.scale / zoomFactor;
            imageIds.forEach(id => this.zoom(newScale, canvasX, canvasY, id));
        }
    }

    /**
     * Get the current pan state (for debugging or external use)
     */
    getPanState(): Readonly<PanState> {
        return this.panState;
    }

    /**
     * Check if any animations are active
     * Note: Zoom animations are tracked by Camera class
     */
    hasActiveAnimations(): boolean {
        return this.panState.isDragging ||
               Math.abs(this.panState.targetCanvasX - this.panState.currentCanvasX) > 0.5 ||
               Math.abs(this.panState.targetCanvasY - this.panState.currentCanvasY) > 0.5;
    }
}
