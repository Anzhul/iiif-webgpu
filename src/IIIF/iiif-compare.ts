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
    /** Universal panels to reparent into the comparison wrapper when in environment mode */
    universalPanels?: { element: HTMLElement; dockPosition: string | null }[];
}

const EYE_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>`;
const PEN_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.85 2.85 0 0 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/><path d="m15 5 4 4"/></svg>`;

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
    private wrapperDocks: Map<string, HTMLDivElement> = new Map();
    private savedPanelPositions: Map<HTMLElement, { parent: HTMLElement; nextSibling: Node | null }> = new Map();

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
            // Restore universal panels before removing wrapper
            this.restoreUniversalPanels();
            this.wrapperDocks.clear();

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
    // UNIVERSAL PANEL REPARENTING
    // ============================================================

    /** Create dock containers inside the comparison wrapper */
    private setupWrapperDocks(): void {
        if (!this.wrapper) return;
        const positions = ['top-right', 'top-left', 'bottom-right', 'bottom-left', 'top-center', 'bottom-center'];
        for (const pos of positions) {
            const dock = document.createElement('div');
            dock.className = `iiif-dock iiif-dock-${pos}`;
            this.wrapper.appendChild(dock);
            this.wrapperDocks.set(pos, dock);
        }
    }

    /**
     * Phase 1: Save original positions and move all panels to wrapper docks.
     * Called immediately in enterEnvironmentMode so panels stay visible.
     */
    private reparentUniversalPanels(): void {
        for (const { element, dockPosition } of this.options.universalPanels ?? []) {
            if (!this.savedPanelPositions.has(element)) {
                this.savedPanelPositions.set(element, {
                    parent: element.parentElement!,
                    nextSibling: element.nextSibling,
                });
            }

            if (dockPosition) {
                const dock = this.wrapperDocks.get(dockPosition);
                if (dock) dock.appendChild(element);
            } else {
                // Floating panel — append directly to wrapper, keep position
                this.wrapper!.appendChild(element);
            }
        }
    }

    /**
     * Phase 2: Move left/right-docked panels into instance docks.
     * - Floating: stays in wrapper (no change)
     * - Center docks: stays in wrapper center dock (no change)
     * - Left docks: moves to leftmost instance's corresponding dock
     * - Right docks: moves to rightmost instance's corresponding dock
     *
     * Called after environments are created/reordered in updateViewers().
     */
    private repositionUniversalPanels(): void {
        const orderedEnvs = this.visibleIndices
            .map(idx => this.environments.get(idx))
            .filter((e): e is ViewerEnvironment => e !== undefined);

        if (orderedEnvs.length === 0) return;

        const leftmost = orderedEnvs[0].container;
        const rightmost = orderedEnvs[orderedEnvs.length - 1].container;

        for (const { element, dockPosition } of this.options.universalPanels ?? []) {
            if (!dockPosition || dockPosition.includes('center')) continue;

            if (dockPosition.includes('left')) {
                const dock = leftmost.querySelector(`.iiif-dock-${dockPosition}`) as HTMLElement | null;
                if (dock) dock.appendChild(element);
            } else if (dockPosition.includes('right')) {
                const dock = rightmost.querySelector(`.iiif-dock-${dockPosition}`) as HTMLElement | null;
                if (dock) dock.appendChild(element);
            }
        }
    }

    /** Restore universal panels to their original positions in the main docks */
    private restoreUniversalPanels(): void {
        for (const [element, { parent, nextSibling }] of this.savedPanelPositions) {
            if (nextSibling && nextSibling.parentNode === parent) {
                parent.insertBefore(element, nextSibling);
            } else {
                parent.appendChild(element);
            }
        }
        this.savedPanelPositions.clear();
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

        // Suspend parent viewer (hides main docks)
        this.options.onSuspendParent?.();

        // Create wrapper for environments
        this.wrapper = document.createElement('div');
        this.wrapper.className = 'iiif-compare-wrapper';

        this.viewersContainer = document.createElement('div');
        this.viewersContainer.className = 'iiif-compare-viewers';
        this.wrapper.appendChild(this.viewersContainer);

        this.container.appendChild(this.wrapper);

        // Create docks in wrapper and move universal panels into them
        this.setupWrapperDocks();
        this.reparentUniversalPanels();
    }

    private exitEnvironmentMode(): void {
        if (!this.inEnvironmentMode) return;

        // Restore universal panels to main docks before removing wrapper
        this.restoreUniversalPanels();
        this.wrapperDocks.clear();

        // Destroy all environments
        for (const [, env] of this.environments) {
            env.destroy();
        }
        this.environments.clear();

        // Remove wrapper
        this.wrapper?.remove();
        this.wrapper = undefined;
        this.viewersContainer = undefined;

        // Resume parent viewer (shows main docks)
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
                // Rescue universal panels before destroying the environment
                for (const { element } of this.options.universalPanels ?? []) {
                    if (env.container.contains(element)) {
                        this.wrapper!.appendChild(element);
                    }
                }
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

        // Move left/right-docked universal panels to instance docks
        this.repositionUniversalPanels();
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
        item.dataset.index = String(index);

        // Make the item itself draggable (outside of buttons)
        item.addEventListener('mousedown', (e) => {
            // Don't drag if clicking on buttons or inputs
            if ((e.target as HTMLElement).closest('button, input')) return;
            e.preventDefault();
            e.stopPropagation();
            this.startDrag(item, index, e.clientY);
        }, { signal: this.abortController.signal });

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

        // Rename button
        const renameBtn = document.createElement('button');
        renameBtn.className = 'iiif-eye-btn iiif-canvas-list-rename';
        renameBtn.innerHTML = PEN_SVG;
        renameBtn.title = 'Rename';
        renameBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            this.startRename(item, index);
        }, { signal: this.abortController.signal });
        item.appendChild(renameBtn);

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

    // ============================================================
    // INLINE RENAME
    // ============================================================

    private startRename(item: HTMLDivElement, index: number): void {
        const labelEl = item.querySelector('.iiif-canvas-list-item-label') as HTMLElement;
        if (!labelEl || item.querySelector('.iiif-canvas-list-rename-input')) return;

        const entry = this.entries[index];
        const originalText = entry.label;

        // Replace label with input
        const input = document.createElement('input');
        input.type = 'text';
        input.className = 'iiif-canvas-list-rename-input';
        input.value = originalText;

        labelEl.style.display = 'none';
        labelEl.parentElement!.appendChild(input);
        input.focus();
        input.select();

        // Prevent panel drag while editing
        input.addEventListener('mousedown', (e) => e.stopPropagation());

        const commit = () => {
            const newLabel = input.value.trim() || originalText;
            entry.label = newLabel;
            labelEl.textContent = newLabel;
            labelEl.style.display = '';
            input.remove();

            // Update environment header if visible
            const env = this.environments.get(index);
            if (env) {
                const header = env.container.querySelector('.iiif-compare-environment-header');
                if (header) header.textContent = newLabel;
            }
        };

        input.addEventListener('blur', commit, { once: true });
        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') { input.blur(); }
            if (e.key === 'Escape') { input.value = originalText; input.blur(); }
        });
    }

    // ============================================================
    // DRAG REORDER
    // ============================================================

    private startDrag(item: HTMLDivElement, index: number, startY: number): void {
        const itemRect = item.getBoundingClientRect();

        // Create placeholder
        const placeholder = document.createElement('div');
        placeholder.className = 'iiif-canvas-list-drag-placeholder';
        placeholder.style.height = `${itemRect.height}px`;

        // Float the item
        item.classList.add('dragging');
        item.style.position = 'fixed';
        item.style.width = `${itemRect.width}px`;
        item.style.left = `${itemRect.left}px`;
        item.style.top = `${itemRect.top}px`;
        item.style.zIndex = '9999';

        // Insert placeholder where item was
        this.listBody.insertBefore(placeholder, item);
        document.body.appendChild(item);

        let currentIndex = index;
        const offsetY = startY - itemRect.top;

        const onMouseMove = (e: MouseEvent) => {
            item.style.top = `${e.clientY - offsetY}px`;

            // Find drop position
            const siblings = Array.from(this.listBody.children).filter(
                c => c !== placeholder
            ) as HTMLDivElement[];

            let newIndex = siblings.length;
            for (let i = 0; i < siblings.length; i++) {
                const rect = siblings[i].getBoundingClientRect();
                if (e.clientY < rect.top + rect.height / 2) {
                    newIndex = i;
                    break;
                }
            }

            if (newIndex !== currentIndex) {
                // Move placeholder
                if (newIndex >= siblings.length) {
                    this.listBody.appendChild(placeholder);
                } else {
                    this.listBody.insertBefore(placeholder, siblings[newIndex]);
                }
                currentIndex = newIndex;
            }
        };

        const onMouseUp = () => {
            document.removeEventListener('mousemove', onMouseMove);
            document.removeEventListener('mouseup', onMouseUp);

            // Put item back in list at placeholder position
            item.classList.remove('dragging');
            item.style.position = '';
            item.style.width = '';
            item.style.left = '';
            item.style.top = '';
            item.style.zIndex = '';
            this.listBody.insertBefore(item, placeholder);
            placeholder.remove();

            // Apply reorder if changed
            if (currentIndex !== index) {
                this.reorderEntry(index, currentIndex);
            }
        };

        document.addEventListener('mousemove', onMouseMove);
        document.addEventListener('mouseup', onMouseUp);
    }

    private reorderEntry(fromIndex: number, toIndex: number): void {
        // Move entry in data array
        const [entry] = this.entries.splice(fromIndex, 1);
        this.entries.splice(toIndex, 0, entry);

        // Remap visible indices
        this.visibleIndices = this.visibleIndices.map(vi => {
            if (vi === fromIndex) return toIndex;
            if (fromIndex < toIndex) {
                // Moved down: items between shift up
                if (vi > fromIndex && vi <= toIndex) return vi - 1;
            } else {
                // Moved up: items between shift down
                if (vi >= toIndex && vi < fromIndex) return vi + 1;
            }
            return vi;
        });

        // Rebuild list to sync data-index attributes and event handlers
        this.rebuildList();
        this.updateViewers();
    }

    private rebuildList(): void {
        // Clear existing items
        while (this.listBody.firstChild) {
            this.listBody.removeChild(this.listBody.firstChild);
        }

        // Recreate all items with correct indices
        for (let i = 0; i < this.entries.length; i++) {
            const item = this.createListItem(i);
            this.listBody.appendChild(item);
        }

        this.updateListState();
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
