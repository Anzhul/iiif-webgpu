import { IIIFImage } from './iiif-image';
import { Viewport } from './iiif-view';
import { TileManager } from './iiif-tile';
import { WebGPURenderer } from './iiif-webgpu';
import { WebGLRenderer } from './iiif-webgl';
import { Canvas2DRenderer } from './iiif-canvas2d';
import type { IIIFRenderer, TileRenderData } from './iiif-renderer';
import { ToolBar } from './iiif-toolbar';
import { AnnotationManager, MOTIVATION_COLORS, DEFAULT_MOTIVATION_COLOR } from './iiif-annotations';
import { Camera } from './iiif-camera';
import { IIIFOverlayManager } from './iiif-overlay';
import { World, WorldImage } from './iiif-world';
import type { WorldPlacement } from './iiif-world';
import { parseIIIFUrl, fetchAnnotationList } from './iiif-parser';
import type { ParsedManifest, ParsedImageService, ParsedAnnotationPage, ParsedRange } from './iiif-parser';

// Re-export types for convenience
export type { OverlayElement } from './iiif-overlay';
export type { CustomAnnotation, Annotation, IIIFAnnotation } from './iiif-annotations';
export { IIIFOverlayManager } from './iiif-overlay';
export type { WorldPlacement } from './iiif-world';
export type { ParsedRange, ParsedManifestMetadata, ParsedMetadataItem } from './iiif-parser';

/**
 * IIIFViewer - Main viewer class orchestrating all components
 *
 * Design principles:
 * - Render-on-demand with dirty flag pattern (only render when needed)
 * - Proper resource cleanup with destroy methods
 * - Centralized configuration
 * - Type-safe event handling
 * - Efficient viewport change detection
 * - Lazy loading and caching where possible
 */

export interface IIIFViewerOptions {
    renderer?: 'webgpu' | 'webgl' | 'canvas2d' | 'auto';
    enableOverlays?: boolean;
    enableToolbar?: boolean;
    enableCompare?: boolean;
    enablePanels?: boolean;
    maxCacheSize?: number;
    toolbar?: any;
    suppressNavigation?: boolean;
    suppressSettings?: boolean;
}

interface CanvasInfo {
    width: number;
    height: number;
    annotations: ParsedAnnotationPage[];
    annotationListUrls: string[];
}

export class IIIFViewer {
    // Core components
    container: HTMLElement;
    world: World;
    viewport: Viewport;
    camera: Camera;
    renderer?: IIIFRenderer;
    canvasToolbar?: ToolBar;
    annotationManager?: AnnotationManager;
    overlayManager?: IIIFOverlayManager;

    // Viewport change callback (used by ComparisonController for camera sync)
    onViewportChange?: (centerX: number, centerY: number, cameraZ: number) => void;

    // UI elements
    private overlayContainer?: HTMLElement;
    private canvasNavContainer?: HTMLElement;
    private canvasNavList?: HTMLElement;
    private tocContainer?: HTMLElement;
    private tocList?: HTMLElement;
    private metadataPanelBody?: HTMLElement;
    private annotationPanel?: HTMLDivElement;
    private annotationPanelBody?: HTMLDivElement;
    private cvPanel?: HTMLDivElement;
    private cvPanelBody?: HTMLDivElement;
    private cvVideo?: HTMLVideoElement;
    private cvDisplayCanvas?: HTMLCanvasElement;

    private cvStatusEl?: HTMLSpanElement;
    private cvToggleBtn?: HTMLButtonElement;
    private cvGestureBtn?: HTMLButtonElement;
    private cvController?: any;

    private comparePanel?: HTMLDivElement;
    private settingsPanel?: HTMLDivElement;
    private settingsPanelBody?: HTMLDivElement;
    private toolsWrapper?: HTMLDivElement;
    private fullscreenBtn?: HTMLButtonElement;

    // State
    private manifest?: ParsedManifest;
    private currentLoadedUrl?: string;
    private currentCanvasIndex: number = -1;
    private canvasIdToIndex: Map<string, number> = new Map();
    private renderLoopActive: boolean = false;
    private animationFrameId?: number;
    private needsRender: boolean = true;
    private comparisonController?: any;
    private compareAddedEntries: Array<{ url: string; label: string }> = [];

    // Cached values for performance
    private cachedContainerRect: DOMRect;
    private lastViewportState = {
        centerX: NaN,
        centerY: NaN,
        scale: NaN
    };

    // Touch gesture state
    private touchState = {
        activeTouches: new Map<number, { x: number; y: number }>(),
        lastPinchDistance: 0,
        isPinching: false,
        lastTapTime: 0,
        lastTapX: 0,
        lastTapY: 0,
    };

    // Event tracking
    private eventHandlers: Map<Element | Document, Map<string, EventListener>> = new Map();
    private abortController: AbortController = new AbortController();

    // Configuration
    private readonly CONFIG: IIIFViewerOptions;

    constructor(container: HTMLElement, options: IIIFViewerOptions = {}) {
        this.container = container;
        this.CONFIG = {
            renderer: options.renderer ?? 'auto',
            enableOverlays: options.enableOverlays ?? true,
            enableToolbar: options.enableToolbar ?? true,
            enableCompare: options.enableCompare ?? true,
            enablePanels: options.enablePanels ?? true,
            maxCacheSize: options.maxCacheSize ?? 500,
            toolbar: options.toolbar,
            suppressNavigation: options.suppressNavigation ?? false,
            suppressSettings: options.suppressSettings ?? false,
        };

        // Initialize core components
        this.world = new World();
        this.viewport = new Viewport(container.clientWidth, container.clientHeight);
        this.camera = new Camera(this.viewport, this.world);

        // Cache container rect
        this.cachedContainerRect = container.getBoundingClientRect();

        // Set up UI components
        if (this.CONFIG.enableOverlays) {
            this.setupOverlayContainer();
        }
        this.annotationManager = new AnnotationManager(this.overlayManager);
        if (!this.CONFIG.suppressNavigation) {
            this.setupCanvasNav();
            this.setupManifestPanel();
        }
        if (!this.CONFIG.suppressNavigation && !this.CONFIG.suppressSettings) {
            this.setupTOC();
        }
        this.setupAnnotationPanel();
        this.setupCVPanel();
        if (this.CONFIG.enableCompare) {
            this.setupComparePanel();
        }
        if (!this.CONFIG.suppressNavigation && !this.CONFIG.suppressSettings) {
            this.setupSettingsPanel();
        }

        if (this.CONFIG.enableToolbar) {
            const tb = this.CONFIG.toolbar;

            // Navigation toolbar: zoom, reset, annotations, layers (fullscreen moved to tools wrapper)
            const hasButtons = tb?.zoom || tb?.annotations || tb?.layers;
            if (hasButtons) {
                this.canvasToolbar = new ToolBar(container, {
                    zoom: tb?.zoom,
                    reset: tb?.zoom, // Show reset when zoom is enabled
                    annotations: tb?.annotations,
                    layers: tb?.layers,
                    variant: 'navigation',
                    position: 'bottom-center',
                });
            }
        }

        // Wire canvas toolbar buttons
        if (this.canvasToolbar?.zoomInButton) {
            this.canvasToolbar.zoomInButton.addEventListener('click', () => {
                this.camera.springZoomByFactor(1.5);
                this.markDirty();
            });
        }
        if (this.canvasToolbar?.zoomOutButton) {
            this.canvasToolbar.zoomOutButton.addEventListener('click', () => {
                this.camera.springZoomByFactor(1 / 1.5);
                this.markDirty();
            });
        }
        if (this.canvasToolbar?.resetButton) {
            this.canvasToolbar.resetButton.addEventListener('click', () => {
                this.fitToWorld();
            });
        }
        // Set up handlers
        this.setupResizeHandler();
        this.initializeRenderer();
    }

