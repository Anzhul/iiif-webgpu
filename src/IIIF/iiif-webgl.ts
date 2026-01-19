import { mat4 } from 'gl-matrix';
import { IIIFImage } from './iiif-image.js';
import { Viewport } from './iiif-view.js';
import type { IIIFRenderer, TileRenderData } from './iiif-renderer.js';

// WebGL vertex shader
const vertexShaderSource = `
attribute vec3 a_position;
attribute vec2 a_texCoord;

uniform mat4 u_combinedMatrix;

varying vec2 v_texCoord;

void main() {
    gl_Position = u_combinedMatrix * vec4(a_position, 1.0);
    v_texCoord = a_texCoord;
}
`;

// WebGL fragment shader
const fragmentShaderSource = `
precision mediump float;

uniform sampler2D u_texture;
varying vec2 v_texCoord;

void main() {
    // Add small epsilon to avoid sampling exactly at texture edges
    // This prevents flickering artifacts at tile boundaries
    float epsilon = 0.0001;
    vec2 clampedCoord = clamp(v_texCoord, vec2(epsilon), vec2(1.0 - epsilon));

    gl_FragColor = texture2D(u_texture, clampedCoord);
}
`;

export class WebGLRenderer implements IIIFRenderer {
    canvas: HTMLCanvasElement;
    container: HTMLElement;
    devicePixelRatio: number;

    // WebGL objects
    private gl?: WebGLRenderingContext;
    private program?: WebGLProgram;
    private vertexBuffer?: WebGLBuffer;
    private texCoordBuffer?: WebGLBuffer;

    // Shader locations
    private positionLocation?: number;
    private texCoordLocation?: number;
    private combinedMatrixLocation?: WebGLUniformLocation | null;
    private textureLocation?: WebGLUniformLocation | null;

    // Texture cache: tileId -> WebGLTexture
    private textureCache: Map<string, WebGLTexture> = new Map();

    // Matrix caching for performance
    private cachedMVPMatrix?: Float32Array;
    private cachedPerspectiveMatrix?: Float32Array;

    // Cache keys using direct value comparison
    private mvpCache = {
        centerX: NaN,
        centerY: NaN,
        imageWidth: NaN,
        imageHeight: NaN,
        canvasWidth: NaN,
        canvasHeight: NaN,
        cameraZ: NaN,
        fov: NaN,
        near: NaN,
        far: NaN
    };

    private perspectiveCache = {
        fov: NaN,
        aspectRatio: NaN,
        near: NaN,
        far: NaN
    };

    // Reusable matrix objects to avoid allocations
    private reusableVP: mat4 = mat4.create();
    private reusableModelMatrix: mat4 = mat4.create();
    private reusableCombinedMatrix: mat4 = mat4.create();

    constructor(container: HTMLElement) {
        this.container = container;
        this.devicePixelRatio = window.devicePixelRatio || 1;

        // Create canvas element
        this.canvas = document.createElement('canvas');

        // Apply styling
        this.canvas.style.position = 'absolute';
        this.canvas.style.top = '0';
        this.canvas.style.left = '0';
        this.canvas.style.width = '100%';
        this.canvas.style.height = '100%';
        this.canvas.style.display = 'block';
        this.canvas.style.touchAction = 'none';
        this.canvas.style.zIndex = '10';

        // Set canvas internal resolution
        this.updateCanvasSize();

        // Append canvas to container
        container.appendChild(this.canvas);
    }

    // Initialize WebGL
    async initialize(): Promise<void> {
        try {
            // Get WebGL context
            this.gl = this.canvas.getContext('webgl', {
                alpha: false,
                depth: true,
                antialias: false,
                premultipliedAlpha: false
            }) as WebGLRenderingContext;

            if (!this.gl) {
                console.error('WebGL is not supported in this browser');
                return;
            }

            // Log WebGL capabilities for debugging
            const maxTextureSize = this.gl.getParameter(this.gl.MAX_TEXTURE_SIZE);
            const maxRenderbufferSize = this.gl.getParameter(this.gl.MAX_RENDERBUFFER_SIZE);
            const maxViewportDims = this.gl.getParameter(this.gl.MAX_VIEWPORT_DIMS);
            console.log('WebGL Capabilities:', {
                maxTextureSize,
                maxRenderbufferSize,
                maxViewportDims,
                vendor: this.gl.getParameter(this.gl.VENDOR),
                renderer: this.gl.getParameter(this.gl.RENDERER)
            });

            // Create shader program
            this.createShaderProgram();

            // Create buffers
            this.createBuffers();

            // Enable depth testing
            this.gl.enable(this.gl.DEPTH_TEST);
            this.gl.depthFunc(this.gl.LESS);

            // Enable blending for transparency
            this.gl.enable(this.gl.BLEND);
            this.gl.blendFunc(this.gl.SRC_ALPHA, this.gl.ONE_MINUS_SRC_ALPHA);

            console.log('WebGL initialized successfully');
        } catch (error) {
            console.error('Failed to initialize WebGL:', error);
        }
    }

