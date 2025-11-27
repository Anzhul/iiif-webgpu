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


}