    // ============================================================
    // INITIALIZATION
    // ============================================================

    private setupOverlayContainer() {
        this.overlayContainer = document.createElement('div');
        Object.assign(this.overlayContainer.style, {
            position: 'absolute',
            top: '0',
            left: '0',
            width: '100%',
            height: '100%',
            pointerEvents: 'none',
            zIndex: '11'
        });

        this.container.appendChild(this.overlayContainer);
        this.overlayManager = new IIIFOverlayManager(this.overlayContainer, this.viewport);
    }

    /** Make a panel draggable by its header */
    private makePanelDraggable(panel: HTMLElement, header: HTMLElement): void {
        let isDragging = false;
        let startX = 0;
        let startY = 0;
        let startLeft = 0;
        let startTop = 0;

        const onMouseDown = (e: MouseEvent) => {
            // Don't drag if clicking on a button
            if ((e.target as HTMLElement).tagName === 'BUTTON') return;

            // Prevent viewer from panning
            e.stopPropagation();

            isDragging = true;
            panel.classList.add('dragging');

            // Get current position
            const rect = panel.getBoundingClientRect();
            const containerRect = this.container.getBoundingClientRect();

            startX = e.clientX;
            startY = e.clientY;
            startLeft = rect.left - containerRect.left;
            startTop = rect.top - containerRect.top;

            // Clear any CSS positioning that might interfere
            panel.style.right = 'auto';
            panel.style.bottom = 'auto';
            panel.style.transform = 'none';
            panel.style.left = `${startLeft}px`;
            panel.style.top = `${startTop}px`;

            e.preventDefault();
        };

        const onMouseMove = (e: MouseEvent) => {
            if (!isDragging) return;

            const dx = e.clientX - startX;
            const dy = e.clientY - startY;

            const newLeft = startLeft + dx;
            const newTop = startTop + dy;

            // Constrain to container bounds
            const containerRect = this.container.getBoundingClientRect();
            const panelRect = panel.getBoundingClientRect();

            const maxLeft = containerRect.width - panelRect.width;
            const maxTop = containerRect.height - panelRect.height;

            panel.style.left = `${Math.max(0, Math.min(newLeft, maxLeft))}px`;
            panel.style.top = `${Math.max(0, Math.min(newTop, maxTop))}px`;
        };

        const onMouseUp = () => {
            if (!isDragging) return;
            isDragging = false;
            panel.classList.remove('dragging');
        };

        this.addEventListener(header, 'mousedown', onMouseDown as EventListener);
        this.addEventListener(document.body, 'mousemove', onMouseMove as EventListener);
        this.addEventListener(document.body, 'mouseup', onMouseUp as EventListener);
    }

    /**
     * Create a standard panel with header, collapse button, and body.
     * Returns { panel, header, body, collapseBtn } for further customization.
     */
    private createPanel(options: {
        className: string;
        title: string;
        initiallyCollapsed?: boolean;
        hidden?: boolean;
    }): { panel: HTMLDivElement; header: HTMLDivElement; body: HTMLDivElement; collapseBtn: HTMLButtonElement } {
        const panel = document.createElement('div');
        panel.className = `iiif-panel ${options.className}`;
        if (options.hidden) panel.style.display = 'none';

        const header = document.createElement('div');
        header.className = `iiif-panel-header ${options.className}-header`;

        const title = document.createElement('span');
        title.textContent = options.title;
        header.appendChild(title);

        const collapseBtn = document.createElement('button');
        collapseBtn.className = `iiif-panel-collapse ${options.className}-collapse`;
        collapseBtn.textContent = options.initiallyCollapsed ? '+' : '−';
        header.appendChild(collapseBtn);

        panel.appendChild(header);

        const body = document.createElement('div');
        body.className = `iiif-panel-body ${options.className}-body`;
        if (options.initiallyCollapsed) body.classList.add('collapsed');
        panel.appendChild(body);

        this.addEventListener(collapseBtn, 'click', () => {
            body.classList.toggle('collapsed');
            collapseBtn.textContent = body.classList.contains('collapsed') ? '+' : '−';
        });

        this.makePanelDraggable(panel, header);
        this.container.appendChild(panel);

        return { panel, header, body, collapseBtn };
    }

    private setupCanvasNav() {
        const { panel, body } = this.createPanel({
            className: 'iiif-canvas-nav',
            title: 'Pages',
            hidden: true,
        });
        this.canvasNavContainer = panel;
        this.canvasNavList = body;
        this.canvasNavList.classList.add('iiif-canvas-nav-list');
    }

    private setupTOC() {
        const { panel, body } = this.createPanel({
            className: 'iiif-toc',
            title: 'Contents',
            hidden: true,
        });
        this.tocContainer = panel;
        this.tocList = body;
        this.tocList.classList.add('iiif-toc-list');
    }

    private setupManifestPanel() {
        const { body } = this.createPanel({
            className: 'iiif-manifest-panel',
            title: 'Manifest',
            initiallyCollapsed: true,
        });
        this.metadataPanelBody = body;
    }

    private setupAnnotationPanel() {
        const { panel, body } = this.createPanel({
            className: 'iiif-annotation-panel',
            title: 'Annotations',
            initiallyCollapsed: true,
            hidden: true,
        });
        this.annotationPanel = panel;
        this.annotationPanelBody = body;
    }

    private setupCVPanel() {
        const { panel, body } = this.createPanel({
            className: 'iiif-cv-panel',
            title: 'Vision',
            initiallyCollapsed: true,
        });
        this.cvPanel = panel;
        this.cvPanelBody = body;

        // Hidden video element — data source only, not displayed.
        // We render to a canvas instead (see below) to bypass Chrome's video
        // compositor, which can be throttled on certain hardware/driver combos.
        this.cvVideo = document.createElement('video');
        this.cvVideo.setAttribute('playsinline', '');
        this.cvVideo.setAttribute('autoplay', '');
        this.cvVideo.muted = true;
        // Must stay in DOM and rendered (not display:none) or Chrome won't start the source.
        // Make it 1x1px offscreen so it doesn't affect layout.
        Object.assign(this.cvVideo.style, {
            position: 'absolute', width: '1px', height: '1px', opacity: '0', pointerEvents: 'none',
        });
        this.cvPanelBody.appendChild(this.cvVideo);

        // Display canvas — webcam feed drawn here via drawImage()
        this.cvDisplayCanvas = document.createElement('canvas');
        this.cvDisplayCanvas.className = 'iiif-cv-panel-video';
        this.cvPanelBody.appendChild(this.cvDisplayCanvas);

        this.cvStatusEl = document.createElement('span');
        this.cvStatusEl.className = 'iiif-cv-panel-status';
        this.cvStatusEl.textContent = 'Ready';
        this.cvPanelBody.appendChild(this.cvStatusEl);

        this.cvToggleBtn = document.createElement('button');
        this.cvToggleBtn.className = 'iiif-cv-panel-toggle';
        this.cvToggleBtn.textContent = 'Start';
        this.cvPanelBody.appendChild(this.cvToggleBtn);

        this.cvGestureBtn = document.createElement('button');
        this.cvGestureBtn.className = 'iiif-cv-panel-toggle';
        this.cvGestureBtn.textContent = 'Gestures: ON';
        this.cvGestureBtn.style.display = 'none';
        this.cvPanelBody.appendChild(this.cvGestureBtn);

        this.addEventListener(this.cvGestureBtn!, 'click', () => {
            if (!this.cvController) return;
            this.cvController.gesturesEnabled = !this.cvController.gesturesEnabled;
            this.cvGestureBtn!.textContent = this.cvController.gesturesEnabled ? 'Gestures: ON' : 'Gestures: OFF';
            this.cvGestureBtn!.classList.toggle('active', this.cvController.gesturesEnabled);
        });

        this.addEventListener(this.cvToggleBtn, 'click', async () => {
            if (this.cvController?.running) {
                this.cvController.stop();
                this.cvToggleBtn!.textContent = 'Start';
                this.cvToggleBtn!.classList.remove('active');
                this.cvGestureBtn!.style.display = 'none';
                return;
            }

            try {
                if (!this.cvController) {
                    const { CVController } = await import('./iiif-cv');
                    this.cvController = new CVController(this.cvVideo!, {
                        onStatusChange: (status: string) => {
                            if (this.cvStatusEl) this.cvStatusEl.textContent = status;
                        },
                        onPan: (dx: number, dy: number) => {
                            this.camera.springPan(dx / this.viewport.scale, dy / this.viewport.scale);
                            this.markDirty();
                        },
                        onZoom: (factor: number) => {
                            this.camera.springZoomByFactor(factor);
                            this.markDirty();
                        },
                    }, 800, this.cvDisplayCanvas);
                    await this.cvController.init();
                }

                await this.cvController.start();
                this.cvToggleBtn!.textContent = 'Stop';
                this.cvToggleBtn!.classList.add('active');
                this.cvGestureBtn!.style.display = '';
            } catch (err) {
                console.error('CV start failed:', err);
                if (this.cvStatusEl) this.cvStatusEl.textContent = 'Error';
            }
        });

        this.container.appendChild(this.cvPanel);
    }

