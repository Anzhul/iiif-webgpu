import { mat4 } from 'gl-matrix';
import type { Viewport } from '../core/iiif-view.js';
import type { IIIFRenderer, TileRenderData } from './iiif-renderer.js';

/**
 * Base class for renderers. Provides:
 * - Canvas creation, styling, and sizing
 * - Device pixel ratio handling
 * - Perspective/MVP matrix computation and caching (for GPU renderers)
 * - Reusable matrix objects to avoid per-frame allocations
 */
export abstract class RendererBase implements IIIFRenderer {
    canvas: HTMLCanvasElement;
    container: HTMLElement;
    devicePixelRatio: number;

    // Background clear color (shared by all renderers)
    protected clearColor = { r: 0.1, g: 0.1, b: 0.1 };

    // Matrix caching — used by GPU renderers, ignored by Canvas2D
    protected cachedMVPMatrix: Float32Array = new Float32Array(16);
    protected cachedPerspectiveMatrix: Float32Array = new Float32Array(16);
    protected mvpCacheValid: boolean = false;
    protected perspectiveCacheValid: boolean = false;

    protected mvpCache = {
        centerX: NaN,
        centerY: NaN,
        canvasWidth: NaN,
        canvasHeight: NaN,
        cameraZ: NaN,
        fov: NaN,
        near: NaN,
        far: NaN
    };

    protected perspectiveCache = {
        fov: NaN,
        aspectRatio: NaN,
        near: NaN,
        far: NaN
    };

    // Reusable matrix objects to avoid allocations
    protected reusableVP: mat4 = mat4.create();
    protected reusableView: mat4 = mat4.create();
    protected reusableModelMatrix: mat4 = mat4.create();
    protected reusableCombinedMatrix: mat4 = mat4.create();

    constructor(container: HTMLElement) {
        this.container = container;
        this.devicePixelRatio = window.devicePixelRatio || 1;

        this.canvas = document.createElement('canvas');
        this.canvas.style.position = 'absolute';
        this.canvas.style.top = '0';
        this.canvas.style.left = '0';
        this.canvas.style.width = '100%';
        this.canvas.style.height = '100%';
        this.canvas.style.display = 'block';
        this.canvas.style.touchAction = 'none';
        this.canvas.style.zIndex = '10';

        this.updateCanvasSize();
        container.appendChild(this.canvas);
    }

    protected updateCanvasSize() {
        const displayWidth = this.container.clientWidth;
        const displayHeight = this.container.clientHeight;
        this.canvas.width = Math.floor(displayWidth * this.devicePixelRatio);
        this.canvas.height = Math.floor(displayHeight * this.devicePixelRatio);
    }

    resize() {
        this.devicePixelRatio = window.devicePixelRatio || 1;
        this.updateCanvasSize();
        this.mvpCacheValid = false;
        this.perspectiveCacheValid = false;
    }

    /**
     * Get or create cached perspective matrix.
     * Reuses pre-allocated Float32Array — no allocations on cache miss.
     */
    protected getPerspectiveMatrix(aspectRatio: number, fov: number, near: number, far: number): Float32Array {
        if (this.perspectiveCacheValid &&
            this.perspectiveCache.aspectRatio === aspectRatio &&
            this.perspectiveCache.fov === fov &&
            this.perspectiveCache.near === near &&
            this.perspectiveCache.far === far) {
            return this.cachedPerspectiveMatrix;
        }

        // Compute into reusable VP, then copy to cache
        const projection = this.reusableVP;
        mat4.perspective(projection, fov, aspectRatio, near, far);
        this.cachedPerspectiveMatrix.set(projection as Float32Array);

        this.perspectiveCache.fov = fov;
        this.perspectiveCache.aspectRatio = aspectRatio;
        this.perspectiveCache.near = near;
        this.perspectiveCache.far = far;
        this.perspectiveCacheValid = true;

        return this.cachedPerspectiveMatrix;
    }

    /**
     * Get or create cached view-projection matrix.
     * Exact comparison — any viewport change must produce a fresh matrix
     * so the projection matches the tile grid selection precisely.
     * No allocations on either cache hit or miss.
     */
    protected getMVPMatrix(
        centerX: number,
        centerY: number,
        canvasWidth: number,
        canvasHeight: number,
        cameraZ: number,
        fov: number,
        near: number,
        far: number
    ): Float32Array {
        if (this.mvpCacheValid &&
            this.mvpCache.centerX === centerX &&
            this.mvpCache.centerY === centerY &&
            this.mvpCache.canvasWidth === canvasWidth &&
            this.mvpCache.canvasHeight === canvasHeight &&
            this.mvpCache.cameraZ === cameraZ &&
            this.mvpCache.fov === fov &&
            this.mvpCache.near === near &&
            this.mvpCache.far === far) {
            return this.cachedMVPMatrix;
        }

        // Projection matrix
        const aspectRatio = canvasWidth / canvasHeight;
        const projection = this.getPerspectiveMatrix(aspectRatio, fov, near, far);

        // View matrix: camera looking at (centerX, centerY, 0) from (0, 0, cameraZ)
        const view = this.reusableView;
        mat4.identity(view);
        mat4.translate(view, view, [0, 0, -cameraZ]);
        mat4.scale(view, view, [1, -1, 1]);
        mat4.translate(view, view, [-centerX, -centerY, 0]);

        mat4.multiply(this.reusableVP, projection as mat4, view);
        this.cachedMVPMatrix.set(this.reusableVP as Float32Array);

        this.mvpCache.centerX = centerX;
        this.mvpCache.centerY = centerY;
        this.mvpCache.canvasWidth = canvasWidth;
        this.mvpCache.canvasHeight = canvasHeight;
        this.mvpCache.cameraZ = cameraZ;
        this.mvpCache.fov = fov;
        this.mvpCache.near = near;
        this.mvpCache.far = far;
        this.mvpCacheValid = true;

        return this.cachedMVPMatrix;
    }

    // Abstract methods that subclasses must implement
    abstract initialize(): Promise<void>;
    abstract render(viewport: Viewport, tiles: TileRenderData[]): void;
    abstract setVideoSource(video: HTMLVideoElement | null): void;
    abstract uploadTextureFromBitmap(tileId: string, bitmap: ImageBitmap): any;
    setClearColor(r: number, g: number, b: number): void {
        this.clearColor = { r, g, b };
    }
    abstract destroyTexture(tileId: string): void;
    abstract clearTextureCache(): void;
    abstract destroy(): void;
}
