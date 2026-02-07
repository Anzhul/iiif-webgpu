import { Viewport } from './iiif-view';
import { World } from './iiif-world';
import type { EasingFunction } from './easing';
import { easeOutQuart } from './easing';
import { Spring } from './spring';

/**
 * Camera system with spring-based interactive animations and easing-based programmatic animations.
 *
 * Design principles:
 * - Single source of truth: Viewport holds all state (centerX, centerY, cameraZ)
 * - Springs are transient animation state, never the source of truth
 * - Cursor is always the zoom focal point for interactive zooms
 * - Anchor point approach: track world point under cursor, keep it fixed during zoom
 */

interface ProgrammaticAnimation {
    type: 'pan' | 'zoom' | 'to';
    startTime: number;
    duration: number;
    // Start values
    startCenterX: number;
    startCenterY: number;
    startCameraZ: number;
    // Target values
    targetCenterX: number;
    targetCenterY: number;
    targetCameraZ: number;
    // Easing
    easing: EasingFunction;
    // Zoom anchor (optional — for zoom-to-point)
    zoomAnchorCanvasX?: number;
    zoomAnchorCanvasY?: number;
    zoomAnchorWorldX?: number;
    zoomAnchorWorldY?: number;
}

interface InteractiveState {
    // Track which world point is under the cursor (anchor point approach)
    anchorWorldX?: number;
    anchorWorldY?: number;
    // Springs for smooth animation (transient state, not source of truth)
    canvasXSpring: Spring;
    canvasYSpring: Spring;
    cameraZSpring: Spring;
    // Interaction flags
    isDragging: boolean;
    isIdle: boolean;
}

export class Camera {
    viewport: Viewport;
    world: World;

    private programmaticAnimation?: ProgrammaticAnimation;
    private animationFrameId?: number;

    private interactiveState: InteractiveState;

    private lastZoomTime: number = 0;
    private lastImmediateRequestTime: number = 0;
    private tileUpdateTimer: number | null = null;

    private readonly CONFIG = {
        TILE_IMMEDIATE_THROTTLE: 200,  // 5 requests/sec max
        TILE_DEBOUNCE_DELAY: 50,       // 50ms debounce
        ZOOM_THROTTLE: 80,              // 80ms between wheel events
        SPRING_STIFFNESS: 6.5,
        ANIMATION_TIME: 1.2
    } as const;

    constructor(viewport: Viewport, world: World) {
        this.viewport = viewport;
        this.world = world;

        // Initialize interactive state with springs
        this.interactiveState = {
            anchorWorldX: undefined,
            anchorWorldY: undefined,
            canvasXSpring: new Spring({
                initial: 0,
                springStiffness: this.CONFIG.SPRING_STIFFNESS,
                animationTime: this.CONFIG.ANIMATION_TIME
            }),
            canvasYSpring: new Spring({
                initial: 0,
                springStiffness: this.CONFIG.SPRING_STIFFNESS,
                animationTime: this.CONFIG.ANIMATION_TIME
            }),
            cameraZSpring: new Spring({
                initial: viewport.cameraZ,
                springStiffness: this.CONFIG.SPRING_STIFFNESS,
                animationTime: this.CONFIG.ANIMATION_TIME,
                exponential: true  // Exponential for zoom feels consistent
            }),
            isDragging: false,
            isIdle: true
        };
    }

    // ============================================================
    // PUBLIC API - Programmatic Animations
    // ============================================================

    /**
     * Navigate to a specific world position and zoom level
     */
    to(worldX: number, worldY: number, cameraZ: number, duration = 500, easing: EasingFunction = easeOutQuart) {
        const clampedZ = Math.max(this.viewport.minZ, Math.min(this.viewport.maxZ, cameraZ));

        this.startProgrammaticAnimation({
            type: 'to',
            startTime: performance.now(),
            duration,
            startCenterX: this.viewport.centerX,
            startCenterY: this.viewport.centerY,
            startCameraZ: this.viewport.cameraZ,
            targetCenterX: worldX,
            targetCenterY: worldY,
            targetCameraZ: clampedZ,
            easing
        });
    }

