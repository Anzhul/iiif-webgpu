import { Viewport } from './iiif-view';
import { World } from './iiif-world';
import type { EasingFunction } from './easing';
import { easeOutQuart, interpolate } from './easing';
import { Spring } from './spring';

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
    // Spring animations for smooth, frame-rate independent trailing
    canvasXSpring: Spring;
    canvasYSpring: Spring;
    cameraZSpring: Spring;
}

export class Camera {
    viewport: Viewport;
    world: World;
    private currentAnimation?: CameraAnimation;
    private animationFrameId?: number;
    private interactiveState: InteractiveState = {
        isDragging: false,
        canvasXSpring: new Spring({
            initial: 0,
            springStiffness: 6.5,
            animationTime: 1.2
        }),
        canvasYSpring: new Spring({
            initial: 0,
            springStiffness: 6.5,
            animationTime: 1.2
        }),
        cameraZSpring: new Spring({
            initial: 1,
            springStiffness: 6.5,
            animationTime: 1.2,
            exponential: true
        })
    };
    private lastZoomTime: number = 0;
    private isIdle: boolean = true; // Track idle state for performance

    // Hybrid tile request strategy (immediate + debounced)
    private lastImmediateRequestTime: number = 0;
    private tileUpdateTimer: number | null = null;

    // Animation strategies (reused to avoid allocation)
    private readonly strategies = {
        pan: new PanAnimationStrategy(),
        zoom: new ZoomAnimationStrategy(),
        to: new ToAnimationStrategy()
    };

    // Reusable result object to avoid allocations (performance optimization)
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
            // Spring physics parameters (OpenSeadragon-style)
            SPRING_STIFFNESS: 6.5,      // Higher = faster response (5.0-10.0 typical)
            ANIMATION_TIME: 1.2         // Animation time in seconds (1.0-1.5 typical)
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
            state.canvasXSpring.current.value,
            state.canvasYSpring.current.value
        );

        return true;
    }

    /**
     * Update interactive animations (OpenSeadragon-style spring physics)
     * Should be called every frame when Camera is not running programmatic animations
     */
    updateInteractiveAnimation(): { needsUpdate: boolean } {
        // Skip all work if idle
        if (this.isIdle) {
            return this.updateResult;
        }

        const state = this.interactiveState;

        // Update all springs and check if any are still animating
        const panXAnimating = state.canvasXSpring.update();
        const panYAnimating = state.canvasYSpring.update();
        const zoomAnimating = state.cameraZSpring.update();

        // Only update viewport camera Z when zoom is actively animating
        // This prevents jolts by keeping viewport as source of truth when at rest
        if (zoomAnimating) {
            this.viewport.cameraZ = state.cameraZSpring.current.value;
            this.viewport.updateScale();
        }

        // Apply transform using updated spring values
        const needsUpdate = this.applyInteractiveTransform();

        // Check if we should go idle (no animations and not dragging)
        const isAnimating = state.isDragging || panXAnimating || panYAnimating || zoomAnimating;
        if (!isAnimating) {
            this.isIdle = true;
            // Request final tiles before going idle
            this.requestTilesImmediate();
        } else if (needsUpdate) {
            // Request tiles during animation (throttled)
            this.requestTilesHybrid(performance.now());
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

        // Initialize springs to current position (no jump)
        this.interactiveState.canvasXSpring.resetTo(canvasX);
        this.interactiveState.canvasYSpring.resetTo(canvasY);
        
        // Sync zoom spring to current camera Z
        if (!this.interactiveState.cameraZSpring.current.value || 
            Math.abs(this.interactiveState.cameraZSpring.current.value - this.viewport.cameraZ) > 1.0) {
            this.interactiveState.cameraZSpring.resetTo(this.viewport.cameraZ);
        }
    }

    /**
     * Update pan target position (mouse move during drag)
     */
    updateInteractivePan(canvasX: number, canvasY: number) {
        if (!this.interactiveState.isDragging) return;

        // Animate canvas position with springs for smooth trailing
        this.interactiveState.canvasXSpring.springTo(canvasX);
        this.interactiveState.canvasYSpring.springTo(canvasY);
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
     * Handle wheel event for zooming with spring physics
     */
    handleWheel(event: WheelEvent, canvasX: number, canvasY: number) {
        event.preventDefault();

        // Check if we're coming out of idle (need to sync spring timing)
        const wasIdle = this.isIdle;
        
        // Wake up from idle state
        this.isIdle = false;

        // Throttle zoom events
        const now = performance.now();
        if (now - this.lastZoomTime < this.CONFIG.ZOOM_THROTTLE) {
            return;
        }
        this.lastZoomTime = now;

        // Check if this is the first interactive action
        const isFirstInteraction = this.interactiveState.anchorWorldX === undefined;

        // Always sync zoom spring to viewport when coming out of idle or first interaction
        // This ensures the zoom animation starts from the current viewport position
        if (wasIdle || isFirstInteraction) {
            this.interactiveState.cameraZSpring.resetTo(this.viewport.cameraZ);
        }
        
        // Refresh spring timing when coming out of idle to prevent stale timestamps
        if (wasIdle) {
            this.interactiveState.canvasXSpring.current.time = now;
            this.interactiveState.canvasYSpring.current.time = now;
            this.interactiveState.cameraZSpring.current.time = now;
        }

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

        // Update target zoom using spring
        this.interactiveState.cameraZSpring.springTo(clampedCameraZ);

        // Always update anchor to world point under current cursor for zoom-to-cursor behavior
        const worldPoint = this.viewport.canvasToWorldPoint(canvasX, canvasY);
        
        this.interactiveState.anchorWorldX = worldPoint.x;
        this.interactiveState.anchorWorldY = worldPoint.y;
        
        // Reset canvas springs if cursor moved significantly or first interaction
        const cursorDx = canvasX - this.interactiveState.canvasXSpring.current.value;
        const cursorDy = canvasY - this.interactiveState.canvasYSpring.current.value;
        const cursorMovedSignificantly = (cursorDx * cursorDx + cursorDy * cursorDy) > 100; // 10 pixel threshold
        
        if (isFirstInteraction || cursorMovedSignificantly) {
            this.interactiveState.canvasXSpring.resetTo(canvasX);
            this.interactiveState.canvasYSpring.resetTo(canvasY);
        }
        
        // Always animate to new cursor position for smooth zoom-to-cursor
        this.interactiveState.canvasXSpring.springTo(canvasX);
        this.interactiveState.canvasYSpring.springTo(canvasY);
    }

}
