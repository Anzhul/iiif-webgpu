import { IIIFImage } from './iiif-image';

/**
 * Classical camera view representation in image pixel coordinates
 * Useful for camera-like pan/zoom operations
 */

export class Viewport {
  // Scale
  scale: number;
  minScale: number;
  maxScale: number;

  // Container dimensions
  containerWidth: number;
  containerHeight: number;

  centerX: number; // Normalized (0-1)
  centerY: number; // Normalized (0-1)

  // 3D camera properties
  cameraZ: number; // Camera Z position (distance from image plane)
  fov: number; // Field of view in degrees
  near: number; // Near clipping plane
  far: number; // Far clipping plane

  constructor(containerWidth: number, containerHeight: number) {
    this.containerWidth = containerWidth;
    this.containerHeight = containerHeight;
    this.scale = 1;
    this.centerX = 0.5; // Normalized coordinates (0-1)
    this.centerY = 0.5;
    this.minScale = 0;
    this.maxScale = 10;

    // Initialize 3D camera parameters
    this.cameraZ = 1000; // Camera is 1000 pixels away from the image plane (at Z=0)
    this.fov = 45; // 60 degree field of view
    this.near = 0.1; // Near clipping plane
    this.far = 10000; // Far clipping plane
  }

  fitToWidth(image: IIIFImage) {
    const imageWidth = image.width;
    this.scale = this.containerWidth / imageWidth;
    this.minScale = this.scale * 0.2;
    this.centerX = 0.5;
    this.centerY = 0.5;
    console.log(this);
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