    /**
     * Pan by delta in world coordinates
     */
    pan(deltaX: number, deltaY: number, duration = 500, easing: EasingFunction = easeOutQuart) {
        this.startProgrammaticAnimation({
            type: 'pan',
            startTime: performance.now(),
            duration,
            startCenterX: this.viewport.centerX,
            startCenterY: this.viewport.centerY,
            startCameraZ: this.viewport.cameraZ,
            targetCenterX: this.viewport.centerX + deltaX,
            targetCenterY: this.viewport.centerY + deltaY,
            targetCameraZ: this.viewport.cameraZ,
            easing
        });
    }

    /**
     * Zoom to a target scale, optionally anchored to a canvas point
     */
    zoom(
        targetScale: number,
        duration = 500,
        easing: EasingFunction = easeOutQuart,
        anchorCanvasX?: number,
        anchorCanvasY?: number
    ) {
        const clampedScale = Math.max(
            this.viewport.minScale,
            Math.min(this.viewport.maxScale, targetScale)
        );

        // Convert scale to cameraZ
        const targetCameraZ = (this.viewport.containerHeight / clampedScale) / (2 * this.viewport.getTanHalfFov());
        const clampedZ = Math.max(this.viewport.minZ, Math.min(this.viewport.maxZ, targetCameraZ));

        // Capture anchor point if provided
        let zoomAnchorWorldX: number | undefined;
        let zoomAnchorWorldY: number | undefined;

        if (anchorCanvasX !== undefined && anchorCanvasY !== undefined) {
            const anchor = this.viewport.canvasToWorldPoint(anchorCanvasX, anchorCanvasY);
            zoomAnchorWorldX = anchor.x;
            zoomAnchorWorldY = anchor.y;
        }

        this.startProgrammaticAnimation({
            type: 'zoom',
            startTime: performance.now(),
            duration,
            startCenterX: this.viewport.centerX,
            startCenterY: this.viewport.centerY,
            startCameraZ: this.viewport.cameraZ,
            targetCenterX: this.viewport.centerX,
            targetCenterY: this.viewport.centerY,
            targetCameraZ: clampedZ,
            zoomAnchorCanvasX: anchorCanvasX,
            zoomAnchorCanvasY: anchorCanvasY,
            zoomAnchorWorldX,
            zoomAnchorWorldY,
            easing
        });
    }

    /**
     * Zoom by factor (convenience)
     */
    zoomByFactor(factor: number, duration = 500, easing: EasingFunction = easeOutQuart) {
        this.zoom(this.viewport.scale * factor, duration, easing);
    }

    isAnimating(): boolean {
        return this.programmaticAnimation !== undefined;
    }

    stopAnimation() {
        if (this.animationFrameId !== undefined) {
            cancelAnimationFrame(this.animationFrameId);
            this.animationFrameId = undefined;
        }
        this.programmaticAnimation = undefined;
    }

    // ============================================================
    // PUBLIC API - Interactive Animations (called from main loop)
    // ============================================================

    /**
     * Update interactive spring animations. Call this every frame from the main render loop.
     */
    updateInteractiveAnimation(): { needsUpdate: boolean } {
        if (this.interactiveState.isIdle) {
            return { needsUpdate: false };
        }

        const state = this.interactiveState;

        // Update all springs
        const panXAnimating = state.canvasXSpring.update();
        const panYAnimating = state.canvasYSpring.update();
        const zoomAnimating = state.cameraZSpring.update();

        // Sync viewport from spring (single source of truth)
        if (zoomAnimating) {
            this.viewport.cameraZ = state.cameraZSpring.current.value;
            this.viewport.updateScale();
        }

        // Apply anchor point transformation
        const needsUpdate = this.applyAnchorTransform();

        // Check if idle
        const isAnimating = state.isDragging || panXAnimating || panYAnimating || zoomAnimating;
        if (!isAnimating) {
            this.interactiveState.isIdle = true;
            this.requestTilesImmediate();
        } else if (needsUpdate) {
            this.requestTilesHybrid(performance.now());
        }

        return { needsUpdate };
    }

