import { Viewport } from '../core/iiif-view.js';
import type { TileRenderData } from './iiif-renderer.js';
import { RendererBase } from './iiif-renderer-base.js';

export class Canvas2DRenderer extends RendererBase {
    private ctx?: CanvasRenderingContext2D;
    private textureCache: Map<string, ImageBitmap> = new Map();

    constructor(container: HTMLElement) {
        super(container);
    }

    async initialize(): Promise<void> {
        const ctx = this.canvas.getContext('2d');
        if (!ctx) {
            throw new Error('Canvas 2D context not available');
        }
        this.ctx = ctx;
        console.log('Canvas 2D renderer initialized successfully');
    }

    render(viewport: Viewport, tiles: TileRenderData[]) {
        if (!this.ctx) return;

        const ctx = this.ctx;
        const dpr = this.devicePixelRatio;
        const cw = this.canvas.width;
        const ch = this.canvas.height;
        const scale = viewport.scale;

        // Clear
        const { r, g, b } = this.clearColor;
        const toHex = (v: number) => Math.round(v * 255).toString(16).padStart(2, '0');
        ctx.fillStyle = `#${toHex(r)}${toHex(g)}${toHex(b)}`;
        ctx.fillRect(0, 0, cw, ch);

        for (const tile of tiles) {
            const bitmap = this.textureCache.get(tile.id);
            if (!bitmap) continue;

            // World -> canvas pixel coordinates
            const dx = (tile.x - viewport.centerX) * scale * dpr + cw / 2;
            const dy = (tile.y - viewport.centerY) * scale * dpr + ch / 2;
            const dw = tile.width * scale * dpr;
            const dh = tile.height * scale * dpr;

            // Texture trimming (overlap handling)
            const texLeft = tile.textureLeft ?? 0;
            const texTop = tile.textureTop ?? 0;
            const texRight = tile.textureRight ?? 1;
            const texBottom = tile.textureBottom ?? 1;

            const sx = texLeft * bitmap.width;
            const sy = texTop * bitmap.height;
            const sw = (texRight - texLeft) * bitmap.width;
            const sh = (texBottom - texTop) * bitmap.height;

            ctx.drawImage(bitmap, sx, sy, sw, sh, dx, dy, dw, dh);
        }
    }

    uploadTextureFromBitmap(tileId: string, bitmap: ImageBitmap): ImageBitmap {
        this.textureCache.set(tileId, bitmap);
        return bitmap;
    }

    destroyTexture(tileId: string) {
        this.textureCache.delete(tileId);
    }

    setVideoSource(_video: HTMLVideoElement | null): void {
        // Video overlay not supported in Canvas2D fallback
    }

    clearTextureCache() {
        this.textureCache.clear();
    }

    destroy() {
        this.clearTextureCache();
        this.canvas.remove();
    }
}
