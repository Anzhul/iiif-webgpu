import { Viewport } from './iiif-view';
import { IIIFImage } from './iiif-image';
import { TileManager } from './iiif-tile';
import type { EasingFunction } from './easing';
import { easeOutQuart, interpolate } from './easing';

interface CameraAnimation {
    type: 'pan' | 'zoom' | 'to';
    startTime: number;
    duration: number;
    startCenterX: number;
    startCenterY: number;
    startCameraZ: number;
    targetCenterX: number;
    targetCenterY: number;
    targetCameraZ: number;
    easing: EasingFunction;
    imageId: string;
    // For zoom animations - anchor point to keep fixed
    zoomAnchorCanvasX?: number;
    zoomAnchorCanvasY?: number;
    zoomAnchorImageX?: number;
    zoomAnchorImageY?: number;
    onUpdate?: () => void;
    onComplete?: () => void;
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

export class Camera {
    viewport: Viewport;
    tiles: Map<string, TileManager>;
    images: Map<string, IIIFImage>;
    private currentAnimation?: CameraAnimation;
    private animationFrameId?: number;
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

    constructor(viewport: Viewport, images: Map<string, IIIFImage>, tiles: Map<string, TileManager>) {
        this.viewport = viewport;
        this.tiles = tiles;
        this.images = images;
    }

    /**
     * Animate camera to a specific position in image coordinates
     * @param imageX - X coordinate in image pixel space
     * @param imageY - Y coordinate in image pixel space
     * @param imageZ - Target camera Z position (distance from image plane)
     * @param imageId - ID of the image to navigate within
     * @param duration - Animation duration in milliseconds
     * @param easing - Easing function for the animation
     */
    to(
        imageX: number,
        imageY: number,
        imageZ: number,
        imageId: string,
        duration = 500,
        easing: EasingFunction = easeOutQuart
    ) {
        const image = this.images.get(imageId);
        if (!image) {
            console.warn(`Image with ID ${imageId} not found`);
            return;
        }

        // Convert image pixel coordinates to normalized coordinates (0-1)
        const targetCenterX = imageX / image.width;
        const targetCenterY = imageY / image.height;

        // Clamp camera Z to valid range
        const targetCameraZ = Math.max(
            this.viewport.minZ,
            Math.min(this.viewport.maxZ, imageZ)
        );

        this.startAnimation({
            type: 'to',
            startTime: performance.now(),
            duration,
            startCenterX: this.viewport.centerX,
            startCenterY: this.viewport.centerY,
            startCameraZ: this.viewport.cameraZ,
            targetCenterX,
            targetCenterY,
            targetCameraZ,
            easing,
            imageId
        });
    }

    /**
     * Pan the camera by delta amounts (in image pixels)
     * @param deltaX - X delta in image pixel space
     * @param deltaY - Y delta in image pixel space
     * @param imageId - ID of the image to pan within
     * @param duration - Animation duration in milliseconds
     * @param easing - Easing function for the animation
     */
    pan(
        deltaX: number,
        deltaY: number,
        imageId: string,
        duration = 500,
        easing: EasingFunction = easeOutQuart
    ) {
        const image = this.images.get(imageId);
        if (!image) {
            console.warn(`Image with ID ${imageId} not found`);
            return;
        }

        // Convert delta to normalized coordinates
        const deltaNormX = deltaX / image.width;
        const deltaNormY = deltaY / image.height;

        // Calculate target position
        const targetCenterX = this.viewport.centerX + deltaNormX;
        const targetCenterY = this.viewport.centerY + deltaNormY;

        this.startAnimation({
            type: 'pan',
            startTime: performance.now(),
            duration,
            startCenterX: this.viewport.centerX,
            startCenterY: this.viewport.centerY,
            startCameraZ: this.viewport.cameraZ,
            targetCenterX,
            targetCenterY,
            targetCameraZ: this.viewport.cameraZ, // Keep Z unchanged for pan
            easing,
            imageId
        });
    }

