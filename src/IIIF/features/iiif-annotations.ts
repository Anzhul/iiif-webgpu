import { IIIFOverlayManager } from './iiif-overlay';
import type { OverlayElement } from './iiif-overlay';
import type { ParsedAnnotation, ParsedAnnotationPage, AnnotationBody } from '../iiif-parser';

// --- Motivation Color Map ---

export const MOTIVATION_COLORS: Record<string, { border: string; bg: string }> = {
    'commenting':       { border: '#ff9800', bg: 'rgba(255, 152, 0, 0.15)' },
    'oa:commenting':    { border: '#ff9800', bg: 'rgba(255, 152, 0, 0.15)' },
    'tagging':          { border: '#4caf50', bg: 'rgba(76, 175, 80, 0.15)' },
    'oa:tagging':       { border: '#4caf50', bg: 'rgba(76, 175, 80, 0.15)' },
    'describing':       { border: '#9c27b0', bg: 'rgba(156, 39, 176, 0.15)' },
    'oa:describing':    { border: '#9c27b0', bg: 'rgba(156, 39, 176, 0.15)' },
    'highlighting':     { border: '#ffeb3b', bg: 'rgba(255, 235, 59, 0.20)' },
    'oa:highlighting':  { border: '#ffeb3b', bg: 'rgba(255, 235, 59, 0.20)' },
    'bookmarking':      { border: '#2196f3', bg: 'rgba(33, 150, 243, 0.15)' },
    'oa:bookmarking':   { border: '#2196f3', bg: 'rgba(33, 150, 243, 0.15)' },
    'linking':          { border: '#00bcd4', bg: 'rgba(0, 188, 212, 0.15)' },
    'oa:linking':       { border: '#00bcd4', bg: 'rgba(0, 188, 212, 0.15)' },
    'questioning':      { border: '#ff5722', bg: 'rgba(255, 87, 34, 0.15)' },
    'classifying':      { border: '#607d8b', bg: 'rgba(96, 125, 139, 0.15)' },
    'editing':          { border: '#795548', bg: 'rgba(121, 85, 72, 0.15)' },
    'identifying':      { border: '#e91e63', bg: 'rgba(233, 30, 99, 0.15)' },
};
export const DEFAULT_MOTIVATION_COLOR = { border: '#f44336', bg: 'rgba(244, 67, 54, 0.15)' };

/**
 * Custom annotation - user-created, with arbitrary styles and HTML content.
 * All coordinates are in world space.
 */
export interface CustomAnnotation {
    /** Unique identifier */
    id: string;
    /** Annotation type/category (e.g., 'detail notes', 'markers') — groups annotations in the panel */
    type?: string;
    /** Color for the annotation type swatch in the panel (e.g., '#ff9800') */
    color?: string;
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
    /** CSS class applied when annotation is active/visible */
    activeClass?: string;
    /** CSS class applied when annotation is inactive/hidden */
    inactiveClass?: string;
    /** Popup content shown when the annotation is clicked */
    popup?: string | HTMLElement;
    /** Popup position offset in screen pixels from the annotation's top-left corner */
    popupPosition?: { x: number; y: number };
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
export interface AnnotationPageGroup {
    pageId: string;
    label: string;
    overlayIds: string[];
    visible: boolean;
}

export class AnnotationManager {
    private customAnnotations: Map<string, CustomAnnotation> = new Map();
    private iiifAnnotations: Map<string, IIIFAnnotation> = new Map();
    private overlayManager?: IIIFOverlayManager;
    private pageGroups: AnnotationPageGroup[] = [];

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
            scaleWithZoom: annotation.scaleWithZoom !== false,
            activeClass: annotation.activeClass,
            inactiveClass: annotation.inactiveClass,
        };

