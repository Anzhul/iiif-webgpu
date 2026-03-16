
interface ToolbarOptions {
    zoom?: boolean;
    reset?: boolean;
    position?: 'top-right' | 'top-left' | 'bottom-right' | 'bottom-left' | 'bottom-center';
    theme?: 'dark' | 'light';
    variant?: string;
    customStyles?: Partial<CSSStyleDeclaration>;
}

export class ToolBar {
    container: HTMLElement;
    toolbar: HTMLDivElement | undefined;
    zoomInButton: HTMLButtonElement | undefined;
    zoomOutButton: HTMLButtonElement | undefined;
    resetButton: HTMLButtonElement | undefined;
    private options: ToolbarOptions;
    private stylesInjected = false;
    private btnGroup: HTMLDivElement | undefined;

    constructor(container: HTMLElement, options: ToolbarOptions = {}) {
        this.container = container;
        this.options = options;

        this.injectStyles();
        this.createToolbar();

        if (this.options.zoom) {
            this.enableZoom();
        }
        if (this.options.reset) {
            this.enableReset();
        }
    }

    private injectStyles(): void {
        if (this.stylesInjected || document.getElementById('iiif-styles')) {
            return;
        }

        // Inject consolidated IIIF styles
        const link = document.createElement('link');
        link.id = 'iiif-styles';
        link.rel = 'stylesheet';
        link.href = new URL('./iiif-styles.css', import.meta.url).href;
        document.head.appendChild(link);

        this.stylesInjected = true;
    }

    private createToolbar(): void {
        this.toolbar = document.createElement('div');
        this.toolbar.className = this.getToolbarClasses();
        if (this.options.customStyles) {
            Object.assign(this.toolbar.style, this.options.customStyles);
        }
        this.container.appendChild(this.toolbar);

        this.btnGroup = document.createElement('div');
        this.btnGroup.className = 'iiif-toolbar-btn-group';
        this.toolbar.appendChild(this.btnGroup);
    }

    private getToolbarClasses(): string {
        const classes = ['iiif-toolbar'];

        if (this.options.variant) {
            classes.push(`iiif-${this.options.variant}-toolbar`);
        }

        if (this.options.position && this.options.position !== 'top-right') {
            classes.push(`position-${this.options.position}`);
        }

        if (this.options.theme) {
            classes.push(`theme-${this.options.theme}`);
        }

        return classes.join(' ');
    }
    display(): void {
        if (this.toolbar) {
            this.toolbar.classList.remove('hidden');
        }
    }

    hide(): void {
        if (this.toolbar) {
            this.toolbar.classList.add('hidden');
        }
    }

    enableZoom() {
        this.zoomInButton = document.createElement('button');
        this.zoomInButton.className = "iiif-toolbar-button iiif-toolbar-button-zoom-in";
        this.zoomInButton.id = "zoom-in";
        this.zoomInButton.title = "Zoom In";

        // Add SVG as inline HTML
        this.zoomInButton.innerHTML = `
            <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 13 13" transform="scale(0.8)">
                <g id="zoom_in" transform="translate(-24 -14)">
                    <rect id="Rectangle_33" data-name="Rectangle 33" width="13" height="3" rx="1" transform="translate(24 19)" fill="currentColor"/>
                    <rect id="Rectangle_43" data-name="Rectangle 43" width="13" height="3" rx="1" transform="translate(32 14) rotate(90)" fill="currentColor"/>
                </g>
            </svg>
        `;

        this.btnGroup?.appendChild(this.zoomInButton);
        this.zoomOutButton = document.createElement('button');
        this.zoomOutButton.className = "iiif-toolbar-button iiif-toolbar-button-zoom-out";
        this.zoomOutButton.id = "zoom-out";
        this.zoomOutButton.title = "Zoom Out";

        // Add SVG as inline HTML
        this.zoomOutButton.innerHTML = `
            <svg xmlns="http://www.w3.org/2000/svg" width="15" height="3" viewBox="0 0 15 3" transform="scale(0.8)">
                <rect id="zoom-out" width="15" height="3" rx="1" fill="currentColor"/>
            </svg>
        `;

        this.btnGroup?.appendChild(this.zoomOutButton);
    }

    enableReset() {
        this.resetButton = document.createElement('button');
        this.resetButton.className = "iiif-toolbar-button iiif-toolbar-button-reset";
        this.resetButton.id = "reset-view";
        this.resetButton.title = "Reset View";

        // Reset/home icon SVG
        this.resetButton.innerHTML = `
            <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>
                <polyline points="9 22 9 12 15 12 15 22"/>
            </svg>
        `;

        this.btnGroup?.appendChild(this.resetButton);
    }
}
