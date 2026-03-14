/**
 * Centralized configuration constants for the IIIF viewer.
 * Extracted from various modules for consistency and easy tuning.
 */

// ============================================================
// CAMERA & ANIMATION CONFIGURATION
// ============================================================

export const CAMERA_CONFIG = {
    /** Minimum time between tile requests during animation (ms) */
    TILE_IMMEDIATE_THROTTLE: 200,
    /** Debounce delay for final tile request after animation settles (ms) */
    TILE_DEBOUNCE_DELAY: 50,
    /** Minimum time between wheel zoom events (ms) */
    ZOOM_THROTTLE: 80,
    /** Spring stiffness for interactive animations */
    SPRING_STIFFNESS: 6.5,
    /** Animation time for spring physics (seconds) */
    ANIMATION_TIME: 1.25,
    /** Default zoom factor for button/keyboard zoom */
    ZOOM_FACTOR: 1.5,
} as const;

// ============================================================
// TOUCH GESTURE CONFIGURATION
// ============================================================

export const TOUCH_CONFIG = {
    /** Maximum time between taps for double-tap detection (ms) */
    DOUBLE_TAP_THRESHOLD_MS: 300,
    /** Maximum squared distance between taps for double-tap (px²) */
    DOUBLE_TAP_DISTANCE_SQ: 900,
    /** Zoom factor applied on double-tap */
    DOUBLE_TAP_ZOOM_FACTOR: 2.0,
} as const;

// ============================================================
// TILE MANAGEMENT CONFIGURATION
// ============================================================

export const TILE_CONFIG = {
    /** Default maximum tiles to keep in LRU cache */
    DEFAULT_CACHE_SIZE: 500,
    /** Maximum tiles to upload to GPU per frame */
    MAX_UPLOADS_PER_FRAME: 8,
    /** Default thumbnail target width (px) */
    THUMBNAIL_TARGET_WIDTH: 256,
    /** Detail factor for zoom level selection (0-1, lower = more detail) */
    DISTANCE_DETAIL: 0.65,
} as const;

// ============================================================
// COMPARISON MODE CONFIGURATION
// ============================================================

export const COMPARE_CONFIG = {
    /** Maximum number of viewers visible simultaneously */
    MAX_VISIBLE_VIEWERS: 4,
    /** Maximum URL length before truncation in labels */
    URL_LABEL_MAX_LENGTH: 30,
} as const;

// ============================================================
// PANEL & UI CONFIGURATION
// ============================================================

export const PANEL_CONFIG = {
    /** Minimum panel width when resizing (px) */
    MIN_WIDTH: 100,
    /** Minimum panel height when resizing (px) */
    MIN_HEIGHT: 60,
    /** Pixel threshold before drag starts (px) */
    DRAG_THRESHOLD: 5,
    /** Margin around docks for hit testing (px) */
    DOCK_HIT_MARGIN: 40,
    /** Starting z-index for panels */
    INITIAL_Z_INDEX: 100,
} as const;

// ============================================================
// CV (COMPUTER VISION) CONFIGURATION
// ============================================================

export const CV_CONFIG = {
    /** Target video width for gesture detection (px) */
    VIDEO_WIDTH: 800,
    /** Pinch detection threshold (normalized distance) */
    PINCH_THRESHOLD: 0.06,
    /** Zoom change deadzone to prevent jitter */
    ZOOM_DEADZONE: 0.02,
} as const;

// ============================================================
// PANEL CLASS NAME MAPPINGS
// ============================================================

/** Maps panel keys to their CSS class names */
export const PANEL_CLASS_MAP: Record<string, string> = {
    'pages': 'iiif-canvas-nav',
    'navigation': 'iiif-toc',
    'manifest': 'iiif-manifest-panel',
    'annotations': 'iiif-annotation-panel',
    'gesture': 'iiif-cv-panel',
    'compare': 'iiif-compare-panel',
    'settings': 'iiif-settings-panel',
};

/** Maps panel keys to container hide classes */
export const PANEL_HIDE_CLASS: Record<string, string> = {
    'navigation': 'hide-navigation',
    'pages': 'hide-pages',
    'manifest': 'hide-manifest',
    'annotations': 'hide-annotations',
    'gesture': 'hide-vision',
    'compare': 'hide-compare',
};

/** Panels that are cloned per viewer instance (content-specific) */
export const PER_INSTANCE_PANELS: ReadonlySet<string> = new Set([
    'navigation', 'pages', 'manifest', 'annotations',
]);

// ============================================================
// UI ELEMENT SELECTORS
// ============================================================

/** Selector for elements that should not trigger canvas pan */
export const NON_PAN_SELECTORS = '.iiif-toolbar, .iiif-canvas-nav, .iiif-navigation-wrapper, .iiif-toc, .iiif-metadata-panel, .iiif-canvas-list, .iiif-compare-control-bar, .iiif-panel';
