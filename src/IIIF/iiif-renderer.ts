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

// Tile data with world offset applied (for multi-image rendering)
export interface WorldTileRenderData extends TileRenderData {
    worldOffsetX: number;
    worldOffsetY: number;
}

export interface IIIFRenderer {
    canvas: HTMLCanvasElement;
    container: HTMLElement;
    devicePixelRatio: number;

    initialize(): Promise<void>;
    resize(): void;
    render(viewport: Viewport, image: IIIFImage, tiles: TileRenderData[], thumbnail?: TileRenderData): void;
    // Multi-image render method for unified canvas (world space mode)
    renderMultiImage?(viewport: Viewport, tiles: WorldTileRenderData[]): void;
    uploadTextureFromBitmap(tileId: string, bitmap: ImageBitmap): any;
    destroyTexture(tileId: string): void;
    clearTextureCache(): void;
    destroy(): void;
}
