/**
 * Centralized type definitions for the IIIF viewer.
 * Provides strong typing across all modules.
 */

import type { ParsedAnnotationPage } from './iiif-parser';

// ============================================================
// VIEWER OPTIONS & STATE
// ============================================================

/** Panel visibility states */
export type PanelVisibility = 'show' | 'hide' | 'show-open' | 'show-closed';

/** Panel configuration for IIIFViewer */
export interface IIIFViewerPanels {
    settings?: PanelVisibility;
    navigation?: PanelVisibility;
    pages?: PanelVisibility;
    manifest?: PanelVisibility;
    annotations?: PanelVisibility;
    gesture?: PanelVisibility;
    compare?: PanelVisibility;
}

/** Toolbar configuration */
export interface ToolbarConfig {
    position?: 'top' | 'bottom' | 'left' | 'right';
    buttons?: string[];
    customButtons?: ToolbarButton[];
    /** Show zoom controls */
    zoom?: boolean;
    /** Show home/fit button */
    home?: boolean;
    /** Show fullscreen button */
    fullscreen?: boolean;
}

/** Custom toolbar button definition */
export interface ToolbarButton {
    id: string;
    icon: string;
    title: string;
    onClick: () => void;
}

/** Main viewer configuration options */
export interface IIIFViewerOptions {
    renderer?: 'webgpu' | 'webgl' | 'canvas2d' | 'auto';
    enableOverlays?: boolean;
    enableToolbar?: boolean;
    enableCompare?: boolean;
    enablePanels?: boolean;
    maxCacheSize?: number;
    toolbar?: ToolbarConfig;
    panels?: IIIFViewerPanels;
    suppressNavigation?: boolean;
    suppressSettings?: boolean;
}

// ============================================================
// VIEWER CONFIG (JSON-based configuration)
// ============================================================

/** Image entry in ViewerConfig */
export interface ViewerConfigImage {
    /** IIIF Image Service URL or info.json URL */
    url: string;
    /** Optional label for the image */
    label?: string;
    /** Position in world coordinates (defaults to 0,0 with natural dimensions) */
    placement?: {
        x: number;
        y: number;
        width?: number;
        height?: number;
    };
}

/** Annotation entry in ViewerConfig */
export interface ViewerConfigAnnotation {
    /** X position in image pixels */
    x: number;
    /** Y position in image pixels */
    y: number;
    /** Width (0 for point annotations) */
    width?: number;
    /** Height (0 for point annotations) */
    height?: number;
    /** Text content or HTML string */
    content: string;
    /** Annotation type/category */
    type?: string;
    /** Color for the annotation marker */
    color?: string;
    /** Whether to scale with zoom */
    scaleWithZoom?: boolean;
    /** CSS styles */
    style?: Record<string, string>;
    /** Popup content (text or HTML) */
    popup?: string;
}

/**
 * JSON configuration for initializing the viewer.
 * Can be passed to viewer.loadConfig() as an object or JSON string.
 *
 * @example
 * ```json
 * {
 *   "images": [
 *     { "url": "https://example.org/iiif/image1/info.json", "label": "Image 1" },
 *     { "url": "https://example.org/iiif/image2/info.json", "placement": { "x": 1000, "y": 0 } }
 *   ],
 *   "settings": {
 *     "backgroundColor": "#1a1a1a",
 *     "theme": "dark"
 *   },
 *   "viewport": {
 *     "centerX": 500,
 *     "centerY": 500,
 *     "zoom": 1.5
 *   },
 *   "annotations": [
 *     { "x": 100, "y": 200, "content": "Note here", "type": "Notes" }
 *   ]
 * }
 * ```
 */
export interface ViewerConfig {
    /** Array of images to load */
    images?: ViewerConfigImage[];
    /** Single manifest URL (alternative to images array) */
    manifestUrl?: string;
    /** Canvas index to load (when using manifestUrl) */
    canvasIndex?: number;
    /** Viewer settings */
    settings?: {
        backgroundColor?: string;
        theme?: 'light' | 'dark';
    };
    /** Initial viewport state */
    viewport?: {
        centerX?: number;
        centerY?: number;
        zoom?: number;
    };
    /** Custom annotations to add */
    annotations?: ViewerConfigAnnotation[];
}

/** Persisted layout state for save/load functionality */
export interface LayoutState {
    version: 1;
    manifestUrl: string;
    canvasIndex: number;
    viewport: {
        centerX: number;
        centerY: number;
        cameraZ: number;
    };
    panels: {
        [key: string]: {
            visible: boolean;
            collapsed: boolean;
            dockPosition: string | null;
            dockIndex: number;
            floatPosition?: { left: number; top: number };
            dimensions?: { width: number; height: number };
        };
    };
    settings: {
        backgroundColor: string;
        theme: 'light' | 'dark';
    };
    annotations: { pageId: string; visible: boolean }[];
}