    private setupComparePanel() {
        const { panel, collapseBtn } = this.createPanel({
            className: 'iiif-compare-panel',
            title: 'Compare',
            initiallyCollapsed: true,
            hidden: true,
        });
        this.comparePanel = panel;

        // Override collapse button behavior for compare mode
        collapseBtn.removeEventListener; // Can't remove, so we override with capture
        this.addEventListener(collapseBtn, 'click', (e) => {
            e.stopImmediatePropagation();
            if (this.comparisonController) {
                // Toggle collapse state - don't exit compare mode
                const isCollapsed = this.comparePanel!.classList.toggle('collapsed');
                collapseBtn.textContent = isCollapsed ? '+' : '−';
            } else {
                // Enter compare mode
                this.enterCompareMode();
                collapseBtn.textContent = '−';
                this.comparePanel!.classList.add('active');
                this.comparePanel!.classList.remove('collapsed');
            }
        });
    }

    private setupSettingsPanel() {
        // Create wrapper to hold both fullscreen button and tools panel
        this.toolsWrapper = document.createElement('div');
        this.toolsWrapper.className = 'iiif-tools-wrapper';

        // Create fullscreen button
        this.fullscreenBtn = document.createElement('button');
        this.fullscreenBtn.className = 'iiif-fullscreen-btn';
        this.fullscreenBtn.title = 'Toggle Fullscreen';
        this.fullscreenBtn.innerHTML = `
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3m0 18h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3"/>
            </svg>
        `;
        this.addEventListener(this.fullscreenBtn, 'click', () => {
            if (!document.fullscreenElement) {
                this.container.requestFullscreen().catch(() => {});
                this.fullscreenBtn!.classList.add('active');
            } else {
                document.exitFullscreen();
                this.fullscreenBtn!.classList.remove('active');
            }
        });

        // Listen for fullscreen changes (e.g., user pressing Escape)
        this.addEventListener(document, 'fullscreenchange', () => {
            if (!document.fullscreenElement) {
                this.fullscreenBtn!.classList.remove('active');
            }
        });

        // Create tools panel
        this.settingsPanel = document.createElement('div');
        this.settingsPanel.className = 'iiif-panel iiif-settings-panel';

        const header = document.createElement('div');
        header.className = 'iiif-panel-header iiif-settings-panel-header';

        const title = document.createElement('span');
        title.textContent = 'Tools';
        header.appendChild(title);

        const collapseBtn = document.createElement('button');
        collapseBtn.className = 'iiif-panel-collapse iiif-settings-panel-collapse';
        collapseBtn.textContent = '+';
        header.appendChild(collapseBtn);

        this.settingsPanel.appendChild(header);

        this.settingsPanelBody = document.createElement('div');
        this.settingsPanelBody.className = 'iiif-panel-body iiif-settings-panel-body collapsed';

        // Define panels with their references and labels
        // All panels use container classes to work globally (including in compare mode)
        const panelConfigs = [
            { label: 'Navigation', defaultVisible: true, containerClass: 'hide-navigation' },
            { label: 'Pages', defaultVisible: false, containerClass: 'hide-pages' },
            { label: 'Manifest', defaultVisible: true, containerClass: 'hide-manifest' },
            { label: 'Annotations', defaultVisible: false, containerClass: 'hide-annotations' },
            { label: 'Vision', defaultVisible: true, containerClass: 'hide-vision' },
            { label: 'Compare', defaultVisible: false, containerClass: 'hide-compare' },
        ];

        for (const config of panelConfigs) {
            const item = document.createElement('label');
            item.className = 'iiif-settings-panel-item';

            const checkbox = document.createElement('input');
            checkbox.type = 'checkbox';
            checkbox.className = 'iiif-settings-panel-checkbox';
            checkbox.checked = config.defaultVisible;

            const labelText = document.createElement('span');
            labelText.textContent = config.label;

            item.appendChild(checkbox);
            item.appendChild(labelText);

            // Apply initial state using container class
            if (!config.defaultVisible) {
                this.container.classList.add(config.containerClass);
            }

            this.addEventListener(checkbox, 'change', () => {
                // Toggle container class for global effect
                if (checkbox.checked) {
                    this.container.classList.remove(config.containerClass);
                } else {
                    this.container.classList.add(config.containerClass);
                }
            });

            this.settingsPanelBody.appendChild(item);
        }

        this.settingsPanel.appendChild(this.settingsPanelBody);

        this.addEventListener(collapseBtn, 'click', () => {
            this.settingsPanelBody!.classList.toggle('collapsed');
            collapseBtn.textContent = this.settingsPanelBody!.classList.contains('collapsed') ? '+' : '−';
        });

        this.toolsWrapper.appendChild(this.settingsPanel);
        this.toolsWrapper.appendChild(this.fullscreenBtn);

        // Make the wrapper draggable by the tools panel header
        this.makePanelDraggable(this.toolsWrapper, header);
        this.container.appendChild(this.toolsWrapper);
    }

    private updateComparePanel() {
        if (!this.comparePanel || !this.manifest) return;

        // Show compare panel when manifest has multiple canvases
        if (this.manifest.canvases.length > 1) {
            this.comparePanel.style.display = 'flex';
        } else {
            this.comparePanel.style.display = 'none';
        }
    }

    private updateAnnotationPanel() {
        if (!this.annotationPanelBody || !this.annotationManager) return;

        this.annotationPanelBody.innerHTML = '';
        const pages = this.annotationManager.getAnnotationPages();

        if (pages.length === 0) {
            if (this.annotationPanel) this.annotationPanel.style.display = 'none';
            return;
        }

        // Auto-show when annotations are available
        if (this.annotationPanel) this.annotationPanel.style.display = 'flex';

        const eyeSvg = '<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>';

        for (const page of pages) {
            const item = document.createElement('div');
            item.className = 'iiif-annotation-panel-item';

            const label = document.createElement('div');
            label.className = 'iiif-annotation-panel-item-label';

            // Color swatch from the page's dominant motivation
            const firstAnn = this.annotationManager!.getAllIIIFAnnotations()
                .find(a => page.overlayIds.some(id => id.includes(a.parsed.id || '')));
            const motivation = firstAnn?.parsed.motivation || '';
            const swatchColor = (MOTIVATION_COLORS[motivation] || DEFAULT_MOTIVATION_COLOR).border;

            const swatch = document.createElement('span');
            swatch.className = 'iiif-annotation-panel-swatch';
            swatch.style.display = 'inline-block';
            swatch.style.width = '8px';
            swatch.style.height = '8px';
            swatch.style.borderRadius = '50%';
            swatch.style.backgroundColor = swatchColor;
            swatch.style.marginRight = '6px';
            swatch.style.flexShrink = '0';
            label.appendChild(swatch);

            label.appendChild(document.createTextNode(page.label));
            item.appendChild(label);

            const eyeBtn = document.createElement('button');
            eyeBtn.className = 'iiif-eye-btn iiif-annotation-panel-eye';
            if (page.visible) eyeBtn.classList.add('active');
            eyeBtn.innerHTML = eyeSvg;
            eyeBtn.title = 'Toggle visibility';
            eyeBtn.addEventListener('click', () => {
                const newVisible = !page.visible;
                this.annotationManager!.setPageVisible(page.pageId, newVisible);
                eyeBtn.classList.toggle('active', newVisible);
            });
            item.appendChild(eyeBtn);

            this.annotationPanelBody.appendChild(item);
        }
    }

