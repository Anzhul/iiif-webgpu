/**
 * ViewerUI - Manages all panel-related UI setup and update methods.
 *
 * Extracted from IIIFViewer to reduce file size and improve maintainability.
 * Handles creation and updating of canvas nav, TOC, manifest, annotation,
 * CV (gesture), compare, and settings panels.
 */

import { PanelManager } from './iiif-panel-manager';
import { AnnotationManager, MOTIVATION_COLORS, DEFAULT_MOTIVATION_COLOR } from '../features/iiif-annotations';
import { IIIFOverlayManager } from '../features/iiif-overlay';
import { EYE_SVG } from './icons';
import type { ParsedManifest, ParsedRange, ParsedCanvas } from '../iiif-parser';
import type { IIIFViewerOptions, IIIFViewerPanels, LayoutState, CustomAnnotationSpec } from '../types';

// Dynamic import types (for lazy loading modules)
import type { CVController } from '../features/iiif-cv';

export interface ViewerUICallbacks {
    markDirty(): void;
    fitToWorld(): void;
    loadCanvas(index: number): Promise<void>;
    previousCanvas(): Promise<void>;
    nextCanvas(): Promise<void>;
    springZoomByFactor(factor: number): void;
    springPan(dx: number, dy: number): void;
    enterCompareMode(): Promise<void>;
    exitCompareMode(): void;
    saveLayout(): LayoutState;
    loadLayout(state: LayoutState): Promise<void>;
    getViewportScale(): number;
    getRenderer(): { setClearColor(r: number, g: number, b: number): void } | undefined;
    getAnnotationManager(): AnnotationManager | undefined;
    getOverlayManager(): IIIFOverlayManager | undefined;
    getManifest(): ParsedManifest | undefined;
    getCurrentCanvasIndex(): number;
    getCurrentLoadedUrl(): string | undefined;
    getCustomAnnotationSpecs(): CustomAnnotationSpec[];
    getHiddenAnnotationTypes(): Set<string>;
    setHiddenAnnotationType(type: string, hidden: boolean): void;
    getComparisonController(): { setBackgroundColor(r: number, g: number, b: number): void } | undefined;
    isMobileOrTablet(): boolean;
    getCanvasIdToIndex(): Map<string, number>;
}

export class ViewerUI {
    // Public fields (panel DOM references - accessed by IIIFViewer for layout save/load, compare mode, etc.)
    canvasNavContainer?: HTMLElement;
    canvasNavList?: HTMLElement;
    tocContainer?: HTMLElement;
    tocList?: HTMLElement;
    metadataPanelBody?: HTMLElement;
    annotationPanel?: HTMLDivElement;
    annotationPanelBody?: HTMLDivElement;
    cvPanel?: HTMLDivElement;
    cvController?: CVController;
    comparePanel?: HTMLDivElement;
    settingsPanel?: HTMLDivElement;
    settingsPanelBody?: HTMLDivElement;
    fullscreenBtn?: HTMLButtonElement;
    colorInput?: HTMLInputElement;
    settingsCheckboxes: Map<string, HTMLInputElement> = new Map();

    // Private fields
    private cvPanelBody?: HTMLDivElement;
    private cvVideo?: HTMLVideoElement;
    private cvDisplayCanvas?: HTMLCanvasElement;
    private cvStatusEl?: HTMLSpanElement;
    private cvToggleBtn?: HTMLButtonElement;
    private cvGestureBtn?: HTMLButtonElement;

    private panelManager: PanelManager;
    private container: HTMLElement;
    private panels: IIIFViewerPanels;
    // @ts-ignore -- reserved for future use
    private config: IIIFViewerOptions;
    private abortController: AbortController;
    private cb: ViewerUICallbacks;

    /** Get the docks map */
    get docks(): Map<string, HTMLDivElement> {
        return this.panelManager.getDocks();
    }

    constructor(
        container: HTMLElement,
        panels: IIIFViewerPanels,
        config: IIIFViewerOptions,
        abortController: AbortController,
        cb: ViewerUICallbacks,
    ) {
        this.container = container;
        this.panels = panels;
        this.config = config;
        this.abortController = abortController;
        this.cb = cb;
        this.panelManager = new PanelManager(container, abortController);
    }

