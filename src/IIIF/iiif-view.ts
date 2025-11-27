import { IIIFImage } from './iiif-image';
import { WorldSpace } from './iiif-world';

/**
 * Viewport representing the camera view in a world coordinate system
 * Supports both world coordinates and legacy image-relative coordinates
 */

export class Viewport {

  // Container dimensions
  containerWidth: number;
  containerHeight: number;

  // World coordinate system (NEW - primary)
  cameraWorldX: number;  // Camera position in world coordinates (pixels)
  cameraWorldY: number;  // Camera position in world coordinates (pixels)

  // Legacy image-relative coordinates (DEPRECATED - kept for backward compatibility)
  /** @deprecated Use cameraWorldX/cameraWorldY instead */
  centerX: number; // Normalized (0-1) - relative to focused image
  /** @deprecated Use cameraWorldY instead */
  centerY: number; // Normalized (0-1) - relative to focused image

  // 3D camera properties
  cameraZ: number; // Camera Z position (distance from world plane)
  minZ: number;
  maxZ: number;

  fov: number; // Field of view in degrees
  near: number; // Near clipping plane
  far: number; // Far clipping plane

  scale: number; // Cached scale derived from cameraZ

  constructor(containerWidth: number, containerHeight: number) {
    this.containerWidth = containerWidth;
    this.containerHeight = containerHeight;

    // Initialize world coordinates
    this.cameraWorldX = 0;
    this.cameraWorldY = 0;

    // Initialize legacy coordinates (for backward compatibility)
    this.centerX = 0.5; // Normalized coordinates (0-1)
    this.centerY = 0.5;

    // Initialize 3D camera parameters
    this.cameraZ = 1000; // Camera is 1000 pixels away from the world plane (at Z=0)
    this.minZ = 100;
    this.maxZ = 2000;

    this.fov = 45; // 45 degree field of view
    this.near = 0.1; // Near clipping plane
    this.far = 10000; // Far clipping plane

    this.scale = this.calculateScale();
  }

  private calculateScale(): number {
    const fovRadians = (this.fov * Math.PI) / 180;
    const visibleHeight = 2 * this.cameraZ * Math.tan(fovRadians / 2);
    return this.containerHeight / visibleHeight;
  }

  private updateScale(): void {
    this.scale = this.calculateScale();
  }

  getScale(): number {
    return this.scale;
  }

  get minScale(): number {
    // Calculate scale at maxZ (farthest = smallest scale)
    const fovRadians = (this.fov * Math.PI) / 180;
    const visibleHeight = 2 * this.maxZ * Math.tan(fovRadians / 2);
    return this.containerHeight / visibleHeight;
  }

  get maxScale(): number {
    // Calculate scale at minZ (closest = largest scale)
    const fovRadians = (this.fov * Math.PI) / 180;
    const visibleHeight = 2 * this.minZ * Math.tan(fovRadians / 2);
    return this.containerHeight / visibleHeight;
  }