    private createShaderProgram() {
        if (!this.gl) return;

        // Create shaders
        const vertexShader = this.compileShader(this.gl.VERTEX_SHADER, vertexShaderSource);
        const fragmentShader = this.compileShader(this.gl.FRAGMENT_SHADER, fragmentShaderSource);

        if (!vertexShader || !fragmentShader) {
            throw new Error('Failed to compile shaders');
        }

        // Create program
        this.program = this.gl.createProgram();
        if (!this.program) {
            throw new Error('Failed to create shader program');
        }

        this.gl.attachShader(this.program, vertexShader);
        this.gl.attachShader(this.program, fragmentShader);
        this.gl.linkProgram(this.program);

        if (!this.gl.getProgramParameter(this.program, this.gl.LINK_STATUS)) {
            const info = this.gl.getProgramInfoLog(this.program);
            throw new Error('Failed to link shader program: ' + info);
        }

        // Get attribute and uniform locations
        this.positionLocation = this.gl.getAttribLocation(this.program, 'a_position');
        this.texCoordLocation = this.gl.getAttribLocation(this.program, 'a_texCoord');
        this.combinedMatrixLocation = this.gl.getUniformLocation(this.program, 'u_combinedMatrix');
        this.textureLocation = this.gl.getUniformLocation(this.program, 'u_texture');
    }

    private compileShader(type: number, source: string): WebGLShader | null {
        if (!this.gl) return null;

        const shader = this.gl.createShader(type);
        if (!shader) return null;

        this.gl.shaderSource(shader, source);
        this.gl.compileShader(shader);

        if (!this.gl.getShaderParameter(shader, this.gl.COMPILE_STATUS)) {
            const info = this.gl.getShaderInfoLog(shader);
            console.error('Shader compilation error:', info);
            this.gl.deleteShader(shader);
            return null;
        }

        return shader;
    }

    private createBuffers() {
        if (!this.gl) return;

        // Create vertex buffer for a unit quad (0,0) to (1,1)
        const positions = new Float32Array([
            0.0, 0.0, 0.0,
            1.0, 0.0, 0.0,
            0.0, 1.0, 0.0,
            0.0, 1.0, 0.0,
            1.0, 0.0, 0.0,
            1.0, 1.0, 0.0
        ]);

        this.vertexBuffer = this.gl.createBuffer();
        this.gl.bindBuffer(this.gl.ARRAY_BUFFER, this.vertexBuffer);
        this.gl.bufferData(this.gl.ARRAY_BUFFER, positions, this.gl.STATIC_DRAW);

        // Create texture coordinate buffer
        const texCoords = new Float32Array([
            0.0, 0.0,
            1.0, 0.0,
            0.0, 1.0,
            0.0, 1.0,
            1.0, 0.0,
            1.0, 1.0
        ]);

        this.texCoordBuffer = this.gl.createBuffer();
        this.gl.bindBuffer(this.gl.ARRAY_BUFFER, this.texCoordBuffer);
        this.gl.bufferData(this.gl.ARRAY_BUFFER, texCoords, this.gl.STATIC_DRAW);
    }

    private updateCanvasSize() {
        const displayWidth = this.container.clientWidth;
        const displayHeight = this.container.clientHeight;

        this.canvas.width = Math.floor(displayWidth * this.devicePixelRatio);
        this.canvas.height = Math.floor(displayHeight * this.devicePixelRatio);
    }

    resize() {
        this.devicePixelRatio = window.devicePixelRatio || 1;
        this.updateCanvasSize();

        if (this.gl) {
            this.gl.viewport(0, 0, this.canvas.width, this.canvas.height);
        }

        // Invalidate matrix caches
        this.mvpCache.canvasWidth = NaN;
        this.mvpCache.canvasHeight = NaN;
        this.perspectiveCache.aspectRatio = NaN;
    }