    /**
     * Start pan (mousedown)
     */
    startInteractivePan(canvasX: number, canvasY: number) {
        this.interactiveState.isIdle = false;
        this.interactiveState.isDragging = true;

        // Establish anchor: world point under cursor
        const worldPoint = this.viewport.canvasToWorldPoint(canvasX, canvasY);
        this.interactiveState.anchorWorldX = worldPoint.x;
        this.interactiveState.anchorWorldY = worldPoint.y;

        // Reset springs to current position (no jump)
        this.interactiveState.canvasXSpring.resetTo(canvasX);
        this.interactiveState.canvasYSpring.resetTo(canvasY);

        // Sync zoom spring to viewport (single source of truth)
        const currentZ = this.viewport.cameraZ;
        if (!this.interactiveState.cameraZSpring.current.value ||
            Math.abs(this.interactiveState.cameraZSpring.current.value / currentZ - 1) > 0.01) {
            this.interactiveState.cameraZSpring.resetTo(currentZ);
        }
    }

    /**
     * Update pan (mousemove)
     */
    updateInteractivePan(canvasX: number, canvasY: number) {
        if (!this.interactiveState.isDragging) return;

        // Animate canvas position with spring
        this.interactiveState.canvasXSpring.springTo(canvasX);
        this.interactiveState.canvasYSpring.springTo(canvasY);
    }

    /**
     * End pan (mouseup)
     */
    endInteractivePan() {
        this.interactiveState.isDragging = false;
        this.requestTilesImmediate();
    }

    /**
     * Handle wheel zoom (cursor is always the focal point)
     */
    handleWheel(event: WheelEvent, canvasX: number, canvasY: number) {
        event.preventDefault();

        const wasIdle = this.interactiveState.isIdle;
        this.interactiveState.isIdle = false;

        // Throttle
        const now = performance.now();
        if (now - this.lastZoomTime < this.CONFIG.ZOOM_THROTTLE) return;
        this.lastZoomTime = now;

        const state = this.interactiveState;
        const isFirstInteraction = state.anchorWorldX === undefined;

        // Sync springs to viewport when waking from idle (single source of truth)
        if (wasIdle || isFirstInteraction) {
            state.cameraZSpring.resetTo(this.viewport.cameraZ);
        }

        if (wasIdle) {
            // Refresh spring timing to prevent stale timestamps
            state.canvasXSpring.current.time = now;
            state.canvasYSpring.current.time = now;
            state.cameraZSpring.current.time = now;
        }

        // Calculate new scale
        const zoomFactor = 1.5;
        const newScale = event.deltaY < 0
            ? this.viewport.scale * zoomFactor
            : this.viewport.scale / zoomFactor;

        const clampedScale = Math.max(
            this.viewport.minScale,
            Math.min(this.viewport.maxScale, newScale)
        );

        // Convert to cameraZ
        const targetZ = (this.viewport.containerHeight / clampedScale) / (2 * this.viewport.getTanHalfFov());
        const clampedZ = Math.max(this.viewport.minZ, Math.min(this.viewport.maxZ, targetZ));

        // Spring to new zoom
        state.cameraZSpring.springTo(clampedZ);

        // Update anchor to cursor position (zoom focal point)
        const worldPoint = this.viewport.canvasToWorldPoint(canvasX, canvasY);
        state.anchorWorldX = worldPoint.x;
        state.anchorWorldY = worldPoint.y;

        // Reset canvas springs if cursor moved significantly
        const dx = canvasX - state.canvasXSpring.current.value;
        const dy = canvasY - state.canvasYSpring.current.value;
        const movedSignificantly = (dx * dx + dy * dy) > 100;

        if (isFirstInteraction || movedSignificantly) {
            state.canvasXSpring.resetTo(canvasX);
            state.canvasYSpring.resetTo(canvasY);
        }

        // Animate to cursor for smooth zoom-to-cursor
        state.canvasXSpring.springTo(canvasX);
        state.canvasYSpring.springTo(canvasY);
    }

    // ============================================================
    // PRIVATE - Programmatic Animation
    // ============================================================

    private startProgrammaticAnimation(animation: ProgrammaticAnimation) {
        this.stopAnimation();
        this.programmaticAnimation = animation;
        this.animationFrameId = requestAnimationFrame(() => this.runProgrammaticAnimation());
    }

