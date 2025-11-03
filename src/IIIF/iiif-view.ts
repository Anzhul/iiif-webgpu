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
    this.minScale = this.scale * 0.5; // Allow zooming out to half of fit size
    this.centerX = 0.5;
    this.centerY = 0.5;
    return this;
  }

  fitToWidth(image: IIIFImage) {
    const imageWidth = image.width;
    this.scale = this.containerWidth / imageWidth;
    this.minScale = this.scale * 0.5;
    this.centerX = 0.5;
    this.centerY = 0.5;
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

  // Zoom to specific point (canvasX/Y are in canvas pixel coordinates)
  zoom(newScale: number, canvasX: number, canvasY: number, image: IIIFImage) {
    console.log(`Zooming to ${newScale} at canvas coords (${canvasX}, ${canvasY})`);

    // Calculate which point in the image (in image pixel coords) is currently at the mouse position
    const bounds = this.getImageBounds(image);
    const viewportWidth = this.containerWidth / this.scale;
    const viewportHeight = this.containerHeight / this.scale;

    // Convert canvas coordinates to image coordinates
    const imagePointX = bounds.left + (canvasX / this.scale);
    const imagePointY = bounds.top + (canvasY / this.scale);

    console.log(`  Image point under cursor: (${imagePointX}, ${imagePointY})`);

    // Clamp new scale
    newScale = Math.max(this.minScale, Math.min(this.maxScale, newScale));

    // Calculate where this same image point should be after the zoom
    // We want: imagePoint = newBounds.left + (canvasX / newScale)
    // So: newBounds.left = imagePoint - (canvasX / newScale)
    // And: newBounds.left = (newCenter * image.width) - (newViewportWidth / 2)
    // Therefore: newCenter = (imagePoint - (canvasX / newScale) + (newViewportWidth / 2)) / image.width

    const newViewportWidth = this.containerWidth / newScale;
    const newViewportHeight = this.containerHeight / newScale;

    this.centerX = (imagePointX - (canvasX / newScale) + (newViewportWidth / 2)) / image.width;
    this.centerY = (imagePointY - (canvasY / newScale) + (newViewportHeight / 2)) / image.height;

    // Update scale
    this.scale = newScale;

    console.log(`  New center: (${this.centerX}, ${this.centerY}), scale: ${this.scale}`);

    this.constrainCenter(image);
  }

  // Pan by pixel offset (deltaX/Y are mouse movement deltas)
  pan(deltaX: number, deltaY: number, image: IIIFImage) {
    const normalizedDx = (deltaX / this.scale) / image.width;
    const normalizedDy = (deltaY / this.scale) / image.height;

    // Add delta for intuitive drag-to-follow behavior
    this.centerX += normalizedDx;
    this.centerY += normalizedDy;
    this.constrainCenter(image);
  }

  constrainCenter(image?: IIIFImage) {
    if (!image) {
      // Basic constraint to 0-1 range
      this.centerX = Math.max(0, Math.min(1, this.centerX));
      this.centerY = Math.max(0, Math.min(1, this.centerY));
      return;
    }

    // Advanced constraint considering zoom level and image bounds
    const bounds = this.getImageBounds(image);
    const scaledWidth = this.containerWidth / this.scale;
    const scaledHeight = this.containerHeight / this.scale;

    // Calculate limits based on zoom level
    const minCenterX = (scaledWidth / 2) / image.width;
    const maxCenterX = 1 - (scaledWidth / 2) / image.width;
    const minCenterY = (scaledHeight / 2) / image.height;
    const maxCenterY = 1 - (scaledHeight / 2) / image.height;

    this.centerX = Math.max(minCenterX, Math.min(maxCenterX, this.centerX));
    this.centerY = Math.max(minCenterY, Math.min(maxCenterY, this.centerY));
  }
}