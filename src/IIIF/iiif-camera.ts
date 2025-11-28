import { Viewport } from './iiif-view';
import { IIIFImage } from './iiif-image';
import { TileManager } from './iiif-tile';
import { WorldSpace } from './iiif-world';
import type { EasingFunction } from './easing';
import { easeOutQuart, interpolate } from './easing';

interface TrailingState {
    // Current interpolated position (WORLD COORDINATES)
    currentX: number;      // World X in pixels
    currentY: number;      // World Y in pixels
    currentZ: number;      // Camera Z position

    // Target position (WORLD COORDINATES)
    targetX: number;       // World X in pixels
    targetY: number;       // World Y in pixels
    targetZ: number;       // Camera Z position

    // Anchor points for maintaining fixed positions
    zoomAnchor?: {
        canvasX: number;   // Canvas point to keep fixed
        canvasY: number;
        worldX: number;    // World point that should stay under canvas point
        worldY: number;
    };

    panAnchor?: {
        canvasX: number;   // Canvas point to keep fixed
        canvasY: number;
        worldX: number;    // World point that should stay under canvas point
        worldY: number;
    };

    trailingFactor: number;  // 0.0-1.0, higher = faster response
}

interface EasingAnimation {
    startTime: number;
    duration: number;

    // Start position (WORLD COORDINATES)
    startX: number;        // World X in pixels
    startY: number;        // World Y in pixels
    startZ: number;        // Camera Z position

    // Target position (WORLD COORDINATES)
    targetX: number;       // World X in pixels
    targetY: number;       // World Y in pixels
    targetZ: number;       // Camera Z position

    easing: EasingFunction;

    // Optional anchor for zoom-to-point animations
    anchor?: {
        canvasX: number;
        canvasY: number;
        worldX: number;
        worldY: number;
    };
}

export class Camera {
    viewport: Viewport;
    world: WorldSpace;
    tiles: Map<string, TileManager>;
    images: Map<string, IIIFImage>;

    private trailing: TrailingState;
    private animation: EasingAnimation | null = null;

    private lastTileRequestTime: number = 0;
    private readonly TILE_REQUEST_THROTTLE = 100; // ms between tile requests

    constructor(viewport: Viewport, world: WorldSpace, images: Map<string, IIIFImage>, tiles: Map<string, TileManager>) {
        this.viewport = viewport;
        this.world = world;
        this.tiles = tiles;
        this.images = images;

        // Initialize trailing state with current viewport position
        this.trailing = {
            currentX: viewport.cameraWorldX,
            currentY: viewport.cameraWorldY,
            currentZ: viewport.cameraZ,
            targetX: viewport.cameraWorldX,
            targetY: viewport.cameraWorldY,
            targetZ: viewport.cameraZ,
            trailingFactor: 0.15  // Lower = more smoothing/lag
        };
    }

    // ============================================================================
    // INTERACTIVE METHODS (Use Trailing - World Coordinates)
    // ============================================================================

    /**
     * Start interactive pan (uses trailing)
     * @param canvasX - Canvas X position of cursor
     * @param canvasY - Canvas Y position of cursor
     */
    startInteractivePan(canvasX: number, canvasY: number) {
        // Convert canvas point to world point to establish anchor
        const worldPoint = this.viewport.canvasToWorld(canvasX, canvasY);

        this.trailing.panAnchor = {
            canvasX,
            canvasY,
            worldX: worldPoint.x,
            worldY: worldPoint.y
        };
    }

    /**
     * Update pan target during drag (uses trailing)
     * @param canvasX - New canvas X position of cursor
     * @param canvasY - New canvas Y position of cursor
     */
    updateInteractivePan(canvasX: number, canvasY: number) {
        if (!this.trailing.panAnchor) return;

        // Just update the canvas target position
        // The world anchor point stays the same, viewport will be adjusted in update()
        this.trailing.panAnchor.canvasX = canvasX;
        this.trailing.panAnchor.canvasY = canvasY;
    }

    /**
     * End interactive pan
     */
    endInteractivePan() {
        // Keep the anchor for a moment to allow trailing to catch up
        // It will be cleared when motion stops
    }

