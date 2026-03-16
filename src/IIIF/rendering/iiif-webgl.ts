import { mat4 } from 'gl-matrix';
import { Viewport } from '../core/iiif-view.js';
import type { TileRenderData } from './iiif-renderer.js';
import { RendererBase } from './iiif-renderer-base.js';

// WebGL vertex shader
const vertexShaderSource = `
attribute vec3 a_position;
attribute vec2 a_texCoord;

uniform mat4 u_combinedMatrix;
uniform vec4 u_textureBounds; // (left, top, right, bottom)

varying vec2 v_texCoord;

void main() {
    gl_Position = u_combinedMatrix * vec4(a_position, 1.0);

    // Map unit quad (0-1) to trimmed texture coordinates (excludes overlap)
    float texX = mix(u_textureBounds.x, u_textureBounds.z, a_texCoord.x);
    float texY = mix(u_textureBounds.y, u_textureBounds.w, a_texCoord.y);
    v_texCoord = vec2(texX, texY);
}
`;

// WebGL fragment shader
const fragmentShaderSource = `
precision mediump float;

uniform sampler2D u_texture;
varying vec2 v_texCoord;

void main() {
    gl_FragColor = texture2D(u_texture, v_texCoord);
}
`;

export class WebGLRenderer extends RendererBase {
    // WebGL objects
    private gl?: WebGLRenderingContext;
    private program?: WebGLProgram;
    private vertexBuffer?: WebGLBuffer;
    private texCoordBuffer?: WebGLBuffer;

    // Shader locations
    private positionLocation?: number;
    private texCoordLocation?: number;
    private combinedMatrixLocation?: WebGLUniformLocation | null;
    private textureBoundsLocation?: WebGLUniformLocation | null;
    private textureLocation?: WebGLUniformLocation | null;

    // Texture cache: tileId -> WebGLTexture
    private textureCache: Map<string, WebGLTexture> = new Map();

    constructor(container: HTMLElement) {
        super(container);
    }