// ============================================================
// CANVAS & IMAGE TYPES
// ============================================================

/** Canvas information for loading */
export interface CanvasInfo {
    width: number;
    height: number;
    annotations: ParsedAnnotationPage[];
    annotationListUrls: string[];
}

/** Touch state for gesture handling */
export interface TouchState {
    activeTouches: Map<number, { x: number; y: number }>;
    lastPinchDistance: number;
    isPinching: boolean;
    lastTapTime: number;
    lastTapX: number;
    lastTapY: number;
}

// ============================================================
// PANEL TYPES
// ============================================================

/** Dock positions for panels */
export type DockPosition = 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right' | 'top-center' | 'bottom-center';

/** Panel creation options */
export interface PanelOptions {
    className: string;
    title: string;
    initiallyCollapsed?: boolean;
    hidden?: boolean;
    parent?: HTMLElement;
    draggable?: boolean;
    resizable?: boolean;
    dock?: DockPosition;
}

/** Panel creation result */
export interface PanelElements {
    panel: HTMLDivElement;
    header: HTMLDivElement;
    body: HTMLDivElement;
    collapseBtn: HTMLButtonElement;
}

// ============================================================
// NAVIGATION TYPES
// ============================================================

/** Options for the lookAt() navigation method */
export interface LookAtOptions {
    /** Target zoom level (scale). 1 = 1:1 pixels, 2 = 2x magnification, 0.5 = zoomed out */
    zoom?: number;
    /** Animation duration in milliseconds (default: 500) */
    duration?: number;
}

// ============================================================
// COMPARISON MODE TYPES
// ============================================================

/** Entry in the comparison list */
export interface CompareEntry {
    url: string;
    canvasIndex?: number;
    label: string;
}

/** Options for ComparisonController */
export interface CompareOptions {
    viewerOptions?: IIIFViewerOptions;
    manifestUrl: string;
    canvases: Array<{ label: string; index: number; thumbnailServiceUrl?: string }>;
    currentCanvasIndex: number;
    onExit?: () => void;
    onSuspendParent?: () => void;
    onResumeParent?: () => void;
    savedEntries?: CompareEntry[];
    listPanel?: HTMLDivElement;
    universalPanels?: { element: HTMLElement; dockPosition: string | null }[];
    customAnnotationSpecs?: CustomAnnotationSpec[];
    initialBackgroundColor?: { r: number; g: number; b: number };
}

// ============================================================
// ANNOTATION TYPES
// ============================================================

/** Custom annotation specification for replay */
export interface CustomAnnotationSpec {
    x: number;
    y: number;
    width: number;
    height: number;
    text?: string;
    popupText?: string;
    targetUrl?: string;
    targetPage?: number;
    options?: {
        id?: string;
        type?: string;
        color?: string;
        style?: Record<string, string | undefined>;
        scaleWithZoom?: boolean;
        activeClass?: string;
        inactiveClass?: string;
        popup?: string | HTMLElement;
        popupPosition?: { x: number; y: number };
    };
}

// ============================================================
// CV (COMPUTER VISION) TYPES
// ============================================================

/** CV Controller callbacks */
export interface CVCallbacks {
    onStatusChange?: (status: string) => void;
    onPan?: (dx: number, dy: number) => void;
    onZoom?: (factor: number) => void;
}

/** CV Controller interface */
export interface CVControllerInterface {
    running: boolean;
    gesturesEnabled: boolean;
    init(): Promise<void>;
    start(): Promise<void>;
    stop(): void;
}

// ============================================================
// INPUT HANDLER TYPES
// ============================================================

/** Input handler dependencies */
export interface InputHandlerDeps {
    container: HTMLElement;
    camera: CameraInterface;
    viewport: ViewportInterface;
    cachedContainerRect: DOMRect;
    touchState: TouchState;
    abortController: AbortController;
    markDirty: () => void;
    loadCanvas: (index: number) => Promise<void>;
    fitToWorld: () => void;
    previousCanvas: () => Promise<void>;
    nextCanvas: () => Promise<void>;
    canvasCount: number;
    manifest: unknown;
}

/** Camera interface for input handlers */
export interface CameraInterface {
    startInteractivePan(canvasX: number, canvasY: number): void;
    updateInteractivePan(canvasX: number, canvasY: number): void;
    endInteractivePan(): void;
    handleWheel(event: WheelEvent, canvasX: number, canvasY: number): void;
    handlePinchZoom(scaleFactor: number, centerCanvasX: number, centerCanvasY: number): void;
    handleDoubleTap(canvasX: number, canvasY: number): void;
    springZoomByFactor(factor: number): void;
    springPan(worldDeltaX: number, worldDeltaY: number): void;
}

/** Viewport interface for input handlers */
export interface ViewportInterface {
    scale: number;
}
