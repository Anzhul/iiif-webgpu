import './IIIF/ui/iiif-styles.css';

// Main viewer and types
export { IIIFViewer, PanelManager, setupInputHandlers } from './IIIF/iiif';
export type { IIIFViewerOptions, IIIFViewerPanels, LayoutState, ViewerConfig, ViewerConfigImage, ViewerConfigAnnotation, LookAtOptions } from './IIIF/types';

// Annotation types
export type { OverlayElement } from './IIIF/features/iiif-overlay';
export type { CustomAnnotation, Annotation, IIIFAnnotation } from './IIIF/features/iiif-annotations';

// Parser types
export type { WorldPlacement } from './IIIF/core/iiif-world';
export type { ParsedRange, ParsedManifestMetadata, ParsedMetadataItem } from './IIIF/iiif-parser';

// Comparison types
export type { CompareEntry, CompareOptions } from './IIIF/types';

// Configuration
export { CAMERA_CONFIG, TILE_CONFIG, PANEL_CONFIG, COMPARE_CONFIG, CV_CONFIG } from './IIIF/config';
