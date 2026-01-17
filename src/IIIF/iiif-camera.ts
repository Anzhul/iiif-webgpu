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

/**
 * Strategy pattern for different animation types
 */
interface AnimationStrategy {
    updateViewport(viewport: Viewport, progress: number, animation: CameraAnimation): void;
    shouldConstrainCenter(animation: CameraAnimation): boolean;
}

class PanAnimationStrategy implements AnimationStrategy {
    updateViewport(viewport: Viewport, progress: number, animation: CameraAnimation): void {
        viewport.centerX = interpolate(animation.startCenterX, animation.targetCenterX, progress);
        viewport.centerY = interpolate(animation.startCenterY, animation.targetCenterY, progress);
    }

    shouldConstrainCenter(_animation: CameraAnimation): boolean {
        return true;
    }
}

class ZoomAnimationStrategy implements AnimationStrategy {
    updateViewport(viewport: Viewport, progress: number, animation: CameraAnimation): void {
        viewport.cameraZ = interpolate(animation.startCameraZ, animation.targetCameraZ, progress);
        viewport.updateScale();
    }

    shouldConstrainCenter(animation: CameraAnimation): boolean {
        // Don't constrain if anchor point is set (anchor takes priority)
        return !(animation.zoomAnchorImageX !== undefined &&
                 animation.zoomAnchorImageY !== undefined &&
                 animation.zoomAnchorCanvasX !== undefined &&
                 animation.zoomAnchorCanvasY !== undefined);
    }
}

class ToAnimationStrategy implements AnimationStrategy {
    private panStrategy = new PanAnimationStrategy();
    private zoomStrategy = new ZoomAnimationStrategy();

    updateViewport(viewport: Viewport, progress: number, animation: CameraAnimation): void {
        this.panStrategy.updateViewport(viewport, progress, animation);
        this.zoomStrategy.updateViewport(viewport, progress, animation);
    }

    shouldConstrainCenter(_animation: CameraAnimation): boolean {
        return true;
    }
}

interface InteractiveState {
    isDragging: boolean;
    // Anchor point approach: track which image point should stay under cursor
    anchorImageX?: number;  // The image point (in image pixels) we're anchored to
    anchorImageY?: number;
    targetCanvasX: number;  // Where the anchor should appear (in canvas pixels)
    targetCanvasY: number;
    currentCanvasX: number; // Smoothly interpolated position
    currentCanvasY: number;
    // Zoom state with trailing
    targetCameraZ: number;  // Target camera Z position
    currentCameraZ: number; // Smoothly interpolated Z position
    imageId?: string;
}

export class Camera {
    viewport: Viewport;
    tiles: Map<string, TileManager>;
    images: Map<string, IIIFImage>;
    private currentAnimation?: CameraAnimation;
    private animationFrameId?: number;
    private interactiveState: InteractiveState = {
        isDragging: false,
        targetCanvasX: 0,
        targetCanvasY: 0,
        currentCanvasX: 0,
        currentCanvasY: 0,
        targetCameraZ: 0,
        currentCameraZ: 0
    };
    private lastZoomTime: number = 0;
    private isIdle: boolean = true; // Track idle state for performance
    private lastScaleUpdateZ: number = 0; // Track last Z position when scale was updated

    // Hybrid tile request strategy (immediate + debounced)
    private lastImmediateRequestTime: number = 0;
    private tileUpdateTimer: number | null = null;

    // Animation strategies (reused to avoid allocation)
    private readonly strategies = {
        pan: new PanAnimationStrategy(),
        zoom: new ZoomAnimationStrategy(),
        to: new ToAnimationStrategy()
    };

    // Reusable result objects to avoid allocations (performance optimization)
    private readonly deltasResult = {
        panDeltaX: 0,
        panDeltaY: 0,
        panDistanceSquared: 0,
        zoomDelta: 0,
        zoomAbs: 0
    };

    private readonly updateResult = {
        needsUpdate: false,
        imageId: undefined as string | undefined
    };

