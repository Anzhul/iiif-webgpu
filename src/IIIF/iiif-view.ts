import { IIIFImage } from './iiif-image';

/**
 * Classical camera view representation supporting both:
 * - Single image mode: normalized coordinates (0-1) relative to one image
 * - World space mode: absolute pixel coordinates for multi-image canvas
 */

export class Viewport {

  // Container dimensions
  containerWidth: number;
  containerHeight: number;

  centerX: number; // Normalized (0-1) for single image mode
  centerY: number; // Normalized (0-1) for single image mode

  // World space coordinates (for multi-image unified canvas)
  worldCenterX: number = 0;  // Absolute pixel X in world space
  worldCenterY: number = 0;  // Absolute pixel Y in world space
  useWorldSpace: boolean = false;  // Toggle between normalized and world space modes

  // 3D camera properties
  cameraZ: number; // Camera Z position (distance from image plane)
  minZ: number;
  maxZ: number;

  fov: number; // Field of view in degrees
  near: number; // Near clipping plane
  far: number; // Far clipping plane

  scale: number; // Cached scale derived from cameraZ
  minScale: number; // Minimum scale (maximum zoom out) derived from maxZ
  maxScale: number; // Maximum scale (maximum zoom in) derived from minZ

  // Cached FOV trigonometric values to avoid repeated calculations
  private fovRadians: number;
  private tanHalfFov: number;

  // Cache for getImageBounds to avoid redundant calculations
  private boundsCache: Map<string, {
    bounds: { left: number; top: number; right: number; bottom: number; width: number; height: number };
    centerX: number;
    centerY: number;
    scale: number;
    containerWidth: number;
    containerHeight: number;
  }> = new Map();

  // OPTIMIZATION: Track if cache needs invalidation (avoid double clear)
  private boundsCacheInvalid: boolean = false;

  constructor(containerWidth: number, containerHeight: number) {
    this.containerWidth = containerWidth;
    this.containerHeight = containerHeight;

    this.centerX = 0.5; // Normalized coordinates (0-1)
    this.centerY = 0.5;

    // Initialize 3D camera parameters
    this.cameraZ = 1000; // Camera is 1000 pixels away from the image plane (at Z=0)
    this.minZ = 100;
    this.maxZ = 2000;

    this.fov = 45; // 60 degree field of view
    this.near = 0.1; // Near clipping plane
    this.far = 10000; // Far clipping plane

    // Initialize cached FOV trigonometric values
    this.fovRadians = (this.fov * Math.PI) / 180;
    this.tanHalfFov = Math.tan(this.fovRadians / 2);

    // Initialize scale properties
    this.scale = this.calculateScale();

    // Initialize scale limits (will be properly calculated in updateScaleLimits)
    const visibleHeightAtMaxZ = 2 * this.maxZ * this.tanHalfFov;
    this.minScale = this.containerHeight / visibleHeightAtMaxZ;
    const visibleHeightAtMinZ = 2 * this.minZ * this.tanHalfFov;
    this.maxScale = this.containerHeight / visibleHeightAtMinZ;
  }

  /**
   * Update cached FOV trigonometric constants
   * Call this whenever FOV changes dynamically
   * @internal Reserved for future use when FOV becomes mutable
   */
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

  /**
   * Invalidate the bounds cache when viewport state changes
   * OPTIMIZED: Only clear if not already invalid (prevents double clear)
   */
  private invalidateBoundsCache(): void {
    if (!this.boundsCacheInvalid) {
      this.boundsCache.clear();
      this.boundsCacheInvalid = true;
    }
  }

  private updateScaleLimits(): void {
    // Calculate scale limits based on Z limits
    // When camera is at maxZ (far away), scale is at minimum (zoomed out)
    const visibleHeightAtMaxZ = 2 * this.maxZ * this.tanHalfFov;
    this.minScale = this.containerHeight / visibleHeightAtMaxZ;

    // When camera is at minZ (close), scale is at maximum (zoomed in)
    const visibleHeightAtMinZ = 2 * this.minZ * this.tanHalfFov;
    this.maxScale = this.containerHeight / visibleHeightAtMinZ;
  }

  getScale(): number {
    return this.scale;
  }

