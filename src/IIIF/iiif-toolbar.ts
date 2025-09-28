
interface ToolbarOptions {
    position?: 'top-right' | 'top-left' | 'bottom-right' | 'bottom-left';
    theme?: 'dark' | 'light';
    customStyles?: Partial<CSSStyleDeclaration>;
}

export class ToolBar {
    container: HTMLElement;
    toolbar: HTMLDivElement | undefined;
    private options: ToolbarOptions;
    private stylesInjected = false;

    constructor(container: HTMLElement, options: ToolbarOptions = {}) {
        this.container = container;
        this.options = { position: 'top-right', theme: 'dark', ...options };

        this.injectStyles();
        this.createToolbar();
    }

    private injectStyles(): void {
        if (this.stylesInjected || document.getElementById('iiif-toolbar-styles')) {
            return;
        }

        const link = document.createElement('link');
        link.id = 'iiif-toolbar-styles';
        link.rel = 'stylesheet';
        link.href = new URL('./iiif-toolbar.css', import.meta.url).href;
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
    }

    private getToolbarClasses(): string {
        const classes = ['iiif-toolbar'];

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
    
    enableZoom(){
        //add a zoom in button and contain the logic that alters the zoom level of the viewer
    }
    enableAnnotation(){

    }
    enableLayers(){

    }
}