    // Configuration constants
    private readonly CONFIG = {
        // Tile request strategy - Hybrid approach (OpenSeadragon-inspired)
        TILE_IMMEDIATE_THROTTLE: 200,   // Max 5 immediate requests/sec for responsiveness
        TILE_DEBOUNCE_DELAY: 50,        // Wait 50ms after movement stops for final request

        // Zoom throttling (ms between wheel events)
        ZOOM_THROTTLE: 80,

        // Interactive animation config
        INTERACTIVE: {
            // Trailing/smoothness factor (0.05-0.15 recommended, lower = more trailing)
            TRAILING_FACTOR: 0.08,

            // Pan animation thresholds (pixels)
            PAN_ANIMATION_THRESHOLD: 0.05,        // Minimum distance to continue animation
            PAN_ANIMATION_THRESHOLD_SQ: 0.0025,   // Squared version for optimization
            PAN_SIGNIFICANT_THRESHOLD: 1.0,       // Minimum distance to request tiles

            // Zoom animation thresholds (camera Z units)
            ZOOM_ANIMATION_THRESHOLD: 0.5,        // Minimum delta to continue animation
            ZOOM_SNAP_THRESHOLD: 0.5,             // Distance to snap to target
            ZOOM_SIGNIFICANT_THRESHOLD: 0.1       // Minimum delta to request tiles
        }
    } as const;

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
        const targetCameraZ = (this.viewport.containerHeight / targetScale) / (2 * this.viewport.getTanHalfFov());

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
        // Cancel any existing animation to prevent leaks
        if (this.currentAnimation || this.animationFrameId !== undefined) {
            this.stopAnimation();
        }

        this.currentAnimation = animation;