    private runProgrammaticAnimation() {
        const anim = this.programmaticAnimation;
        if (!anim) {
            if (this.animationFrameId !== undefined) {
                cancelAnimationFrame(this.animationFrameId);
                this.animationFrameId = undefined;
            }
            return;
        }

        const now = performance.now();
        const elapsed = now - anim.startTime;

        if (elapsed >= anim.duration) {
            // Complete: snap to final values
            this.updateProgrammaticAnimation(anim, 1.0);
            this.applyZoomAnchor(anim);
            this.stopAnimation();
            return;
        }

        const progress = elapsed / anim.duration;
        const easedProgress = anim.easing(progress);

        this.updateProgrammaticAnimation(anim, easedProgress);

        if (anim.type === 'zoom' && this.hasZoomAnchor(anim)) {
            this.applyZoomAnchor(anim);
        }

        this.requestTilesHybrid(now);
        this.animationFrameId = requestAnimationFrame(() => this.runProgrammaticAnimation());
    }

    private updateProgrammaticAnimation(anim: ProgrammaticAnimation, progress: number) {
        if (anim.type === 'pan' || anim.type === 'to') {
            this.viewport.centerX = anim.startCenterX + (anim.targetCenterX - anim.startCenterX) * progress;
            this.viewport.centerY = anim.startCenterY + (anim.targetCenterY - anim.startCenterY) * progress;
        }

        if (anim.type === 'zoom' || anim.type === 'to') {
            // Exponential interpolation for zoom
            const startLog = Math.log(anim.startCameraZ);
            const targetLog = Math.log(anim.targetCameraZ);
            this.viewport.cameraZ = Math.exp(startLog + (targetLog - startLog) * progress);
            this.viewport.updateScale();
        }
    }

    private hasZoomAnchor(anim: ProgrammaticAnimation): boolean {
        return anim.zoomAnchorWorldX !== undefined &&
               anim.zoomAnchorWorldY !== undefined &&
               anim.zoomAnchorCanvasX !== undefined &&
               anim.zoomAnchorCanvasY !== undefined;
    }

    private applyZoomAnchor(anim: ProgrammaticAnimation) {
        if (!this.hasZoomAnchor(anim)) return;
        this.viewport.setCenterFromWorldPoint(
            anim.zoomAnchorWorldX!,
            anim.zoomAnchorWorldY!,
            anim.zoomAnchorCanvasX!,
            anim.zoomAnchorCanvasY!
        );
    }

    // ============================================================
    // PRIVATE - Interactive Animation Helpers
    // ============================================================

    /**
     * Apply anchor point transformation: keep world point under cursor
     * Returns true if transform was applied
     */
    private applyAnchorTransform(): boolean {
        const state = this.interactiveState;

        if (state.anchorWorldX === undefined || state.anchorWorldY === undefined) {
            return false;
        }

        // Keep anchor world point at current canvas spring position
        this.viewport.setCenterFromWorldPoint(
            state.anchorWorldX,
            state.anchorWorldY,
            state.canvasXSpring.current.value,
            state.canvasYSpring.current.value
        );

        return true;
    }

    // ============================================================
    // PRIVATE - Tile Request Strategy
    // ============================================================

    private requestTilesImmediate() {
        const bounds = this.viewport.getWorldBounds();
        const visibleImages = this.world.getVisibleImages(bounds.left, bounds.top, bounds.right, bounds.bottom);
        for (const img of visibleImages) {
            img.tileManager.requestTilesForViewport(this.viewport);
        }
    }

    private requestTilesHybrid(now: number) {
        // Immediate request (throttled)
        if (now - this.lastImmediateRequestTime > this.CONFIG.TILE_IMMEDIATE_THROTTLE) {
            this.requestTilesImmediate();
            this.lastImmediateRequestTime = now;
        }

        // Debounced request (ensures final position gets tiles)
        if (this.tileUpdateTimer !== null) {
            clearTimeout(this.tileUpdateTimer);
        }
        this.tileUpdateTimer = window.setTimeout(() => {
            this.tileUpdateTimer = null;
            this.requestTilesImmediate();
        }, this.CONFIG.TILE_DEBOUNCE_DELAY);
    }
}
