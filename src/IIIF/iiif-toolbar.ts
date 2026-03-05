
interface ToolbarOptions {
    zoom?: boolean;
    annotations?: boolean;
    layers?: boolean;

    fullscreen?: boolean;
    info?: boolean;
    compare?: boolean;
    position?: 'top-right' | 'top-left' | 'bottom-right' | 'bottom-left';
    theme?: 'dark' | 'light';
    variant?: string;
    customStyles?: Partial<CSSStyleDeclaration>;
}

export class ToolBar {
    container: HTMLElement;
    toolbar: HTMLDivElement | undefined;
    maintools: HTMLDivElement | undefined;
    secondarytools: HTMLDivElement | undefined;
    divider: HTMLDivElement | undefined;
    zoomInButton: HTMLButtonElement | undefined;
    zoomOutButton: HTMLButtonElement | undefined;
    annotationButton: HTMLButtonElement | undefined;
    layersButton: HTMLButtonElement | undefined;
    fullscreenButton: HTMLButtonElement | undefined;
    infoButton: HTMLButtonElement | undefined;
    compareButton: HTMLButtonElement | undefined;
    private options: ToolbarOptions;
    private stylesInjected = false;

    constructor(container: HTMLElement, options: ToolbarOptions = {}) {
        this.container = container;
        this.options = options;

        this.injectStyles();
        this.createToolbar();

        if (this.options.zoom) {
            this.enableZoom();
        }
        if (this.options.annotations) {
            this.enableAnnotation();
        }
        if (this.options.layers) {
            this.enableLayers();
        }

        if (this.options.fullscreen) {
            this.enableFullscreen();
        }
        if (this.options.info) {
            this.enableInfo();
        }
        if (this.options.compare) {
            this.enableCompare();
        }
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
        this.maintools = document.createElement('div');
        this.maintools.className = "iiif-toolbar-main-tools";
        this.toolbar.appendChild(this.maintools);
        this.divider = document.createElement('div');
        this.divider.className = "iiif-toolbar-divider";
        this.toolbar.appendChild(this.divider);
        this.secondarytools = document.createElement('div');
        this.secondarytools.className = "iiif-toolbar-secondary-tools";
        this.toolbar.appendChild(this.secondarytools);
    
        if ((this.options.zoom || this.options.annotations || this.options.layers) && (this.options.fullscreen || this.options.info || this.options.compare)) {
            this.enableDivider();
        }
        
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
                    <rect id="Rectangle_33" data-name="Rectangle 33" width="13" height="3" rx="1" transform="translate(24 19)" fill="#fff"/>
                    <rect id="Rectangle_43" data-name="Rectangle 43" width="13" height="3" rx="1" transform="translate(32 14) rotate(90)" fill="#fff"/>
                </g>
            </svg>
        `;

        this.maintools?.appendChild(this.zoomInButton);
        this.zoomOutButton = document.createElement('button');
        this.zoomOutButton.className = "iiif-toolbar-button iiif-toolbar-button-zoom-out";
        this.zoomOutButton.id = "zoom-out";
        this.zoomOutButton.title = "Zoom Out";

        // Add SVG as inline HTML
        this.zoomOutButton.innerHTML = `
            <svg xmlns="http://www.w3.org/2000/svg" width="15" height="3" viewBox="0 0 15 3" transform="scale(0.8)">
                <rect id="zoom-out" width="15" height="3" rx="1" fill="#fff"/>
            </svg>
        `;

        this.maintools?.appendChild(this.zoomOutButton);
    }
    enableAnnotation(){
        this.annotationButton = document.createElement('button');
        this.annotationButton.className = "iiif-toolbar-button iiif-toolbar-button-annotation";
        this.annotationButton.id = "annotation-toggle";
        this.annotationButton.title = "Toggle Annotations";

        // Add SVG as inline HTML
        this.annotationButton.innerHTML = `
            <svg xmlns="http://www.w3.org/2000/svg" width="16" height="17" viewBox="0 0 16 17" transform="scale(0.75)" transform-origin="center">
                <g id="Dots_" data-name="Dots!" transform="translate(-1.4 -1)">
                    <circle id="Ellipse_15" data-name="Ellipse 15" cx="3" cy="3" r="3" transform="translate(1.4 1)" fill="#fff"/>
                    <circle id="Ellipse_16" data-name="Ellipse 16" cx="3" cy="3" r="3" transform="translate(1.4 12)" fill="#fff"/>
                    <circle id="Ellipse_17" data-name="Ellipse 17" cx="3" cy="3" r="3" transform="translate(11.4 6)" fill="#fff"/>
                </g>
            </svg>
        `;

        this.maintools?.appendChild(this.annotationButton);
    }
    enableLayers(){
        this.layersButton = document.createElement('button');
        this.layersButton.className = "iiif-toolbar-button iiif-toolbar-button-layers";
        this.layersButton.id = "layers-toggle";
        this.layersButton.title = "Toggle Layers";

        // Add SVG as inline HTML
        this.layersButton.innerHTML = `
        <svg xmlns="http://www.w3.org/2000/svg" width="18.059" height="16.035" viewBox="0 0 18.059 16.035" transform="scale(0.75)" transform-origin="center">
        <g id="Layers" transform="translate(-517.369 -449.174)">
            <path id="Rectangle_32" data-name="Rectangle 32" d="M517.924,453.7l7.137-4.2a2.9,2.9,0,0,1,2.676,0l7.137,4.2a.837.837,0,0,1,0,1.576l-7.137,4.2a2.9,2.9,0,0,1-2.676,0l-7.137-4.2A.837.837,0,0,1,517.924,453.7Z" transform="translate(0)" fill="#fff"/>
            <g id="Group_10" data-name="Group 10" transform="translate(517.369 457.794)">
            <path id="Path_28" data-name="Path 28" d="M534.873,464.932l-1.559-.969-5.578,3.467a2.768,2.768,0,0,1-2.676,0l-5.578-3.467-1.559.969a.9.9,0,0,0,0,1.664l7.137,4.437a2.772,2.772,0,0,0,2.676,0l7.137-4.437A.9.9,0,0,0,534.873,464.932Z" transform="translate(-517.369 -463.963)" fill="#fff"/>
            </g>
        </g>
        </svg>
        `;

        this.maintools?.appendChild(this.layersButton);
    }

    enableDivider() {
        const divider = document.createElement('div');
        divider.className = "iiif-toolbar-divider-block";
        this.divider?.appendChild(divider);
    }


    enableInfo() {
        this.infoButton = document.createElement('button');
        this.infoButton.className = "iiif-toolbar-button iiif-toolbar-button-info";
        this.infoButton.id = "info-toggle";
        this.infoButton.title = "Manifest Info";
        this.infoButton.innerHTML = `
        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16" transform="scale(0.75)" transform-origin="center">
            <circle cx="8" cy="8" r="7" fill="none" stroke="#fff" stroke-width="1.5"/>
            <text x="8" y="12" text-anchor="middle" fill="#fff" font-size="11" font-weight="bold" font-family="serif">i</text>
        </svg>
        `;
        this.secondarytools?.appendChild(this.infoButton);
    }

    enableCompare() {
        this.compareButton = document.createElement('button');
        this.compareButton.className = "iiif-toolbar-button iiif-toolbar-button-compare";
        this.compareButton.id = "compare-toggle";
        this.compareButton.title = "Compare Canvases";
        this.compareButton.innerHTML = `
        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16" transform="scale(0.75)" transform-origin="center">
            <rect x="1" y="1" width="6" height="14" rx="1" fill="none" stroke="#fff" stroke-width="1.5"/>
            <rect x="9" y="1" width="6" height="14" rx="1" fill="none" stroke="#fff" stroke-width="1.5"/>
        </svg>
        `;
        this.secondarytools?.appendChild(this.compareButton);
    }

    enableFullscreen() {
        this.fullscreenButton = document.createElement('button');
        this.fullscreenButton.className = "iiif-toolbar-button iiif-toolbar-button-fullscreen";
        this.fullscreenButton.id = "fullscreen-toggle";
        this.fullscreenButton.title = "Toggle Fullscreen";
        this.fullscreenButton.innerHTML = `
        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16">
            <g id="Fullscreen" transform="scale(0.8)" transform-origin="center">
                <rect id="Rectangle_35" data-name="Rectangle 35" width="6" height="2" rx="1" transform="translate(0.126 -0.055)" fill="#fff"/>
                <rect id="Rectangle_36" data-name="Rectangle 36" width="6" height="2" rx="1" transform="translate(2.126 -0.055) rotate(90)" fill="#fff"/>
                <rect id="Rectangle_37" data-name="Rectangle 37" width="6" height="2" rx="1" transform="translate(0.126 13.945)" fill="#fff"/>
                <rect id="Rectangle_38" data-name="Rectangle 38" width="6" height="2" rx="1" transform="translate(0.126 15.945) rotate(-90)" fill="#fff"/>
                <rect id="Rectangle_39" data-name="Rectangle 39" width="7" height="2" rx="1" transform="translate(9.126 -0.055)" fill="#fff"/>
                <rect id="Rectangle_40" data-name="Rectangle 40" width="6" height="2" rx="1" transform="translate(16.126 -0.055) rotate(90)" fill="#fff"/>
                <rect id="Rectangle_41" data-name="Rectangle 41" width="7" height="2" rx="1" transform="translate(9.126 13.945)" fill="#fff"/>
                <rect id="Rectangle_42" data-name="Rectangle 42" width="6" height="2" rx="1" transform="translate(14.126 15.945) rotate(-90)" fill="#fff"/>
            </g>
        </svg>
        `;
        this.secondarytools?.appendChild(this.fullscreenButton);
        this.fullscreenButton.addEventListener('click', () => {
            document.getElementsByClassName('iiif-toolbar-button-fullscreen')[0].classList.toggle('active');
            if (!document.fullscreenElement) {
                this.container.requestFullscreen().catch(err => {
                    console.error(`Error attempting to enable fullscreen mode: ${err.message} (${err.name})`);
                });
            } else {
                document.exitFullscreen();
            }
        });
    }
}