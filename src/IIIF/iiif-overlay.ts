import { Viewport } from './iiif-view';

/**
 * Represents an HTML overlay element positioned in world coordinates
 */
export interface OverlayElement {
  /** Unique identifier for this overlay */
  id: string;
  /** The HTML element to position */
  element: HTMLElement;
  /** X position in world coordinates */
  worldX: number;
  /** Y position in world coordinates */
  worldY: number;
  /** Width in world coordinates */
  worldWidth: number;
  /** Height in world coordinates */
  worldHeight: number;
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

  /**
   * Creates a new overlay manager
   * @param container The container element to add overlays to (should be same size as canvas)
   * @param viewport The viewport instance from the IIIF viewer
   */
  constructor(
    container: HTMLElement,
    viewport: Viewport
  ) {
    this.container = container;
    this.viewport = viewport;

    // Ensure container is positioned
    if (getComputedStyle(container).position === 'static') {
      container.style.position = 'relative';
    }

    // Container should allow pointer events to pass through by default
    container.style.pointerEvents = 'none';
  }

  /**
   * Adds an overlay element at the specified world coordinates
   * @param overlay The overlay configuration
   */
  addOverlay(overlay: OverlayElement): void {
    // Set up the element styling
    overlay.element.style.position = 'absolute';
    overlay.element.style.transformOrigin = 'top left';
    overlay.element.style.pointerEvents = 'auto';

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

    // Get viewport bounds in world space
    const bounds = this.viewport.getWorldBounds();

    // Check if overlay is visible
    const overlayRight = overlay.worldX + overlay.worldWidth;
    const overlayBottom = overlay.worldY + overlay.worldHeight;

    if (
      overlayRight < bounds.left ||
      overlay.worldX > bounds.right ||
      overlayBottom < bounds.top ||
      overlay.worldY > bounds.bottom
    ) {
      // Overlay is off-screen
      overlay.element.style.display = 'none';
      return;
    }

    // Convert world coordinates to canvas pixel coordinates
    const position = this.worldToCanvasCoords(overlay.worldX, overlay.worldY);

    // Calculate scale: viewport.scale is CSS pixels per world unit
    const scale = overlay.scaleWithZoom !== false ? this.viewport.scale : 1;

    // Apply transform with scale
    overlay.element.style.display = 'block';
    overlay.element.style.transform = `translate(${position.x}px, ${position.y}px) scale(${scale})`;
    overlay.element.style.width = `${overlay.worldWidth}px`;
    overlay.element.style.height = `${overlay.worldHeight}px`;
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
   * Converts world coordinates to canvas pixel coordinates
   */
  private worldToCanvasCoords(
    worldX: number,
    worldY: number
  ): { x: number; y: number } {
    const bounds = this.viewport.getWorldBounds();

    const canvasX = (worldX - bounds.left) * this.viewport.scale;
    const canvasY = (worldY - bounds.top) * this.viewport.scale;

    return { x: canvasX, y: canvasY };
  }

  /**
   * Converts canvas pixel coordinates to world coordinates
   */
  canvasToWorldCoords(
    canvasX: number,
    canvasY: number
  ): { x: number; y: number } {
    return this.viewport.canvasToWorldPoint(canvasX, canvasY);
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
   * Updates an overlay's world position (useful for draggable overlays)
   */
  updateOverlayPosition(
    id: string,
    worldX: number,
    worldY: number
  ): void {
    const overlay = this.overlays.get(id);
    if (overlay) {
      overlay.worldX = worldX;
      overlay.worldY = worldY;
      this.updateOverlay(id);
    }
  }

  /**
   * Updates an overlay's size in world coordinates
   */
  updateOverlaySize(
    id: string,
    worldWidth: number,
    worldHeight: number
  ): void {
    const overlay = this.overlays.get(id);
    if (overlay) {
      overlay.worldWidth = worldWidth;
      overlay.worldHeight = worldHeight;
      this.updateOverlay(id);
    }
  }
}
