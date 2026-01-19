import { IIIFImage } from './iiif-image';
import { Viewport } from './iiif-view';

/**
 * Represents an HTML overlay element positioned over an IIIF image
 */
export interface OverlayElement {
  /** Unique identifier for this overlay */
  id: string;
  /** The HTML element to position */
  element: HTMLElement;
  /** X position in image pixel coordinates */
  imageX: number;
  /** Y position in image pixel coordinates */
  imageY: number;
  /** Width in image pixel coordinates */
  imageWidth: number;
  /** Height in image pixel coordinates */
  imageHeight: number;
  /** Which image this overlay belongs to */
  imageId: string;
  /** Whether to scale the element with zoom (default: true) */
  scaleWithZoom?: boolean;
}

/**
 * Manages HTML overlays that are positioned and scaled to match
 * the 3D camera transformations of the IIIF viewer
 */
export class IIIFOverlayManager {
  private overlays: Map<string, OverlayElement> = new Map();
  private container: HTMLElement;
  private viewport: Viewport;
  private images: Map<string, IIIFImage>;

  /**
   * Creates a new overlay manager
   * @param container The container element to add overlays to (should be same size as canvas)
   * @param viewport The viewport instance from the IIIF viewer
   * @param images Map of image IDs to IIIFImage instances
   */
  constructor(
    container: HTMLElement,
    viewport: Viewport,
    images: Map<string, IIIFImage>
  ) {
    this.container = container;
    this.viewport = viewport;
    this.images = images;

    // Ensure container is positioned
    if (getComputedStyle(container).position === 'static') {
      container.style.position = 'relative';
    }

    // Container should allow pointer events to pass through by default
    container.style.pointerEvents = 'none';
  }

  /**
   * Adds an overlay element at the specified image coordinates
   * @param overlay The overlay configuration
   */
  addOverlay(overlay: OverlayElement): void {
    // Set up the element styling
    overlay.element.style.position = 'absolute';
    overlay.element.style.transformOrigin = 'top left';
    overlay.element.style.pointerEvents = 'auto'; // Allow individual overlays to receive events

    // Add to DOM if not already present
    if (!overlay.element.parentElement) {
      this.container.appendChild(overlay.element);
    }

    // Store the overlay
    this.overlays.set(overlay.id, overlay);

    // Position it immediately
    this.updateOverlay(overlay.id);
  }

  /**
   * Removes an overlay by ID
   * @param id The overlay ID
   */
  removeOverlay(id: string): void {
    const overlay = this.overlays.get(id);
    if (overlay) {
      if (overlay.element.parentElement === this.container) {
        this.container.removeChild(overlay.element);
      }
      this.overlays.delete(id);
    }
  }

  /**
   * Updates the position of a specific overlay
   * @param id The overlay ID
   */
  updateOverlay(id: string): void {
    const overlay = this.overlays.get(id);
    if (!overlay) return;

    const image = this.images.get(overlay.imageId);
    if (!image) {
      // Hide overlay if image not found
      overlay.element.style.display = 'none';
      return;
    }

    // Get viewport bounds in image space
    const bounds = this.viewport.getImageBounds(image);

    // Check if overlay is visible
    const overlayRight = overlay.imageX + overlay.imageWidth;
    const overlayBottom = overlay.imageY + overlay.imageHeight;

    if (
      overlayRight < bounds.left ||
      overlay.imageX > bounds.right ||
      overlayBottom < bounds.top ||
      overlay.imageY > bounds.bottom
    ) {
      // Overlay is off-screen
      overlay.element.style.display = 'none';
      return;
    }

    // Convert image coordinates to canvas pixel coordinates
    const position = this.imageToCanvasCoords(
      overlay.imageX,
      overlay.imageY,
      image
    );

    // Calculate scale
    const scale = overlay.scaleWithZoom !== false ? this.viewport.scale : 1;

    // Apply transform with scale (this scales everything including text)
    overlay.element.style.display = 'block';
    overlay.element.style.transform = `translate(${position.x}px, ${position.y}px) scale(${scale})`;
    overlay.element.style.width = `${overlay.imageWidth}px`;
    overlay.element.style.height = `${overlay.imageHeight}px`;
  }

  /**
   * Updates all overlays - call this each frame during camera animation
   */
  updateAllOverlays(): void {
    for (const id of this.overlays.keys()) {
      this.updateOverlay(id);
    }
  }

  /**
   * Converts image pixel coordinates to canvas pixel coordinates
   */
  private imageToCanvasCoords(
    imageX: number,
    imageY: number,
    image: IIIFImage
  ): { x: number; y: number } {
    const scaledWidth = this.viewport.containerWidth / this.viewport.scale;
    const scaledHeight = this.viewport.containerHeight / this.viewport.scale;

    const viewportMinX = (this.viewport.centerX * image.width) - (scaledWidth / 2);
    const viewportMinY = (this.viewport.centerY * image.height) - (scaledHeight / 2);

    const canvasX = (imageX - viewportMinX) * this.viewport.scale;
    const canvasY = (imageY - viewportMinY) * this.viewport.scale;

    return { x: canvasX, y: canvasY };
  }

  /**
   * Converts canvas pixel coordinates to image pixel coordinates
   */
  canvasToImageCoords(
    canvasX: number,
    canvasY: number,
    imageId: string
  ): { x: number; y: number } | null {
    const image = this.images.get(imageId);
    if (!image) return null;

    const point = this.viewport.canvasToImagePoint(canvasX, canvasY, image);
    return { x: point.x, y: point.y };
  }

  /**
   * Gets an overlay by ID
   */
  getOverlay(id: string): OverlayElement | undefined {
    return this.overlays.get(id);
  }

  /**
   * Gets all overlay IDs
   */
  getOverlayIds(): string[] {
    return Array.from(this.overlays.keys());
  }

  /**
   * Clears all overlays
   */
  clearAllOverlays(): void {
    for (const overlay of this.overlays.values()) {
      if (overlay.element.parentElement === this.container) {
        this.container.removeChild(overlay.element);
      }
    }
    this.overlays.clear();
  }

  /**
   * Updates an overlay's image position (useful for draggable overlays)
   */
  updateOverlayPosition(
    id: string,
    imageX: number,
    imageY: number
  ): void {
    const overlay = this.overlays.get(id);
    if (overlay) {
      overlay.imageX = imageX;
      overlay.imageY = imageY;
      this.updateOverlay(id);
    }
  }

  /**
   * Updates an overlay's size in image coordinates
   */
  updateOverlaySize(
    id: string,
    imageWidth: number,
    imageHeight: number
  ): void {
    const overlay = this.overlays.get(id);
    if (overlay) {
      overlay.imageWidth = imageWidth;
      overlay.imageHeight = imageHeight;
      this.updateOverlay(id);
    }
  }
}
