
import { IIIFImage } from './iiif-image';
import { Viewport } from './iiif-view';
import { TileManager } from './iiif-tile';
import { ToolBar } from './iiif-toolbar';

export class IIIFViewer {
    container: HTMLElement;
    manifests: any[];
    images: Map<string, IIIFImage>;
    tiles: Map<string, TileManager>;
    viewport: Viewport;
    private eventListeners: { event: string, handler: EventListener }[];

    constructor(container: HTMLElement, /*options: any = {}*/) {
        this.container = container;
        this.manifests = [];
        this.images = new Map();
        this.tiles = new Map();
        this.viewport = new Viewport(container.clientWidth, container.clientHeight);
        this.eventListeners = [];
    }

    async addImage(id: string, url: string) {
        const iiifImage = new IIIFImage(id, url);
        await iiifImage.loadManifest(url);
        this.images.set(id, iiifImage);
        const tileManager = new TileManager(id, iiifImage);
        this.viewport.fitToWidth(iiifImage);
        this.viewport.getImageBounds(iiifImage); 
        this.tiles.set(id, tileManager);
        this.tiles.get(id)?.getOptimalZoomLevel(this.viewport.scale);
        this.viewport.fitToContainer(iiifImage);
        this.tiles.get(id)?.getTilesForViewport(this.viewport);
    }

    async removeImage(id: string) {
        const index = this.images.has(id) ? Array.from(this.images.keys()).indexOf(id) : -1;
        if (index !== -1) {
            this.images.delete(id);
            this.tiles.delete(id);
            console.log(`Image with ID ${id} removed.`);
        } else {
            console.warn(`Image with ID ${id} not found.`);
        }
    }

    zoom(newScale: number, imageX: number, imageY: number, id: string) {
        const image = this.images.get(id);
        console.log(`Zoom request to scale ${newScale} at (${imageX}, ${imageY}) for image ID ${id}`);
        if (image) {
            this.viewport.zoom(newScale, imageX, imageY, image);
            const tiles = this.tiles.get(id);
            if (tiles) {
                tiles.getTilesForViewport(this.viewport);
            }
        } else {
            console.warn(`Image with ID ${id} not found for zooming.`);
        }
    }

    pan(deltaX: number, deltaY: number, id: string) {
        const image = this.images.get(id);
        if (image) {
            this.viewport.pan(deltaX, deltaY, image);
            const tiles = this.tiles.get(id);
            if (tiles) {
                tiles.getTilesForViewport(this.viewport);
            }
        } else {
            console.warn(`Image with ID ${id} not found for panning.`);
        }
    }

    addControls(){
        const controlsContainer = document.createElement('div');
        controlsContainer.className = 'controls-container';
        this.container.appendChild(controlsContainer);
        this.addZoom(controlsContainer);
        //const zoomInButton = document.createElement('button');
    }

    addZoom(container = this.container) {
        const zoomIn = document.createElement('button');
        zoomIn.className = 'control-button';
        zoomIn.classList.add('zoom-in-button');
        container.appendChild(zoomIn);
        zoomIn.innerHTML = '+';
    }

    listen(...ids: string[]) {
        const mousedownHandler = (event: MouseEvent) => {
            event.preventDefault();
            const startX = event.clientX;
            const startY = event.clientY;
            const onMouseMove = (moveEvent: MouseEvent) => {
                const deltaX = moveEvent.clientX - startX;
                const deltaY = moveEvent.clientY - startY;
                ids.forEach(id => this.pan(deltaX, deltaY, id));
                console.log('Mouse move to', moveEvent.clientX, moveEvent.clientY, 'Delta:', deltaX, deltaY);
            };
            const onMouseUp = () => {
                this.container.removeEventListener('mousemove', onMouseMove);
                this.container.removeEventListener('mouseup', onMouseUp);
            };
            this.container.addEventListener('mousemove', onMouseMove);
            this.container.addEventListener('mouseup', onMouseUp);
        };

        const wheelHandler = (event: WheelEvent) => {
            //alt or shift key pressed
            if (event.altKey || event.shiftKey) {
                event.preventDefault();
                const zoomFactor = 1.1;
                const rect = this.container.getBoundingClientRect();
                const imageX = event.clientX - rect.left;
                const imageY = event.clientY - rect.top;
                const newScale = event.deltaY < 0 ? this.viewport.scale * zoomFactor : this.viewport.scale / zoomFactor;
                ids.forEach(id => this.zoom(newScale, imageX, imageY, id));
            }
        };

        this.container.addEventListener('mousedown', mousedownHandler);
        this.container.addEventListener('wheel', wheelHandler);

        this.eventListeners.push(
            { event: 'mousedown', handler: mousedownHandler },
            { event: 'wheel', handler: wheelHandler }
        );
    }

    unlisten() {
        this.eventListeners.forEach(({ event, handler }) => {
            this.container.removeEventListener(event, handler);
        });
        this.eventListeners = [];
    }


    render() {
        
    }

}

//const viewer = new IIIFViewer(document.getElementById('iiif-container')!);
//viewer.addImage('id', 'https://iiif.harvardartmuseums.org/manifests/object/299843');
//viewer.