  /**
   * Get cached FOV in radians
   */
  getFovRadians(): number {
    return this.fovRadians;
  }

  /**
   * Get cached tan(fov/2) value
   */
  getTanHalfFov(): number {
    return this.tanHalfFov;
  }
    

  fitToWidth(image: IIIFImage) {

    const targetScale = this.containerWidth / image.width;

    this.cameraZ = this.containerHeight / (2 * targetScale * this.tanHalfFov);

    // Set max zoom out to 5x farther, max zoom in to 10x closer
    this.maxZ = this.cameraZ * 5;
    this.minZ = this.cameraZ * 0.1;

    // Update clipping planes based on zoom constraints
    this.near = this.minZ * 0.01;  // 1% of closest zoom for safety
    this.far = this.maxZ * 2;      // 2x farthest zoom for safety

    this.updateScale();

    this.centerX = 0.5;
    this.centerY = 0.5;
    return this;
  }



  // Get visible bounds in image coordinates
  getImageBounds(image: IIIFImage) {
    // Check cache first (only if cache is valid)
    if (!this.boundsCacheInvalid) {
      const cached = this.boundsCache.get(image.id);

      // Round scale to 3 decimal places for cache comparison (matching tile manager precision)
      const roundedScale = Math.round(this.scale * 1000) / 1000;

      if (cached &&
          cached.centerX === this.centerX &&
          cached.centerY === this.centerY &&
          cached.scale === roundedScale &&
          cached.containerWidth === this.containerWidth &&
          cached.containerHeight === this.containerHeight) {
        // Cache hit - return cached bounds without recalculation
        return cached.bounds;
      }
    }

    // Cache miss - calculate bounds
    // How many pixels of the original image are visible in the viewport
    const scaledWidth = this.containerWidth / this.scale;
    const scaledHeight = this.containerHeight / this.scale;

    const left = (this.centerX * image.width) - (scaledWidth / 2);
    const top = (this.centerY * image.height) - (scaledHeight / 2);

    const bounds = {
      left: Math.max(0, left),
      top: Math.max(0, top),
      right: Math.min(image.width, left + scaledWidth),
      bottom: Math.min(image.height, top + scaledHeight),
      width: scaledWidth,
      height: scaledHeight
    };

    // Round scale to 3 decimal places for cache storage
    const roundedScale = Math.round(this.scale * 1000) / 1000;

    // Store in cache (using rounded scale for consistency)
    this.boundsCache.set(image.id, {
      bounds,
      centerX: this.centerX,
      centerY: this.centerY,
      scale: roundedScale,
      containerWidth: this.containerWidth,
      containerHeight: this.containerHeight
    });

    // Mark cache as valid since we just populated it
    this.boundsCacheInvalid = false;

    return bounds;
  }

  constrainCenter(image?: IIIFImage) {
    const oldCenterX = this.centerX;
    const oldCenterY = this.centerY;

    if (!image) {
      // Basic constraint to 0-1 range
      this.centerX = Math.max(0, Math.min(1, this.centerX));
      this.centerY = Math.max(0, Math.min(1, this.centerY));
    } else {
      // Advanced constraint considering zoom level and image bounds
      const scaledWidth = this.containerWidth / this.scale;
      const scaledHeight = this.containerHeight / this.scale;

      // When viewport is larger than image, don't constrain (allow free positioning for zoom-to-cursor)
      // When viewport is smaller than image, constrain to keep image visible
      if (scaledWidth < image.width) {
        const minCenterX = (scaledWidth / 2) / image.width;
        const maxCenterX = 1 - (scaledWidth / 2) / image.width;
        this.centerX = Math.max(minCenterX, Math.min(maxCenterX, this.centerX));
      }

      if (scaledHeight < image.height) {
        const minCenterY = (scaledHeight / 2) / image.height;
        const maxCenterY = 1 - (scaledHeight / 2) / image.height;
        this.centerY = Math.max(minCenterY, Math.min(maxCenterY, this.centerY));
      }
    }

    // Only invalidate cache if center actually changed
    if (oldCenterX !== this.centerX || oldCenterY !== this.centerY) {
      // DEBUG: Log constraint changes to detect wavering
      const deltaX = Math.abs(this.centerX - oldCenterX);
      const deltaY = Math.abs(this.centerY - oldCenterY);
      if (deltaX > 0.000001 || deltaY > 0.000001) {
        console.log('Constraint adjusted center:', {
          deltaX: deltaX.toFixed(8),
          deltaY: deltaY.toFixed(8),
          scale: this.scale.toFixed(3)
        });
      }
      this.invalidateBoundsCache();
    }
  }