    /**
     * Get or create cached perspective matrix
     */
    private getPerspectiveMatrix(fov: number, aspectRatio: number, near: number, far: number): Float32Array {
        if (this.perspectiveCache.fov === fov &&
            this.perspectiveCache.aspectRatio === aspectRatio &&
            this.perspectiveCache.near === near &&
            this.perspectiveCache.far === far &&
            this.cachedPerspectiveMatrix) {
            return this.cachedPerspectiveMatrix;
        }

        const projection = mat4.create();
        const fovRadians = (fov * Math.PI) / 180;
        mat4.perspective(projection, fovRadians, aspectRatio, near, far);

        this.cachedPerspectiveMatrix = projection as Float32Array;

        this.perspectiveCache.fov = fov;
        this.perspectiveCache.aspectRatio = aspectRatio;
        this.perspectiveCache.near = near;
        this.perspectiveCache.far = far;

        return this.cachedPerspectiveMatrix;
    }

    /**
     * Get or create cached MVP matrix
     */
    private getMVPMatrix(
        centerX: number,
        centerY: number,
        imageWidth: number,
        imageHeight: number,
        canvasWidth: number,
        canvasHeight: number,
        cameraZ: number,
        fov: number,
        near: number,
        far: number
    ): Float32Array {
        const roundedCenterX = Math.round(centerX * 1000000) / 1000000;
        const roundedCenterY = Math.round(centerY * 1000000) / 1000000;
        const roundedCameraZ = Math.round(cameraZ * 10000) / 10000;

        if (this.mvpCache.centerX === roundedCenterX &&
            this.mvpCache.centerY === roundedCenterY &&
            this.mvpCache.imageWidth === imageWidth &&
            this.mvpCache.imageHeight === imageHeight &&
            this.mvpCache.canvasWidth === canvasWidth &&
            this.mvpCache.canvasHeight === canvasHeight &&
            this.mvpCache.cameraZ === roundedCameraZ &&
            this.mvpCache.fov === fov &&
            this.mvpCache.near === near &&
            this.mvpCache.far === far &&
            this.cachedMVPMatrix) {
            return this.cachedMVPMatrix;
        }

        const aspectRatio = canvasWidth / canvasHeight;
        const projection = this.getPerspectiveMatrix(fov, aspectRatio, near, far);

        const lookAtX = centerX * imageWidth;
        const lookAtY = centerY * imageHeight;
        const cameraX = lookAtX;
        const cameraY = lookAtY;

        const view = mat4.create();
        mat4.translate(view, view, [-cameraX, cameraY, -cameraZ]);
        mat4.scale(view, view, [1, -1, 1]);

        mat4.multiply(this.reusableVP, projection as mat4, view as mat4);

        this.cachedMVPMatrix = new Float32Array(this.reusableVP);

        this.mvpCache.centerX = roundedCenterX;
        this.mvpCache.centerY = roundedCenterY;
        this.mvpCache.imageWidth = imageWidth;
        this.mvpCache.imageHeight = imageHeight;
        this.mvpCache.canvasWidth = canvasWidth;
        this.mvpCache.canvasHeight = canvasHeight;
        this.mvpCache.cameraZ = roundedCameraZ;
        this.mvpCache.fov = fov;
        this.mvpCache.near = near;
        this.mvpCache.far = far;

        return this.cachedMVPMatrix;
    }

    uploadTextureFromBitmap(tileId: string, bitmap: ImageBitmap): WebGLTexture | undefined {
        if (!this.gl || !this.program) return undefined;

        // Check if texture already exists
        if (this.textureCache.has(tileId)) {
            return this.textureCache.get(tileId)!;
        }

        // Create texture
        const texture = this.gl.createTexture();
        if (!texture) return undefined;

        this.gl.bindTexture(this.gl.TEXTURE_2D, texture);

        // Upload bitmap to texture
        this.gl.texImage2D(
            this.gl.TEXTURE_2D,
            0,
            this.gl.RGBA,
            this.gl.RGBA,
            this.gl.UNSIGNED_BYTE,
            bitmap
        );

        // Set texture parameters
        this.gl.texParameteri(this.gl.TEXTURE_2D, this.gl.TEXTURE_WRAP_S, this.gl.CLAMP_TO_EDGE);
        this.gl.texParameteri(this.gl.TEXTURE_2D, this.gl.TEXTURE_WRAP_T, this.gl.CLAMP_TO_EDGE);
        this.gl.texParameteri(this.gl.TEXTURE_2D, this.gl.TEXTURE_MIN_FILTER, this.gl.LINEAR);
        this.gl.texParameteri(this.gl.TEXTURE_2D, this.gl.TEXTURE_MAG_FILTER, this.gl.LINEAR);

        // Cache the texture
        this.textureCache.set(tileId, texture);

        return texture;
    }