    /**
     * Private helper to add event listeners with automatic cleanup via AbortController.
     */
    private addEvent<K extends keyof HTMLElementEventMap>(
        element: Element | Document,
        type: K,
        handler: (event: HTMLElementEventMap[K]) => void,
        options?: { passive?: boolean }
    ): void {
        const listener = handler as EventListener;
        element.addEventListener(type, listener, { signal: this.abortController.signal, ...options });
    }

    // ============================================================
    // SETUP ALL
    // ============================================================

    /**
     * Set up all UI panels in the correct order (same order as IIIFViewer constructor).
     */
    setupAll(): void {
        // Create docks before any panels so dock assignments work
        this.setupDocks();

        if (this.panels.pages !== undefined) this.setupCanvasNav();
        if (this.panels.navigation !== undefined) this.setupTOC();
        this.setupNavigationPanel();
        if (this.panels.settings !== undefined) this.setupSettingsPanel();
        if (this.panels.annotations !== undefined) this.setupAnnotationPanel();
        if (this.panels.manifest !== undefined) this.setupManifestPanel();
        if (this.panels.gesture !== undefined && !this.cb.isMobileOrTablet()) this.setupCVPanel();
        if (this.panels.compare !== undefined) this.setupComparePanel();
    }

    // ============================================================
    // SETUP METHODS
    // ============================================================

    setupDocks(): void {
        this.panelManager.setupDocks();
    }

    private setupCanvasNav(): void {
        const { panel, body } = this.panelManager.createPanel({
            className: 'iiif-canvas-nav',
            title: 'Pages',
            initiallyCollapsed: this.panels.pages === 'hide' || this.panels.pages === 'show-closed',
            dock: 'bottom-left',
        });
        this.canvasNavContainer = panel;
        this.canvasNavList = body;
        this.canvasNavList.classList.add('iiif-canvas-nav-list');
    }

    private setupNavigationPanel(): void {
        const wrapper = document.createElement('div');
        wrapper.className = 'iiif-navigation-wrapper';

        const bar = document.createElement('div');
        bar.className = 'iiif-navigation-bar';

        const zoomIn = document.createElement('button');
        zoomIn.className = 'iiif-nav-zoom-btn';
        zoomIn.title = 'Zoom In';
        zoomIn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 13 13"><rect width="13" height="2.5" rx="1" y="5.25" fill="currentColor"/><rect width="13" height="2.5" rx="1" transform="translate(7.75 0) rotate(90)" fill="currentColor"/></svg>`;
        zoomIn.addEventListener('click', () => { this.cb.springZoomByFactor(1.5); this.cb.markDirty(); });

        const zoomOut = document.createElement('button');
        zoomOut.className = 'iiif-nav-zoom-btn';
        zoomOut.title = 'Zoom Out';
        zoomOut.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="10" height="2" viewBox="0 0 13 3"><rect width="13" height="2.5" rx="1" fill="currentColor"/></svg>`;
        zoomOut.addEventListener('click', () => { this.cb.springZoomByFactor(1 / 1.5); this.cb.markDirty(); });

        const resetBtn = document.createElement('button');
        resetBtn.className = 'iiif-nav-zoom-btn';
        resetBtn.title = 'Reset View';
        resetBtn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg>`;
        resetBtn.addEventListener('click', () => { this.cb.fitToWorld(); });

        bar.appendChild(zoomIn);
        bar.appendChild(zoomOut);
        bar.appendChild(resetBtn);

        const dragHandle = document.createElement('div');
        dragHandle.className = 'iiif-navigation-drag-handle';

        wrapper.appendChild(bar);
        wrapper.appendChild(dragHandle);

        this.panelManager.makePanelDraggable(wrapper, dragHandle);

        const dock = this.panelManager.getDocks().get('bottom-center');
        if (dock) {
            dock.appendChild(wrapper);
        } else {
            this.container.appendChild(wrapper);
        }
    }