  // Matrix-based coordinate transformations

  // Convert canvas pixel coordinates to image pixel coordinates
  // In 3D mode, this performs a ray-plane intersection at Z=0
  canvasToImagePoint(canvasX: number, canvasY: number, image: IIIFImage, targetZ: number = 0): { x: number, y: number, z: number } {
    // Calculate viewport bounds in image space
    const viewportWidth = this.containerWidth / this.scale;
    const viewportHeight = this.containerHeight / this.scale;
    const viewportMinX = (this.centerX * image.width) - (viewportWidth / 2);
    const viewportMinY = (this.centerY * image.height) - (viewportHeight / 2);

    // Transform canvas pixel to image pixel
    const imageX = viewportMinX + (canvasX / this.scale);
    const imageY = viewportMinY + (canvasY / this.scale);

    return { x: imageX, y: imageY, z: targetZ };
  }

  // Set center such that a given image point appears at a given canvas position
  setCenterFromImagePoint(imageX: number, imageY: number, canvasX: number, canvasY: number, image: IIIFImage) {
    const viewportWidth = this.containerWidth / this.scale;
    const viewportHeight = this.containerHeight / this.scale;

    // Calculate what center would place imagePoint at canvasPosition
    this.centerX = (imageX - (canvasX / this.scale) + (viewportWidth / 2)) / image.width;
    this.centerY = (imageY - (canvasY / this.scale) + (viewportHeight / 2)) / image.height;

    // Invalidate bounds cache since center changed
    this.invalidateBoundsCache();
  }

  // ============ WORLD SPACE METHODS ============

  /**
   * Enable world space mode for multi-image canvas
   */
  enableWorldSpace(): void {
    this.useWorldSpace = true;
  }

  /**
   * Disable world space mode (single image mode)
   */
  disableWorldSpace(): void {
    this.useWorldSpace = false;
  }

  /**
   * Set the world space center position
   */
  setWorldCenter(worldX: number, worldY: number): void {
    this.worldCenterX = worldX;
    this.worldCenterY = worldY;
    this.invalidateBoundsCache();
  }

  /**
   * Get the visible bounds in world coordinates
   * Uses live calculation from cameraZ to ensure accuracy during animations
   */
  getWorldBounds(): { left: number; top: number; right: number; bottom: number; width: number; height: number } {
    // Calculate scale directly from cameraZ to ensure accuracy during zoom animations
    // (this.scale may be slightly stale due to throttled updateScale() calls)
    const liveScale = this.containerHeight / (2 * this.cameraZ * this.tanHalfFov);
    const viewportWidth = this.containerWidth / liveScale;
    const viewportHeight = this.containerHeight / liveScale;

    return {
      left: this.worldCenterX - viewportWidth / 2,
      top: this.worldCenterY - viewportHeight / 2,
      right: this.worldCenterX + viewportWidth / 2,
      bottom: this.worldCenterY + viewportHeight / 2,
      width: viewportWidth,
      height: viewportHeight
    };
  }

  /**
   * Convert canvas coordinates to world coordinates
   */
  canvasToWorldPoint(canvasX: number, canvasY: number): { x: number; y: number } {
    // Use live scale for accuracy during zoom animations
    const liveScale = this.containerHeight / (2 * this.cameraZ * this.tanHalfFov);
    const viewportWidth = this.containerWidth / liveScale;
    const viewportHeight = this.containerHeight / liveScale;

    const worldX = (this.worldCenterX - viewportWidth / 2) + (canvasX / liveScale);
    const worldY = (this.worldCenterY - viewportHeight / 2) + (canvasY / liveScale);

    return { x: worldX, y: worldY };
  }