    /**
     * Zoom the camera to a target scale
     * @param targetScale - Target scale value (like ViewportController.zoom)
     * @param imageId - ID of the image to zoom within
     * @param duration - Animation duration in milliseconds
     * @param easing - Easing function for the animation
     * @param anchorCanvasX - Optional canvas X coordinate to keep fixed during zoom
     * @param anchorCanvasY - Optional canvas Y coordinate to keep fixed during zoom
     */
    zoom(
        targetScale: number,
        imageId: string,
        duration = 500,
        easing: EasingFunction = easeOutQuart,
        anchorCanvasX?: number,
        anchorCanvasY?: number
    ) {
        const image = this.images.get(imageId);
        if (!image) {
            console.warn(`Image with ID ${imageId} not found`);
            return;
        }

        // Clamp target scale to valid range
        targetScale = Math.max(
            this.viewport.minScale,
            Math.min(this.viewport.maxScale, targetScale)
        );

        // Convert target scale to camera Z position
        // scale = containerHeight / visibleHeight
        // visibleHeight = 2 * cameraZ * tan(fov/2)
        // Therefore: cameraZ = (containerHeight / scale) / (2 * tan(fov/2))
        const fovRadians = (this.viewport.fov * Math.PI) / 180;
        const targetCameraZ = (this.viewport.containerHeight / targetScale) / (2 * Math.tan(fovRadians / 2));

        // Clamp to valid Z range
        const clampedCameraZ = Math.max(
            this.viewport.minZ,
            Math.min(this.viewport.maxZ, targetCameraZ)
        );

        // If anchor point is provided, calculate the image point to keep fixed
        let zoomAnchorImageX: number | undefined;
        let zoomAnchorImageY: number | undefined;

        if (anchorCanvasX !== undefined && anchorCanvasY !== undefined) {
            const anchorPoint = this.viewport.canvasToImagePoint(anchorCanvasX, anchorCanvasY, image);
            zoomAnchorImageX = anchorPoint.x;
            zoomAnchorImageY = anchorPoint.y;
        }

        this.startAnimation({
            type: 'zoom',
            startTime: performance.now(),
            duration,
            startCenterX: this.viewport.centerX,
            startCenterY: this.viewport.centerY,
            startCameraZ: this.viewport.cameraZ,
            targetCenterX: this.viewport.centerX, // Will be adjusted during animation if anchor point is set
            targetCenterY: this.viewport.centerY,
            targetCameraZ: clampedCameraZ,
            zoomAnchorCanvasX: anchorCanvasX,
            zoomAnchorCanvasY: anchorCanvasY,
            zoomAnchorImageX,
            zoomAnchorImageY,
            easing,
            imageId
        });
    }

    /**
     * Zoom by a factor (convenience method)
     * @param factor - Zoom factor (>1 = zoom in, <1 = zoom out)
     * @param imageId - ID of the image to zoom within
     * @param duration - Animation duration in milliseconds
     * @param easing - Easing function for the animation
     */
    zoomByFactor(
        factor: number,
        imageId: string,
        duration = 500,
        easing: EasingFunction = easeOutQuart
    ) {
        const targetScale = this.viewport.scale * factor;
        this.zoom(targetScale, imageId, duration, easing);
    }

    /**
     * Start an animation with the given parameters
     */
    private startAnimation(animation: CameraAnimation) {
        // Cancel any existing animation
        if (this.currentAnimation) {
            this.stopAnimation();
        }

        this.currentAnimation = animation;

        // Start the animation loop
        this.runAnimation();
    }

    /**
     * Stop the current animation
     */
    stopAnimation() {
        if (this.animationFrameId !== undefined) {
            cancelAnimationFrame(this.animationFrameId);
            this.animationFrameId = undefined;
        }

        if (this.currentAnimation?.onComplete) {
            this.currentAnimation.onComplete();
        }

        this.currentAnimation = undefined;
    }

