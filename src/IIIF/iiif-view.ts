import { IIIFImage } from './iiif-image';

/**
 * Classical camera view representation in image pixel coordinates
 * Useful for camera-like pan/zoom operations
 */

export class Viewport {

  // Container dimensions
  containerWidth: number;
  containerHeight: number;

  centerX: number; // Normalized (0-1)
  centerY: number; // Normalized (0-1)

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


}