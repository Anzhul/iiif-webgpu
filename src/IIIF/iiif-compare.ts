import { IIIFViewer } from './iiif';
import type { IIIFViewerOptions } from './iiif';

export interface CompareEntry {
    url: string;
    canvasIndex?: number;
    label: string;
}

export interface CompareOptions {
    viewerOptions?: IIIFViewerOptions;
    manifestUrl: string;
    canvases: Array<{ label: string; index: number; thumbnailServiceUrl?: string }>;
    currentCanvasIndex: number;
    onExit?: () => void;
    onSuspendParent?: () => void;
    onResumeParent?: () => void;
    savedEntries?: CompareEntry[];
    /** External panel element to populate with canvas list (instead of creating a new one) */
    listPanel?: HTMLDivElement;
}

const EYE_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>`;

// ============================================================
// VIEWER ENVIRONMENT
// ============================================================

class ViewerEnvironment {
    readonly container: HTMLDivElement;
    readonly viewer: IIIFViewer;

    constructor(parent: HTMLElement, label: string, viewerOptions: IIIFViewerOptions) {
        this.container = document.createElement('div');
        this.container.className = 'iiif-compare-environment';

        const header = document.createElement('div');
        header.className = 'iiif-compare-environment-header';
        header.textContent = label;
        this.container.appendChild(header);

        const viewerContainer = document.createElement('div');
        viewerContainer.className = 'iiif-compare-environment-viewer';
        this.container.appendChild(viewerContainer);

        parent.appendChild(this.container);

        this.viewer = new IIIFViewer(viewerContainer, viewerOptions);
        this.viewer.listen();
        this.viewer.startRenderLoop();
    }

    destroy(): void {
        this.viewer.destroy();
        this.container.remove();
    }
}

// ============================================================
// COMPARISON CONTROLLER
// ============================================================

export class ComparisonController {
    readonly container: HTMLElement;

    private entries: CompareEntry[] = [];
    private visibleIndices: number[] = [];
    private readonly MAX_VISIBLE = 4;
    private initialEntryIndex: number = 0;

    // Environment mode state
    private environments: Map<number, ViewerEnvironment> = new Map();
    private inEnvironmentMode: boolean = false;
    private wrapper?: HTMLDivElement;
    private viewersContainer?: HTMLDivElement;

    // Always-present DOM
    private listPanel!: HTMLDivElement;
    private listBody!: HTMLDivElement;
    private addInput!: HTMLInputElement;

    private options: CompareOptions;
    private abortController = new AbortController();
    private updateGeneration = 0;

    constructor(container: HTMLElement, options: CompareOptions) {
        this.container = container;
        this.options = options;

        // Populate entries from manifest canvases
        for (const canvas of options.canvases) {
            this.entries.push({
                url: options.manifestUrl,
                canvasIndex: canvas.index,
                label: canvas.label,
            });
        }

        // Restore saved entries from previous session
        if (options.savedEntries) {
            for (const entry of options.savedEntries) {
                this.entries.push(entry);
            }
        }

        // Set current canvas as initially visible
        const currentIdx = this.entries.findIndex(
            e => e.canvasIndex === options.currentCanvasIndex
        );
        this.initialEntryIndex = currentIdx !== -1 ? currentIdx : 0;
        this.visibleIndices = [this.initialEntryIndex];

        // Use external panel - always required
        if (!options.listPanel) {
            throw new Error('ComparisonController requires listPanel to be provided');
        }
        this.listPanel = options.listPanel;
        this.populateExternalPanel();

        // Only enter environment mode if we have 2+ visible entries
        // Otherwise stay in single-parent mode (keep original viewer)
        this.updateViewers();
    }

    // ============================================================
    // PUBLIC API
    // ============================================================

    destroy(): void {
        this.abortController.abort();
        if (this.inEnvironmentMode) {
            for (const [, env] of this.environments) {
                env.destroy();
            }
            this.environments.clear();
            this.wrapper?.remove();
        }
        // Clear the body and add section from the external panel
        this.listBody?.remove();
        const addSection = this.listPanel?.querySelector('.iiif-canvas-list-add');
        addSection?.remove();
    }

    /** Returns entries that were manually added via URL input (not the initial canvas entries) */
    getAddedEntries(): CompareEntry[] {
        return this.entries.slice(this.options.canvases.length);
    }

    // ============================================================
    // ENTRY MANAGEMENT
    // ============================================================

    private toggleEntry(index: number): void {
        const pos = this.visibleIndices.indexOf(index);
        if (pos !== -1) {
            // Turning off — don't allow removing last visible
            if (this.visibleIndices.length <= 1) return;
            this.visibleIndices.splice(pos, 1);
        } else {
            // Turning on — reject if at max capacity
            if (this.visibleIndices.length >= this.MAX_VISIBLE) return;
            this.visibleIndices.push(index);
        }
        this.updateListState();
        this.updateViewers();
    }

    private addEntry(url: string): void {
        const label = this.shortenUrl(url);
        this.entries.push({ url, label });

        const item = this.createListItem(this.entries.length - 1);
        this.listBody.appendChild(item);

        // Auto-show if under limit
        if (this.visibleIndices.length < this.MAX_VISIBLE) {
            this.toggleEntry(this.entries.length - 1);
        }
    }

    private shortenUrl(url: string): string {
        try {
            const u = new URL(url);
            const parts = u.pathname.split('/').filter(Boolean);
            const last = parts[parts.length - 1] || '';
            const short = `${u.hostname}/${last}`;
            return short.length > 30 ? short.slice(0, 27) + '...' : short;
        } catch {
            return url.length > 30 ? url.slice(0, 27) + '...' : url;
        }
    }

    // ============================================================
    // MODE TRANSITIONS
    // ============================================================

    /** True when only 1 entry is visible - use parent viewer instead of creating new ones */
    private get isSingleParentMode(): boolean {
        return this.visibleIndices.length <= 1;
    }

    private enterEnvironmentMode(): void {
        if (this.inEnvironmentMode) return;
        this.inEnvironmentMode = true;

        // Suspend parent viewer
        this.options.onSuspendParent?.();

        // Create wrapper for environments (list panel stays floating above)
        this.wrapper = document.createElement('div');
        this.wrapper.className = 'iiif-compare-wrapper';

        this.viewersContainer = document.createElement('div');
        this.viewersContainer.className = 'iiif-compare-viewers';
        this.wrapper.appendChild(this.viewersContainer);

        this.container.appendChild(this.wrapper);
    }

    private exitEnvironmentMode(): void {
        if (!this.inEnvironmentMode) return;

        // Destroy all environments
        for (const [, env] of this.environments) {
            env.destroy();
        }
        this.environments.clear();

        // Remove wrapper (list panel stays in container)
        this.wrapper?.remove();
        this.wrapper = undefined;
        this.viewersContainer = undefined;

        // Resume parent viewer
        this.options.onResumeParent?.();
        this.inEnvironmentMode = false;
    }

    // ============================================================
    // VIEWER UPDATES
    // ============================================================

    private async updateViewers(): Promise<void> {
        const gen = ++this.updateGeneration;

        if (this.isSingleParentMode) {
            // Transition back to single-parent mode if needed
            if (this.inEnvironmentMode) {
                this.exitEnvironmentMode();
            }
            return;
        }

        // Need environment mode
        if (!this.inEnvironmentMode) {
            this.enterEnvironmentMode();
        }

        // Destroy environments that are no longer visible
        for (const [idx, env] of this.environments) {
            if (!this.visibleIndices.includes(idx)) {
                env.destroy();
                this.environments.delete(idx);
            }
        }

        // Create environments for newly visible entries
        for (const idx of this.visibleIndices) {
            if (this.environments.has(idx)) continue;

            const entry = this.entries[idx];
            const env = new ViewerEnvironment(
                this.viewersContainer!,
                entry.label,
                { ...this.options.viewerOptions }
            );
            this.environments.set(idx, env);

            if (gen !== this.updateGeneration) return;
            try {
                await env.viewer.loadUrl(entry.url, true);
                if (gen !== this.updateGeneration) return;
                if (entry.canvasIndex !== undefined && entry.canvasIndex > 0) {
                    await env.viewer.loadCanvas(entry.canvasIndex, true);
                }
            } catch (err) {
                if (gen !== this.updateGeneration) return;
                console.warn('Failed to load entry:', err);
            }
        }

        // Reorder DOM to match visibleIndices order
        for (const idx of this.visibleIndices) {
            const env = this.environments.get(idx);
            if (env) {
                this.viewersContainer!.appendChild(env.container);
            }
        }
    }

    // ============================================================
    // DOM CONSTRUCTION
    // ============================================================

    /** Populate an external panel (provided by parent) with body and add section */
    private populateExternalPanel(): void {
        // Body (scrollable list of entries)
        this.listBody = document.createElement('div');
        this.listBody.className = 'iiif-panel-body iiif-canvas-list-body';

        for (let i = 0; i < this.entries.length; i++) {
            const item = this.createListItem(i);
            this.listBody.appendChild(item);
        }

        this.listPanel.appendChild(this.listBody);

        // Add URL section
        const addSection = document.createElement('div');
        addSection.className = 'iiif-canvas-list-add';

        this.addInput = document.createElement('input');
        this.addInput.type = 'text';
        this.addInput.placeholder = 'Add IIIF URL...';
        this.addInput.className = 'iiif-canvas-list-add-input';
        this.addInput.addEventListener('mousedown', (e) => {
            e.stopPropagation();
        }, { signal: this.abortController.signal });
        addSection.appendChild(this.addInput);

        const addBtn = document.createElement('button');
        addBtn.className = 'iiif-canvas-list-add-btn';
        addBtn.textContent = '+';
        addBtn.title = 'Add URL';
        addBtn.addEventListener('click', () => {
            const url = this.addInput.value.trim();
            if (url) {
                this.addEntry(url);
                this.addInput.value = '';
            }
        }, { signal: this.abortController.signal });
        addSection.appendChild(addBtn);

        this.addInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                const url = this.addInput.value.trim();
                if (url) {
                    this.addEntry(url);
                    this.addInput.value = '';
                }
            }
        }, { signal: this.abortController.signal });

        // Ensure input can receive focus by handling click on the section
        addSection.addEventListener('click', (e) => {
            if (e.target === addSection) {
                this.addInput.focus();
            }
        }, { signal: this.abortController.signal });

        this.listPanel.appendChild(addSection);
    }

    private createListItem(index: number): HTMLDivElement {
        const entry = this.entries[index];
        const item = document.createElement('div');
        item.className = 'iiif-canvas-list-item';

        const info = document.createElement('div');
        info.className = 'iiif-canvas-list-item-info';

        const labelEl = document.createElement('div');
        labelEl.className = 'iiif-canvas-list-item-label';
        labelEl.textContent = entry.label;
        labelEl.title = entry.canvasIndex !== undefined
            ? `Canvas ${entry.canvasIndex + 1}`
            : entry.url;
        info.appendChild(labelEl);

        item.appendChild(info);

        // Eye toggle button
        const eyeBtn = document.createElement('button');
        eyeBtn.className = 'iiif-eye-btn iiif-canvas-list-eye';
        if (this.visibleIndices.includes(index)) {
            eyeBtn.classList.add('active');
        }
        eyeBtn.innerHTML = EYE_SVG;
        eyeBtn.title = 'Toggle visibility';
        eyeBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            this.toggleEntry(index);
        }, { signal: this.abortController.signal });
        item.appendChild(eyeBtn);

        return item;
    }

    private updateListState(): void {
        const eyeBtns = this.listBody.querySelectorAll('.iiif-canvas-list-eye');
        const atCapacity = this.visibleIndices.length >= this.MAX_VISIBLE;

        eyeBtns.forEach((eyeBtn, i) => {
            const isVisible = this.visibleIndices.includes(i);
            eyeBtn.classList.toggle('active', isVisible);
            eyeBtn.classList.toggle('disabled', atCapacity && !isVisible);
        });
    }
}