  /**
   * Convert world coordinates to canvas coordinates
   */
  worldToCanvasPoint(worldX: number, worldY: number): { x: number; y: number } {
    // Use live scale for accuracy during zoom animations
    const liveScale = this.containerHeight / (2 * this.cameraZ * this.tanHalfFov);
    const viewportWidth = this.containerWidth / liveScale;
    const viewportHeight = this.containerHeight / liveScale;

    const canvasX = (worldX - (this.worldCenterX - viewportWidth / 2)) * liveScale;
    const canvasY = (worldY - (this.worldCenterY - viewportHeight / 2)) * liveScale;

    return { x: canvasX, y: canvasY };
  }

  /**
   * Get image bounds in LOCAL image coordinates (accounting for world position)
   * This is used by TileManager to know which tiles to load
   */
  getImageBoundsInWorldSpace(image: IIIFImage): { left: number; top: number; right: number; bottom: number; width: number; height: number } {
    const worldBounds = this.getWorldBounds();

    // Convert world bounds to image-local coordinates
    const localLeft = worldBounds.left - image.worldX;
    const localTop = worldBounds.top - image.worldY;
    const localRight = worldBounds.right - image.worldX;
    const localBottom = worldBounds.bottom - image.worldY;

    // Clamp to image dimensions
    return {
      left: Math.max(0, localLeft),
      top: Math.max(0, localTop),
      right: Math.min(image.width, localRight),
      bottom: Math.min(image.height, localBottom),
      width: worldBounds.width,
      height: worldBounds.height
    };
  }

  /**
   * Check if an image is visible in the current viewport (world space)
   */
  isImageVisible(image: IIIFImage): boolean {
    const worldBounds = this.getWorldBounds();
    const imageBounds = image.worldBounds;

    // Check for intersection
    return !(imageBounds.right < worldBounds.left ||
             imageBounds.left > worldBounds.right ||
             imageBounds.bottom < worldBounds.top ||
             imageBounds.top > worldBounds.bottom);
  }

  /**
   * Fit the viewport to show all images within given bounds
   */
  fitToBounds(minX: number, minY: number, maxX: number, maxY: number, padding: number = 50): void {
    const boundsWidth = maxX - minX + padding * 2;
    const boundsHeight = maxY - minY + padding * 2;

    // Calculate scale to fit bounds
    const scaleX = this.containerWidth / boundsWidth;
    const scaleY = this.containerHeight / boundsHeight;
    const targetScale = Math.min(scaleX, scaleY);

    // Calculate cameraZ from target scale
    this.cameraZ = this.containerHeight / (2 * targetScale * this.tanHalfFov);

    // Set adaptive zoom limits based on content size
    // For multi-image viewing, allow much more zoom-in to see details
    // maxZ: zoom out to see 5x more than fit-all view
    this.maxZ = this.cameraZ * 5;

    // minZ: Calculate based on target pixel-level zoom
    // We want to be able to zoom in until ~1:1 pixel viewing
    // At 1:1, scale = 1 (1 screen pixel = 1 image pixel)
    // minZ at scale=1: containerHeight / (2 * 1 * tanHalfFov)
    const zoomOneToOneZ = this.containerHeight / (2 * 1 * this.tanHalfFov);

    // Allow zooming to 2x beyond 1:1 (200% zoom)
    this.minZ = zoomOneToOneZ * 0.5;

    // But don't allow minZ to be larger than current camera Z (would prevent any zoom-in)
    this.minZ = Math.min(this.minZ, this.cameraZ * 0.01);

    this.near = this.minZ * 0.01;
    this.far = this.maxZ * 2;

    this.updateScale();

    // Center on the bounds
    this.worldCenterX = (minX + maxX) / 2;
    this.worldCenterY = (minY + maxY) / 2;
  }

  /**
   * Set center from world point (for world-space panning)
   */
  setCenterFromWorldPoint(worldX: number, worldY: number, canvasX: number, canvasY: number): void {
    // Use live scale for accuracy during zoom animations
    const liveScale = this.containerHeight / (2 * this.cameraZ * this.tanHalfFov);
    const viewportWidth = this.containerWidth / liveScale;
    const viewportHeight = this.containerHeight / liveScale;

    this.worldCenterX = worldX - (canvasX / liveScale) + (viewportWidth / 2);
    this.worldCenterY = worldY - (canvasY / liveScale) + (viewportHeight / 2);

    this.invalidateBoundsCache();
  }
}