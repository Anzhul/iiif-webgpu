import type { WorldImage } from './iiif-world';

/**
 * Viewport using world coordinates.
 * centerX/centerY are absolute world coordinates (not normalized 0-1).
 * scale = CSS pixels per world unit.
 */

export class Viewport {

  // Container dimensions
  containerWidth: number;
  containerHeight: number;

  centerX: number; // World coordinate
  centerY: number; // World coordinate

  // 3D camera properties
  cameraZ: number; // Camera Z position in world units
  minZ: number;
  maxZ: number;

  fov: number; // Field of view in degrees
  near: number; // Near clipping plane
  far: number; // Far clipping plane

  scale: number; // CSS pixels per world unit
  minScale: number;
  maxScale: number;

  // Cached FOV trigonometric values
  private fovRadians: number;
  private tanHalfFov: number;

  // Cache for world bounds
  private worldBoundsCache: {
    bounds: { left: number; top: number; right: number; bottom: number; width: number; height: number } | null;
    centerX: number;
    centerY: number;
    scale: number;
    containerWidth: number;
    containerHeight: number;
  } = {
    bounds: null,
    centerX: NaN,
    centerY: NaN,
    scale: NaN,
    containerWidth: NaN,
    containerHeight: NaN,
  };

  private boundsCacheInvalid: boolean = false;

  constructor(containerWidth: number, containerHeight: number) {
    this.containerWidth = containerWidth;
    this.containerHeight = containerHeight;

    // Will be set properly by fitToWorld
    this.centerX = 0;
    this.centerY = 0;

    this.cameraZ = 1000;
    this.minZ = 100;
    this.maxZ = 2000;

    this.fov = 45;
    this.near = 0.1;
    this.far = 10000;

    this.fovRadians = (this.fov * Math.PI) / 180;
    this.tanHalfFov = Math.tan(this.fovRadians / 2);

    this.scale = this.calculateScale();

    const visibleHeightAtMaxZ = 2 * this.maxZ * this.tanHalfFov;
    this.minScale = this.containerHeight / visibleHeightAtMaxZ;
    const visibleHeightAtMinZ = 2 * this.minZ * this.tanHalfFov;
    this.maxScale = this.containerHeight / visibleHeightAtMinZ;
  }

  // @ts-ignore - Reserved for future use when FOV becomes mutable
  private updateFovConstants(): void {
    this.fovRadians = (this.fov * Math.PI) / 180;
    this.tanHalfFov = Math.tan(this.fovRadians / 2);
  }

  private calculateScale(): number {
    const visibleHeight = 2 * this.cameraZ * this.tanHalfFov;
    return this.containerHeight / visibleHeight;
  }

  updateScale(): void {
    this.scale = this.calculateScale();
    this.updateScaleLimits();
    this.invalidateBoundsCache();
  }

  private invalidateBoundsCache(): void {
    if (!this.boundsCacheInvalid) {
      this.worldBoundsCache.bounds = null;
      this.boundsCacheInvalid = true;
    }
  }

  private updateScaleLimits(): void {
    const visibleHeightAtMaxZ = 2 * this.maxZ * this.tanHalfFov;
    this.minScale = this.containerHeight / visibleHeightAtMaxZ;
    const visibleHeightAtMinZ = 2 * this.minZ * this.tanHalfFov;
    this.maxScale = this.containerHeight / visibleHeightAtMinZ;
  }

  getScale(): number {
    return this.scale;
  }

  getFovRadians(): number {
    return this.fovRadians;
  }

  getTanHalfFov(): number {
    return this.tanHalfFov;
  }

  /**
   * Fit the viewport so that a world region fills the container width.
   * Sets center to the middle of the given world dimensions.
   */
  fitToWorld(worldWidth: number, worldHeight: number) {
    const targetScale = this.containerWidth / worldWidth;
    this.cameraZ = this.containerHeight / (2 * targetScale * this.tanHalfFov);

    this.maxZ = this.cameraZ * 5;
    this.minZ = this.cameraZ * 0.1;
    this.near = this.minZ * 0.01;
    this.far = this.maxZ * 2;

    this.updateScale();

    this.centerX = worldWidth / 2;
    this.centerY = worldHeight / 2;
    return this;
  }