        this.customAnnotations.set(annotation.id, annotation);
        this.overlayManager.addOverlay(overlay);
    }

    /**
     * Create the HTML element for a custom annotation
     */
    private createCustomAnnotationElement(annotation: CustomAnnotation): HTMLElement {
        // If an HTMLElement is provided directly, use it as the annotation container
        // (no wrapper, no default styles — the element controls its own appearance)
        if (annotation.content?.element) {
            const el = annotation.content.element;
            el.style.boxSizing = 'border-box';

            // Apply any additional inline styles
            if (annotation.style) {
                Object.entries(annotation.style).forEach(([key, value]) => {
                    if (value !== undefined) {
                        el.style[key as any] = value;
                    }
                });
            }

            // Add popup on click
            if (annotation.popup) {
                el.style.cursor = 'pointer';
                this.attachPopup(el, annotation.popup, annotation.popupPosition);
            }

            return el;
        }

        // Text or empty content: use a default styled container
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

        // Add text content if provided
        if (annotation.content?.text) {
            const contentWrapper = document.createElement('div');
            contentWrapper.style.width = '100%';
            contentWrapper.style.height = '100%';
            contentWrapper.style.overflow = 'auto';
            contentWrapper.style.padding = '8px';
            contentWrapper.textContent = annotation.content.text;
            contentWrapper.style.fontSize = '14px';
            contentWrapper.style.fontFamily = 'Arial, sans-serif';
            container.appendChild(contentWrapper);
        }

        // Add popup on click
        if (annotation.popup) {
            container.style.cursor = 'pointer';
            this.attachPopup(container, annotation.popup, annotation.popupPosition);
        }

        return container;
    }

    /**
     * Attach a click-toggled popup to an annotation element.
     * The popup is a child of the annotation, positioned next to it,
     * and uses inverse scale to stay at a fixed screen size.
     */
    private attachPopup(container: HTMLElement, content: string | HTMLElement, position?: { x: number; y: number }): void {
        let popupEl: HTMLDivElement | null = null;

        const show = () => {
            if (popupEl) return;
            popupEl = document.createElement('div');
            popupEl.className = 'iiif-annotation-popup';

            // Custom position from annotation top-left (overrides CSS defaults)
            if (position) {
                popupEl.style.left = `${position.x}px`;
                popupEl.style.top = `${position.y}px`;
                popupEl.style.marginLeft = '0';
            }
            // Stop clicks inside popup from reaching the annotation toggle
            popupEl.addEventListener('click', (e) => e.stopPropagation());
            popupEl.addEventListener('mousedown', (e) => e.stopPropagation());

            // Close button
            const closeBtn = document.createElement('button');
            closeBtn.className = 'iiif-annotation-popup-close';
            closeBtn.innerHTML = '&times;';
            closeBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                hide();
            });
            popupEl.appendChild(closeBtn);

            // Content
            const body = document.createElement('div');
            if (typeof content === 'string') {
                body.textContent = content;
            } else {
                body.appendChild(content.cloneNode(true));
            }
            popupEl.appendChild(body);

            container.appendChild(popupEl);
        };

        const hide = () => {
            if (!popupEl) return;
            popupEl.remove();
            popupEl = null;
        };

        // Click annotation to toggle popup
        container.addEventListener('click', (e) => {
            e.stopPropagation();
            if (popupEl) {
                hide();
            } else {
                show();
            }
        });
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
     * Get custom annotations grouped by type for the panel UI
     */
    getCustomAnnotationGroups(): { type: string; ids: string[]; visible: boolean; color: string }[] {
        const groups = new Map<string, { ids: string[]; color: string }>();
        for (const [id, ann] of this.customAnnotations) {
            const type = ann.type || 'Custom';
            if (!groups.has(type)) groups.set(type, { ids: [], color: ann.color || '#007bff' });
            groups.get(type)!.ids.push(id);
        }
        return Array.from(groups.entries()).map(([type, { ids, color }]) => ({
            type,
            ids,
            color,
            visible: ids.some(id => {
                const overlay = this.overlayManager?.getOverlay(id);
                return overlay ? !overlay.hidden : true;
            }),
        }));
    }

    /**
     * Toggle visibility of all custom annotations of a given type
     */
    setCustomTypeVisible(type: string, visible: boolean): void {
        if (!this.overlayManager) return;

        for (const [id, ann] of this.customAnnotations) {
            if ((ann.type || 'Custom') === type) {
                const overlay = this.overlayManager.getOverlay(id);
                if (overlay) {
                    overlay.hidden = !visible;
                    this.overlayManager.updateOverlay(id);
                }
            }
        }
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
            const overlayIds: string[] = [];

            for (const ann of page.annotations) {
                const iiifAnn: IIIFAnnotation = {
                    parsed: ann,
                    visible: false
                };

                const target = ann.target;
                let x: number, y: number, w: number, h: number;
                let scaleWithZoom = true;

                switch (target.type) {
                    case 'rect':
                        x = target.x; y = target.y; w = target.w; h = target.h;
                        break;
                    case 'svg':
                        x = target.bounds.x; y = target.bounds.y;
                        w = target.bounds.w; h = target.bounds.h;
                        break;
                    case 'point':
                        x = target.x; y = target.y; w = 0; h = 0;
                        scaleWithZoom = false;
                        break;
                    case 'full':
                    default:
                        x = 0; y = 0; w = canvasWidth; h = canvasHeight;
                        break;
                }

                const overlayId = `iiif-ann-${ann.id || page.id + '-' + this.iiifAnnotations.size}`;
                const element = this.createIIIFAnnotationElement(ann);

                // Point annotations need overflow visible so the pin renders outside the 0x0 box
                if (target.type === 'point') {
                    element.style.overflow = 'visible';
                }

                const overlay: OverlayElement = {
                    id: overlayId,
                    element,
                    worldX: x,
                    worldY: y,
                    worldWidth: w,
                    worldHeight: h,
                    scaleWithZoom,
                    hidden: true
                };

                // Hide initially - user must click to show
                element.style.display = 'none';

                this.iiifAnnotations.set(overlayId, iiifAnn);
                this.overlayManager.addOverlay(overlay);
                overlayIds.push(overlayId);
            }

            // Track page group with a derived label
            const label = this.derivePageLabel(page);
            this.pageGroups.push({
                pageId: page.id,
                label,
                overlayIds,
                visible: false,
            });
        }
    }

    private derivePageLabel(page: ParsedAnnotationPage): string {
        const motivations = page.annotations.map(a => a.motivation);
        const unique = [...new Set(motivations)];
        const count = page.annotations.length;

        if (unique.length === 1 && unique[0] !== 'unknown') {
            // Strip OA prefix and capitalize
            const raw = unique[0].replace(/^oa:/, '');
            const capitalized = raw.charAt(0).toUpperCase() + raw.slice(1);
            return `${capitalized} (${count})`;
        }
        return `Annotations (${count})`;
    }

    /**
     * Create the HTML element for an IIIF annotation — dispatches by target type
     */
    private createIIIFAnnotationElement(ann: ParsedAnnotation): HTMLElement {
        const target = ann.target;

        if (target.type === 'svg') {
            return this.createSvgAnnotationElement(ann);
        }
        if (target.type === 'point') {
            return this.createPointAnnotationElement(ann);
        }
        return this.createRectAnnotationElement(ann);
    }

    private createRectAnnotationElement(ann: ParsedAnnotation): HTMLElement {
        const container = document.createElement('div');
        container.className = 'iiif-annotation';
        container.style.boxSizing = 'border-box';
        container.style.width = '100%';
        container.style.height = '100%';

        const colors = MOTIVATION_COLORS[ann.motivation] || DEFAULT_MOTIVATION_COLOR;
        container.style.border = `2px solid ${colors.border}`;
        container.style.backgroundColor = colors.bg;

        if (ann.bodies[0]) {
            this.attachBodyLabel(container, ann.bodies[0]);
        }

        return container;
    }

    private createSvgAnnotationElement(ann: ParsedAnnotation): HTMLElement {
        const target = ann.target as { type: 'svg'; svg: string; bounds: { x: number; y: number; w: number; h: number } };
        const container = document.createElement('div');
        container.className = 'iiif-annotation iiif-annotation-svg';
        container.style.boxSizing = 'border-box';
        container.style.width = '100%';
        container.style.height = '100%';
        container.style.overflow = 'visible';

        const colors = MOTIVATION_COLORS[ann.motivation] || DEFAULT_MOTIVATION_COLOR;

        // Parse SVG string safely
        const parser = new DOMParser();
        const svgDoc = parser.parseFromString(target.svg, 'image/svg+xml');
        const svgEl = svgDoc.documentElement;

        if (svgEl.tagName !== 'parsererror' && svgEl instanceof SVGElement) {
            svgEl.setAttribute('width', '100%');
            svgEl.setAttribute('height', '100%');
            if (!svgEl.hasAttribute('viewBox')) {
                svgEl.setAttribute('viewBox', `${target.bounds.x} ${target.bounds.y} ${target.bounds.w} ${target.bounds.h}`);
            }
            svgEl.style.position = 'absolute';
            svgEl.style.top = '0';
            svgEl.style.left = '0';

            // Sanitize: remove dangerous elements and attributes
            this.sanitizeSvg(svgEl);

            // Apply motivation colors to shapes that lack explicit styling
            const shapes = svgEl.querySelectorAll('path, rect, circle, ellipse, polygon, polyline, line');
            shapes.forEach(shape => {
                if (!shape.getAttribute('stroke')) {
                    shape.setAttribute('stroke', colors.border);
                }
                if (!shape.getAttribute('fill')) {
                    shape.setAttribute('fill', colors.bg);
                }
            });

            container.appendChild(svgEl);
        } else {
            // Fallback: render as rect
            container.style.border = `2px solid ${colors.border}`;
            container.style.backgroundColor = colors.bg;
        }

        if (ann.bodies[0]) {
            this.attachBodyLabel(container, ann.bodies[0]);
        }

        return container;
    }

    private createPointAnnotationElement(ann: ParsedAnnotation): HTMLElement {
        const container = document.createElement('div');
        container.className = 'iiif-annotation iiif-annotation-point';

        const colors = MOTIVATION_COLORS[ann.motivation] || DEFAULT_MOTIVATION_COLOR;

        const pin = document.createElement('div');
        pin.className = 'iiif-annotation-pin';
        pin.style.width = '16px';
        pin.style.height = '16px';
        pin.style.borderRadius = '50% 50% 50% 0';
        pin.style.transform = 'rotate(-45deg)';
        pin.style.backgroundColor = colors.border;
        pin.style.border = '2px solid white';
        pin.style.boxShadow = '0 1px 4px rgba(0,0,0,0.4)';
        pin.style.position = 'relative';
        pin.style.top = '-16px';
        pin.style.left = '-8px';
        container.appendChild(pin);

        if (ann.bodies[0]) {
            this.attachBodyLabel(container, ann.bodies[0]);
        }

        return container;
    }

    /**
     * Attach a hover label showing the annotation body content
     */
    private attachBodyLabel(container: HTMLElement, body: AnnotationBody): void {
        const isHtml = body.format === 'text/html';
        const bodyValue = body.value || '';
        if (!bodyValue) return;

        // Tooltip is always plain text
        container.title = bodyValue.replace(/<[^>]*>/g, '');

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
        label.style.maxHeight = '80px';

        if (isHtml) {
            label.innerHTML = this.sanitizeHtml(bodyValue);
            label.style.whiteSpace = 'normal';
        } else {
            label.style.textOverflow = 'ellipsis';
            label.style.whiteSpace = 'nowrap';
            label.textContent = bodyValue.replace(/<[^>]*>/g, '').substring(0, 120);
        }

        container.appendChild(label);
        container.addEventListener('mouseenter', () => { label.style.display = 'block'; });
        container.addEventListener('mouseleave', () => { label.style.display = 'none'; });
        // Touch: tap to toggle label visibility
        container.addEventListener('touchend', (e) => {
            e.preventDefault();
            label.style.display = label.style.display === 'none' ? 'block' : 'none';
        });
    }

    /**
     * Sanitize HTML body content — strip dangerous tags and attributes
     */
    private sanitizeHtml(html: string): string {
        return html
            .replace(/<script[\s\S]*?<\/script>/gi, '')
            .replace(/<iframe[\s\S]*?<\/iframe>/gi, '')
            .replace(/<object[\s\S]*?<\/object>/gi, '')
            .replace(/<embed[\s\S]*?>/gi, '')
            .replace(/\bon\w+\s*=\s*["'][^"']*["']/gi, '')
            .replace(/\bon\w+\s*=\s*[^\s>]*/gi, '');
    }

    /**
     * Sanitize a parsed SVG DOM — remove dangerous elements and event handlers
     */
    private sanitizeSvg(svg: Element): void {
        const dangerous = svg.querySelectorAll('script, foreignObject, iframe, object, embed');
        dangerous.forEach(el => el.remove());

        const all = svg.querySelectorAll('*');
        all.forEach(el => {
            const attrs = Array.from(el.attributes);
            for (const attr of attrs) {
                if (attr.name.startsWith('on')) {
                    el.removeAttribute(attr.name);
                }
            }
        });
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
                overlay.hidden = !visible;
                this.overlayManager.updateOverlay(id);
            }
        }
    }

    /**
     * Get annotation page groups for the UI panel
     */
    getAnnotationPages(): AnnotationPageGroup[] {
        return this.pageGroups;
    }

    /**
     * Toggle visibility of a single annotation page
     */
    setPageVisible(pageId: string, visible: boolean): void {
        if (!this.overlayManager) return;

        const group = this.pageGroups.find(g => g.pageId === pageId);
        if (!group) return;

        group.visible = visible;
        for (const id of group.overlayIds) {
            const ann = this.iiifAnnotations.get(id);
            if (ann) ann.visible = visible;
            const overlay = this.overlayManager.getOverlay(id);
            if (overlay) {
                overlay.hidden = !visible;
                this.overlayManager.updateOverlay(id);
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
        this.pageGroups = [];
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