    private async initializeRenderer() {
        const rendererType = this.CONFIG.renderer;

        if (rendererType === 'webgl') {
            await this.initializeWebGL();
            return;
        }

        if (rendererType === 'webgpu') {
            await this.initializeWebGPU();
            return;
        }

        if (rendererType === 'canvas2d') {
            await this.initializeCanvas2D();
            return;
        }

        // Auto mode: try WebGPU → WebGL → Canvas 2D
        if (await this.isWebGPUAvailable()) {
            const success = await this.initializeWebGPU();
            if (!success) {
                console.warn('WebGPU initialization failed, falling back to WebGL');
                const webglSuccess = await this.initializeWebGL();
                if (!webglSuccess) {
                    console.warn('WebGL initialization failed, falling back to Canvas 2D');
                    await this.initializeCanvas2D();
                }
            }
        } else {
            console.log('WebGPU not available, trying WebGL');
            const webglSuccess = await this.initializeWebGL();
            if (!webglSuccess) {
                console.warn('WebGL initialization failed, falling back to Canvas 2D');
                await this.initializeCanvas2D();
            }
        }

        // If tiles were loaded before the renderer was ready, ensure they get uploaded and rendered
        if (this.renderer) {
            this.requestTilesForAllVisibleImages();
            this.markDirty();
        }
    }

    private async initializeWebGPU(): Promise<boolean> {
        try {
            console.log('Initializing WebGPU renderer');
            this.renderer = new WebGPURenderer(this.container);
            await this.renderer.initialize();
            this.updateRendererForAllTileManagers();
            return true;
        } catch (error) {
            console.error('Failed to initialize WebGPU renderer:', error);
            this.renderer = undefined;
            return false;
        }
    }

    private async initializeWebGL(): Promise<boolean> {
        try {
            console.log('Initializing WebGL renderer');
            this.renderer = new WebGLRenderer(this.container);
            await this.renderer.initialize();
            this.updateRendererForAllTileManagers();
            return true;
        } catch (error) {
            console.error('Failed to initialize WebGL renderer:', error);
            this.renderer = undefined;
            return false;
        }
    }

    private async initializeCanvas2D(): Promise<boolean> {
        try {
            console.log('Initializing Canvas 2D renderer');
            this.renderer = new Canvas2DRenderer(this.container);
            await this.renderer.initialize();
            this.updateRendererForAllTileManagers();
            return true;
        } catch (error) {
            console.error('Failed to initialize Canvas 2D renderer:', error);
            this.renderer = undefined;
            return false;
        }
    }

    private async isWebGPUAvailable(): Promise<boolean> {
        if (!navigator.gpu) return false;
        try {
            const adapter = await navigator.gpu.requestAdapter();
            return adapter !== null;
        } catch {
            return false;
        }
    }

    private updateRendererForAllTileManagers() {
        if (!this.renderer) return;
        for (const wi of this.world.worldImages.values()) {
            wi.tileManager.setRenderer(this.renderer);
        }
    }

    private setupResizeHandler() {
        const resizeObserver = new ResizeObserver(() => {
            this.handleResize();
        });
        resizeObserver.observe(this.container);
    }

    private handleResize() {
        this.cachedContainerRect = this.container.getBoundingClientRect();
        this.viewport.containerWidth = this.container.clientWidth;
        this.viewport.containerHeight = this.container.clientHeight;
        this.viewport.updateScale(); // Recalculate scale for new container dimensions

        this.renderer?.resize();
        this.requestTilesForAllVisibleImages();
        this.overlayManager?.updateAllOverlays();
        this.markDirty();
    }

    // ============================================================
    // EVENT HANDLING
    // ============================================================

    private addEventListener<K extends keyof HTMLElementEventMap>(
        element: Element | Document,
        type: K,
        handler: (event: HTMLElementEventMap[K]) => void,
        options?: { passive?: boolean }
    ) {
        if (!this.eventHandlers.has(element)) {
            this.eventHandlers.set(element, new Map());
        }
        const listener = handler as EventListener;
        this.eventHandlers.get(element)!.set(type, listener);
        element.addEventListener(type, listener, { signal: this.abortController.signal, ...options });
    }

