import { Viewport } from './iiif-view';
import { World } from './iiif-world';
import type { EasingFunction } from './easing';
import { easeOutQuart } from './easing';
import { Spring } from './spring';
import { CAMERA_CONFIG } from '../config';

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
    // Track current input source for conflict resolution between mouse and keyboard
    lastInputType: 'none' | 'wheel' | 'drag' | 'pinch' | 'keyboard-zoom' | 'keyboard-pan';
}

export class Camera {
    viewport: Viewport;
    world: World;

    private programmaticAnimation?: ProgrammaticAnimation;

    private interactiveState: InteractiveState;

    private lastZoomTime: number = 0;
    private lastImmediateRequestTime: number = 0;
    private tileUpdateTimer: number | null = null;

    // Use centralized config
    private readonly CONFIG = CAMERA_CONFIG;

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
            isIdle: true,
            lastInputType: 'none'
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
        this.programmaticAnimation = undefined;
    }

    // ============================================================
    // PUBLIC API - Spring-based (keyboard/button)
    // ============================================================

    /**
     * Zoom by factor using springs, centered on viewport.
     * Feels the same as mouse wheel zoom but without cursor anchoring.
     * Handles rapid repeated calls naturally (spring targets compose).
     */
    springZoomByFactor(factor: number) {
        this.commitIfNeeded('keyboard-zoom');
        const wasIdle = this.interactiveState.isIdle;
        const needsInit = wasIdle || this.interactiveState.anchorWorldX === undefined;
        this.interactiveState.isIdle = false;

        const state = this.interactiveState;
        const now = performance.now();

        if (needsInit) {
            state.cameraZSpring.resetTo(this.viewport.cameraZ);
            state.canvasXSpring.current.time = now;
            state.canvasYSpring.current.time = now;
            state.cameraZSpring.current.time = now;
        }

        // Compute target scale from the spring's current target (not viewport.scale)
        // so rapid calls compose correctly
        const currentTargetZ = state.cameraZSpring.target?.value ?? this.viewport.cameraZ;
        const currentTargetScale = this.viewport.containerHeight / (currentTargetZ * 2 * this.viewport.getTanHalfFov());
        const newScale = currentTargetScale * factor;
        const clampedScale = Math.max(
            this.viewport.minScale,
            Math.min(this.viewport.maxScale, newScale)
        );

        const targetZ = (this.viewport.containerHeight / clampedScale) / (2 * this.viewport.getTanHalfFov());
        const clampedZ = Math.max(this.viewport.minZ, Math.min(this.viewport.maxZ, targetZ));

        state.cameraZSpring.springTo(clampedZ);

        // Anchor to viewport center — only set on init to prevent drift from
        // recalculating the world point mid-animation (which causes squiggly zoom)
        const cx = this.viewport.containerWidth / 2;
        const cy = this.viewport.containerHeight / 2;
        if (needsInit) {
            const worldPoint = this.viewport.canvasToWorldPoint(cx, cy);
            state.anchorWorldX = worldPoint.x;
            state.anchorWorldY = worldPoint.y;
            state.canvasXSpring.resetTo(cx);
            state.canvasYSpring.resetTo(cy);
        }
        state.canvasXSpring.springTo(cx);
        state.canvasYSpring.springTo(cy);
    }

    /**
     * Pan by world delta using springs.
     * Handles rapid repeated calls naturally (anchor shifts compose).
     */
    springPan(worldDeltaX: number, worldDeltaY: number) {
        this.commitIfNeeded('keyboard-pan');
        const wasIdle = this.interactiveState.isIdle;
        this.interactiveState.isIdle = false;

        const state = this.interactiveState;
        const now = performance.now();
        const cx = this.viewport.containerWidth / 2;
        const cy = this.viewport.containerHeight / 2;

        if (wasIdle || state.anchorWorldX === undefined || state.anchorWorldY === undefined) {
            state.cameraZSpring.resetTo(this.viewport.cameraZ);
            state.canvasXSpring.current.time = now;
            state.canvasYSpring.current.time = now;
            state.cameraZSpring.current.time = now;

            // Target world point is where we want the center to be
            state.anchorWorldX = this.viewport.centerX + worldDeltaX;
            state.anchorWorldY = this.viewport.centerY + worldDeltaY;

            // Start canvas springs at where that world point currently appears on screen
            state.canvasXSpring.resetTo(cx + worldDeltaX * this.viewport.scale);
            state.canvasYSpring.resetTo(cy + worldDeltaY * this.viewport.scale);
        } else {
            // Composable: shift anchor further, canvas spring adjusts naturally
            state.anchorWorldX += worldDeltaX;
            state.anchorWorldY += worldDeltaY;

            // Nudge the canvas spring's current position to reflect the new delta,
            // so the spring has distance to travel and doesn't snap
            const curr = state.canvasXSpring.current.value;
            const currY = state.canvasYSpring.current.value;
            state.canvasXSpring.resetTo(curr + worldDeltaX * this.viewport.scale);
            state.canvasYSpring.resetTo(currY + worldDeltaY * this.viewport.scale);
        }

        // Spring to center — pulls the anchor world point to the viewport center
        state.canvasXSpring.springTo(cx);
        state.canvasYSpring.springTo(cy);
    }

    // ============================================================
    // PUBLIC API - Interactive Animations (called from main loop)
    // ============================================================

    /**
     * Update all animations. Call this every frame from the main render loop.
     * Handles both interactive (spring-based) and programmatic (easing-based) animations.
     */
    updateInteractiveAnimation(): { needsUpdate: boolean } {
        // Update programmatic animation if active (runs in main render loop, not separate rAF)
        const programmaticActive = this.updateProgrammaticStep();

        if (this.interactiveState.isIdle && !programmaticActive) {
            return { needsUpdate: false };
        }

        const state = this.interactiveState;
        let needsUpdate = programmaticActive;

        if (!this.interactiveState.isIdle) {
            // Update all springs
            const panXAnimating = state.canvasXSpring.update();
            const panYAnimating = state.canvasYSpring.update();
            const zoomAnimating = state.cameraZSpring.update();

            // Always sync viewport from spring — even on the settling frame where
            // spring.update() snaps current.value to target but returns false.
            // Without this, viewport.cameraZ retains the previous frame's interpolated
            // value, causing scale/tile-grid to be slightly off from the MVP matrix.
            this.viewport.cameraZ = state.cameraZSpring.current.value;
            this.viewport.updateScale();

            // Apply anchor point transformation
            if (this.applyAnchorTransform()) {
                needsUpdate = true;
            }

            // Check if idle
            const isAnimating = state.isDragging || panXAnimating || panYAnimating || zoomAnimating;
            if (!isAnimating) {
                this.interactiveState.isIdle = true;
                this.interactiveState.lastInputType = 'none';
                this.requestTilesImmediate();
            } else if (needsUpdate) {
                this.requestTilesHybrid(performance.now());
            }
        } else if (programmaticActive) {
            this.requestTilesHybrid(performance.now());
        }

        return { needsUpdate };
    }

    /**
     * Start pan (mousedown)
     */
    startInteractivePan(canvasX: number, canvasY: number) {
        this.commitIfNeeded('drag');
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

        // Throttle
        const now = performance.now();
        if (now - this.lastZoomTime < this.CONFIG.ZOOM_THROTTLE) return;
        this.lastZoomTime = now;

        this.commitIfNeeded('wheel');
        const wasIdle = this.interactiveState.isIdle;
        this.interactiveState.isIdle = false;

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

    /**
     * Handle pinch zoom (two-finger gesture, continuous)
     * scaleFactor is the ratio: newPinchDistance / previousPinchDistance
     */
    handlePinchZoom(scaleFactor: number, centerCanvasX: number, centerCanvasY: number) {
        this.commitIfNeeded('pinch');
        const wasIdle = this.interactiveState.isIdle;
        this.interactiveState.isIdle = false;

        const state = this.interactiveState;
        const now = performance.now();
        const isFirstInteraction = state.anchorWorldX === undefined;

        // Sync springs on first interaction or wake from idle
        if (wasIdle || isFirstInteraction) {
            state.cameraZSpring.resetTo(this.viewport.cameraZ);
            state.canvasXSpring.resetTo(centerCanvasX);
            state.canvasYSpring.resetTo(centerCanvasY);
            state.canvasXSpring.current.time = now;
            state.canvasYSpring.current.time = now;
            state.cameraZSpring.current.time = now;
        }

        // Calculate target scale from current scale * pinch ratio
        const newScale = this.viewport.scale * scaleFactor;
        const clampedScale = Math.max(
            this.viewport.minScale,
            Math.min(this.viewport.maxScale, newScale)
        );

        // Convert to cameraZ
        const targetZ = (this.viewport.containerHeight / clampedScale) / (2 * this.viewport.getTanHalfFov());
        const clampedZ = Math.max(this.viewport.minZ, Math.min(this.viewport.maxZ, targetZ));

        // Spring zoom to target
        state.cameraZSpring.springTo(clampedZ);

        // Update anchor to pinch midpoint (zoom focal point)
        const worldPoint = this.viewport.canvasToWorldPoint(centerCanvasX, centerCanvasY);
        state.anchorWorldX = worldPoint.x;
        state.anchorWorldY = worldPoint.y;

        // Spring canvas position to midpoint (enables simultaneous pan)
        state.canvasXSpring.springTo(centerCanvasX);
        state.canvasYSpring.springTo(centerCanvasY);
    }

    /**
     * Handle double-tap zoom (delegates to programmatic zoom)
     */
    handleDoubleTap(canvasX: number, canvasY: number) {
        const targetScale = this.viewport.scale * 2.0;
        this.zoom(targetScale, 300, easeOutQuart, canvasX, canvasY);
    }

    // ============================================================
    // PRIVATE - Programmatic Animation
    // ============================================================

    private startProgrammaticAnimation(animation: ProgrammaticAnimation) {
        this.stopAnimation();
        // Cancel any active springs so they don't overwrite viewport during easing
        this.interactiveState.isIdle = true;
        this.interactiveState.isDragging = false;
        this.interactiveState.lastInputType = 'none';
        this.programmaticAnimation = animation;
    }

    /**
     * Advance the programmatic animation by one frame.
     * Called from updateInteractiveAnimation() in the main render loop.
     * Returns true if the animation is still active.
     */
    private updateProgrammaticStep(): boolean {
        const anim = this.programmaticAnimation;
        if (!anim) return false;

        const now = performance.now();
        const elapsed = now - anim.startTime;

        if (elapsed >= anim.duration) {
            // Complete: snap to final values
            this.updateProgrammaticAnimationProgress(anim, 1.0);
            this.applyZoomAnchor(anim);
            this.programmaticAnimation = undefined;
            return true; // still needed render for final frame
        }

        const progress = elapsed / anim.duration;
        const easedProgress = anim.easing(progress);

        this.updateProgrammaticAnimationProgress(anim, easedProgress);

        if (anim.type === 'zoom' && this.hasZoomAnchor(anim)) {
            this.applyZoomAnchor(anim);
        }

        return true;
    }

    private updateProgrammaticAnimationProgress(anim: ProgrammaticAnimation, progress: number) {
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

    /**
     * Commit current spring state to viewport and reset when switching input types.
     * Prevents conflicts when transitioning between mouse and keyboard interactions.
     */
    private commitIfNeeded(newType: InteractiveState['lastInputType']) {
        const state = this.interactiveState;

        // No commit needed if idle or same input type
        if (state.isIdle || state.lastInputType === 'none' || state.lastInputType === newType) {
            state.lastInputType = newType;
            return;
        }

        // Input type changed mid-animation: snapshot viewport from current spring positions
        this.viewport.cameraZ = state.cameraZSpring.current.value;
        this.viewport.updateScale();
        if (state.anchorWorldX !== undefined && state.anchorWorldY !== undefined) {
            this.viewport.setCenterFromWorldPoint(
                state.anchorWorldX,
                state.anchorWorldY,
                state.canvasXSpring.current.value,
                state.canvasYSpring.current.value
            );
        }

        // Reset to idle so the new input starts fresh
        state.anchorWorldX = undefined;
        state.anchorWorldY = undefined;
        state.isDragging = false;
        state.isIdle = true;
        state.lastInputType = newType;
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