  fitToWidth(image: IIIFImage) {

    const targetScale = this.containerWidth / image.width;

    const fovRadians = (this.fov * Math.PI) / 180;
    this.cameraZ = this.containerHeight / (2 * targetScale * Math.tan(fovRadians / 2));

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


  fitToHeight(image: IIIFImage) {
    const imageHeight = image.height;
    const targetScale = this.containerHeight / imageHeight;
    // Calculate camera Z for this scale
    const fovRadians = (this.fov * Math.PI) / 180;
    this.cameraZ = this.containerHeight / (2 * targetScale * Math.tan(fovRadians / 2));
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
    // How many pixels of the original image are visible in the viewport
    const scaledWidth = this.containerWidth / this.scale;
    const scaledHeight = this.containerHeight / this.scale;

    const left = (this.centerX * image.width) - (scaledWidth / 2);
    const top = (this.centerY * image.height) - (scaledHeight / 2);

    return {
      left: Math.max(0, left),
      top: Math.max(0, top),
      right: Math.min(image.width, left + scaledWidth),
      bottom: Math.min(image.height, top + scaledHeight),
      width: scaledWidth,
      height: scaledHeight
    };
  }

  constrainCenter(image?: IIIFImage) {
    if (!image) {
      // Basic constraint to 0-1 range
      this.centerX = Math.max(0, Math.min(1, this.centerX));
      this.centerY = Math.max(0, Math.min(1, this.centerY));
      return;
    }

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
  }

  // ============================================================================
  // WORLD COORDINATE METHODS (NEW)
  // ============================================================================

  /**
   * Get the visible bounds in world coordinates
   * @returns Bounding box of visible area in world space
   */
  getWorldBounds(): { left: number, top: number, right: number, bottom: number, width: number, height: number } {
    const halfWidth = (this.containerWidth / this.scale) / 2;
    const halfHeight = (this.containerHeight / this.scale) / 2;

    return {
      left: this.cameraWorldX - halfWidth,
      right: this.cameraWorldX + halfWidth,
      top: this.cameraWorldY - halfHeight,
      bottom: this.cameraWorldY + halfHeight,
      width: this.containerWidth / this.scale,
      height: this.containerHeight / this.scale
    };
  }

  /**
   * Convert canvas pixel coordinates to world coordinates
   * @param canvasX - X coordinate on canvas (pixels)
   * @param canvasY - Y coordinate on canvas (pixels)
   * @returns Point in world coordinates
   */
  canvasToWorld(canvasX: number, canvasY: number): { x: number, y: number } {
    const bounds = this.getWorldBounds();

    // Convert canvas pixel to world coordinate
    const worldX = bounds.left + (canvasX / this.scale);
    const worldY = bounds.top + (canvasY / this.scale);

    return { x: worldX, y: worldY };
  }

  /**
   * Convert world coordinates to canvas pixel coordinates
   * @param worldX - X coordinate in world space
   * @param worldY - Y coordinate in world space
   * @returns Point on canvas (pixels), or null if outside viewport
   */
  worldToCanvas(worldX: number, worldY: number): { x: number, y: number } | null {
    const bounds = this.getWorldBounds();

    // Calculate offset from viewport top-left
    const offsetX = worldX - bounds.left;
    const offsetY = worldY - bounds.top;

    // Convert to canvas pixels
    const canvasX = offsetX * this.scale;
    const canvasY = offsetY * this.scale;

    // Check if in bounds
    if (canvasX < 0 || canvasX > this.containerWidth ||
        canvasY < 0 || canvasY > this.containerHeight) {
      return null;
    }

    return { x: canvasX, y: canvasY };
  }

  /**
   * Set camera position so that a world point appears at a specific canvas position
   * @param worldX - World X coordinate to anchor
   * @param worldY - World Y coordinate to anchor
   * @param canvasX - Target canvas X position
   * @param canvasY - Target canvas Y position
   */
  setCameraFromWorldPoint(worldX: number, worldY: number, canvasX: number, canvasY: number) {
    const halfWidth = (this.containerWidth / this.scale) / 2;
    const halfHeight = (this.containerHeight / this.scale) / 2;

    // Calculate camera position that would place worldPoint at canvasPosition
    this.cameraWorldX = worldX - (canvasX / this.scale) + halfWidth;
    this.cameraWorldY = worldY - (canvasY / this.scale) + halfHeight;
  }

  /**
   * Get images visible in the current viewport
   * @param world - WorldSpace instance
   * @returns Array of visible image transforms
   */
  getVisibleImages(world: WorldSpace) {
    const bounds = this.getWorldBounds();
    return world.getVisibleImages(bounds);
  }

  /**
   * Focus camera on a specific world region
   * @param worldX - Center X in world coordinates
   * @param worldY - Center Y in world coordinates
   * @param worldZ - Optional Z position (defaults to current)
   */
  focusOnWorldPoint(worldX: number, worldY: number, worldZ?: number) {
    this.cameraWorldX = worldX;
    this.cameraWorldY = worldY;
    if (worldZ !== undefined) {
      this.cameraZ = worldZ;
      this.updateScale();
    }
  }

  /**
   * Fit camera to show all images in the world
   * @param world - WorldSpace instance
   * @param padding - Padding around images as a fraction (0.1 = 10% padding)
   */
  fitToWorld(world: WorldSpace, padding: number = 0.1) {
    const bounds = world.getWorldBounds();
    if (!bounds) return;

    // Add padding
    const paddingX = bounds.width * padding;
    const paddingY = bounds.height * padding;
    const paddedWidth = bounds.width + paddingX * 2;
    const paddedHeight = bounds.height + paddingY * 2;

    // Calculate Z to fit width or height (whichever requires more zoom out)
    const scaleX = this.containerWidth / paddedWidth;
    const scaleY = this.containerHeight / paddedHeight;
    const targetScale = Math.min(scaleX, scaleY);

    // Calculate Z from scale
    const fovRadians = (this.fov * Math.PI) / 180;
    this.cameraZ = this.containerHeight / (2 * targetScale * Math.tan(fovRadians / 2));
    this.cameraZ = Math.max(this.minZ, Math.min(this.maxZ, this.cameraZ));
    this.updateScale();

    // Center camera on world bounds
    this.cameraWorldX = bounds.left + bounds.width / 2;
    this.cameraWorldY = bounds.top + bounds.height / 2;
  }

  /**
   * Sync legacy centerX/centerY with world coordinates for a specific image
   * Used for backward compatibility
   * @param image - Reference image for normalization
   * @param imageWorldX - Image's world X position
   * @param imageWorldY - Image's world Y position
   */
  syncLegacyCoordinates(image: IIIFImage, imageWorldX: number, imageWorldY: number) {
    // Convert camera world position to normalized image coordinates
    const relativeX = this.cameraWorldX - imageWorldX;
    const relativeY = this.cameraWorldY - imageWorldY;

    this.centerX = relativeX / image.width;
    this.centerY = relativeY / image.height;
  }


}