    private renderTile(tile: TileRenderData, mvpMatrix: Float32Array) {
        if (!this.gl || !this.program || !this.textureLocation || !this.combinedMatrixLocation) return;

        // Get or upload texture
        let texture = this.textureCache.get(tile.id);
        if (!texture) {
            texture = this.uploadTextureFromBitmap(tile.id, tile.image);
            if (!texture) return;
        }

        // Create model matrix for this tile
        mat4.identity(this.reusableModelMatrix);
        mat4.translate(this.reusableModelMatrix, this.reusableModelMatrix, [
            tile.x,
            tile.y,
            tile.z
        ]);
        mat4.scale(this.reusableModelMatrix, this.reusableModelMatrix, [
            tile.width,
            tile.height,
            1
        ]);

        // Combine MVP * Model
        mat4.multiply(this.reusableCombinedMatrix, mvpMatrix as mat4, this.reusableModelMatrix);

        // Bind texture
        this.gl.activeTexture(this.gl.TEXTURE0);
        this.gl.bindTexture(this.gl.TEXTURE_2D, texture);
        this.gl.uniform1i(this.textureLocation, 0);

        // Set combined matrix uniform
        this.gl.uniformMatrix4fv(this.combinedMatrixLocation, false, this.reusableCombinedMatrix);

        // Draw the quad
        this.gl.drawArrays(this.gl.TRIANGLES, 0, 6);
    }

    render(viewport: Viewport, image: IIIFImage, tiles: TileRenderData[], thumbnail?: TileRenderData) {
        if (!this.gl || !this.program) return;

        // Get cached MVP matrix
        const mvpMatrix = this.getMVPMatrix(
            viewport.centerX,
            viewport.centerY,
            image.width,
            image.height,
            this.canvas.width,
            this.canvas.height,
            viewport.cameraZ,
            viewport.fov,
            viewport.near,
            viewport.far
        );

        // Prepare all tiles and sort by z-depth
        let allTiles: TileRenderData[];
        if (thumbnail) {
            allTiles = [...tiles, thumbnail].sort((a, b) => a.z - b.z);
        } else {
            allTiles = tiles;
        }

        // Clear the canvas
        this.gl.clearColor(0.1, 0.1, 0.1, 1.0);
        this.gl.clear(this.gl.COLOR_BUFFER_BIT | this.gl.DEPTH_BUFFER_BIT);

        // Set viewport
        this.gl.viewport(0, 0, this.canvas.width, this.canvas.height);

        // Use shader program
        this.gl.useProgram(this.program);

        // Check all required resources are available
        if (!this.vertexBuffer || !this.texCoordBuffer ||
            this.positionLocation === undefined || this.texCoordLocation === undefined) {
            console.error('Required WebGL resources not available');
            return;
        }

        // Bind vertex buffer
        this.gl.bindBuffer(this.gl.ARRAY_BUFFER, this.vertexBuffer);
        this.gl.enableVertexAttribArray(this.positionLocation);
        this.gl.vertexAttribPointer(this.positionLocation, 3, this.gl.FLOAT, false, 0, 0);

        // Bind texture coordinate buffer
        this.gl.bindBuffer(this.gl.ARRAY_BUFFER, this.texCoordBuffer);
        this.gl.enableVertexAttribArray(this.texCoordLocation);
        this.gl.vertexAttribPointer(this.texCoordLocation, 2, this.gl.FLOAT, false, 0, 0);

        // Render each tile
        for (const tile of allTiles) {
            this.renderTile(tile, mvpMatrix);
        }
    }

    destroyTexture(tileId: string) {
        const texture = this.textureCache.get(tileId);
        if (texture && this.gl) {
            this.gl.deleteTexture(texture);
            this.textureCache.delete(tileId);
        }
    }

    clearTextureCache() {
        if (this.gl) {
            for (const texture of this.textureCache.values()) {
                this.gl.deleteTexture(texture);
            }
        }
        this.textureCache.clear();
    }

    destroy() {
        this.clearTextureCache();

        if (this.gl) {
            if (this.vertexBuffer) this.gl.deleteBuffer(this.vertexBuffer);
            if (this.texCoordBuffer) this.gl.deleteBuffer(this.texCoordBuffer);
            if (this.program) this.gl.deleteProgram(this.program);
        }
    }
}
