import { Viewport } from './iiif-view';
import { IIIFImage } from './iiif-image';
import { TileManager } from './iiif-tile';
import type { EasingFunction } from './easing';
import { easeOutQuart, interpolate } from './easing';

export class IIIFCamera {
    viewport: Viewport;
    tileManager: TileManager;

    constructor(viewport: Viewport, tileManager: TileManager) {
        this.viewport = viewport;
        this.tileManager = tileManager;
    }   


    private animatePan(){

    }

    private animateZoom(){

    }



    to(imageX: number, imageY: number, imageZ: number, duration = 500, easing: EasingFunction = easeOutQuart) {
    }
}