    /**
     * Set up mouse/wheel event listeners for interactive navigation
     */
    listen() {
        this.addEventListener(this.container, 'mousedown', (event: MouseEvent) => {
            // Don't start pan when clicking toolbar/UI elements
            if ((event.target as HTMLElement).closest('.iiif-toolbar, .iiif-canvas-nav, .iiif-toc, .iiif-metadata-panel, .iiif-canvas-list, .iiif-compare-control-bar')) return;

            event.preventDefault();
            event.stopPropagation();

            const canvasX = event.clientX - this.cachedContainerRect.left;
            const canvasY = event.clientY - this.cachedContainerRect.top;

            this.camera.startInteractivePan(canvasX, canvasY);

            const onMouseMove = (moveEvent: MouseEvent) => {
                const newCanvasX = moveEvent.clientX - this.cachedContainerRect.left;
                const newCanvasY = moveEvent.clientY - this.cachedContainerRect.top;
                this.camera.updateInteractivePan(newCanvasX, newCanvasY);
            };

            const cleanup = () => {
                this.camera.endInteractivePan();
                document.removeEventListener('mousemove', onMouseMove);
                document.removeEventListener('mouseup', cleanup);
                document.removeEventListener('mouseleave', cleanup);
            };

            document.addEventListener('mousemove', onMouseMove, { signal: this.abortController.signal });
            document.addEventListener('mouseup', cleanup, { signal: this.abortController.signal });
            document.addEventListener('mouseleave', cleanup, { signal: this.abortController.signal });
        });

        this.addEventListener(this.container, 'wheel', (event: WheelEvent) => {
            const canvasX = event.clientX - this.cachedContainerRect.left;
            const canvasY = event.clientY - this.cachedContainerRect.top;
            this.camera.handleWheel(event, canvasX, canvasY);
        }, { passive: false });

        // Touch events for mobile/tablet
        this.addEventListener(this.container, 'touchstart', (event: TouchEvent) => {
            if ((event.target as HTMLElement).closest('.iiif-toolbar, .iiif-canvas-nav, .iiif-toc, .iiif-metadata-panel, .iiif-canvas-list, .iiif-compare-control-bar')) return;

            event.preventDefault();
            event.stopPropagation();

            const rect = this.cachedContainerRect;
            for (let i = 0; i < event.changedTouches.length; i++) {
                const t = event.changedTouches[i];
                this.touchState.activeTouches.set(t.identifier, {
                    x: t.clientX - rect.left,
                    y: t.clientY - rect.top
                });
            }

            const touchCount = this.touchState.activeTouches.size;

            if (touchCount === 1) {
                const touch = event.changedTouches[0];
                const canvasX = touch.clientX - rect.left;
                const canvasY = touch.clientY - rect.top;

                // Double-tap detection
                const now = performance.now();
                const dt = now - this.touchState.lastTapTime;
                const dx = canvasX - this.touchState.lastTapX;
                const dy = canvasY - this.touchState.lastTapY;

                if (dt < 300 && (dx * dx + dy * dy) < 900) {
                    this.camera.handleDoubleTap(canvasX, canvasY);
                    this.touchState.lastTapTime = 0;
                    return;
                }

                this.touchState.lastTapTime = now;
                this.touchState.lastTapX = canvasX;
                this.touchState.lastTapY = canvasY;

                this.camera.startInteractivePan(canvasX, canvasY);
            }

            if (touchCount === 2) {
                // End single-finger pan, start pinch
                this.camera.endInteractivePan();

                const touches = Array.from(this.touchState.activeTouches.values());
                const dx = touches[1].x - touches[0].x;
                const dy = touches[1].y - touches[0].y;
                this.touchState.lastPinchDistance = Math.sqrt(dx * dx + dy * dy);
                this.touchState.isPinching = true;
            }
        }, { passive: false });

        this.addEventListener(this.container, 'touchmove', (event: TouchEvent) => {
            event.preventDefault();

            const rect = this.cachedContainerRect;
            for (let i = 0; i < event.changedTouches.length; i++) {
                const t = event.changedTouches[i];
                this.touchState.activeTouches.set(t.identifier, {
                    x: t.clientX - rect.left,
                    y: t.clientY - rect.top
                });
            }

            const touchCount = this.touchState.activeTouches.size;

            if (touchCount === 1 && !this.touchState.isPinching) {
                const touch = event.changedTouches[0];
                const canvasX = touch.clientX - rect.left;
                const canvasY = touch.clientY - rect.top;
                this.camera.updateInteractivePan(canvasX, canvasY);
            }

            if (touchCount >= 2 && this.touchState.isPinching) {
                const touches = Array.from(this.touchState.activeTouches.values());
                const dx = touches[1].x - touches[0].x;
                const dy = touches[1].y - touches[0].y;
                const newDistance = Math.sqrt(dx * dx + dy * dy);
                const centerX = (touches[0].x + touches[1].x) / 2;
                const centerY = (touches[0].y + touches[1].y) / 2;

                if (this.touchState.lastPinchDistance > 0) {
                    const scaleFactor = newDistance / this.touchState.lastPinchDistance;
                    this.camera.handlePinchZoom(scaleFactor, centerX, centerY);
                }

                this.touchState.lastPinchDistance = newDistance;
            }
        }, { passive: false });

        const onTouchEnd = (event: TouchEvent) => {
            event.preventDefault();

            for (let i = 0; i < event.changedTouches.length; i++) {
                this.touchState.activeTouches.delete(event.changedTouches[i].identifier);
            }

            const remaining = this.touchState.activeTouches.size;

            if (remaining < 2 && this.touchState.isPinching) {
                this.touchState.isPinching = false;

                if (remaining === 1) {
                    // One finger still down: resume single-finger pan
                    const touch = Array.from(this.touchState.activeTouches.values())[0];
                    this.camera.startInteractivePan(touch.x, touch.y);
                } else {
                    this.camera.endInteractivePan();
                }
            }

            if (remaining === 0 && !this.touchState.isPinching) {
                this.camera.endInteractivePan();
            }
        };

        this.addEventListener(this.container, 'touchend', onTouchEnd, { passive: false });
        this.addEventListener(this.container, 'touchcancel', onTouchEnd, { passive: false });

        // Keyboard navigation — make container focusable
        if (!this.container.hasAttribute('tabindex')) {
            this.container.tabIndex = 0;
            this.container.style.outline = 'none';
        }

        // Focus container on click so keyboard events work
        this.addEventListener(this.container, 'click', (event: MouseEvent) => {
            const tag = (event.target as HTMLElement).tagName;
            if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
            this.container.focus();
        });

        // Track held arrow keys for diagonal movement
        const heldArrows = new Set<string>();

        this.addEventListener(this.container, 'keyup', (event: KeyboardEvent) => {
            heldArrows.delete(event.key);
        });

        this.addEventListener(this.container, 'blur', () => {
            heldArrows.clear();
        });

        this.addEventListener(this.container, 'keydown', (event: KeyboardEvent) => {
            // Don't intercept keys when typing in an input
            if ((event.target as HTMLElement).tagName === 'INPUT' || (event.target as HTMLElement).tagName === 'TEXTAREA') return;

            // Arrow keys: combine held keys for diagonal panning
            const isArrow = event.key === 'ArrowLeft' || event.key === 'ArrowRight' ||
                            event.key === 'ArrowUp' || event.key === 'ArrowDown';

            if (isArrow) {
                event.preventDefault();
                heldArrows.add(event.key);

                let dx = 0, dy = 0;
                if (heldArrows.has('ArrowLeft')) dx -= 1;
                if (heldArrows.has('ArrowRight')) dx += 1;
                if (heldArrows.has('ArrowUp')) dy -= 1;
                if (heldArrows.has('ArrowDown')) dy += 1;

                if (dx !== 0 || dy !== 0) {
                    const panAmount = 100 / this.viewport.scale;
                    // Normalize so diagonal has same per-event magnitude as cardinal
                    const len = Math.sqrt(dx * dx + dy * dy);
                    this.camera.springPan((dx / len) * panAmount, (dy / len) * panAmount);
                    this.markDirty();
                }
                return;
            }

            switch (event.key) {
                // Zoom with +/- or =/- (spring-based, same feel as mouse wheel)
                case '+':
                case '=':
                    event.preventDefault();
                    this.camera.springZoomByFactor(1.5);
                    this.markDirty();
                    break;
                case '-':
                    event.preventDefault();
                    this.camera.springZoomByFactor(1 / 1.5);
                    this.markDirty();
                    break;

                // Fit to view
                case '0':
                    event.preventDefault();
                    this.fitToWorld();
                    break;

                // Canvas navigation with Page Up/Down or [ ]
                case 'PageUp':
                case '[':
                    event.preventDefault();
                    this.previousCanvas();
                    break;
                case 'PageDown':
                case ']':
                    event.preventDefault();
                    this.nextCanvas();
                    break;

                // Home/End for first/last canvas
                case 'Home':
                    event.preventDefault();
                    if (this.manifest && this.canvasCount > 0) {
                        this.loadCanvas(0);
                    }
                    break;
                case 'End':
                    event.preventDefault();
                    if (this.manifest && this.canvasCount > 0) {
                        this.loadCanvas(this.canvasCount - 1);
                    }
                    break;

                // Fullscreen toggle
                case 'f':
                    if (!event.ctrlKey && !event.metaKey) {
                        event.preventDefault();
                        if (!document.fullscreenElement) {
                            this.container.requestFullscreen().catch(() => {});
                            this.fullscreenBtn?.classList.add('active');
                        } else {
                            document.exitFullscreen();
                            this.fullscreenBtn?.classList.remove('active');
                        }
                    }
                    break;
            }
        });
    }

    // ============================================================
    // IMAGE MANAGEMENT
    // ============================================================

    /**
     * Add an image to the viewer
     */
    async addImage(
        id: string,
        url: string,
        focus: boolean = false,
        placement?: WorldPlacement
    ): Promise<void> {
        const iiifImage = new IIIFImage(id, url);
        await iiifImage.loadManifest(url);

        const worldPlacement: WorldPlacement = placement ?? {
            worldX: 0,
            worldY: 0,
            worldWidth: iiifImage.width,
            worldHeight: iiifImage.height
        };

        const tileManager = new TileManager(
            id,
            iiifImage,
            this.CONFIG.maxCacheSize,
            this.renderer,
            1.0,  // distanceDetail
            () => this.markDirty()  // onTileLoaded callback
        );

        const worldImage = new WorldImage(iiifImage, tileManager, worldPlacement);
        tileManager.setWorldImage(worldImage);
        this.world.addImage(id, worldImage);

        if (focus) {
            this.viewport.fitToWorld(this.world.worldWidth, this.world.worldHeight);
        }

        tileManager.requestTilesForViewport(this.viewport);
        await tileManager.loadThumbnail();
        this.markDirty();
    }

