import { IIIFOverlayManager } from './iiif-overlay';
import type { OverlayElement } from './iiif-overlay';
import type { ParsedAnnotation, ParsedAnnotationPage } from './iiif-parser';

/**
 * Custom annotation - user-created, with arbitrary styles and HTML content.
 * All coordinates are in world space.
 */
export interface CustomAnnotation {
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

/** @deprecated Use CustomAnnotation instead */
export type Annotation = CustomAnnotation;

/**
 * IIIF annotation - parsed from a IIIF manifest.
 * Wraps the parsed data with rendering state.
 */
export interface IIIFAnnotation {
    /** The parsed annotation data from the manifest */
    parsed: ParsedAnnotation;
    /** Whether this annotation is currently visible */
    visible: boolean;
}

/**
 * Manages both IIIF and custom annotations using the overlay system
 */
export class AnnotationManager {
    private customAnnotations: Map<string, CustomAnnotation> = new Map();
    private iiifAnnotations: Map<string, IIIFAnnotation> = new Map();
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

    // --- Custom Annotations ---

    /**
     * Add a custom (user-created) annotation
     */
    addAnnotation(annotation: CustomAnnotation): void {
        if (!this.overlayManager) {
            console.error('Overlay manager not initialized');
            return;
        }

        const annotationElement = this.createCustomAnnotationElement(annotation);

        const overlay: OverlayElement = {
            id: annotation.id,
            element: annotationElement,
            worldX: annotation.x,
            worldY: annotation.y,
            worldWidth: annotation.width,
            worldHeight: annotation.height,
            scaleWithZoom: annotation.scaleWithZoom !== false
        };

        this.customAnnotations.set(annotation.id, annotation);
        this.overlayManager.addOverlay(overlay);
    }

