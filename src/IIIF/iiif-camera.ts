import { Viewport } from './iiif-view';
import { IIIFImage } from './iiif-image';
import { TileManager } from './iiif-tile';
import type { EasingFunction } from './easing';
import { easeOutQuart, interpolate } from './easing';

export class Camera {
    viewport: Viewport;
    tileManager: TileManager;
    images: Map<string, IIIFImage>;

    constructor(viewport: Viewport, images: Map<string, IIIFImage>, tileManager: TileManager) {
        this.viewport = viewport;
        this.tileManager = tileManager;
        this.images = images;
    }   


    private animatePan(){

    }

    private animateZoom(){

    }



    to(imageX: number, imageY: number, imageZ: number, duration = 500, easing: EasingFunction = easeOutQuart) {


    }

    pan(deltaX: number, deltaY: number, duration = 500, easing: EasingFunction = easeOutQuart) {}
    zoom(factor: number, duration = 500, easing: EasingFunction = easeOutQuart) {}

}