        // Schedule the animation loop on the next frame
        this.animationFrameId = requestAnimationFrame(() => this.runAnimation());
    }

    /**
     * Stop the current animation
     */
    stopAnimation() {
        // Cancel animation frame first to prevent any further execution
        if (this.animationFrameId !== undefined) {
            cancelAnimationFrame(this.animationFrameId);
            this.animationFrameId = undefined;
        }

        // Store onComplete callback before clearing currentAnimation
        const onComplete = this.currentAnimation?.onComplete;

        // Clear current animation to prevent re-entry
        this.currentAnimation = undefined;

        // Call onComplete callback after clearing state
        if (onComplete) {
            onComplete();
        }
    }

    /**
     * Get the animation strategy for a given type
     */
    private getAnimationStrategy(type: 'pan' | 'zoom' | 'to'): AnimationStrategy {
        return this.strategies[type];
    }

    /**
     * Check if animation has anchor point defined
     */
    private hasAnchorPoint(animation: CameraAnimation): boolean {
        return animation.zoomAnchorImageX !== undefined &&
               animation.zoomAnchorImageY !== undefined &&
               animation.zoomAnchorCanvasX !== undefined &&
               animation.zoomAnchorCanvasY !== undefined;
    }

    /**
     * Apply zoom anchor point to viewport
     */
    private applyZoomAnchor(animation: CameraAnimation, image: IIIFImage): void {
        if (!this.hasAnchorPoint(animation)) return;

        this.viewport.setCenterFromImagePoint(
            animation.zoomAnchorImageX!,
            animation.zoomAnchorImageY!,
            animation.zoomAnchorCanvasX!,
            animation.zoomAnchorCanvasY!,
            image
        );
    }

    /**
     * Request tiles immediately (without debounce)
     * Used for immediate feedback on first interaction
     */
    private requestTilesImmediate(imageId: string): void {
        const tileManager = this.tiles.get(imageId);
        if (tileManager) {
            tileManager.requestTilesForViewport(this.viewport);
        }
    }

    /**
     * Hybrid tile request strategy (OpenSeadragon-inspired)
     * - Provides immediate feedback on first movement (max 5/sec)
     * - Debounces during continuous movement (50ms after stopping)
     * - Ensures final position always gets tiles
     *
     * This reduces tile requests from 40/sec to ~6/sec during continuous pan
     * while maintaining excellent responsiveness
     */
    private requestTilesHybrid(imageId: string, now: number): void {
        const timeSinceImmediate = now - this.lastImmediateRequestTime;

        // Immediate request for responsiveness (but throttled to 5/sec max)
        if (timeSinceImmediate > this.CONFIG.TILE_IMMEDIATE_THROTTLE) {
            this.requestTilesImmediate(imageId);
            this.lastImmediateRequestTime = now;
        }

        // Always schedule debounced request for final position
        // Clear any existing timer
        if (this.tileUpdateTimer !== null) {
            clearTimeout(this.tileUpdateTimer);
        }

        // Schedule new request after movement stops
        this.tileUpdateTimer = window.setTimeout(() => {
            this.tileUpdateTimer = null;
            this.requestTilesImmediate(imageId);
        }, this.CONFIG.TILE_DEBOUNCE_DELAY);
    }

    /**
     * Complete animation by snapping to final values
     */
    private completeAnimation(animation: CameraAnimation): void {
        // Snap to final values using strategy
        const strategy = this.getAnimationStrategy(animation.type);
        strategy.updateViewport(this.viewport, 1.0, animation);

        // Apply zoom anchor if present
        if (animation.type === 'zoom') {
            const image = this.images.get(animation.imageId);
            if (image) {
                this.applyZoomAnchor(animation, image);
            }
        }

        // Ensure final state is constrained
        const image = this.images.get(animation.imageId);
        if (image && strategy.shouldConstrainCenter(animation)) {
            this.viewport.constrainCenter(image);
        }

        this.stopAnimation();
    }

    /**
     * Clean up animation frame without calling callbacks
     */
    private cleanupAnimationFrame(): void {
        if (this.animationFrameId !== undefined) {
            cancelAnimationFrame(this.animationFrameId);
            this.animationFrameId = undefined;
        }
    }

    /**
     * Run the animation loop (REFACTORED)
     */
    private runAnimation() {
        const animation = this.currentAnimation;

        // Early exit if no animation exists
        if (!animation) {
            this.cleanupAnimationFrame();
            return;
        }

        const now = performance.now();
        const elapsed = now - animation.startTime;

        // Early completion optimization - snap to final values
        if (elapsed >= animation.duration) {
            this.completeAnimation(animation);
            return;
        }

        const progress = elapsed / animation.duration;
        const easedProgress = animation.easing(progress);

        // Cache image lookup (used multiple times)
        const image = this.images.get(animation.imageId);
        if (!image) {
            console.warn(`Animation image ${animation.imageId} not found`);
            this.stopAnimation();
            return;
        }

        // Get strategy for animation type and update viewport
        const strategy = this.getAnimationStrategy(animation.type);
        strategy.updateViewport(this.viewport, easedProgress, animation);

        // Apply zoom anchor point if present (for zoom animations only)
        if (animation.type === 'zoom' && this.hasAnchorPoint(animation)) {
            this.applyZoomAnchor(animation, image);
        }

        // Apply constraints if strategy requires it
        if (strategy.shouldConstrainCenter(animation)) {
            this.viewport.constrainCenter(image);
        }

        // Request tiles for new position (hybrid strategy)
        this.requestTilesHybrid(animation.imageId, now);

        
        // Call update callback if provided
        animation.onUpdate?.();

        // Continue animation
        this.animationFrameId = requestAnimationFrame(() => this.runAnimation());
    }


    /**
     * Check if an animation is currently active
     */
    isAnimating(): boolean {
        return this.currentAnimation !== undefined;
    }


    /**
     * Calculate interactive animation deltas (OPTIMIZED - reuses object to avoid allocation)
     * Updates the shared deltasResult object and returns it
     */
    private calculateInteractiveDeltas() {
        const state = this.interactiveState;

        this.deltasResult.panDeltaX = state.targetCanvasX - state.currentCanvasX;
        this.deltasResult.panDeltaY = state.targetCanvasY - state.currentCanvasY;
        this.deltasResult.panDistanceSquared =
            this.deltasResult.panDeltaX * this.deltasResult.panDeltaX +
            this.deltasResult.panDeltaY * this.deltasResult.panDeltaY;

        this.deltasResult.zoomDelta = state.targetCameraZ - state.currentCameraZ;
        this.deltasResult.zoomAbs = Math.abs(this.deltasResult.zoomDelta);

        return this.deltasResult;
    }

    /**
     * Update pan animation using trailing effect
     */
    private updatePanAnimation(panDeltaX: number, panDeltaY: number): void {
        const factor = this.CONFIG.INTERACTIVE.TRAILING_FACTOR;
        this.interactiveState.currentCanvasX += panDeltaX * factor;
        this.interactiveState.currentCanvasY += panDeltaY * factor;
    }

    /**
     * Update zoom animation using trailing effect (OPTIMIZED)
     * Only updates scale when Z changes significantly (performance optimization)
     */
    private updateZoomAnimation(zoomDelta: number, zoomAbs: number): void {
        const state = this.interactiveState;
        const config = this.CONFIG.INTERACTIVE;

        // Snap to target when very close to prevent infinite oscillation
        if (zoomAbs < config.ZOOM_SNAP_THRESHOLD) {
            state.currentCameraZ = state.targetCameraZ;
        } else {
            // Exponential decay for smooth approach
            state.currentCameraZ += zoomDelta * config.TRAILING_FACTOR;
        }

        // Update viewport Z
        this.viewport.cameraZ = state.currentCameraZ;

        // OPTIMIZATION: Only call expensive updateScale() if Z changed significantly
        // This avoids 9 arithmetic operations + cache clear on tiny changes
        const zChange = Math.abs(this.viewport.cameraZ - this.lastScaleUpdateZ);
        if (zChange > 1.0) {  // Threshold: 1 unit change
            this.viewport.updateScale();
            this.lastScaleUpdateZ = this.viewport.cameraZ;
        }
    }

    /**
     * Apply interactive transform (anchor point transformation)
     * Returns true if transform was applied
     */
    private applyInteractiveTransform(): boolean {
        const state = this.interactiveState;

        if (state.anchorImageX === undefined ||
            state.anchorImageY === undefined ||
            !state.imageId) {
            return false;
        }

        const image = this.images.get(state.imageId);
        if (!image) {
            return false;
        }

        // Set viewport center so anchor image point appears at current canvas position
        this.viewport.setCenterFromImagePoint(
            state.anchorImageX,
            state.anchorImageY,
            state.currentCanvasX,
            state.currentCanvasY,
            image
        );

        return true;
    }

    /**
     * Update interactive animations (trailing effect for both pan and zoom)
     * Should be called every frame when Camera is not running programmatic animations
     *
     * OPTIMIZED: Avoids duplicate calculations, uses idle state, reuses result objects
     */
    updateInteractiveAnimation(): { needsUpdate: boolean; imageId?: string } {
        // OPTIMIZATION: Skip all work if idle (most of the time)
        if (this.isIdle) {
            return this.updateResult;
        }

        const state = this.interactiveState;
        const config = this.CONFIG.INTERACTIVE;

        // OPTIMIZATION: Calculate deltas ONCE (not twice like before)
        const deltas = this.calculateInteractiveDeltas();

        // Check if any animations are active using pre-calculated deltas
        const hasPanAnimation = state.isDragging ||
            deltas.panDistanceSquared > config.PAN_ANIMATION_THRESHOLD_SQ;
        const hasZoomAnimation = deltas.zoomAbs > config.ZOOM_ANIMATION_THRESHOLD;

        // Early exit if no animations (and set idle state)
        if (!hasPanAnimation && !hasZoomAnimation) {
            this.isIdle = true;  // Go to sleep until next interaction
            this.updateResult.needsUpdate = false;
            this.updateResult.imageId = undefined;
            return this.updateResult;
        }

        // Update pan animation with trailing effect
        if (hasPanAnimation) {
            this.updatePanAnimation(deltas.panDeltaX, deltas.panDeltaY);
        }

        // Update zoom animation with trailing effect
        if (hasZoomAnimation) {
            this.updateZoomAnimation(deltas.zoomDelta, deltas.zoomAbs);
        }

        // Apply viewport transformation using anchor point
        const needsUpdate = this.applyInteractiveTransform();

        // Request tiles if movement is significant (throttled)
        if (needsUpdate && state.imageId) {
            const isSignificant =
                deltas.panDistanceSquared > (config.PAN_SIGNIFICANT_THRESHOLD ** 2) ||
                deltas.zoomAbs > config.ZOOM_SIGNIFICANT_THRESHOLD;

            if (isSignificant) {
                this.requestTilesHybrid(state.imageId, performance.now());
            }
        }

        // OPTIMIZATION: Reuse result object instead of allocating new one
        this.updateResult.needsUpdate = needsUpdate;
        this.updateResult.imageId = needsUpdate ? state.imageId : undefined;
        return this.updateResult;
    }

    /**
     * Start an interactive pan (mouse down)
     */
    startInteractivePan(canvasX: number, canvasY: number, imageId: string) {
        const image = this.images.get(imageId);
        if (!image) return;

        // OPTIMIZATION: Wake up from idle state
        this.isIdle = false;

        this.interactiveState.isDragging = true;
        this.interactiveState.imageId = imageId;

        // Convert to image coordinates to establish anchor point
        const imagePoint = this.viewport.canvasToImagePoint(canvasX, canvasY, image);
        this.interactiveState.anchorImageX = imagePoint.x;
        this.interactiveState.anchorImageY = imagePoint.y;

        // Initialize both target and current to the starting position
        this.interactiveState.targetCanvasX = canvasX;
        this.interactiveState.targetCanvasY = canvasY;
        this.interactiveState.currentCanvasX = canvasX;
        this.interactiveState.currentCanvasY = canvasY;

        // Initialize zoom state to current viewport state
        this.interactiveState.targetCameraZ = this.viewport.cameraZ;
        this.interactiveState.currentCameraZ = this.viewport.cameraZ;
        this.lastScaleUpdateZ = this.viewport.cameraZ;
    }

    /**
     * Update pan target position (mouse move during drag)
     */
    updateInteractivePan(canvasX: number, canvasY: number) {
        if (!this.interactiveState.isDragging) return;

        // Update target canvas position
        this.interactiveState.targetCanvasX = canvasX;
        this.interactiveState.targetCanvasY = canvasY;
    }

    /**
     * End interactive pan (mouse up)
     */
    endInteractivePan() {
        this.interactiveState.isDragging = false;

        // Let the animation continue to catch up to target position
        // The updateInteractivePan loop will stop automatically when caught up

        // Request tiles for final position
        if (this.interactiveState.imageId) {
            const tiles = this.tiles.get(this.interactiveState.imageId);
            if (tiles) {
                tiles.requestTilesForViewport(this.viewport);
            }
        }
    }

    /**
     * Handle wheel event for zooming with trailing effect
     */
    handleWheel(event: WheelEvent, canvasX: number, canvasY: number, imageIds: string[]) {
        event.preventDefault();

        // OPTIMIZATION: Wake up from idle state
        this.isIdle = false;

        // Throttle zoom events for smoother experience
        const now = performance.now();
        if (now - this.lastZoomTime < this.CONFIG.ZOOM_THROTTLE) {
            return;
        }
        this.lastZoomTime = now;

        // Zoom factor for each scroll increment
        // deltaY < 0 = scroll up (away from user) = zoom in
        const zoomFactor = 1.5;
        const newScale = event.deltaY < 0 ? this.viewport.scale * zoomFactor : this.viewport.scale / zoomFactor;

        // Clamp to valid scale range
        const clampedScale = Math.max(
            this.viewport.minScale,
            Math.min(this.viewport.maxScale, newScale)
        );

        // Convert scale to camera Z
        const targetCameraZ = (this.viewport.containerHeight / clampedScale) / (2 * this.viewport.getTanHalfFov());

        // Clamp to valid Z range
        const clampedCameraZ = Math.max(
            this.viewport.minZ,
            Math.min(this.viewport.maxZ, targetCameraZ)
        );

        // Update target zoom for trailing animation
        this.interactiveState.targetCameraZ = clampedCameraZ;

        // Check if this is the first interactive action
        const isFirstInteraction = this.interactiveState.anchorImageX === undefined;

        // On first interaction, initialize current Z to viewport Z to prevent jump
        if (isFirstInteraction) {
            this.interactiveState.currentCameraZ = this.viewport.cameraZ;
        }

        // Initialize imageId if not already set
        if (!this.interactiveState.imageId && imageIds.length > 0) {
            this.interactiveState.imageId = imageIds[0];
        }

        // Always update anchor to current cursor position for zoom-to-cursor behavior
        if (this.interactiveState.imageId && imageIds.length > 0) {
            const image = this.images.get(imageIds[0]);
            if (image) {
                // Get the image point under the current cursor position
                const imagePoint = this.viewport.canvasToImagePoint(canvasX, canvasY, image);

                // Update anchor to keep this image point under the cursor as we zoom
                this.interactiveState.anchorImageX = imagePoint.x;
                this.interactiveState.anchorImageY = imagePoint.y;
                this.interactiveState.targetCanvasX = canvasX;
                this.interactiveState.targetCanvasY = canvasY;

                // On first interaction or when not dragging, snap current position to avoid jump
                if (isFirstInteraction || !this.interactiveState.isDragging) {
                    this.interactiveState.currentCanvasX = canvasX;
                    this.interactiveState.currentCanvasY = canvasY;
                }
            }
        }
    }

}