    /**
     * Create the HTML element for a custom annotation
     */
    private createCustomAnnotationElement(annotation: CustomAnnotation): HTMLElement {
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
     * Remove a custom annotation
     */
    removeAnnotation(id: string): void {
        if (!this.overlayManager) return;

        this.customAnnotations.delete(id);
        this.overlayManager.removeOverlay(id);
    }

    /**
     * Get a custom annotation by ID
     */
    getAnnotation(id: string): CustomAnnotation | undefined {
        return this.customAnnotations.get(id);
    }

    /**
     * Get all custom annotations
     */
    getAllAnnotations(): CustomAnnotation[] {
        return Array.from(this.customAnnotations.values());
    }

    /**
     * Update custom annotation position in world coordinates
     */
    updateAnnotationPosition(id: string, x: number, y: number): void {
        const annotation = this.customAnnotations.get(id);
        if (!annotation || !this.overlayManager) return;

        annotation.x = x;
        annotation.y = y;
        this.overlayManager.updateOverlayPosition(id, x, y);
    }

    /**
     * Update custom annotation size in world coordinates
     */
    updateAnnotationSize(id: string, width: number, height: number): void {
        const annotation = this.customAnnotations.get(id);
        if (!annotation || !this.overlayManager) return;

        annotation.width = width;
        annotation.height = height;
        this.overlayManager.updateOverlaySize(id, width, height);
    }

    /**
     * Clear all custom annotations
     */
    clearCustomAnnotations(): void {
        if (!this.overlayManager) return;

        for (const id of this.customAnnotations.keys()) {
            this.overlayManager.removeOverlay(id);
        }
        this.customAnnotations.clear();
    }

    // --- IIIF Annotations ---

    /**
     * Load IIIF annotations from parsed annotation pages.
     * Converts them into visual overlays on the canvas.
     * @param pages - Parsed annotation pages from the IIIF manifest
     * @param canvasWidth - Width of the canvas (for annotations without xywh target)
     * @param canvasHeight - Height of the canvas
     */
    loadIIIFAnnotations(pages: ParsedAnnotationPage[], canvasWidth: number, canvasHeight: number): void {
        if (!this.overlayManager) {
            console.error('Overlay manager not initialized');
            return;
        }

        for (const page of pages) {
            for (const ann of page.annotations) {
                const iiifAnn: IIIFAnnotation = {
                    parsed: ann,
                    visible: true
                };

                // Determine position — use target xywh if available, otherwise full canvas
                const x = ann.target?.x ?? 0;
                const y = ann.target?.y ?? 0;
                const w = ann.target?.w ?? canvasWidth;
                const h = ann.target?.h ?? canvasHeight;

                const overlayId = `iiif-ann-${ann.id || page.id + '-' + this.iiifAnnotations.size}`;
                const element = this.createIIIFAnnotationElement(ann);

                const overlay: OverlayElement = {
                    id: overlayId,
                    element,
                    worldX: x,
                    worldY: y,
                    worldWidth: w,
                    worldHeight: h,
                    scaleWithZoom: true
                };

                this.iiifAnnotations.set(overlayId, iiifAnn);
                this.overlayManager.addOverlay(overlay);
            }
        }
    }

    /**
     * Create the HTML element for an IIIF annotation
     */
    private createIIIFAnnotationElement(ann: ParsedAnnotation): HTMLElement {
        const container = document.createElement('div');
        container.className = 'iiif-annotation';
        container.style.boxSizing = 'border-box';
        container.style.width = '100%';
        container.style.height = '100%';

        // Style based on motivation
        if (ann.motivation === 'commenting' || ann.motivation === 'oa:commenting') {
            container.style.border = '2px solid #ff9800';
            container.style.backgroundColor = 'rgba(255, 152, 0, 0.15)';
        } else if (ann.motivation === 'tagging' || ann.motivation === 'oa:tagging') {
            container.style.border = '2px solid #4caf50';
            container.style.backgroundColor = 'rgba(76, 175, 80, 0.15)';
        } else if (ann.motivation === 'describing' || ann.motivation === 'oa:describing') {
            container.style.border = '2px solid #9c27b0';
            container.style.backgroundColor = 'rgba(156, 39, 176, 0.15)';
        } else {
            container.style.border = '2px solid #f44336';
            container.style.backgroundColor = 'rgba(244, 67, 54, 0.15)';
        }

        // Add body text as tooltip or content
        const bodyText = ann.body.value?.replace(/<[^>]*>/g, '') || '';
        if (bodyText) {
            container.title = bodyText;

            // For annotations with a target region, show a small label on hover
            const label = document.createElement('div');
            label.className = 'iiif-annotation-label';
            label.style.position = 'absolute';
            label.style.bottom = '0';
            label.style.left = '0';
            label.style.right = '0';
            label.style.padding = '4px 6px';
            label.style.fontSize = '12px';
            label.style.fontFamily = 'Arial, sans-serif';
            label.style.color = '#fff';
            label.style.backgroundColor = 'rgba(0,0,0,0.7)';
            label.style.display = 'none';
            label.style.overflow = 'hidden';
            label.style.textOverflow = 'ellipsis';
            label.style.whiteSpace = 'nowrap';
            label.textContent = bodyText.substring(0, 120);

            container.appendChild(label);

            container.addEventListener('mouseenter', () => { label.style.display = 'block'; });
            container.addEventListener('mouseleave', () => { label.style.display = 'none'; });
        }

        return container;
    }

    /**
     * Get all IIIF annotations
     */
    getAllIIIFAnnotations(): IIIFAnnotation[] {
        return Array.from(this.iiifAnnotations.values());
    }

    /**
     * Toggle visibility of all IIIF annotations
     */
    setIIIFAnnotationsVisible(visible: boolean): void {
        if (!this.overlayManager) return;

        for (const [id, ann] of this.iiifAnnotations) {
            ann.visible = visible;
            const overlay = this.overlayManager.getOverlay(id);
            if (overlay) {
                overlay.element.style.display = visible ? 'block' : 'none';
            }
        }
    }

    /**
     * Clear all IIIF annotations
     */
    clearIIIFAnnotations(): void {
        if (!this.overlayManager) return;

        for (const id of this.iiifAnnotations.keys()) {
            this.overlayManager.removeOverlay(id);
        }
        this.iiifAnnotations.clear();
    }

    // --- Combined ---

    /**
     * Clear all annotations (both custom and IIIF)
     */
    clearAllAnnotations(): void {
        this.clearCustomAnnotations();
        this.clearIIIFAnnotations();
    }
}
