import type { WorldImage } from './iiif-world';

/**
 * Viewport using world coordinates.
 * centerX/centerY are absolute world coordinates (not normalized 0-1).
 * scale = CSS pixels per world unit, derived from cameraZ via perspective formula.
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

  private calculateScale(): number {
    const visibleHeight = 2 * this.cameraZ * this.tanHalfFov;
    return this.containerHeight / visibleHeight;
  }

  updateScale(): void {
    this.scale = this.calculateScale();
    this.updateScaleLimits();
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
   * Fit the viewport so that a world region fills the container.
   * Sets center to the middle of the given world dimensions.
   */
  fitToWorld(worldWidth: number, worldHeight: number) {
    const targetScale = Math.min(
      this.containerWidth / worldWidth,
      this.containerHeight / worldHeight
    );
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
   * Get visible bounds in world coordinates.
   * Cheap computation (4 divisions + additions), no caching needed.
   */
  getWorldBounds(): { left: number; top: number; right: number; bottom: number; width: number; height: number } {
    const worldWidth = this.containerWidth / this.scale;
    const worldHeight = this.containerHeight / this.scale;
    const left = this.centerX - worldWidth / 2;
    const top = this.centerY - worldHeight / 2;

    return {
      left,
      top,
      right: left + worldWidth,
      bottom: top + worldHeight,
      width: worldWidth,
      height: worldHeight
    };
  }

  /**
   * Get the visible region of a WorldImage in image pixel coordinates.
   * Used by TileManager to determine which tiles to fetch.
   */
  getImageBoundsForWorldImage(worldImage: WorldImage): { left: number; top: number; right: number; bottom: number; width: number; height: number } {
    const wb = this.getWorldBounds();
    const p = worldImage.placement;

    // Add generous buffer to viewport bounds (2 world units on each side)
    // This prevents edge tiles from flickering due to floating-point precision at boundaries
    const buffer = 2;
    const bufferedLeft = wb.left - buffer;
    const bufferedTop = wb.top - buffer;
    const bufferedRight = wb.right + buffer;
    const bufferedBottom = wb.bottom + buffer;

    // Clamp buffered world bounds to this image's world region
    const clampedLeft = Math.max(bufferedLeft, p.worldX);
    const clampedTop = Math.max(bufferedTop, p.worldY);
    const clampedRight = Math.min(bufferedRight, p.worldX + p.worldWidth);
    const clampedBottom = Math.min(bufferedBottom, p.worldY + p.worldHeight);

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
   * Determine the optimal IIIF zoom level for rendering a WorldImage
   * at the current viewport scale.
   *
   * No rounding — even tiny scale differences must produce a stable zoom level.
   * The camera throttles how often tiles are requested, so oscillation at
   * boundaries is handled by the multi-level coverage in TileManager.
   */
  getOptimalZoomLevel(worldImage: WorldImage, distanceDetail: number = 1.0): { zoomLevel: number; scaleFactor: number } {
    const image = worldImage.image;
    const imagePixelScale = this.scale * worldImage.worldPerPixel;
    const imageScale = distanceDetail / imagePixelScale;

    let zoomLevel = image.maxZoomLevel;
    for (let i = 0; i < image.scaleFactors.length; i++) {
      if (imageScale <= image.scaleFactors[i]) {
        zoomLevel = i;
        break;
      }
    }
    zoomLevel = Math.max(0, Math.min(zoomLevel, image.maxZoomLevel));

    return {
      zoomLevel,
      scaleFactor: image.scaleFactors[zoomLevel]
    };
  }

  /**
   * Get the visible tile grid range for a WorldImage at a specific zoom level.
   * Returns tile coordinate range or null if no tiles are visible.
   */
  getTileGridForLevel(
    worldImage: WorldImage,
    _zoomLevel: number,
    scaleFactor: number
  ): { startX: number; startY: number; endX: number; endY: number; centerX: number; centerY: number } | null {
    const imageBounds = this.getImageBoundsForWorldImage(worldImage);
    const tileSize = worldImage.image.tileSize;
    const tileSizeAtLevel = tileSize * scaleFactor;

    // Epsilon prevents Math.floor/ceil from oscillating during sub-pixel animations
    const epsilon = 0.5;

    let startX = Math.floor((imageBounds.left - epsilon) / tileSizeAtLevel);
    let startY = Math.floor((imageBounds.top - epsilon) / tileSizeAtLevel);
    let endX = Math.ceil((imageBounds.right + epsilon) / tileSizeAtLevel);
    let endY = Math.ceil((imageBounds.bottom + epsilon) / tileSizeAtLevel);

    const maxTileX = Math.floor((worldImage.image.width - 1) / tileSizeAtLevel);
    const maxTileY = Math.floor((worldImage.image.height - 1) / tileSizeAtLevel);

    startX = Math.max(0, startX);
    startY = Math.max(0, startY);
    endX = Math.min(maxTileX, endX);
    endY = Math.min(maxTileY, endY);

    if (startX > endX || startY > endY) return null;

    return {
      startX, startY, endX, endY,
      centerX: (startX + endX) / 2,
      centerY: (startY + endY) / 2
    };
  }

  /**
   * Constrain center to keep content visible.
   * worldWidth/worldHeight define the total content bounds.
   */
  constrainCenter(worldWidth?: number, worldHeight?: number) {
    if (worldWidth === undefined || worldHeight === undefined) {
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
  }
}