    private setupTOC(): void {
        const { panel, body } = this.panelManager.createPanel({
            className: 'iiif-toc',
            title: 'Contents',
            initiallyCollapsed: this.panels.navigation === 'hide' || this.panels.navigation === 'show-closed',
            dock: 'top-right',
        });
        this.tocContainer = panel;
        this.tocList = body;
        this.tocList.classList.add('iiif-toc-list');
    }

    private setupManifestPanel(): void {
        const { body } = this.panelManager.createPanel({
            className: 'iiif-manifest-panel',
            title: 'Manifest',
            initiallyCollapsed: this.panels.manifest === 'hide' || this.panels.manifest === 'show-closed',
            dock: 'top-right',
        });
        this.metadataPanelBody = body;
    }

    private setupAnnotationPanel(): void {
        const { panel, body } = this.panelManager.createPanel({
            className: 'iiif-annotation-panel',
            title: 'Annotations',
            initiallyCollapsed: this.panels.annotations === 'hide' || this.panels.annotations === 'show-closed',
            dock: 'top-right',
        });
        this.annotationPanel = panel;
        this.annotationPanelBody = body;
    }

    private setupCVPanel(): void {
        const { panel, body } = this.panelManager.createPanel({
            className: 'iiif-cv-panel',
            title: 'Gesture',
            initiallyCollapsed: this.panels.gesture === 'hide' || this.panels.gesture === 'show-closed',
            dock: 'top-left',
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

        this.addEvent(this.cvGestureBtn!, 'click', () => {
            if (!this.cvController) return;
            this.cvController.gesturesEnabled = !this.cvController.gesturesEnabled;
            this.cvGestureBtn!.textContent = this.cvController.gesturesEnabled ? 'Gestures: ON' : 'Gestures: OFF';
            this.cvGestureBtn!.classList.toggle('active', this.cvController.gesturesEnabled);
        });

        this.addEvent(this.cvToggleBtn, 'click', async () => {
            if (this.cvController?.running) {
                this.cvController.stop();
                this.cvToggleBtn!.textContent = 'Start';
                this.cvToggleBtn!.classList.remove('active');
                this.cvGestureBtn!.style.display = 'none';
                return;
            }

            try {
                if (!this.cvController) {
                    const { CVController } = await import('../features/iiif-cv');
                    this.cvController = new CVController(this.cvVideo!, {
                        onStatusChange: (status: string) => {
                            if (this.cvStatusEl) this.cvStatusEl.textContent = status;
                        },
                        onPan: (dx: number, dy: number) => {
                            this.cb.springPan(dx / this.cb.getViewportScale(), dy / this.cb.getViewportScale());
                            this.cb.markDirty();
                        },
                        onZoom: (factor: number) => {
                            this.cb.springZoomByFactor(factor);
                            this.cb.markDirty();
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
    }

    private setupComparePanel(): void {
        const { panel, collapseBtn } = this.panelManager.createPanel({
            className: 'iiif-compare-panel',
            title: 'Compare',
            initiallyCollapsed: true, // Always collapsed — expanding enters compare mode
            dock: 'bottom-right',
        });
        this.comparePanel = panel;

        // Override collapse button: use capture phase so this fires BEFORE
        // the default handler from createPanel (which is in bubble phase).
        collapseBtn.addEventListener('click', (e) => {
            e.stopImmediatePropagation();
            if (this.cb.getComparisonController()) {
                // Toggle collapse state - don't exit compare mode
                const body = this.comparePanel!.querySelector('.iiif-panel-body');
                const isCollapsed = body?.classList.toggle('collapsed') ?? false;
                collapseBtn.textContent = isCollapsed ? '+' : '\u2212';
            } else {
                // Enter compare mode
                this.cb.enterCompareMode();
                collapseBtn.textContent = '\u2212';
                this.comparePanel!.classList.add('active');
                const body = this.comparePanel!.querySelector('.iiif-panel-body');
                body?.classList.remove('collapsed');
            }
        }, { capture: true, signal: this.abortController.signal });
    }

    private setupSettingsPanel(): void {
        // Create fullscreen button
        this.fullscreenBtn = document.createElement('button');
        this.fullscreenBtn.className = 'iiif-fullscreen-btn';
        this.fullscreenBtn.title = 'Toggle Fullscreen';
        this.fullscreenBtn.innerHTML = `
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3m0 18h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3"/>
            </svg>
        `;
        this.addEvent(this.fullscreenBtn, 'click', () => {
            if (!document.fullscreenElement) {
                this.container.requestFullscreen().catch(() => {});
                this.fullscreenBtn!.classList.add('active');
            } else {
                document.exitFullscreen();
                this.fullscreenBtn!.classList.remove('active');
            }
        });

        this.addEvent(document, 'fullscreenchange', () => {
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
        title.textContent = 'Settings';
        header.appendChild(title);

        const collapseBtn = document.createElement('button');
        collapseBtn.className = 'iiif-panel-collapse iiif-settings-panel-collapse';
        collapseBtn.textContent = '+';
        header.appendChild(collapseBtn);

        this.settingsPanel.appendChild(header);

        this.settingsPanelBody = document.createElement('div');
        this.settingsPanelBody.className = 'iiif-panel-body iiif-settings-panel-body collapsed';

        // Only show toggles for panels that are included
        const panelConfigs: { label: string; defaultVisible: boolean; containerClass: string }[] = [];
        if (this.panels.navigation !== undefined) panelConfigs.push({ label: 'Navigation', defaultVisible: this.panels.navigation !== 'hide', containerClass: 'hide-navigation' });
        if (this.panels.pages !== undefined) panelConfigs.push({ label: 'Pages', defaultVisible: this.panels.pages !== 'hide', containerClass: 'hide-pages' });
        if (this.panels.manifest !== undefined) panelConfigs.push({ label: 'Manifest', defaultVisible: this.panels.manifest !== 'hide', containerClass: 'hide-manifest' });
        if (this.panels.annotations !== undefined) panelConfigs.push({ label: 'Annotations', defaultVisible: this.panels.annotations !== 'hide', containerClass: 'hide-annotations' });
        if (this.panels.gesture !== undefined && !this.cb.isMobileOrTablet()) panelConfigs.push({ label: 'Gesture', defaultVisible: this.panels.gesture !== 'hide', containerClass: 'hide-vision' });
        if (this.panels.compare !== undefined) panelConfigs.push({ label: 'Compare', defaultVisible: this.panels.compare !== 'hide', containerClass: 'hide-compare' });

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
            this.settingsCheckboxes.set(config.containerClass, checkbox);

            // Apply initial state using container class
            if (!config.defaultVisible) {
                this.container.classList.add(config.containerClass);
            }

            this.addEvent(checkbox, 'change', () => {
                // Toggle container class for global effect
                if (checkbox.checked) {
                    this.container.classList.remove(config.containerClass);
                } else {
                    this.container.classList.add(config.containerClass);
                }
            });

            this.settingsPanelBody.appendChild(item);
        }

        // --- Divider ---
        const divider = document.createElement('div');
        divider.className = 'iiif-settings-divider';
        this.settingsPanelBody.appendChild(divider);

        // --- Background color picker ---
        const colorItem = document.createElement('label');
        colorItem.className = 'iiif-settings-panel-item iiif-settings-color-item';

        const colorLabel = document.createElement('span');
        colorLabel.textContent = 'Background';

        this.colorInput = document.createElement('input');
        this.colorInput.type = 'color';
        this.colorInput.className = 'iiif-settings-color-input';
        this.colorInput.value = '#1a1a1a';
        const colorInput = this.colorInput;

        this.addEvent(colorInput, 'input', () => {
            const hex = colorInput.value;
            const r = parseInt(hex.slice(1, 3), 16) / 255;
            const g = parseInt(hex.slice(3, 5), 16) / 255;
            const b = parseInt(hex.slice(5, 7), 16) / 255;
            const renderer = this.cb.getRenderer();
            if (renderer) {
                renderer.setClearColor(r, g, b);
            }
            // Also update compare instance viewers
            const comparisonController = this.cb.getComparisonController();
            if (comparisonController) {
                comparisonController.setBackgroundColor(r, g, b);
            }
        });

        colorItem.appendChild(colorLabel);
        colorItem.appendChild(colorInput);
        this.settingsPanelBody.appendChild(colorItem);

        this.settingsPanel.appendChild(this.settingsPanelBody);

        // --- Icon button row at bottom of panel ---
        const btnRow = document.createElement('div');
        btnRow.className = 'iiif-settings-btn-row';

        // Light/dark theme toggle (lightbulb icon)
        const themeBtn = document.createElement('button');
        themeBtn.className = 'iiif-settings-icon-btn';
        themeBtn.title = 'Toggle Light Theme';
        themeBtn.innerHTML = `
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M9 18h6"/>
                <path d="M10 22h4"/>
                <path d="M12 2a7 7 0 0 0-4 12.7V17h8v-2.3A7 7 0 0 0 12 2z"/>
            </svg>
        `;
        this.addEvent(themeBtn, 'click', () => {
            const isLight = this.container.classList.toggle('theme-light');
            themeBtn.classList.toggle('active', isLight);
        });

        // Fullscreen button
        this.fullscreenBtn.classList.add('iiif-settings-icon-btn');

        // Save layout button (download icon)
        const saveBtn = document.createElement('button');
        saveBtn.className = 'iiif-settings-icon-btn';
        saveBtn.title = 'Save Layout';
        saveBtn.innerHTML = `
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
                <polyline points="7 10 12 15 17 10"/>
                <line x1="12" y1="15" x2="12" y2="3"/>
            </svg>
        `;
        this.addEvent(saveBtn, 'click', () => {
            const state = this.cb.saveLayout();
            const json = JSON.stringify(state, null, 2);
            const blob = new Blob([json], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = 'layout.json';
            a.click();
            URL.revokeObjectURL(url);
        });

        // Load layout button (upload icon)
        const loadBtn = document.createElement('button');
        loadBtn.className = 'iiif-settings-icon-btn';
        loadBtn.title = 'Load Layout';
        loadBtn.innerHTML = `
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
                <polyline points="17 8 12 3 7 8"/>
                <line x1="12" y1="3" x2="12" y2="15"/>
            </svg>
        `;
        const fileInput = document.createElement('input');
        fileInput.type = 'file';
        fileInput.accept = '.json';
        fileInput.style.display = 'none';
        fileInput.addEventListener('change', () => {
            const file = fileInput.files?.[0];
            if (!file) return;
            const reader = new FileReader();
            reader.onload = () => {
                try {
                    const state = JSON.parse(reader.result as string) as LayoutState;
                    if (state.version !== 1) {
                        console.warn('Unknown layout version:', state.version);
                        return;
                    }
                    this.cb.loadLayout(state);
                } catch (err) {
                    console.error('Failed to parse layout file:', err);
                }
                fileInput.value = '';
            };
            reader.readAsText(file);
        });
        this.addEvent(loadBtn, 'click', () => {
            fileInput.click();
        });

        // Append: save + load on left, spacer, theme + fullscreen on right
        btnRow.appendChild(saveBtn);
        btnRow.appendChild(loadBtn);
        const btnSpacer = document.createElement('div');
        btnSpacer.style.flex = '1';
        btnRow.appendChild(btnSpacer);
        btnRow.appendChild(themeBtn);
        btnRow.appendChild(this.fullscreenBtn);

        this.settingsPanel.appendChild(btnRow);

        this.addEvent(collapseBtn, 'click', () => {
            this.settingsPanelBody!.classList.toggle('collapsed');
            collapseBtn.textContent = this.settingsPanelBody!.classList.contains('collapsed') ? '+' : '\u2212';
        });

        // Make settings panel draggable
        this.panelManager.makePanelDraggable(this.settingsPanel, header);

        // Settings panel in top-right dock
        this.panelManager.getDocks().get('top-right')!.appendChild(this.settingsPanel);
    }

    // ============================================================
    // UPDATE METHODS
    // ============================================================

    updateComparePanel(): void {
        if (!this.comparePanel) return;

        // Always show the compare panel — even single images can compare via URL input
        this.comparePanel.style.display = 'flex';

        // Auto-enter compare mode for 'show' option
        if (this.panels.compare === 'show' && !this.cb.getComparisonController() && this.cb.getCurrentLoadedUrl()) {
            this.cb.enterCompareMode();
            const body = this.comparePanel.querySelector('.iiif-panel-body');
            body?.classList.remove('collapsed');
            const collapseBtn = this.comparePanel.querySelector('.iiif-compare-panel-collapse');
            if (collapseBtn) collapseBtn.textContent = '\u2212';
        }
    }

    updateAnnotationPanel(): void {
        const annotationManager = this.cb.getAnnotationManager();
        if (!this.annotationPanelBody || !annotationManager) return;

        this.annotationPanelBody.innerHTML = '';
        const pages = annotationManager.getAnnotationPages();
        const customGroups = annotationManager.getCustomAnnotationGroups();

        // Always show the panel; display "None" when empty
        if (this.annotationPanel) this.annotationPanel.style.display = 'flex';

        if (pages.length === 0 && customGroups.length === 0) {
            const none = document.createElement('div');
            none.className = 'iiif-panel-empty';
            none.textContent = 'None';
            this.annotationPanelBody.appendChild(none);
            return;
        }

        // --- IIIF annotation pages ---
        for (const page of pages) {
            const item = document.createElement('div');
            item.className = 'iiif-annotation-panel-item';

            const label = document.createElement('div');
            label.className = 'iiif-annotation-panel-item-label';

            // Color swatch from the page's dominant motivation
            const firstAnn = annotationManager.getAllIIIFAnnotations()
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
            eyeBtn.innerHTML = EYE_SVG;
            eyeBtn.title = 'Toggle visibility';
            eyeBtn.addEventListener('click', () => {
                const newVisible = !page.visible;
                annotationManager.setPageVisible(page.pageId, newVisible);
                eyeBtn.classList.toggle('active', newVisible);
            });
            item.appendChild(eyeBtn);

            this.annotationPanelBody.appendChild(item);
        }

        // --- Custom annotation type groups (filtered by current canvas) ---
        // Build set of annotation IDs valid for the current canvas
        // When there's no manifest (single image), skip targetPage filtering
        const manifest = this.cb.getManifest();
        const currentCanvasIndex = this.cb.getCurrentCanvasIndex();
        const customAnnotationSpecs = this.cb.getCustomAnnotationSpecs();

        const hasPages = manifest !== undefined;
        const idsForCurrentCanvas = new Set<string>();
        for (const spec of customAnnotationSpecs) {
            const id = spec.options?.id;
            if (!id) continue;
            if (hasPages && spec.targetPage !== undefined && spec.targetPage !== currentCanvasIndex) continue;
            idsForCurrentCanvas.add(id);
        }

        for (const group of customGroups) {
            const filteredIds = group.ids.filter(id => idsForCurrentCanvas.has(id));
            if (filteredIds.length === 0) continue;

            const item = document.createElement('div');
            item.className = 'iiif-annotation-panel-item';

            const label = document.createElement('div');
            label.className = 'iiif-annotation-panel-item-label';

            const swatch = document.createElement('span');
            swatch.className = 'iiif-annotation-panel-swatch';
            swatch.style.display = 'inline-block';
            swatch.style.width = '8px';
            swatch.style.height = '8px';
            swatch.style.borderRadius = '50%';
            swatch.style.backgroundColor = group.color;
            swatch.style.marginRight = '6px';
            swatch.style.flexShrink = '0';
            label.appendChild(swatch);

            label.appendChild(document.createTextNode(`${group.type} (${filteredIds.length})`));
            item.appendChild(label);

            const eyeBtn = document.createElement('button');
            eyeBtn.className = 'iiif-eye-btn iiif-annotation-panel-eye';
            if (group.visible) eyeBtn.classList.add('active');
            eyeBtn.innerHTML = EYE_SVG;
            eyeBtn.title = 'Toggle visibility';
            eyeBtn.addEventListener('click', () => {
                group.visible = !group.visible;
                if (group.visible) {
                    this.cb.setHiddenAnnotationType(group.type, false);
                } else {
                    this.cb.setHiddenAnnotationType(group.type, true);
                }
                annotationManager.setCustomTypeVisible(group.type, group.visible);
                eyeBtn.classList.toggle('active', group.visible);
            });
            item.appendChild(eyeBtn);

            this.annotationPanelBody.appendChild(item);
        }

        // Show "None" if no annotations are visible for this canvas
        if (this.annotationPanelBody.children.length === 0) {
            const none = document.createElement('div');
            none.className = 'iiif-panel-empty';
            none.textContent = 'None';
            this.annotationPanelBody.appendChild(none);
        }
    }

    updateCanvasNav(): void {
        if (!this.canvasNavContainer || !this.canvasNavList) return;

        const manifest = this.cb.getManifest();
        if (!manifest || manifest.canvases.length <= 1) {
            this.canvasNavContainer.style.display = 'none';
            return;
        }

        this.canvasNavContainer.style.display = 'flex';
        this.canvasNavList.innerHTML = '';

        for (let i = 0; i < manifest.canvases.length; i++) {
            const canvas = manifest.canvases[i];
            const item = this.createCanvasNavItem(canvas, i);
            this.canvasNavList.appendChild(item);
        }
    }

    private createCanvasNavItem(canvas: ParsedCanvas, index: number): HTMLElement {
        const currentCanvasIndex = this.cb.getCurrentCanvasIndex();

        const item = document.createElement('div');
        item.className = 'iiif-canvas-nav-item';
        if (index === currentCanvasIndex) {
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
            this.cb.loadCanvas(index);
        });

        return item;
    }

    updateCanvasNavActiveState(): void {
        if (!this.canvasNavList) return;
        const currentCanvasIndex = this.cb.getCurrentCanvasIndex();
        const items = this.canvasNavList.querySelectorAll('.iiif-canvas-nav-item');
        items.forEach((item, i) => {
            item.classList.toggle('active', i === currentCanvasIndex);
        });
    }

    updateTOC(): void {
        if (!this.tocContainer || !this.tocList) return;

        const manifest = this.cb.getManifest();
        const ranges = manifest?.ranges;
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
                this.cb.loadCanvas(firstCanvasIndex);
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
        const canvasIdToIndex = this.cb.getCanvasIdToIndex();
        // Check direct canvas refs first
        for (const canvasId of range.canvasIds) {
            const index = canvasIdToIndex.get(canvasId);
            if (index !== undefined) return index;
        }
        // Recurse into children
        for (const child of range.children) {
            const index = this.findFirstCanvasIndex(child);
            if (index !== undefined) return index;
        }
        return undefined;
    }

    updateManifestPanel(): void {
        if (!this.metadataPanelBody) return;
        this.metadataPanelBody.innerHTML = '';

        const manifest = this.cb.getManifest();
        const meta = manifest?.metadata;
        if (!meta) {
            const none = document.createElement('div');
            none.className = 'iiif-panel-empty';
            none.textContent = 'None';
            this.metadataPanelBody.appendChild(none);
            return;
        }

        if (manifest?.label) {
            this.appendManifestField('Title', manifest.label);
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

    private appendManifestField(label: string, value: string): void {
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

    private appendManifestFieldElement(label: string, element: HTMLElement): void {
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

    /** Show/hide custom annotations based on targetPage matching current canvas */
    updateCustomAnnotationVisibility(): void {
        const overlayManager = this.cb.getOverlayManager();
        if (!overlayManager) return;
        const manifest = this.cb.getManifest();
        const currentCanvasIndex = this.cb.getCurrentCanvasIndex();
        const customAnnotationSpecs = this.cb.getCustomAnnotationSpecs();
        const hiddenAnnotationTypes = this.cb.getHiddenAnnotationTypes();

        const hasPages = manifest !== undefined;
        for (const spec of customAnnotationSpecs) {
            const id = spec.options?.id;
            if (!id) continue;
            const overlay = overlayManager.getOverlay(id);
            if (!overlay) continue;

            // Hidden if on wrong page OR user toggled the type off
            // Skip page check when there's no manifest (single image)
            const wrongPage = hasPages && spec.targetPage !== undefined && spec.targetPage !== currentCanvasIndex;
            const typeHidden = hiddenAnnotationTypes.has(spec.options?.type || 'Custom');
            overlay.hidden = wrongPage || typeHidden;
            overlayManager.updateOverlay(id);
        }
    }
}