    /**
     * Clear all images and free GPU resources
     */
    clearWorld() {
        // Collect IDs first to avoid modifying Map during iteration
        const imageIds = Array.from(this.world.worldImages.keys());
        for (const id of imageIds) {
            const wi = this.world.worldImages.get(id);
            if (wi) {
                for (const tileId of wi.tileManager.getLoadedTileIds()) {
                    this.renderer?.destroyTexture(tileId);
                }
            }
            this.world.removeImage(id);
        }
        this.annotationManager?.clearIIIFAnnotations();
        this.markDirty();
    }

    // ============================================================
    // IIIF MANIFEST LOADING
    // ============================================================

    /**
     * Load any IIIF URL (image service, bare URL, or manifest)
     */
    async loadUrl(url: string, focus: boolean = true): Promise<void> {
        this.currentLoadedUrl = url;
        const result = await parseIIIFUrl(url);

        if (result.type === 'image-service-2' || result.type === 'image-service-3') {
            this.clearWorld();
            this.manifest = undefined;
            this.currentCanvasIndex = -1;

            const svc = result as ParsedImageService;
            const infoUrl = svc.id.replace(/\/$/, '') + '/info.json';
            await this.addImage('image-0', infoUrl, focus);
            this.canvasIdToIndex.clear();
            this.updateCanvasNav();
            this.updateTOC();
            this.updateManifestPanel();
        } else {
            this.clearWorld();
            this.manifest = result as ParsedManifest;

            // Build canvas ID -> index lookup for range navigation
            this.canvasIdToIndex.clear();
            for (let i = 0; i < this.manifest.canvases.length; i++) {
                this.canvasIdToIndex.set(this.manifest.canvases[i].id, i);
            }

            this.updateCanvasNav();
            this.updateTOC();
            this.updateManifestPanel();
            this.updateComparePanel();
            await this.loadCanvas(0, focus);
        }
    }

    /**
     * Load a specific canvas from the current manifest
     */
    async loadCanvas(index: number, focus: boolean = true): Promise<void> {
        if (!this.manifest) {
            throw new Error('No manifest loaded. Call loadUrl() with a manifest URL first.');
        }
        if (index < 0 || index >= this.manifest.canvases.length) {
            throw new Error(`Canvas index ${index} out of range (0-${this.manifest.canvases.length - 1})`);
        }

        this.clearWorld();
        this.currentCanvasIndex = index;
        this.updateCanvasNavActiveState();

        const canvas = this.manifest.canvases[index];
        let loadedCount = 0;

        for (let i = 0; i < canvas.images.length; i++) {
            const img = canvas.images[i];
            const infoUrl = img.imageServiceUrl.replace(/\/$/, '') + '/info.json';

            const placement: WorldPlacement | undefined = img.target
                ? {
                    worldX: img.target.x,
                    worldY: img.target.y,
                    worldWidth: img.target.w,
                    worldHeight: img.target.h
                }
                : undefined;

            try {
                const shouldFocus = focus && i === canvas.images.length - 1;
                await this.addImage(`canvas-${index}-img-${i}`, infoUrl, shouldFocus, placement);
                loadedCount++;
            } catch (err) {
                console.warn(`Failed to load image ${i} for canvas ${index}:`, err);
            }
        }

        if (focus && loadedCount > 0 && this.world.worldImages.size > 0) {
            this.viewport.fitToWorld(this.world.worldWidth, this.world.worldHeight);
        }

        await this.loadIIIFAnnotationsForCanvas(canvas);
    }

    private async loadIIIFAnnotationsForCanvas(canvas: CanvasInfo): Promise<void> {
        if (!this.annotationManager) return;

        this.annotationManager.clearIIIFAnnotations();

        const allPages = [...canvas.annotations];

        for (const listUrl of canvas.annotationListUrls) {
            try {
                const page = await fetchAnnotationList(listUrl);
                if (page && page.annotations && page.annotations.length > 0) {
                    allPages.push(page);
                }
            } catch {
                console.warn(`Failed to fetch annotation list: ${listUrl}`);
            }
        }

        if (allPages.length > 0) {
            this.annotationManager.loadIIIFAnnotations(allPages, canvas.width, canvas.height);
        }

        this.updateAnnotationPanel();
    }

    /**
     * Navigate to next canvas
     */
    async nextCanvas(): Promise<void> {
        if (!this.manifest || this.currentCanvasIndex >= this.manifest.canvases.length - 1) {
            return;
        }
        await this.loadCanvas(this.currentCanvasIndex + 1);
    }

    /**
     * Navigate to previous canvas
     */
    async previousCanvas(): Promise<void> {
        if (!this.manifest || this.currentCanvasIndex <= 0) {
            return;
        }
        await this.loadCanvas(this.currentCanvasIndex - 1);
    }

    /** Number of canvases in the loaded manifest */
    get canvasCount(): number {
        return this.manifest?.canvases.length ?? 0;
    }

    /** Current canvas index */
    get currentCanvas(): number {
        return this.currentCanvasIndex;
    }

    // ============================================================
    // CANVAS NAVIGATION UI
    // ============================================================

    private updateCanvasNav() {
        if (!this.canvasNavContainer || !this.canvasNavList) return;

        if (!this.manifest || this.manifest.canvases.length <= 1) {
            this.canvasNavContainer.style.display = 'none';
            return;
        }

        this.canvasNavContainer.style.display = 'flex';
        this.canvasNavList.innerHTML = '';

        for (let i = 0; i < this.manifest.canvases.length; i++) {
            const canvas = this.manifest.canvases[i];
            const item = this.createCanvasNavItem(canvas, i);
            this.canvasNavList.appendChild(item);
        }
    }

    private createCanvasNavItem(canvas: any, index: number): HTMLElement {
        const item = document.createElement('div');
        item.className = 'iiif-canvas-nav-item';
        if (index === this.currentCanvasIndex) {
            item.classList.add('active');
        }

        if (canvas.images.length > 0) {
            const serviceUrl = canvas.images[0].imageServiceUrl.replace(/\/$/, '');
            const thumbUrl = `${serviceUrl}/full/!120,120/0/default.jpg`;

            const img = document.createElement('img');
            img.className = 'iiif-canvas-nav-item-img';
            img.src = thumbUrl;
            img.alt = canvas.label || `Canvas ${index + 1}`;
            img.loading = 'lazy';
            img.onerror = () => {
                img.style.display = 'none';
            };
            item.appendChild(img);
        }

        const labelEl = document.createElement('div');
        labelEl.className = 'iiif-canvas-nav-item-label';
        labelEl.textContent = canvas.label || `${index + 1}`;
        item.appendChild(labelEl);

        item.addEventListener('click', () => {
            this.loadCanvas(index);
        });

        return item;
    }

    private updateCanvasNavActiveState() {
        if (!this.canvasNavList) return;
        const items = this.canvasNavList.querySelectorAll('.iiif-canvas-nav-item');
        items.forEach((item, i) => {
            item.classList.toggle('active', i === this.currentCanvasIndex);
        });
    }

    // ============================================================
    // TABLE OF CONTENTS
    // ============================================================

    private updateTOC() {
        if (!this.tocContainer || !this.tocList) return;

        const ranges = this.manifest?.ranges;
        if (!ranges || ranges.length === 0) {
            this.tocContainer.style.display = 'none';
            return;
        }

        this.tocContainer.style.display = 'flex';
        this.tocList.innerHTML = '';

        for (const range of ranges) {
            this.tocList.appendChild(this.createTOCNode(range, 0));
        }
    }

