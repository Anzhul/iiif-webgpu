import { IIIFOverlayManager } from './iiif-overlay';
import type { OverlayElement } from './iiif-overlay';

/**
 * Annotation configuration - all coordinates are in world space
 */
export interface Annotation {
    /** Unique identifier */
    id: string;
    /** Whether annotation is fixed in place or can be moved */
    fixed: boolean;
    /** X position in world coordinates */
    x: number;
    /** Y position in world coordinates */
    y: number;
    /** Width in world coordinates */
    width: number;
    /** Height in world coordinates */
    height: number;
    /** CSS styles to apply to the annotation box */
    style?: {
        border?: string;
        backgroundColor?: string;
        borderRadius?: string;
        opacity?: string;
        [key: string]: string | undefined;
    };
    /** Content to display inside the annotation */
    content?: {
        /** HTML element to display */
        element?: HTMLElement;
        /** Text content (if no element provided) */
        text?: string;
        /** Width of content area */
        width?: number;
        /** Height of content area */
        height?: number;
    };
    /** Whether annotation scales with zoom (default: true) */
    scaleWithZoom?: boolean;
}

/**
 * Manages annotations on IIIF images using the overlay system
 */
export class AnnotationManager {
    private annotations: Map<string, Annotation> = new Map();
    private overlayManager?: IIIFOverlayManager;

    constructor(overlayManager?: IIIFOverlayManager) {
        this.overlayManager = overlayManager;
    }

    /**
     * Set the overlay manager (called after initialization)
     */
    setOverlayManager(overlayManager: IIIFOverlayManager): void {
        this.overlayManager = overlayManager;
    }

    /**
     * Add an annotation
     */
    addAnnotation(annotation: Annotation): void {
        if (!this.overlayManager) {
            console.error('Overlay manager not initialized');
            return;
        }

        // Create the annotation element
        const annotationElement = this.createAnnotationElement(annotation);

        // Create overlay from annotation (using world coordinates)
        const overlay: OverlayElement = {
            id: annotation.id,
            element: annotationElement,
            worldX: annotation.x,
            worldY: annotation.y,
            worldWidth: annotation.width,
            worldHeight: annotation.height,
            scaleWithZoom: annotation.scaleWithZoom !== false
        };

        // Store annotation
        this.annotations.set(annotation.id, annotation);

        // Add to overlay manager
        this.overlayManager.addOverlay(overlay);
    }

    /**
     * Create the HTML element for an annotation
     */
    private createAnnotationElement(annotation: Annotation): HTMLElement {
        const container = document.createElement('div');
        container.style.boxSizing = 'border-box';
        container.style.width = '100%';
        container.style.height = '100%';

        // Apply default styles
        container.style.border = '2px solid #007bff';
        container.style.backgroundColor = 'rgba(0, 123, 255, 0.1)';

        // Apply custom styles
        if (annotation.style) {
            Object.entries(annotation.style).forEach(([key, value]) => {
                if (value !== undefined) {
                    container.style[key as any] = value;
                }
            });
        }

        // Add content if provided
        if (annotation.content) {
            const contentWrapper = document.createElement('div');
            contentWrapper.style.width = '100%';
            contentWrapper.style.height = '100%';
            contentWrapper.style.overflow = 'auto';
            contentWrapper.style.padding = '8px';

            if (annotation.content.element) {
                contentWrapper.appendChild(annotation.content.element);
            } else if (annotation.content.text) {
                contentWrapper.textContent = annotation.content.text;
                contentWrapper.style.fontSize = '14px';
                contentWrapper.style.fontFamily = 'Arial, sans-serif';
            }

            container.appendChild(contentWrapper);
        }

        return container;
    }

    /**
     * Remove an annotation
     */
    removeAnnotation(id: string): void {
        if (!this.overlayManager) return;

        this.annotations.delete(id);
        this.overlayManager.removeOverlay(id);
    }

    /**
     * Get an annotation by ID
     */
    getAnnotation(id: string): Annotation | undefined {
        return this.annotations.get(id);
    }

    /**
     * Get all annotations
     */
    getAllAnnotations(): Annotation[] {
        return Array.from(this.annotations.values());
    }

    /**
     * Update annotation position in world coordinates
     */
    updateAnnotationPosition(id: string, x: number, y: number): void {
        const annotation = this.annotations.get(id);
        if (!annotation || !this.overlayManager) return;

        annotation.x = x;
        annotation.y = y;
        this.overlayManager.updateOverlayPosition(id, x, y);
    }

    /**
     * Update annotation size in world coordinates
     */
    updateAnnotationSize(id: string, width: number, height: number): void {
        const annotation = this.annotations.get(id);
        if (!annotation || !this.overlayManager) return;

        annotation.width = width;
        annotation.height = height;
        this.overlayManager.updateOverlaySize(id, width, height);
    }

    /**
     * Clear all annotations
     */
    clearAllAnnotations(): void {
        if (!this.overlayManager) return;

        for (const id of this.annotations.keys()) {
            this.overlayManager.removeOverlay(id);
        }
        this.annotations.clear();
    }
}
