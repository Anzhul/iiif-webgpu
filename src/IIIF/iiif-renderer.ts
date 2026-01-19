import { IIIFImage } from './iiif-image.js';
import { Viewport } from './iiif-view.js';

export interface TileRenderData {
    id: string;
    image: ImageBitmap;
    x: number;
    y: number;
    z: number;
    width: number;
    height: number;
}

export interface IIIFRenderer {
    canvas: HTMLCanvasElement;
    container: HTMLElement;
    devicePixelRatio: number;

    initialize(): Promise<void>;
    resize(): void;
    render(viewport: Viewport, image: IIIFImage, tiles: TileRenderData[], thumbnail?: TileRenderData): void;
    uploadTextureFromBitmap(tileId: string, bitmap: ImageBitmap): any;
    destroyTexture(tileId: string): void;
    clearTextureCache(): void;
    destroy(): void;
}