    async initialize(): Promise<void> {
        try {
            this.gl = this.canvas.getContext('webgl', {
                alpha: false,
                depth: false, // Not used — tiles are z-sorted with painter's algorithm
                antialias: true,
                premultipliedAlpha: false
            }) as WebGLRenderingContext;

            if (!this.gl) {
                console.error('WebGL is not supported in this browser');
                return;
            }

            this.createShaderProgram();
            this.createBuffers();

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

        const vertexShader = this.compileShader(this.gl.VERTEX_SHADER, vertexShaderSource);
        const fragmentShader = this.compileShader(this.gl.FRAGMENT_SHADER, fragmentShaderSource);

        if (!vertexShader || !fragmentShader) {
            throw new Error('Failed to compile shaders');
        }

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
        this.textureBoundsLocation = this.gl.getUniformLocation(this.program, 'u_textureBounds');
        this.textureLocation = this.gl.getUniformLocation(this.program, 'u_texture');

        // Clean up individual shaders after linking (frees driver memory)
        this.gl.detachShader(this.program, vertexShader);
        this.gl.detachShader(this.program, fragmentShader);
        this.gl.deleteShader(vertexShader);
        this.gl.deleteShader(fragmentShader);
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

        // Unit quad (0,0) to (1,1)
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

    resize() {
        super.resize();

        if (this.gl) {
            this.gl.viewport(0, 0, this.canvas.width, this.canvas.height);
        }
    }

    uploadTextureFromBitmap(tileId: string, bitmap: ImageBitmap): WebGLTexture | undefined {
        if (!this.gl || !this.program) return undefined;

        if (this.textureCache.has(tileId)) {
            return this.textureCache.get(tileId)!;
        }

        const texture = this.gl.createTexture();
        if (!texture) return undefined;

        this.gl.bindTexture(this.gl.TEXTURE_2D, texture);

        this.gl.texImage2D(
            this.gl.TEXTURE_2D,
            0,
            this.gl.RGBA,
            this.gl.RGBA,
            this.gl.UNSIGNED_BYTE,
            bitmap
        );

        this.gl.texParameteri(this.gl.TEXTURE_2D, this.gl.TEXTURE_WRAP_S, this.gl.CLAMP_TO_EDGE);
        this.gl.texParameteri(this.gl.TEXTURE_2D, this.gl.TEXTURE_WRAP_T, this.gl.CLAMP_TO_EDGE);
        this.gl.texParameteri(this.gl.TEXTURE_2D, this.gl.TEXTURE_MIN_FILTER, this.gl.LINEAR_MIPMAP_LINEAR);
        this.gl.texParameteri(this.gl.TEXTURE_2D, this.gl.TEXTURE_MAG_FILTER, this.gl.LINEAR);
        this.gl.generateMipmap(this.gl.TEXTURE_2D);

        this.textureCache.set(tileId, texture);
        return texture;
    }

    private renderTile(tile: TileRenderData, mvpMatrix: Float32Array, expand: number) {
        if (!this.gl || !this.program || !this.textureLocation || !this.combinedMatrixLocation || !this.textureBoundsLocation) return;

        let texture = this.textureCache.get(tile.id);
        if (!texture) {
            texture = this.uploadTextureFromBitmap(tile.id, tile.image);
            if (!texture) return;
        }

        // Per-edge expand: skip expand at image edges to prevent sub-pixel
        // fringe oscillation. Only expand between adjacent tiles (seam prevention).
        const eL = tile.isEdgeLeft ? 0 : expand;
        const eT = tile.isEdgeTop ? 0 : expand;
        const eR = tile.isEdgeRight ? 0 : expand;
        const eB = tile.isEdgeBottom ? 0 : expand;

        mat4.identity(this.reusableModelMatrix);
        mat4.translate(this.reusableModelMatrix, this.reusableModelMatrix, [
            tile.x - eL,
            tile.y - eT,
            tile.z
        ]);
        mat4.scale(this.reusableModelMatrix, this.reusableModelMatrix, [
            tile.width + eL + eR,
            tile.height + eT + eB,
            1
        ]);

        mat4.multiply(this.reusableCombinedMatrix, mvpMatrix as mat4, this.reusableModelMatrix);

        this.gl.activeTexture(this.gl.TEXTURE0);
        this.gl.bindTexture(this.gl.TEXTURE_2D, texture);
        this.gl.uniform1i(this.textureLocation, 0);

        this.gl.uniformMatrix4fv(this.combinedMatrixLocation, false, this.reusableCombinedMatrix);

        const texLeft = tile.textureLeft ?? 0.0;
        const texTop = tile.textureTop ?? 0.0;
        const texRight = tile.textureRight ?? 1.0;
        const texBottom = tile.textureBottom ?? 1.0;
        this.gl.uniform4f(this.textureBoundsLocation, texLeft, texTop, texRight, texBottom);

        this.gl.drawArrays(this.gl.TRIANGLES, 0, 6);
    }

    render(viewport: Viewport, tiles: TileRenderData[]) {
        if (!this.gl || !this.program) return;

        const mvpMatrix = this.getMVPMatrix(
            viewport.centerX,
            viewport.centerY,
            this.canvas.width,
            this.canvas.height,
            viewport.cameraZ,
            viewport.getFovRadians(),
            viewport.near,
            viewport.far
        );

        this.gl.clearColor(this.clearColor.r, this.clearColor.g, this.clearColor.b, 1.0);
        this.gl.clear(this.gl.COLOR_BUFFER_BIT);
        this.gl.viewport(0, 0, this.canvas.width, this.canvas.height);

        this.gl.useProgram(this.program);

        if (!this.vertexBuffer || !this.texCoordBuffer ||
            this.positionLocation === undefined || this.texCoordLocation === undefined) {
            return;
        }

        this.gl.bindBuffer(this.gl.ARRAY_BUFFER, this.vertexBuffer);
        this.gl.enableVertexAttribArray(this.positionLocation);
        this.gl.vertexAttribPointer(this.positionLocation, 3, this.gl.FLOAT, false, 0, 0);

        this.gl.bindBuffer(this.gl.ARRAY_BUFFER, this.texCoordBuffer);
        this.gl.enableVertexAttribArray(this.texCoordLocation);
        this.gl.vertexAttribPointer(this.texCoordLocation, 2, this.gl.FLOAT, false, 0, 0);

        // Expand each tile quad by 0.5 physical pixels to prevent border wavering
        const expand = 0.5 / (viewport.scale * this.devicePixelRatio);

        for (const tile of tiles) {
            this.renderTile(tile, mvpMatrix, expand);
        }
    }

    destroyTexture(tileId: string) {
        const texture = this.textureCache.get(tileId);
        if (texture && this.gl) {
            this.gl.deleteTexture(texture);
            this.textureCache.delete(tileId);
        }
    }

    setVideoSource(_video: HTMLVideoElement | null): void {
        // Video overlay not supported in WebGL fallback
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