    /**
     * Set zoom target for interactive scrolling (uses trailing)
     * @param deltaZ - Change in Z position (positive = zoom out, negative = zoom in)
     * @param canvasX - Canvas X position to zoom toward (anchor point)
     * @param canvasY - Canvas Y position to zoom toward (anchor point)
     */
    setZoomTarget(deltaZ: number, canvasX: number, canvasY: number) {
        // Calculate new target Z
        const newTargetZ = this.trailing.targetZ + deltaZ;
        const clampedZ = Math.max(this.viewport.minZ, Math.min(this.viewport.maxZ, newTargetZ));

        this.trailing.targetZ = clampedZ;

        // Get the world point currently under the canvas point
        // This is the point we want to keep fixed during zoom
        const worldPoint = this.viewport.canvasToWorld(canvasX, canvasY);

        this.trailing.zoomAnchor = {
            canvasX,
            canvasY,
            worldX: worldPoint.x,
            worldY: worldPoint.y
        };
    }

    /**
     * Clear zoom anchor (e.g., when wheel scrolling stops)
     */
    clearZoomAnchor() {
        this.trailing.zoomAnchor = undefined;
    }

    /**
     * Clear pan anchor
     */
    clearPanAnchor() {
        this.trailing.panAnchor = undefined;
    }

    // ============================================================================
    // PROGRAMMATIC METHODS (Use Easing - World Coordinates)
    // ============================================================================

    /**
     * Move camera to a specific world position (uses easing)
     * For scripted/programmatic movements like "fly to bookmark"
     * @param worldX - Target X coordinate in world space
     * @param worldY - Target Y coordinate in world space
     * @param worldZ - Target Z position (camera distance)
     * @param duration - Animation duration in milliseconds (0 for instant)
     * @param easing - Easing function to use
     */
    to(worldX: number, worldY: number, worldZ: number, duration = 500, easing: EasingFunction = easeOutQuart) {
        // Clamp Z to valid range
        const clampedZ = Math.max(this.viewport.minZ, Math.min(this.viewport.maxZ, worldZ));

        // If duration is 0, jump immediately
        if (duration === 0) {
            this.viewport.cameraWorldX = worldX;
            this.viewport.cameraWorldY = worldY;
            this.viewport.cameraZ = clampedZ;
            this.viewport['updateScale']();

            // Update trailing to match
            this.trailing.currentX = worldX;
            this.trailing.currentY = worldY;
            this.trailing.currentZ = clampedZ;
            this.trailing.targetX = worldX;
            this.trailing.targetY = worldY;
            this.trailing.targetZ = clampedZ;

            // Request tiles for all visible images
            this.requestTilesForVisibleImages(true);
            return;
        }

        // Start easing animation
        this.animation = {
            startTime: performance.now(),
            duration,
            startX: this.viewport.cameraWorldX,
            startY: this.viewport.cameraWorldY,
            startZ: this.viewport.cameraZ,
            targetX: worldX,
            targetY: worldY,
            targetZ: clampedZ,
            easing
        };
    }

    /**
     * Zoom to a specific Z level at an anchor point (uses easing)
     * For programmatic zoom like "zoom to 100%" or "zoom to fit"
     * @param targetZ - Target camera Z position
     * @param anchorCanvasX - Canvas X point to keep fixed (optional, defaults to center)
     * @param anchorCanvasY - Canvas Y point to keep fixed (optional, defaults to center)
     * @param duration - Animation duration in milliseconds
     * @param easing - Easing function to use
     */
    zoomTo(targetZ: number, anchorCanvasX?: number, anchorCanvasY?: number, duration = 500, easing: EasingFunction = easeOutQuart) {
        // Default to center if no anchor specified
        const canvasX = anchorCanvasX ?? this.viewport.containerWidth / 2;
        const canvasY = anchorCanvasY ?? this.viewport.containerHeight / 2;

        // Get the world point at the anchor
        const anchorWorldPoint = this.viewport.canvasToWorld(canvasX, canvasY);

        // Clamp Z
        const clampedZ = Math.max(this.viewport.minZ, Math.min(this.viewport.maxZ, targetZ));

        // Start animation with anchor
        this.animation = {
            startTime: performance.now(),
            duration,
            startX: this.viewport.cameraWorldX,
            startY: this.viewport.cameraWorldY,
            startZ: this.viewport.cameraZ,
            targetX: this.viewport.cameraWorldX,  // Will be recalculated to maintain anchor
            targetY: this.viewport.cameraWorldY,
            targetZ: clampedZ,
            easing,
            anchor: {
                canvasX,
                canvasY,
                worldX: anchorWorldPoint.x,
                worldY: anchorWorldPoint.y
            }
        };
    }

    // ============================================================================
    // HELPER METHODS (For Backward Compatibility and Convenience)
    // ============================================================================