    /**
     * Run the animation loop
     */
    private runAnimation() {
        if (!this.currentAnimation) return;

        const now = performance.now();
        const elapsed = now - this.currentAnimation.startTime;
        const progress = Math.min(elapsed / this.currentAnimation.duration, 1);
        const easedProgress = this.currentAnimation.easing(progress);

        if (this.currentAnimation.type === 'pan' || this.currentAnimation.type === 'to') {
            // Interpolate center position
            this.viewport.centerX = interpolate(
                this.currentAnimation.startCenterX,
                this.currentAnimation.targetCenterX,
                easedProgress
            );

            this.viewport.centerY = interpolate(
                this.currentAnimation.startCenterY,
                this.currentAnimation.targetCenterY,
                easedProgress
            );
        }

        if (this.currentAnimation.type === 'zoom' || this.currentAnimation.type === 'to') {
            // Interpolate camera Z
            this.viewport.cameraZ = interpolate(
                this.currentAnimation.startCameraZ,
                this.currentAnimation.targetCameraZ,
                easedProgress
            );

            // Update scale based on new cameraZ
            this.viewport.updateScale();

            // If zoom has an anchor point, adjust center to keep that point fixed
            if (this.currentAnimation.type === 'zoom' &&
                this.currentAnimation.zoomAnchorCanvasX !== undefined &&
                this.currentAnimation.zoomAnchorCanvasY !== undefined &&
                this.currentAnimation.zoomAnchorImageX !== undefined &&
                this.currentAnimation.zoomAnchorImageY !== undefined) {

                const image = this.images.get(this.currentAnimation.imageId);
                if (image) {
                    // Set viewport center so that the anchor image point stays under the canvas point
                    this.viewport.setCenterFromImagePoint(
                        this.currentAnimation.zoomAnchorImageX,
                        this.currentAnimation.zoomAnchorImageY,
                        this.currentAnimation.zoomAnchorCanvasX,
                        this.currentAnimation.zoomAnchorCanvasY,
                        image
                    );
                }
            } else {
                // Only constrain center for non-anchored zoom and 'to' animations
                // Anchored zoom shouldn't be constrained because the anchor point takes priority
                const image = this.images.get(this.currentAnimation.imageId);
                if (image) {
                    this.viewport.constrainCenter(image);
                }
            }
        }

        // Constrain center for pan animations
        if (this.currentAnimation.type === 'pan') {
            const image = this.images.get(this.currentAnimation.imageId);
            if (image) {
                this.viewport.constrainCenter(image);
            }
        }

        // Request tiles for new position
        this.requestTiles(this.currentAnimation.imageId);

        // Call update callback if provided
        if (this.currentAnimation.onUpdate) {
            this.currentAnimation.onUpdate();
        }

        // Continue or complete animation
        if (progress < 1) {
            this.animationFrameId = requestAnimationFrame(() => this.runAnimation());
        } else {
            this.stopAnimation();
        }
    }


    /**
     * Request tiles for the current viewport state
     */
    private requestTiles(imageId: string) {
        const tileManager = this.tiles.get(imageId);
        if (tileManager) {
            tileManager.requestTilesForViewport(this.viewport);
        }
    }

    /**
     * Check if an animation is currently active
     */
    isAnimating(): boolean {
        return this.currentAnimation !== undefined;
    }

    /**
     * Get the current animation type, if any
     */
    getAnimationType(): 'pan' | 'zoom' | 'to' | undefined {
        return this.currentAnimation?.type;
    }

    /**
     * Update interactive pan animations (trailing effect)
     * Should be called every frame when Camera is not running programmatic animations
     * Returns true if tiles need to be updated
     */
    updateInteractivePanAnimation(): { needsUpdate: boolean; imageId?: string } {
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
     * Start an interactive pan (mouse down)
     */
    startInteractivePan(canvasX: number, canvasY: number, imageId: string) {
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
    updateInteractivePan(canvasX: number, canvasY: number) {
        if (!this.panState.isDragging) return;

        // Update target canvas position
        this.panState.targetCanvasX = canvasX;
        this.panState.targetCanvasY = canvasY;
    }

    /**
     * End interactive pan (mouse up)
     */
    endInteractivePan() {
        this.panState.isDragging = false;

        // Let the animation continue to catch up to target position
        // The updateInteractivePan loop will stop automatically when caught up

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

            // Calculate adaptive duration based on zoom distance
            const zoomRatio = Math.abs(Math.log(newScale / this.viewport.scale));
            const baseDuration = 700;
            const maxDuration = 1000;
            const duration = Math.min(baseDuration + (zoomRatio * 300), maxDuration);

            imageIds.forEach(id => this.zoom(newScale, id, duration, undefined, canvasX, canvasY));
        }
    }

    /**
     * Check if interactive pan or programmatic animations are active
     */
    hasActiveAnimations(): boolean {
        return this.isAnimating() ||
               this.panState.isDragging ||
               Math.abs(this.panState.targetCanvasX - this.panState.currentCanvasX) > 0.5 ||
               Math.abs(this.panState.targetCanvasY - this.panState.currentCanvasY) > 0.5;
    }

    /**
     * Get the current pan state (for debugging or external use)
     */
    getPanState(): Readonly<PanState> {
        return this.panState;
    }
}