  /**
   * Get visible bounds in world coordinates
   */
  getWorldBounds(): { left: number; top: number; right: number; bottom: number; width: number; height: number } {
    if (!this.boundsCacheInvalid && this.worldBoundsCache.bounds) {
      const c = this.worldBoundsCache;
      const roundedScale = Math.round(this.scale * 1000) / 1000;
      if (c.centerX === this.centerX &&
          c.centerY === this.centerY &&
          c.scale === roundedScale &&
          c.containerWidth === this.containerWidth &&
          c.containerHeight === this.containerHeight) {
        return c.bounds!;
      }
    }

    const worldWidth = this.containerWidth / this.scale;
    const worldHeight = this.containerHeight / this.scale;
    const left = this.centerX - worldWidth / 2;
    const top = this.centerY - worldHeight / 2;

    const bounds = {
      left,
      top,
      right: left + worldWidth,
      bottom: top + worldHeight,
      width: worldWidth,
      height: worldHeight
    };

    const roundedScale = Math.round(this.scale * 1000) / 1000;
    this.worldBoundsCache = {
      bounds,
      centerX: this.centerX,
      centerY: this.centerY,
      scale: roundedScale,
      containerWidth: this.containerWidth,
      containerHeight: this.containerHeight,
    };
    this.boundsCacheInvalid = false;

    return bounds;
  }

  /**
   * Get the visible region of a WorldImage in image pixel coordinates.
   * Used by TileManager to determine which tiles to fetch.
   */
  getImageBoundsForWorldImage(worldImage: WorldImage): { left: number; top: number; right: number; bottom: number; width: number; height: number } {
    const wb = this.getWorldBounds();
    const p = worldImage.placement;

    // Clamp world bounds to this image's world region
    const clampedLeft = Math.max(wb.left, p.worldX);
    const clampedTop = Math.max(wb.top, p.worldY);
    const clampedRight = Math.min(wb.right, p.worldX + p.worldWidth);
    const clampedBottom = Math.min(wb.bottom, p.worldY + p.worldHeight);

    // Convert world coords to image pixels
    const imgLeft = worldImage.worldToImage(clampedLeft, 0).x;
    const imgTop = worldImage.worldToImage(0, clampedTop).y;
    const imgRight = worldImage.worldToImage(clampedRight, 0).x;
    const imgBottom = worldImage.worldToImage(0, clampedBottom).y;

    return {
      left: Math.max(0, imgLeft),
      top: Math.max(0, imgTop),
      right: Math.min(worldImage.image.width, imgRight),
      bottom: Math.min(worldImage.image.height, imgBottom),
      width: imgRight - imgLeft,
      height: imgBottom - imgTop
    };
  }

  /**
   * Constrain center to keep content visible.
   * worldWidth/worldHeight define the total content bounds.
   */
  constrainCenter(worldWidth?: number, worldHeight?: number) {
    const oldCenterX = this.centerX;
    const oldCenterY = this.centerY;

    if (worldWidth === undefined || worldHeight === undefined) {
      // No constraint
      return;
    }

    const viewWidth = this.containerWidth / this.scale;
    const viewHeight = this.containerHeight / this.scale;

    if (viewWidth < worldWidth) {
      const minCenterX = viewWidth / 2;
      const maxCenterX = worldWidth - viewWidth / 2;
      this.centerX = Math.max(minCenterX, Math.min(maxCenterX, this.centerX));
    }

    if (viewHeight < worldHeight) {
      const minCenterY = viewHeight / 2;
      const maxCenterY = worldHeight - viewHeight / 2;
      this.centerY = Math.max(minCenterY, Math.min(maxCenterY, this.centerY));
    }

    if (oldCenterX !== this.centerX || oldCenterY !== this.centerY) {
      this.invalidateBoundsCache();
    }
  }

  /**
   * Convert canvas pixel coordinates to world coordinates
   */
  canvasToWorldPoint(canvasX: number, canvasY: number): { x: number; y: number } {
    const worldWidth = this.containerWidth / this.scale;
    const worldHeight = this.containerHeight / this.scale;
    const worldMinX = this.centerX - worldWidth / 2;
    const worldMinY = this.centerY - worldHeight / 2;

    return {
      x: worldMinX + canvasX / this.scale,
      y: worldMinY + canvasY / this.scale
    };
  }

  /**
   * Set center such that a given world point appears at a given canvas position
   */
  setCenterFromWorldPoint(worldX: number, worldY: number, canvasX: number, canvasY: number) {
    const worldWidth = this.containerWidth / this.scale;
    const worldHeight = this.containerHeight / this.scale;

    this.centerX = worldX - (canvasX / this.scale) + worldWidth / 2;
    this.centerY = worldY - (canvasY / this.scale) + worldHeight / 2;

    this.invalidateBoundsCache();
  }
}