    private createTOCNode(range: ParsedRange, depth: number): HTMLElement {
        const node = document.createElement('div');
        node.className = 'iiif-toc-node';

        const row = document.createElement('div');
        row.className = 'iiif-toc-row';
        row.style.paddingLeft = `${8 + depth * 14}px`;

        if (range.children.length > 0) {
            const toggle = document.createElement('span');
            toggle.className = 'iiif-toc-toggle';
            toggle.textContent = '\u25BC';
            toggle.addEventListener('click', (e) => {
                e.stopPropagation();
                const childContainer = node.querySelector(':scope > .iiif-toc-children') as HTMLElement;
                if (childContainer) {
                    const isCollapsed = childContainer.style.display === 'none';
                    childContainer.style.display = isCollapsed ? 'block' : 'none';
                    toggle.textContent = isCollapsed ? '\u25BC' : '\u25B6';
                }
            });
            row.appendChild(toggle);
        } else {
            const spacer = document.createElement('span');
            spacer.className = 'iiif-toc-toggle-spacer';
            row.appendChild(spacer);
        }

        const labelEl = document.createElement('span');
        labelEl.className = 'iiif-toc-label';
        labelEl.textContent = range.label || 'Untitled';
        row.appendChild(labelEl);

        // Click navigates to the first canvas in this range (or first child's canvas)
        const firstCanvasIndex = this.findFirstCanvasIndex(range);
        if (firstCanvasIndex !== undefined) {
            row.classList.add('iiif-toc-clickable');
            row.addEventListener('click', () => {
                this.loadCanvas(firstCanvasIndex);
            });
        }

        node.appendChild(row);

        if (range.children.length > 0) {
            const childContainer = document.createElement('div');
            childContainer.className = 'iiif-toc-children';
            for (const child of range.children) {
                childContainer.appendChild(this.createTOCNode(child, depth + 1));
            }
            node.appendChild(childContainer);
        }

        return node;
    }

    private findFirstCanvasIndex(range: ParsedRange): number | undefined {
        // Check direct canvas refs first
        for (const canvasId of range.canvasIds) {
            const index = this.canvasIdToIndex.get(canvasId);
            if (index !== undefined) return index;
        }
        // Recurse into children
        for (const child of range.children) {
            const index = this.findFirstCanvasIndex(child);
            if (index !== undefined) return index;
        }
        return undefined;
    }

    // ============================================================
    // MANIFEST PANEL
    // ============================================================

    private updateManifestPanel() {
        if (!this.metadataPanelBody) return;
        this.metadataPanelBody.innerHTML = '';

        const meta = this.manifest?.metadata;
        if (!meta) return;

        if (this.manifest?.label) {
            this.appendManifestField('Title', this.manifest.label);
        }

        if (meta.description) {
            this.appendManifestField('Description', meta.description);
        }

        if (meta.attribution) {
            this.appendManifestField(meta.attributionLabel || 'Attribution', meta.attribution);
        }

        if (meta.rights) {
            const link = document.createElement('a');
            link.href = meta.rights;
            link.target = '_blank';
            link.rel = 'noopener';
            link.textContent = meta.rights;
            this.appendManifestFieldElement('Rights', link);
        }

        if (meta.logo) {
            const img = document.createElement('img');
            img.src = meta.logo;
            img.className = 'iiif-manifest-panel-logo';
            img.alt = 'Logo';
            this.appendManifestFieldElement('Logo', img);
        }

        if (meta.metadata.length > 0) {
            const separator = document.createElement('div');
            separator.className = 'iiif-manifest-panel-separator';
            this.metadataPanelBody.appendChild(separator);

            for (const item of meta.metadata) {
                this.appendManifestField(item.label, item.value);
            }
        }
    }

    private appendManifestField(label: string, value: string) {
        const row = document.createElement('div');
        row.className = 'iiif-manifest-panel-row';

        const labelEl = document.createElement('div');
        labelEl.className = 'iiif-manifest-panel-label';
        labelEl.textContent = label;

        const valueEl = document.createElement('div');
        valueEl.className = 'iiif-manifest-panel-value';
        valueEl.textContent = value;

        row.appendChild(labelEl);
        row.appendChild(valueEl);
        this.metadataPanelBody!.appendChild(row);
    }

    private appendManifestFieldElement(label: string, element: HTMLElement) {
        const row = document.createElement('div');
        row.className = 'iiif-manifest-panel-row';

        const labelEl = document.createElement('div');
        labelEl.className = 'iiif-manifest-panel-label';
        labelEl.textContent = label;

        const valueEl = document.createElement('div');
        valueEl.className = 'iiif-manifest-panel-value';
        valueEl.appendChild(element);

        row.appendChild(labelEl);
        row.appendChild(valueEl);
        this.metadataPanelBody!.appendChild(row);
    }

    // ============================================================
    // NAVIGATION API
    // ============================================================

    /**
     * Zoom to a specific scale value
     */
    zoom(targetScale: number, duration = 500) {
        this.camera.zoom(targetScale, duration);
        this.markDirty();
    }

    /**
     * Zoom by a factor
     */
    zoomByFactor(factor: number, duration = 500) {
        this.camera.zoomByFactor(factor, duration);
        this.markDirty();
    }

    /**
     * Pan by delta amounts in world coordinates
     */
    pan(deltaX: number, deltaY: number, duration = 500) {
        this.camera.pan(deltaX, deltaY, duration);
        this.markDirty();
    }

    /**
     * Navigate to a specific position
     */
    to(worldX: number, worldY: number, cameraZ: number, duration = 500) {
        this.camera.to(worldX, worldY, cameraZ, duration);
        this.markDirty();
    }

    /**
     * Fit the view to show the entire world
     */
    fitToWorld() {
        this.viewport.fitToWorld(this.world.worldWidth, this.world.worldHeight);
        this.markDirty();
    }

    // ============================================================
    // OVERLAYS & ANNOTATIONS
    // ============================================================

    /**
     * Add an overlay element to the viewer
     */
    addOverlay(overlay: {
        id: string;
        element: HTMLElement;
        worldX: number;
        worldY: number;
        worldWidth: number;
        worldHeight: number;
        scaleWithZoom?: boolean;
    }): void {
        if (!this.overlayManager) {
            console.error('Overlay manager not initialized. Enable overlays in viewer options.');
            return;
        }
        this.overlayManager.addOverlay(overlay);
    }

