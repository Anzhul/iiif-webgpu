import { Viewport } from './iiif-view';
import { World } from './iiif-world';
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
    // For zoom animations - anchor point to keep fixed
    zoomAnchorCanvasX?: number;
    zoomAnchorCanvasY?: number;
    zoomAnchorWorldX?: number;
    zoomAnchorWorldY?: number;
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
        return !(animation.zoomAnchorWorldX !== undefined &&
                 animation.zoomAnchorWorldY !== undefined &&
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
    // Anchor point approach: track which world point should stay under cursor
    anchorWorldX?: number;  // The world point we're anchored to
    anchorWorldY?: number;
    targetCanvasX: number;  // Where the anchor should appear (in canvas pixels)
    targetCanvasY: number;
    currentCanvasX: number; // Smoothly interpolated position
    currentCanvasY: number;
    // Zoom state with trailing
    targetCameraZ: number;  // Target camera Z position
    currentCameraZ: number; // Smoothly interpolated Z position
}

export class Camera {
    viewport: Viewport;
    world: World;
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
        needsUpdate: false
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
            PAN_SIGNIFICANT_THRESHOLD: 1.0,        // Minimum distance to request tiles

            // Zoom animation thresholds (camera Z units)
            ZOOM_ANIMATION_THRESHOLD: 0.5,        // Minimum delta to continue animation
            ZOOM_SNAP_THRESHOLD: 0.5,             // Distance to snap to target
            ZOOM_SIGNIFICANT_THRESHOLD: 0.1       // Minimum delta to request tiles
        }
    } as const;

    constructor(viewport: Viewport, world: World) {
        this.viewport = viewport;
        this.world = world;
    }

    /**
     * Animate camera to a specific position in world coordinates
     * @param worldX - X coordinate in world space
     * @param worldY - Y coordinate in world space
     * @param cameraZ - Target camera Z position
     * @param duration - Animation duration in milliseconds
     * @param easing - Easing function for the animation
     */
    to(
        worldX: number,
        worldY: number,
        cameraZ: number,
        duration = 500,
        easing: EasingFunction = easeOutQuart
    ) {
        // Clamp camera Z to valid range
        const targetCameraZ = Math.max(
            this.viewport.minZ,
            Math.min(this.viewport.maxZ, cameraZ)
        );

        this.startAnimation({
            type: 'to',
            startTime: performance.now(),
            duration,
            startCenterX: this.viewport.centerX,
            startCenterY: this.viewport.centerY,
            startCameraZ: this.viewport.cameraZ,
            targetCenterX: worldX,
            targetCenterY: worldY,
            targetCameraZ,
            easing
        });
    }

    /**
     * Pan the camera by delta amounts in world coordinates
     * @param deltaX - X delta in world units
     * @param deltaY - Y delta in world units
     * @param duration - Animation duration in milliseconds
     * @param easing - Easing function for the animation
     */
    pan(
        deltaX: number,
        deltaY: number,
        duration = 500,
        easing: EasingFunction = easeOutQuart
    ) {
        const targetCenterX = this.viewport.centerX + deltaX;
        const targetCenterY = this.viewport.centerY + deltaY;

        this.startAnimation({
            type: 'pan',
            startTime: performance.now(),
            duration,
            startCenterX: this.viewport.centerX,
            startCenterY: this.viewport.centerY,
            startCameraZ: this.viewport.cameraZ,
            targetCenterX,
            targetCenterY,
            targetCameraZ: this.viewport.cameraZ,
            easing
        });
    }

    /**
     * Zoom the camera to a target scale
     * @param targetScale - Target scale value
     * @param duration - Animation duration in milliseconds
     * @param easing - Easing function for the animation
     * @param anchorCanvasX - Optional canvas X coordinate to keep fixed during zoom
     * @param anchorCanvasY - Optional canvas Y coordinate to keep fixed during zoom
     */
    zoom(
        targetScale: number,
        duration = 500,
        easing: EasingFunction = easeOutQuart,
        anchorCanvasX?: number,
        anchorCanvasY?: number
    ) {
        // Clamp target scale to valid range
        targetScale = Math.max(
            this.viewport.minScale,
            Math.min(this.viewport.maxScale, targetScale)
        );

        // Convert target scale to camera Z position
        const targetCameraZ = (this.viewport.containerHeight / targetScale) / (2 * this.viewport.getTanHalfFov());

        // Clamp to valid Z range
        const clampedCameraZ = Math.max(
            this.viewport.minZ,
            Math.min(this.viewport.maxZ, targetCameraZ)
        );

        // If anchor point is provided, calculate the world point to keep fixed
        let zoomAnchorWorldX: number | undefined;
        let zoomAnchorWorldY: number | undefined;

        if (anchorCanvasX !== undefined && anchorCanvasY !== undefined) {
            const anchorPoint = this.viewport.canvasToWorldPoint(anchorCanvasX, anchorCanvasY);
            zoomAnchorWorldX = anchorPoint.x;
            zoomAnchorWorldY = anchorPoint.y;
        }

        this.startAnimation({
            type: 'zoom',
            startTime: performance.now(),
            duration,
            startCenterX: this.viewport.centerX,
            startCenterY: this.viewport.centerY,
            startCameraZ: this.viewport.cameraZ,
            targetCenterX: this.viewport.centerX,
            targetCenterY: this.viewport.centerY,
            targetCameraZ: clampedCameraZ,
            zoomAnchorCanvasX: anchorCanvasX,
            zoomAnchorCanvasY: anchorCanvasY,
            zoomAnchorWorldX,
            zoomAnchorWorldY,
            easing
        });
    }

    /**
     * Zoom by a factor (convenience method)
     * @param factor - Zoom factor (>1 = zoom in, <1 = zoom out)
     * @param duration - Animation duration in milliseconds
     * @param easing - Easing function for the animation
     */
    zoomByFactor(
        factor: number,
        duration = 500,
        easing: EasingFunction = easeOutQuart
    ) {
        const targetScale = this.viewport.scale * factor;
        this.zoom(targetScale, duration, easing);
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
        return animation.zoomAnchorWorldX !== undefined &&
               animation.zoomAnchorWorldY !== undefined &&
               animation.zoomAnchorCanvasX !== undefined &&
               animation.zoomAnchorCanvasY !== undefined;
    }

    /**
     * Apply zoom anchor point to viewport
     */
    private applyZoomAnchor(animation: CameraAnimation): void {
        if (!this.hasAnchorPoint(animation)) return;

        this.viewport.setCenterFromWorldPoint(
            animation.zoomAnchorWorldX!,
            animation.zoomAnchorWorldY!,
            animation.zoomAnchorCanvasX!,
            animation.zoomAnchorCanvasY!
        );
    }

    /**
     * Request tiles for all visible world images
     */
    private requestTilesImmediate(): void {
        const bounds = this.viewport.getWorldBounds();
        const visibleImages = this.world.getVisibleImages(bounds.left, bounds.top, bounds.right, bounds.bottom);
        for (const worldImage of visibleImages) {
            worldImage.tileManager.requestTilesForViewport(this.viewport);
        }
    }

    /**
     * Hybrid tile request strategy (OpenSeadragon-inspired)
     * - Provides immediate feedback on first movement (max 5/sec)
     * - Debounces during continuous movement (50ms after stopping)
     * - Ensures final position always gets tiles
     */
    private requestTilesHybrid(now: number): void {
        const timeSinceImmediate = now - this.lastImmediateRequestTime;

        // Immediate request for responsiveness (but throttled to 5/sec max)
        if (timeSinceImmediate > this.CONFIG.TILE_IMMEDIATE_THROTTLE) {
            this.requestTilesImmediate();
            this.lastImmediateRequestTime = now;
        }

        // Always schedule debounced request for final position
        if (this.tileUpdateTimer !== null) {
            clearTimeout(this.tileUpdateTimer);
        }

        this.tileUpdateTimer = window.setTimeout(() => {
            this.tileUpdateTimer = null;
            this.requestTilesImmediate();
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
            this.applyZoomAnchor(animation);
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
     * Run the animation loop
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

        // Get strategy for animation type and update viewport
        const strategy = this.getAnimationStrategy(animation.type);
        strategy.updateViewport(this.viewport, easedProgress, animation);

        // Apply zoom anchor point if present (for zoom animations only)
        if (animation.type === 'zoom' && this.hasAnchorPoint(animation)) {
            this.applyZoomAnchor(animation);
        }

        // Request tiles for new position (hybrid strategy)
        this.requestTilesHybrid(now);

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
     * Calculate interactive animation deltas (reuses object to avoid allocation)
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
     * Update zoom animation using trailing effect
     */
    private updateZoomAnimation(zoomDelta: number, zoomAbs: number): void {
        const state = this.interactiveState;
        const config = this.CONFIG.INTERACTIVE;

        // Snap to target when very close to prevent infinite oscillation
        if (zoomAbs < config.ZOOM_SNAP_THRESHOLD) {
            state.currentCameraZ = state.targetCameraZ;
        } else {
            state.currentCameraZ += zoomDelta * config.TRAILING_FACTOR;
        }

        this.viewport.cameraZ = state.currentCameraZ;

        // Only call expensive updateScale() if Z changed significantly
        const zChange = Math.abs(this.viewport.cameraZ - this.lastScaleUpdateZ);
        if (zChange > 1.0) {
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

        if (state.anchorWorldX === undefined || state.anchorWorldY === undefined) {
            return false;
        }

        // Set viewport center so anchor world point appears at current canvas position
        this.viewport.setCenterFromWorldPoint(
            state.anchorWorldX,
            state.anchorWorldY,
            state.currentCanvasX,
            state.currentCanvasY
        );

        return true;
    }

    /**
     * Update interactive animations (trailing effect for both pan and zoom)
     * Should be called every frame when Camera is not running programmatic animations
     */
    updateInteractiveAnimation(): { needsUpdate: boolean } {
        // Skip all work if idle
        if (this.isIdle) {
            return this.updateResult;
        }

        const state = this.interactiveState;
        const config = this.CONFIG.INTERACTIVE;

        const deltas = this.calculateInteractiveDeltas();

        const hasPanAnimation = state.isDragging ||
            deltas.panDistanceSquared > config.PAN_ANIMATION_THRESHOLD_SQ;
        const hasZoomAnimation = deltas.zoomAbs > config.ZOOM_ANIMATION_THRESHOLD;

        // Early exit if no animations (and set idle state)
        if (!hasPanAnimation && !hasZoomAnimation) {
            this.isIdle = true;
            this.updateResult.needsUpdate = false;
            return this.updateResult;
        }

        if (hasPanAnimation) {
            this.updatePanAnimation(deltas.panDeltaX, deltas.panDeltaY);
        }

        if (hasZoomAnimation) {
            this.updateZoomAnimation(deltas.zoomDelta, deltas.zoomAbs);
        }

        const needsUpdate = this.applyInteractiveTransform();

        // Request tiles if movement is significant (throttled)
        if (needsUpdate) {
            const isSignificant =
                deltas.panDistanceSquared > (config.PAN_SIGNIFICANT_THRESHOLD ** 2) ||
                deltas.zoomAbs > config.ZOOM_SIGNIFICANT_THRESHOLD;

            if (isSignificant) {
                this.requestTilesHybrid(performance.now());
            }
        }

        this.updateResult.needsUpdate = needsUpdate;
        return this.updateResult;
    }

    /**
     * Start an interactive pan (mouse down)
     */
    startInteractivePan(canvasX: number, canvasY: number) {
        // Wake up from idle state
        this.isIdle = false;

        this.interactiveState.isDragging = true;

        // Convert to world coordinates to establish anchor point
        const worldPoint = this.viewport.canvasToWorldPoint(canvasX, canvasY);
        this.interactiveState.anchorWorldX = worldPoint.x;
        this.interactiveState.anchorWorldY = worldPoint.y;

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

        this.interactiveState.targetCanvasX = canvasX;
        this.interactiveState.targetCanvasY = canvasY;
    }

    /**
     * End interactive pan (mouse up)
     */
    endInteractivePan() {
        this.interactiveState.isDragging = false;

        // Request tiles for final position
        this.requestTilesImmediate();
    }

    /**
     * Handle wheel event for zooming with trailing effect
     */
    handleWheel(event: WheelEvent, canvasX: number, canvasY: number) {
        event.preventDefault();

        // Wake up from idle state
        this.isIdle = false;

        // Throttle zoom events
        const now = performance.now();
        if (now - this.lastZoomTime < this.CONFIG.ZOOM_THROTTLE) {
            return;
        }
        this.lastZoomTime = now;

        // Zoom factor for each scroll increment
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
        const isFirstInteraction = this.interactiveState.anchorWorldX === undefined;

        // On first interaction, initialize current Z to viewport Z to prevent jump
        if (isFirstInteraction) {
            this.interactiveState.currentCameraZ = this.viewport.cameraZ;
        }

        // Always update anchor to current cursor position for zoom-to-cursor behavior
        const worldPoint = this.viewport.canvasToWorldPoint(canvasX, canvasY);

        this.interactiveState.anchorWorldX = worldPoint.x;
        this.interactiveState.anchorWorldY = worldPoint.y;
        this.interactiveState.targetCanvasX = canvasX;
        this.interactiveState.targetCanvasY = canvasY;

        // On first interaction or when not dragging, snap current position to avoid jump
        if (isFirstInteraction || !this.interactiveState.isDragging) {
            this.interactiveState.currentCanvasX = canvasX;
            this.interactiveState.currentCanvasY = canvasY;
        }
    }

}