    /**
     * Move camera to a specific image position (helper for backward compatibility)
     * @param imageX - Target X coordinate in image pixels
     * @param imageY - Target Y coordinate in image pixels
     * @param imageZ - Target Z position
     * @param imageId - ID of the target image
     * @param duration - Animation duration
     * @param easing - Easing function
     */
    toImage(imageX: number, imageY: number, imageZ: number, imageId: string, duration = 500, easing: EasingFunction = easeOutQuart) {
        /*const worldPoint = this.world.imageToWorld(imageX, imageY, imageId);
        if (!worldPoint) {
            console.warn(`Image with ID ${imageId} not found in world`);
            return;
        }
        this.to(worldPoint.x, worldPoint.y, imageZ, duration, easing);*/
    }

    /**
     * Focus camera on a specific image (fit to view)
     * @param imageId - ID of the image to focus on
     * @param padding - Padding as a fraction (0.1 = 10% padding)
     * @param duration - Animation duration
     */
    focusOnImage(imageId: string, padding = 0.1, duration = 500) {

    }

    /**
     * Fit camera to show all images
     * @param padding - Padding as a fraction (0.1 = 10% padding)
     * @param duration - Animation duration
     */
    fitToWorld(padding = 0.1, duration = 500) {
    }

    // ============================================================================
    // UPDATE LOOP
    // ============================================================================

    /**
     * Update camera state (called every frame)
     * Handles both easing animations and trailing interpolation
     * @returns Object indicating if camera is animating
     */
    update(): { isAnimating: boolean; needsTileUpdate: boolean } {
        // Programmatic animation takes priority
        if (this.animation) {
            return this.updateEasingAnimation();
        }

        // Otherwise update trailing (interactive)
        return this.updateTrailing();
    }

    /**
     * Update easing-based animation
     */
    private updateEasingAnimation(): { isAnimating: boolean; needsTileUpdate: boolean } {
        if (!this.animation) {
            return { isAnimating: false, needsTileUpdate: false };
        }

        const now = performance.now();
        const elapsed = now - this.animation.startTime;
        const progress = Math.min(elapsed / this.animation.duration, 1);
        const easedProgress = this.animation.easing(progress);

        // Interpolate Z
        const currentZ = interpolate(this.animation.startZ, this.animation.targetZ, easedProgress);

        // Update viewport Z
        this.viewport.cameraZ = currentZ;
        this.viewport['updateScale']();

        // If we have an anchor, calculate X/Y to maintain it
        if (this.animation.anchor) {
            this.viewport.setCameraFromWorldPoint(
                this.animation.anchor.worldX,
                this.animation.anchor.worldY,
                this.animation.anchor.canvasX,
                this.animation.anchor.canvasY
            );
        } else {
            // No anchor, interpolate X/Y directly
            const currentX = interpolate(this.animation.startX, this.animation.targetX, easedProgress);
            const currentY = interpolate(this.animation.startY, this.animation.targetY, easedProgress);

            this.viewport.cameraWorldX = currentX;
            this.viewport.cameraWorldY = currentY;
        }

        // Check if complete
        const isComplete = progress >= 1;

        if (isComplete) {
            // Update trailing state to match final position
            this.trailing.currentX = this.viewport.cameraWorldX;
            this.trailing.currentY = this.viewport.cameraWorldY;
            this.trailing.currentZ = this.viewport.cameraZ;
            this.trailing.targetX = this.viewport.cameraWorldX;
            this.trailing.targetY = this.viewport.cameraWorldY;
            this.trailing.targetZ = this.viewport.cameraZ;

            // Request final tiles
            this.requestTilesForVisibleImages(true);

            this.animation = null;
            return { isAnimating: false, needsTileUpdate: true };
        }

        // Request tiles with throttling
        this.requestTilesForVisibleImages(false);

        return { isAnimating: true, needsTileUpdate: true };
    }