    /**
     * Add a custom annotation to the viewer.
     * Returns the annotation ID (auto-generated if not provided).
     *
     * @example
     * // Simple element annotation
     * const id = viewer.addAnnotation(100, 200, 300, 150, myElement);
     *
     * // With options
     * const id = viewer.addAnnotation(100, 200, 300, 150, myElement, {
     *     id: 'my-annotation',
     *     style: { border: '3px solid red' },
     *     scaleWithZoom: false,
     * });
     */
    addAnnotation(
        x: number,
        y: number,
        width: number,
        height: number,
        element?: HTMLElement | string,
        options?: {
            id?: string;
            style?: Record<string, string | undefined>;
            scaleWithZoom?: boolean;
        }
    ): string | undefined {
        if (!this.annotationManager) {
            console.error('Annotation manager not initialized.');
            return undefined;
        }

        const id = options?.id ?? `custom-ann-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

        const content: { element?: HTMLElement; text?: string } = {};
        if (typeof element === 'string') {
            content.text = element;
        } else if (element) {
            content.element = element;
        }

        this.annotationManager.addAnnotation({
            id,
            fixed: true,
            x,
            y,
            width,
            height,
            style: options?.style,
            content: Object.keys(content).length > 0 ? content : undefined,
            scaleWithZoom: options?.scaleWithZoom,
        });

        return id;
    }

    /**
     * Remove a custom annotation by ID.
     */
    removeAnnotation(id: string): void {
        if (!this.annotationManager) return;
        this.annotationManager.removeAnnotation(id);
    }

    /**
     * Clear all custom annotations (does not affect IIIF annotations).
     */
    clearAnnotations(): void {
        if (!this.annotationManager) return;
        this.annotationManager.clearCustomAnnotations();
    }

    // ============================================================
    // RENDERING
    // ============================================================

    markDirty() {
        this.needsRender = true;
    }

    private hasViewportChanged(): boolean {
        // Check for uninitialized state (NaN values)
        if (isNaN(this.lastViewportState.centerX)) {
            return true;
        }

        return (
            this.viewport.centerX !== this.lastViewportState.centerX ||
            this.viewport.centerY !== this.lastViewportState.centerY ||
            this.viewport.scale !== this.lastViewportState.scale
        );
    }

    private updateViewportState() {
        this.lastViewportState.centerX = this.viewport.centerX;
        this.lastViewportState.centerY = this.viewport.centerY;
        this.lastViewportState.scale = this.viewport.scale;
    }

    private requestTilesForAllVisibleImages() {
        const bounds = this.viewport.getWorldBounds();
        const visibleImages = this.world.getVisibleImages(
            bounds.left,
            bounds.top,
            bounds.right,
            bounds.bottom
        );
        for (const wi of visibleImages) {
            wi.tileManager.requestTilesForViewport(this.viewport);
        }
    }

    /**
     * Render a single frame
     */
    render() {
        // Update animations (may modify viewport)
        const animationResult = this.camera.updateInteractiveAnimation();
        if (animationResult.needsUpdate) {
            this.markDirty();
        }

        // Check if we need to render
        const viewportChanged = this.hasViewportChanged();
        if (!this.needsRender && !viewportChanged) {
            return;
        }

        if (!this.renderer) {
            return;
        }

        const bounds = this.viewport.getWorldBounds();
        const visibleImages = this.world.getVisibleImages(
            bounds.left,
            bounds.top,
            bounds.right,
            bounds.bottom
        );

        if (visibleImages.length === 0) {
            return;
        }

        // Collect tiles from all visible images
        const allTiles: TileRenderData[] = [];
        let thumbnail: TileRenderData | undefined;

        for (const worldImage of visibleImages) {
            const tiles = worldImage.tileManager.getLoadedTilesForRender(this.viewport);
            allTiles.push(...tiles);

            if (!thumbnail) {
                thumbnail = worldImage.tileManager.getThumbnail();
            }
        }

        // Sort by z-depth for proper layering
        allTiles.sort((a, b) => a.z - b.z);

        // Render
        this.renderer.render(this.viewport, allTiles, thumbnail);

        // Update overlays only if viewport changed
        if (viewportChanged) {
            this.overlayManager?.updateAllOverlays();
            this.updateViewportState();
            if (this.onViewportChange) {
                this.onViewportChange(this.viewport.centerX, this.viewport.centerY, this.viewport.cameraZ);
            }
        }

        this.needsRender = false;
    }

    /**
     * Start continuous render loop
     */
    startRenderLoop() {
        if (this.renderLoopActive) {
            return;
        }

        this.renderLoopActive = true;
        console.log('Starting render loop');

        const loop = () => {
            if (!this.renderLoopActive) {
                return;
            }
            this.render();
            this.animationFrameId = requestAnimationFrame(loop);
        };
        loop();
    }

    /**
     * Stop render loop
     */
    stopRenderLoop() {
        this.renderLoopActive = false;
        if (this.animationFrameId !== undefined) {
            cancelAnimationFrame(this.animationFrameId);
            this.animationFrameId = undefined;
        }
    }

    // ============================================================
    // COMPARISON MODE
    // ============================================================

    /**
     * Enter comparison mode. Shows the canvas list panel alongside
     * the current viewer. The parent viewer keeps running until
     * additional canvases are toggled on.
     */
    async enterCompareMode(): Promise<void> {
        if (this.comparisonController) return;
        if (!this.currentLoadedUrl) return;
        if (!this.manifest || this.manifest.canvases.length === 0) return;

        const { ComparisonController } = await import('./iiif-compare');

        // Hide panels that don't apply in compare mode
        if (this.tocContainer) this.tocContainer.style.display = 'none';

        // Add compare-active class for expanded styling
        if (this.comparePanel) {
            this.comparePanel.classList.add('compare-active');
        }

        const currentCanvas = this.manifest.canvases[this.currentCanvasIndex];
        const canvases = [{
            label: currentCanvas?.label || `Canvas ${this.currentCanvasIndex + 1}`,
            index: this.currentCanvasIndex,
            thumbnailServiceUrl: currentCanvas?.images[0]?.imageServiceUrl,
        }];

        this.comparisonController = new ComparisonController(this.container, {
            viewerOptions: {
                enableOverlays: this.CONFIG.enableOverlays,
                maxCacheSize: this.CONFIG.maxCacheSize,
                enableToolbar: true,
                enableCompare: false,
                suppressSettings: true,
                toolbar: { zoom: true },
            },
            manifestUrl: this.currentLoadedUrl!,
            canvases,
            currentCanvasIndex: this.currentCanvasIndex,
            savedEntries: this.compareAddedEntries,
            listPanel: this.comparePanel,
            onExit: () => {
                this.exitCompareMode();
            },
            onSuspendParent: () => {
                this.stopRenderLoop();
                // Mark container as in compare mode to hide main viewer panels via CSS
                this.container.classList.add('iiif-compare-active');
                if (this.renderer?.canvas) this.renderer.canvas.style.display = 'none';
                if (this.overlayContainer) this.overlayContainer.style.display = 'none';
            },
            onResumeParent: () => {
                this.container.classList.remove('iiif-compare-active');
                if (this.renderer?.canvas) this.renderer.canvas.style.display = '';
                if (this.overlayContainer) this.overlayContainer.style.display = '';
                this.startRenderLoop();
                this.markDirty();
            },
        });
    }

    /**
     * Exit comparison mode and resume the single viewer.
     */
    exitCompareMode(): void {
        if (!this.comparisonController) return;

        // Save manually-added URLs so they persist across compare sessions
        this.compareAddedEntries = this.comparisonController.getAddedEntries();

        this.comparisonController.destroy();
        this.comparisonController = undefined;

        // Ensure viewer is fully visible (handles both single-parent and env mode exit)
        if (this.renderer?.canvas) this.renderer.canvas.style.display = '';
        if (this.overlayContainer) this.overlayContainer.style.display = '';
        if (this.canvasToolbar?.toolbar) this.canvasToolbar.toolbar.style.display = '';

        // Restore panels based on manifest data (they set their own display)
        this.updateCanvasNav();
        this.updateTOC();

        // Reset compare panel to original state
        if (this.comparePanel) {
            this.comparePanel.classList.remove('compare-active', 'active', 'collapsed');
            // Reset toggle button and hide close button
            const toggleBtn = this.comparePanel.querySelector('.iiif-compare-panel-collapse');
            if (toggleBtn) toggleBtn.textContent = '+';
            const closeBtn = this.comparePanel.querySelector('.iiif-compare-panel-close') as HTMLElement;
            if (closeBtn) closeBtn.style.display = 'none';
        }
        this.updateComparePanel();

        // Ensure render loop is running
        if (!this.renderLoopActive) {
            this.startRenderLoop();
        }
        this.markDirty();
    }

    // ============================================================
    // CLEANUP
    // ============================================================

    /**
     * Destroy the viewer and free all resources
     */
    destroy() {
        this.stopRenderLoop();
        this.abortController.abort();
        this.clearWorld();
        this.renderer?.destroy();
        this.cvController?.destroy();
        this.cvController = undefined;
        this.overlayManager = undefined;
        this.annotationManager = undefined;
        this.canvasToolbar = undefined;
    }
}
