import { Viewport } from '../core/iiif-view';

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
  /** Whether this overlay is hidden (toggled off by user) */
  hidden?: boolean;
  /** CSS class applied when overlay is active/visible */
  activeClass?: string;
  /** CSS class applied when overlay is inactive/hidden */
  inactiveClass?: string;
  /** Whether the overlay has been activated at least once (intro transition played) */
  hasBeenActive?: boolean;
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
    // Promote to GPU-composited layer so the browser moves a pre-rasterized
    // texture during pan/zoom instead of re-rasterizing content each frame.
    overlay.element.style.willChange = 'transform';

    // Apply initial class state for class-based transitions
    if (overlay.activeClass || overlay.inactiveClass) {
      if (overlay.hidden && overlay.inactiveClass) {
        overlay.element.classList.add(overlay.inactiveClass);
      } else if (!overlay.hidden && overlay.activeClass) {
        overlay.element.classList.add(overlay.activeClass);
      }
    }

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

    const hasTransitionClasses = !!(overlay.activeClass || overlay.inactiveClass);

    // Respect user-toggled hidden state
    if (overlay.hidden) {
      if (hasTransitionClasses) {
        this.setOverlayInactive(overlay);
      } else {
        overlay.element.style.display = 'none';
        overlay.element.style.pointerEvents = 'none';
      }
      return;
    }

    // Convert world coordinates to screen coordinates
    const position = this.worldToCanvasCoords(overlay.worldX, overlay.worldY);
    const scale = overlay.scaleWithZoom !== false ? this.viewport.scale : 1;

    // Off-screen check only for intro transition (before first activation).
    // After first activation, the container's overflow:hidden handles clipping
    // and we skip culling to avoid flickering from offsetWidth being 0 when hidden.
    if (!overlay.hasBeenActive) {
      const screenW = overlay.worldWidth * scale;
      const screenH = overlay.worldHeight * scale;
      const effectiveW = screenW || 32;
      const effectiveH = screenH || 32;
      const containerW = this.container.clientWidth;
      const containerH = this.container.clientHeight;

      const offScreen =
        position.x + effectiveW < 0 ||
        position.x > containerW ||
        position.y + effectiveH < 0 ||
        position.y > containerH;

      if (offScreen) {
        if (hasTransitionClasses) {
          this.setOverlayInactive(overlay);
        } else {
          overlay.element.style.display = 'none';
          overlay.element.style.pointerEvents = 'none';
        }
        return;
      }
    }

    // Apply transform with scale — translate3d promotes to GPU layer
    overlay.element.style.setProperty('--iiif-overlay-scale', String(scale));
    overlay.element.style.transform = `translate3d(${position.x}px, ${position.y}px, 0) scale(${scale})`;
    overlay.element.style.width = `${overlay.worldWidth}px`;
    overlay.element.style.height = `${overlay.worldHeight}px`;

    if (hasTransitionClasses && !overlay.hasBeenActive) {
      // First time entering viewport — play intro transition
      this.setOverlayActive(overlay);
      overlay.hasBeenActive = true;
    } else {
      // Check if transitioning from hidden → visible (toggle or display:none)
      const wasHidden = overlay.element.style.display === 'none' ||
        (overlay.inactiveClass && overlay.element.classList.contains(overlay.inactiveClass));
      if (wasHidden) {
        if (overlay.element.style.display === 'none') {
          overlay.element.style.display = '';
        }
        if (hasTransitionClasses) {
          this.setOverlayActive(overlay);
        } else {
          overlay.element.style.display = 'block';
          overlay.element.style.pointerEvents = 'auto';
        }
      }
    }
  }

  private setOverlayActive(overlay: OverlayElement): void {
    if (overlay.inactiveClass) overlay.element.classList.remove(overlay.inactiveClass);
    if (overlay.activeClass) overlay.element.classList.add(overlay.activeClass);
    overlay.element.style.pointerEvents = 'auto';
  }

  private setOverlayInactive(overlay: OverlayElement): void {
    if (overlay.activeClass) overlay.element.classList.remove(overlay.activeClass);
    if (overlay.inactiveClass) overlay.element.classList.add(overlay.inactiveClass);
    overlay.element.style.pointerEvents = 'none';
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
