import { IIIFImage } from './iiif-image';

export class Viewport {
    containerWidth: number;
    containerHeight: number;
    scale: number;
    centerX: number; // Normalized (0-1)
    centerY: number; // Normalized (0-1)
    minScale: number;
    maxScale: number;

  constructor(containerWidth: number, containerHeight: number) {
    this.containerWidth = containerWidth;
    this.containerHeight = containerHeight;
    this.scale = 1;
    this.centerX = 0.5; // Normalized coordinates (0-1)
    this.centerY = 0.5;
    this.minScale = 0;
    this.maxScale = 10;
  }

  // Set viewport to fit entire image
  fitToContainer(image : IIIFImage) {
    const imageWidth = image.width;
    const imageHeight = image.height;
    const scaleX = this.containerWidth / imageWidth;
    const scaleY = this.containerHeight / imageHeight;
    this.scale = Math.min(scaleX, scaleY);
    this.minScale = this.scale * 0.2; // Allow zooming out to half of fit size
    this.centerX = 0.5;
    this.centerY = 0.5;
    return this;
  }

  fitToWidth(image: IIIFImage) {
    const imageWidth = image.width;
    this.scale = this.containerWidth / imageWidth;
    this.minScale = this.scale * 0.2;
    this.centerX = 0.5;
    this.centerY = 0.5;
    console.log(`Image width: ${imageWidth}`);
    console.log(`Container width: ${this.containerWidth}`);
    console.log(`fitToWidth: scale set to ${this.scale}`);

    return this;
  }

  fitToHeight(image: IIIFImage) {
    const imageHeight = image.height;
    this.scale = this.containerHeight / imageHeight;
    this.minScale = this.scale * 0.5;
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

    //console.log(`Viewport bounds in image coords: left=${left}, top=${top}, width=${scaledWidth}, height=${scaledHeight}`);
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
  canvasToImagePoint(canvasX: number, canvasY: number, image: IIIFImage): { x: number, y: number } {
    // Calculate viewport bounds in image space
    const viewportWidth = this.containerWidth / this.scale;
    const viewportHeight = this.containerHeight / this.scale;
    const viewportMinX = (this.centerX * image.width) - (viewportWidth / 2);
    const viewportMinY = (this.centerY * image.height) - (viewportHeight / 2);

    // Transform canvas pixel to image pixel
    const imageX = viewportMinX + (canvasX / this.scale);
    const imageY = viewportMinY + (canvasY / this.scale);

    return { x: imageX, y: imageY };
  }

  // Convert image pixel coordinates to normalized coordinates (0-1)
  imageToNormalizedPoint(imageX: number, imageY: number, image: IIIFImage): { x: number, y: number } {
    return {
      x: imageX / image.width,
      y: imageY / image.height
    };
  }

  // Convert canvas pixel coordinates directly to normalized coordinates
  canvasToNormalized(canvasX: number, canvasY: number, image: IIIFImage): { x: number, y: number } {
    const imagePoint = this.canvasToImagePoint(canvasX, canvasY, image);
    return this.imageToNormalizedPoint(imagePoint.x, imagePoint.y, image);
  }

  // Convert normalized coordinates back to image pixel coordinates
  normalizedToImagePoint(normalizedX: number, normalizedY: number, image: IIIFImage): { x: number, y: number } {
    return {
      x: normalizedX * image.width,
      y: normalizedY * image.height
    };
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