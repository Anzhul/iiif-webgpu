
interface ToolbarOptions {
    zoom?: boolean;
    annotations?: boolean;
    layers?: boolean;
    CVButton?: boolean;
    fullscreen?: boolean;
    position?: 'top-right' | 'top-left' | 'bottom-right' | 'bottom-left';
    theme?: 'dark' | 'light';
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
    CVButton: HTMLButtonElement | undefined;
    fullscreenButton: HTMLButtonElement | undefined;
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
        if (this.options.CVButton) {
            this.enableCV();
        }
        if (this.options.fullscreen) {
            this.enableFullscreen();
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
    
        if ((this.options.zoom || this.options.annotations || this.options.layers) && (this.options.CVButton || this.options.fullscreen)) {
            console.log("ADDING DIVIDER");
            this.enableDivider();
        }
        
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

    enableCV(){
        this.CVButton = document.createElement('button');
        this.CVButton.className = "iiif-toolbar-button iiif-toolbar-button-cv";
        this.CVButton.id = "cv-toggle";
        this.CVButton.title = "Toggle Computer Vision";
        this.CVButton.innerHTML = `
        <svg xmlns="http://www.w3.org/2000/svg" width="17.9" height="20.867" viewBox="0 0 17.9 20.867" transform="scale(0.75)" transform-origin="center">
            <g transform="translate(-205.388 -10.664)">
                <path id="Hand" d="M15.171,2.9a2.249,2.249,0,0,0-1.489.557V2.178a2.232,2.232,0,0,0-4.453-.164,2.267,2.267,0,0,0-2.4-.375A2.178,2.178,0,0,0,5.506,3.633v7.375L4.163,8.727A2.257,2.257,0,0,0,1.12,7.918a2.156,2.156,0,0,0-.858,2.925l.031.055c2.946,6.08,4.892,9.458,9.3,9.458,4.26.042,7.8,0,7.8-6.912V5.083A2.209,2.209,0,0,0,15.168,2.9ZM16.66,13.441c0,6.259-3.207,6.223-7.061,6.185-3.435,0-5.256-2.078-8.637-9.055l-.014-.026a1.437,1.437,0,0,1,.509-1.967l.035-.02a1.5,1.5,0,0,1,2.028.532l2.037,3.452a.375.375,0,0,0,.418.17.365.365,0,0,0,.272-.352V3.629a1.489,1.489,0,0,1,2.973,0V9.809a.372.372,0,1,0,.744,0V2.178a1.489,1.489,0,0,1,2.973,0V9.813a.372.372,0,1,0,.744,0V5.083a1.489,1.489,0,0,1,2.973,0Z" transform="translate(205.639 10.918)" fill="#fff"/>
                <path id="Hand_-_Outline" data-name="Hand - Outline" d="M11.449-.254l.093,0a2.485,2.485,0,0,1,2.39,2.425v.8a2.5,2.5,0,0,1,.855-.3l-.012-.025.417-.008A2.467,2.467,0,0,1,17.648,5.08v8.365c0,3.077-.676,5.008-2.126,6.077-1.366,1.006-3.256,1.091-5.075,1.091-.293,0-.6,0-.856-.005-4.634,0-6.638-3.644-9.519-9.591l-.03-.053A2.409,2.409,0,0,1,1,7.7a2.506,2.506,0,0,1,3.377.9l.879,1.492V3.633A2.427,2.427,0,0,1,6.731,1.409a2.516,2.516,0,0,1,2.324.167A2.47,2.47,0,0,1,11.449-.254Zm1.982,2.436a1.982,1.982,0,0,0-3.954-.143l-.047.486L9.064,2.2a2.016,2.016,0,0,0-2.135-.334A1.928,1.928,0,0,0,5.756,3.634v8.291L3.947,8.854a2.006,2.006,0,0,0-2.705-.718,1.909,1.909,0,0,0-.761,2.588l.027.048.009.017a32.706,32.706,0,0,0,4.065,6.954,6.221,6.221,0,0,0,5.011,2.364c.262,0,.563.005.854.005,1.736,0,3.534-.077,4.778-.993,1.312-.966,1.922-2.769,1.922-5.674V5.083A1.965,1.965,0,0,0,15.305,3.15h-.142a2,2,0,0,0-1.317.5l-.415.363ZM11.451.525a1.741,1.741,0,0,1,1.736,1.639V9.813a.122.122,0,1,0,.244,0V5.068a1.739,1.739,0,0,1,3.472,0v.014l.005,8.358c0,2.766-.6,4.5-1.9,5.461-1.218.9-2.906.979-4.531.979-.288,0-.574,0-.877-.006H9.6a5.709,5.709,0,0,1-4.518-1.99c-1.245-1.325-2.5-3.412-4.339-7.2L.73,10.667a1.689,1.689,0,0,1,.6-2.3l.042-.024a1.754,1.754,0,0,1,2.363.622l2.038,3.454a.127.127,0,0,0,.139.055A.115.115,0,0,0,6,12.36V3.614a1.739,1.739,0,0,1,3.472,0V9.809a.122.122,0,1,0,.244,0V2.164A1.741,1.741,0,0,1,11.451.525Zm1.237,1.661a1.239,1.239,0,0,0-2.473,0V9.809a.622.622,0,1,1-1.244,0V3.636a1.239,1.239,0,0,0-2.473,0v8.725a.615.615,0,0,1-.459.593.625.625,0,0,1-.7-.283L3.305,9.218a1.254,1.254,0,0,0-1.69-.442l-.031.018a1.188,1.188,0,0,0-.42,1.624l.023.044c1.814,3.744,3.047,5.8,4.256,7.082A5.252,5.252,0,0,0,9.6,19.376h.012c.3,0,.586.006.872.006,3.47,0,5.927-.426,5.927-5.941L16.4,5.09a1.239,1.239,0,0,0-2.473,0V9.813a.622.622,0,1,1-1.244,0Z" transform="translate(205.639 10.918)" fill="#fff"/>
            </g>
        </svg>`;
        this.secondarytools?.appendChild(this.CVButton);
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