    /**
     * Update trailing-based interpolation (for interactive input)
     */
    private updateTrailing(): { isAnimating: boolean; needsTileUpdate: boolean } {
        const { trailing } = this;

        // Calculate distances
        const zDist = Math.abs(trailing.targetZ - trailing.currentZ);
        const xDist = Math.abs(trailing.targetX - trailing.currentX);
        const yDist = Math.abs(trailing.targetY - trailing.currentY);

        // Thresholds for considering movement stopped
        const Z_THRESHOLD = 0.1;
        const XY_THRESHOLD = 0.1;  // World pixels

        const hasZoomMovement = zDist > Z_THRESHOLD;
        const hasPanMovement = xDist > XY_THRESHOLD || yDist > XY_THRESHOLD;

        if (!hasZoomMovement && !hasPanMovement) {
            // Clear anchors when movement stops
            if (!trailing.panAnchor && !trailing.zoomAnchor) {
                return { isAnimating: false, needsTileUpdate: false };
            }

            // Movement stopped, clear anchors
            trailing.panAnchor = undefined;
            trailing.zoomAnchor = undefined;

            // Final tile request
            this.requestTilesForVisibleImages(true);

            return { isAnimating: false, needsTileUpdate: true };
        }

        // Interpolate Z with trailing
        trailing.currentZ += (trailing.targetZ - trailing.currentZ) * trailing.trailingFactor;

        // Update viewport Z and scale
        this.viewport.cameraZ = trailing.currentZ;
        this.viewport['updateScale']();

        // Apply pan or zoom anchor
        if (trailing.zoomAnchor) {
            // Zooming - maintain zoom anchor point
            this.viewport.setCameraFromWorldPoint(
                trailing.zoomAnchor.worldX,
                trailing.zoomAnchor.worldY,
                trailing.zoomAnchor.canvasX,
                trailing.zoomAnchor.canvasY
            );
        } else if (trailing.panAnchor) {
            // Panning - maintain pan anchor point
            this.viewport.setCameraFromWorldPoint(
                trailing.panAnchor.worldX,
                trailing.panAnchor.worldY,
                trailing.panAnchor.canvasX,
                trailing.panAnchor.canvasY
            );
        } else {
            // No anchor, interpolate X/Y directly
            trailing.currentX += (trailing.targetX - trailing.currentX) * trailing.trailingFactor;
            trailing.currentY += (trailing.targetY - trailing.currentY) * trailing.trailingFactor;

            this.viewport.cameraWorldX = trailing.currentX;
            this.viewport.cameraWorldY = trailing.currentY;
        }

        // Sync trailing state with viewport (in case it was modified)
        trailing.currentX = this.viewport.cameraWorldX;
        trailing.currentY = this.viewport.cameraWorldY;

        // Request tiles with throttling
        this.requestTilesForVisibleImages(false);

        return { isAnimating: true, needsTileUpdate: true };
    }

    /**
     * Request tiles for all visible images with optional throttling
     */
    private requestTilesForVisibleImages(force: boolean = false) {
        const now = performance.now();
        const timeSinceLastRequest = now - this.lastTileRequestTime;

        if (!force && timeSinceLastRequest < this.TILE_REQUEST_THROTTLE) {
            return;
        }

        // Get visible images
        const visibleImages = this.viewport.getVisibleImages(this.world);

        // Request tiles for each visible image
        visibleImages.forEach(image => {
            const tileManager = this.tiles.get(image.id);
            if (tileManager) {
                tileManager.requestTilesForViewport(this.viewport);
            }
        });

        this.lastTileRequestTime = now;
    }

    // ============================================================================
    // UTILITY METHODS
    // ============================================================================

    /**
     * Check if camera is currently animating (either easing or trailing)
     */
    isAnimating(): boolean {
        if (this.animation) return true;

        const { trailing } = this;
        const hasMovement =
            Math.abs(trailing.targetZ - trailing.currentZ) > 0.1 ||
            Math.abs(trailing.targetX - trailing.currentX) > 0.1 ||
            Math.abs(trailing.targetY - trailing.currentY) > 0.1;

        return hasMovement;
    }

    /**
     * Cancel any active animation
     */
    cancel() {
        this.animation = null;
    }

    /**
     * Get trailing factor (for debugging/tuning)
     */
    getTrailingFactor(): number {
        return this.trailing.trailingFactor;
    }

    /**
     * Set trailing factor (0.0-1.0, higher = faster response)
     */
    setTrailingFactor(factor: number) {
        this.trailing.trailingFactor = Math.max(0.01, Math.min(1.0, factor));
    }

    /**
     * Get current camera world position
     */
    getWorldPosition(): { x: number, y: number, z: number } {
        return {
            x: this.viewport.cameraWorldX,
            y: this.viewport.cameraWorldY,
            z: this.viewport.cameraZ
        };
    }

    // ============================================================================
    // LEGACY METHODS (Deprecated - for backward compatibility)
    // ============================================================================

    /**
     * @deprecated Use startInteractivePan() instead
     */
    pan(_deltaX: number, _deltaY: number, _imageId: string) {
        console.warn('camera.pan() is deprecated. Use startInteractivePan/updateInteractivePan instead');
    }

    /**
     * @deprecated Use setZoomTarget() instead
     */
    zoom(_newScale: number, _canvasX: number, _canvasY: number, _imageId: string) {
        console.warn('camera.zoom() is deprecated. Use setZoomTarget() instead');
    }
}
