import { Viewport } from '../core/iiif-view.js';

export interface TileRenderData {
    id: string;
    image: ImageBitmap;
    x: number;
    y: number;
    z: number;
    width: number;
    height: number;
    // Texture coordinate trimming (to exclude overlap regions)
    textureLeft?: number;   // UV left (default 0)
    textureTop?: number;    // UV top (default 0)
    textureRight?: number;  // UV right (default 1)
    textureBottom?: number; // UV bottom (default 1)
    // Image edge flags — true means this tile side is at the image boundary.
    // Renderers skip the half-pixel expand on image edges to prevent
    // sub-pixel fringe oscillation against the background.
    isEdgeLeft?: boolean;
    isEdgeTop?: boolean;
    isEdgeRight?: boolean;
    isEdgeBottom?: boolean;
}

export interface IIIFRenderer {
    canvas: HTMLCanvasElement;
    container: HTMLElement;
    devicePixelRatio: number;

    initialize(): Promise<void>;
    resize(): void;
    render(viewport: Viewport, tiles: TileRenderData[]): void;
    setVideoSource(video: HTMLVideoElement | null): void;
    uploadTextureFromBitmap(tileId: string, bitmap: ImageBitmap): any;
    setClearColor(r: number, g: number, b: number): void; // Implemented in RendererBase
    destroyTexture(tileId: string): void;
    clearTextureCache(): void;
    destroy(): void;
}
