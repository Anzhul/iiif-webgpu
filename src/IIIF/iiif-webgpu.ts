
/// <reference types="@webgpu/types" />
import { mat4 } from 'gl-matrix';
import { IIIFImage } from './iiif-image.js';
import { Viewport } from './iiif-view.js';
import type { IIIFRenderer, TileRenderData, WorldTileRenderData } from './iiif-renderer.js';
import ShaderModule from './iiif-shader.wgsl?raw';

// Note: Matrix creation functions moved into WebGPURenderer class
// to enable caching and reuse. See getPerspectiveMatrix() and getMVPMatrix().

export class WebGPURenderer implements IIIFRenderer {
    canvas: HTMLCanvasElement;
    container: HTMLElement;
    devicePixelRatio: number;

    // WebGPU objects
    private device?: GPUDevice;
    private context?: GPUCanvasContext;
    private pipeline?: GPURenderPipeline;
    private sampler?: GPUSampler;
    private format: GPUTextureFormat = 'bgra8unorm';
    private depthTexture?: GPUTexture;
    private depthFormat: GPUTextureFormat = 'depth24plus';

    // Shared storage buffer for all tile uniforms
    private storageBuffer?: GPUBuffer;
    private storageBufferSize: number = 64 * 1000; // Support up to 1000 tiles (64 bytes per tile)

    // Reusable buffer for uniform data to avoid per-frame allocations
    private uniformDataBuffer: Float32Array = new Float32Array(new ArrayBuffer(1000 * 16 * 4)); // Pre-allocate for 1000 tiles × 16 floats × 4 bytes

    // Texture cache: tileId -> GPUTexture
    private textureCache: Map<string, GPUTexture> = new Map();
    private bindGroupCache: Map<string, GPUBindGroup> = new Map();

    // Matrix caching for performance - using numeric comparison instead of string keys
    private cachedMVPMatrix?: Float32Array;
    private cachedPerspectiveMatrix?: Float32Array;

    // Cache keys using direct value comparison (faster than string concatenation)
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

        // devicePixelRatio: How many physical pixels per CSS pixel
        this.devicePixelRatio = window.devicePixelRatio || 1;

        // Create canvas element
        this.canvas = document.createElement('canvas');

        // Apply styling - CSS dimensions (logical pixels)
        this.canvas.style.position = 'absolute';
        this.canvas.style.top = '0';
        this.canvas.style.left = '0';
        this.canvas.style.width = '100%';
        this.canvas.style.height = '100%';
        this.canvas.style.display = 'block';
        this.canvas.style.touchAction = 'none';
        this.canvas.style.zIndex = '10';

        // Set canvas internal resolution accounting for device pixel ratio
        this.updateCanvasSize();

        // Append canvas to container
        container.appendChild(this.canvas);
    }

    // Initialize WebGPU asynchronously
    async initialize(): Promise<void> {
        if (!navigator.gpu) {
            console.error('WebGPU is not supported in this browser');
            return;
        }

        try {
            // Request adapter and device
            const adapter = await navigator.gpu.requestAdapter();
            if (!adapter) {
                console.error('Failed to get GPU adapter');
                return;
            }

            this.device = await adapter.requestDevice();

            // Set up error handling
            this.device.addEventListener('uncapturederror', (event) => {
                console.error('WebGPU uncaptured error:', event.error);
            });

            // Configure canvas context
            this.context = this.canvas.getContext('webgpu') as GPUCanvasContext;
            if (!this.context) {
                throw new Error('Failed to get WebGPU context from canvas');
            }

            // Get the preferred format for this device
            const preferredFormat = navigator.gpu.getPreferredCanvasFormat();
            this.format = preferredFormat;
            console.log('Using canvas format:', preferredFormat);

            this.context.configure({
                device: this.device,
                format: preferredFormat,
                alphaMode: 'opaque',
            });

            // Create resources
            await this.createPipeline();
            this.createSampler();
            this.createStorageBuffer();
            this.createDepthTexture();

            console.log('WebGPU initialized successfully');
        } catch (error) {
            console.error('Failed to initialize WebGPU:', error);
        }
    }

    private updateCanvasSize() {
        // Get CSS dimensions
        const displayWidth = this.container.clientWidth;
        const displayHeight = this.container.clientHeight;

        // Scale internal resolution by device pixel ratio for high-DPI displays
        this.canvas.width = Math.floor(displayWidth * this.devicePixelRatio);
        this.canvas.height = Math.floor(displayHeight * this.devicePixelRatio);
    }

    resize() {
        // Update device pixel ratio in case it changed (e.g., window moved to different monitor)
        this.devicePixelRatio = window.devicePixelRatio || 1;
        this.updateCanvasSize();

        // Reconfigure canvas context
        if (this.context && this.device) {
            this.context.configure({
                device: this.device,
                format: this.format,
                alphaMode: 'opaque',
            });
        }

        // Recreate depth texture with new size
        this.createDepthTexture();

        // Invalidate matrix caches since canvas size changed
        this.mvpCache.canvasWidth = NaN;
        this.mvpCache.canvasHeight = NaN;
        this.perspectiveCache.aspectRatio = NaN;
    }

    private async createPipeline() {
        if (!this.device) return;

        const shaderModule = this.device.createShaderModule({
            label: 'Tile Shader Module',
            code: ShaderModule,
        });

        // Check for shader compilation errors
        const compilationInfo = await shaderModule.getCompilationInfo();
        for (const message of compilationInfo.messages) {
            if (message.type === 'error') {
                console.error('Shader compilation error:', message);
            } else if (message.type === 'warning') {
                console.warn('Shader compilation warning:', message);
            }
        }

        const pipelineLayout = this.device.createPipelineLayout({
            bindGroupLayouts: [
                this.device.createBindGroupLayout({
                    entries: [
                        {
                            binding: 0,
                            visibility: GPUShaderStage.VERTEX,
                            buffer: { type: 'read-only-storage' }
                        },
                        {
                            binding: 1,
                            visibility: GPUShaderStage.FRAGMENT,
                            sampler: { type: 'filtering' }
                        },
                        {
                            binding: 2,
                            visibility: GPUShaderStage.FRAGMENT,
                            texture: { sampleType: 'float' }
                        }
                    ]
                })
            ]
        });

        this.pipeline = this.device.createRenderPipeline({
            layout: pipelineLayout,
            vertex: {
                module: shaderModule,
                entryPoint: 'vs_main',
            },
            fragment: {
                module: shaderModule,
                entryPoint: 'fs_main',
                targets: [{
                    format: this.format,
                    blend: {
                        color: {
                            srcFactor: 'src-alpha',
                            dstFactor: 'one-minus-src-alpha',
                            operation: 'add',
                        },
                        alpha: {
                            srcFactor: 'one',
                            dstFactor: 'one-minus-src-alpha',
                            operation: 'add',
                        }
                    }
                }]
            },
            primitive: {
                topology: 'triangle-list',
                cullMode: 'none',  // Disable culling to ensure triangles are visible
            },
            depthStencil: {
                format: this.depthFormat,
                depthWriteEnabled: true,
                depthCompare: 'less',  // Closer fragments pass the depth test (smaller depth = closer to camera)
            },
        });
    }

    private createDepthTexture() {
        if (!this.device) return;

        // Destroy old depth texture if it exists
        if (this.depthTexture) {
            this.depthTexture.destroy();
        }

        // Create new depth texture matching canvas size
        this.depthTexture = this.device.createTexture({
            size: {
                width: this.canvas.width,
                height: this.canvas.height,
                depthOrArrayLayers: 1,
            },
            format: this.depthFormat,
            usage: GPUTextureUsage.RENDER_ATTACHMENT,
        });
    }

    /**
     * Get or create cached perspective matrix
     * Only recalculates when canvas size or FOV changes
     * Optimized: uses direct numeric comparison instead of string concatenation
     */
    private getPerspectiveMatrix(fov: number, aspectRatio: number, near: number, far: number): Float32Array {
        // Fast cache check using direct value comparison (no string allocation)
        if (this.perspectiveCache.fov === fov &&
            this.perspectiveCache.aspectRatio === aspectRatio &&
            this.perspectiveCache.near === near &&
            this.perspectiveCache.far === far &&
            this.cachedPerspectiveMatrix) {
            return this.cachedPerspectiveMatrix;
        }

        // Cache miss - recalculate
        const projection = mat4.create();
        const fovRadians = (fov * Math.PI) / 180;
        mat4.perspective(projection, fovRadians, aspectRatio, near, far);

        this.cachedPerspectiveMatrix = projection as Float32Array;

        // Update cache keys
        this.perspectiveCache.fov = fov;
        this.perspectiveCache.aspectRatio = aspectRatio;
        this.perspectiveCache.near = near;
        this.perspectiveCache.far = far;

        return this.cachedPerspectiveMatrix;
    }

    /**
     * Get or create cached MVP matrix
     * Only recalculates when viewport parameters change
     * Optimized: uses direct numeric comparison instead of expensive string concatenation with toFixed()
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
        // Fast cache check using direct value comparison (no string allocation or toFixed() calls)
        // Round centerX/centerY to avoid cache misses from floating point precision
        const roundedCenterX = Math.round(centerX * 1000000) / 1000000;  // 6 decimals
        const roundedCenterY = Math.round(centerY * 1000000) / 1000000;
        const roundedCameraZ = Math.round(cameraZ * 10000) / 10000;      // 4 decimals

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

        // Cache miss - recalculate
        const aspectRatio = canvasWidth / canvasHeight;
        const projection = this.getPerspectiveMatrix(fov, aspectRatio, near, far);

        // Create view matrix
        const lookAtX = centerX * imageWidth;
        const lookAtY = centerY * imageHeight;
        const cameraX = lookAtX;
        const cameraY = lookAtY;

        const view = mat4.create();
        mat4.translate(view, view, [-cameraX, cameraY, -cameraZ]);
        mat4.scale(view, view, [1, -1, 1]);

        // Combine projection * view using reusable matrix
        mat4.multiply(this.reusableVP, projection as mat4, view as mat4);

        // Store in cache
        this.cachedMVPMatrix = new Float32Array(this.reusableVP);

        // Update cache keys
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

    private createSampler() {
        if (!this.device) return;

        this.sampler = this.device.createSampler({
            magFilter: 'linear',
            minFilter: 'linear',
            addressModeU: 'clamp-to-edge',
            addressModeV: 'clamp-to-edge',
        });
    }

    private createStorageBuffer() {
        if (!this.device) return;

        this.storageBuffer = this.device.createBuffer({
            size: this.storageBufferSize,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
        });
    }

    uploadTextureFromBitmap(tileId: string, bitmap: ImageBitmap): GPUTexture | undefined {
        if (!this.device || !this.pipeline || !this.sampler || !this.storageBuffer) return undefined;

        // Check if texture already exists
        if (this.textureCache.has(tileId)) {
            return this.textureCache.get(tileId)!;
        }

        // Create texture without mipmaps (single level only for performance)
        // Mipmaps disabled: IIIF provides multi-resolution tiles, so GPU downsampling not needed
        const texture = this.device.createTexture({
            size: [bitmap.width, bitmap.height, 1],
            format: this.format,
            mipLevelCount: 1,  // No mipmaps - single level only
            usage: GPUTextureUsage.TEXTURE_BINDING |
                   GPUTextureUsage.COPY_DST |
                   GPUTextureUsage.RENDER_ATTACHMENT,  // Required for copyExternalImageToTexture
        });

        // Upload bitmap to texture
        this.device.queue.copyExternalImageToTexture(
            { source: bitmap },
            { texture: texture, mipLevel: 0 },
            [bitmap.width, bitmap.height]
        );

        // Cache the texture
        this.textureCache.set(tileId, texture);

        // Bind group will be created lazily in renderTile() on first use
        // This spreads GPU object creation across frames instead of blocking upload

        return texture;
    }

    private renderTile(
        renderPass: GPURenderPassEncoder,
        tile: TileRenderData,
        tileIndex: number
    ) {
        if (!this.device || !this.pipeline || !this.sampler || !this.storageBuffer) return;

        // Get or create bind group lazily (created on first render instead of during upload)
        let bindGroup = this.bindGroupCache.get(tile.id);

        if (!bindGroup) {
            // Get texture from cache
            const texture = this.textureCache.get(tile.id);
            if (!texture) {
                // Texture not uploaded yet, try to upload
                this.uploadTextureFromBitmap(tile.id, tile.image);
                const uploadedTexture = this.textureCache.get(tile.id);
                if (!uploadedTexture) return;
            }

            // Create bind group on first use (lazy creation)
            const cachedTexture = this.textureCache.get(tile.id)!;
            bindGroup = this.device.createBindGroup({
                layout: this.pipeline.getBindGroupLayout(0),
                entries: [
                    {
                        binding: 0,
                        resource: { buffer: this.storageBuffer }
                    },
                    {
                        binding: 1,
                        resource: this.sampler
                    },
                    {
                        binding: 2,
                        resource: cachedTexture.createView()
                    }
                ]
            });
            this.bindGroupCache.set(tile.id, bindGroup);
        }

        // Draw the tile using instanced rendering with tileIndex
        renderPass.setBindGroup(0, bindGroup);
        renderPass.draw(6, 1, 0, tileIndex);
    }

    render(viewport: Viewport, image: IIIFImage, tiles: TileRenderData[], thumbnail?: TileRenderData) {
        if (!this.device || !this.context || !this.pipeline || !this.storageBuffer) {
            return;
        }

        // Get cached MVP matrix (only recalculates when viewport changes)
        // Work in image pixel coordinates - zoom is controlled by cameraZ distance
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

        // Prepare all tiles (including thumbnail) and sort by z-depth
        // CRITICAL: Must sort thumbnail together with tiles for consistent render order
        let allTiles: TileRenderData[];
        if (thumbnail) {
            // Combine thumbnail and tiles, then sort by z-depth (back to front: lower z first)
            allTiles = [...tiles, thumbnail].sort((a, b) => a.z - b.z);
        } else {
            allTiles = tiles;
        }

        // Check for storage buffer overflow
        const maxTiles = this.storageBufferSize / 64; // 64 bytes per tile (single mat4x4)
        if (allTiles.length > maxTiles) {
            console.error(`Storage buffer overflow: Trying to render ${allTiles.length} tiles but buffer only supports ${maxTiles} tiles. Truncating to ${maxTiles} tiles.`);
            allTiles = allTiles.slice(0, maxTiles);
        }

        // Batch write all tile uniforms to storage buffer ONCE
        // WGSL struct layout: mat4x4<f32> combinedMatrix (64 bytes = 16 floats per tile)
        const floatsPerTile = 16;

        // Reuse pre-allocated buffer, only process the tiles we need
        for (let i = 0; i < allTiles.length; i++) {
            const tile = allTiles[i];
            const offset = i * floatsPerTile;

            // Create model matrix for this tile (position and scale)
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

            // Pre-multiply: combinedMatrix = MVP × Model (done on CPU once per tile)
            mat4.multiply(this.reusableCombinedMatrix, mvpMatrix as mat4, this.reusableModelMatrix);

            // Pack combined matrix into pre-allocated buffer (16 floats)
            this.uniformDataBuffer.set(this.reusableCombinedMatrix, offset);
        }

        // Single write operation for all tile data (subarray to avoid uploading unused data)
        this.device.queue.writeBuffer(
            this.storageBuffer,
            0,
            this.uniformDataBuffer.buffer,
            0,
            allTiles.length * floatsPerTile * 4  // Convert float count to byte count
        );

        const commandEncoder = this.device.createCommandEncoder();
        const textureView = this.context.getCurrentTexture().createView();

        const renderPass = commandEncoder.beginRenderPass({
            colorAttachments: [{
                view: textureView,
                clearValue: { r: 0.1, g: 0.1, b: 0.1, a: 1.0 },
                loadOp: 'clear',
                storeOp: 'store',
            }],
            depthStencilAttachment: {
                view: this.depthTexture!.createView(),
                depthClearValue: 1.0,  // Clear to max depth (far plane)
                depthLoadOp: 'clear',
                depthStoreOp: 'store',
            }
        });

        renderPass.setPipeline(this.pipeline);

        // Render each tile with its index
        for (let i = 0; i < allTiles.length; i++) {
            this.renderTile(renderPass, allTiles[i], i);
        }

        renderPass.end();
        const commandBuffer = commandEncoder.finish();
        this.device.queue.submit([commandBuffer]);
    }

    /**
     * Render multiple images in world space (unified canvas mode)
     * Tiles include world offset information for positioning
     */
    renderMultiImage(viewport: Viewport, tiles: WorldTileRenderData[]): void {
        if (!this.device || !this.context || !this.pipeline || !this.storageBuffer) {
            return;
        }

        // Get MVP matrix for world space rendering
        // In world space mode, we use worldCenterX/Y instead of normalized coordinates
        const mvpMatrix = this.getWorldSpaceMVPMatrix(viewport);

        // Sort all tiles by z-depth (back to front)
        const sortedTiles = [...tiles].sort((a, b) => a.z - b.z);

        // Check for storage buffer overflow
        const maxTiles = this.storageBufferSize / 64;
        let renderTiles = sortedTiles;
        if (sortedTiles.length > maxTiles) {
            console.warn(`Storage buffer overflow: ${sortedTiles.length} tiles, max ${maxTiles}. Truncating.`);
            renderTiles = sortedTiles.slice(0, maxTiles);
        }

        // Batch write all tile uniforms to storage buffer
        const floatsPerTile = 16;

        for (let i = 0; i < renderTiles.length; i++) {
            const tile = renderTiles[i];
            const offset = i * floatsPerTile;

            // Create model matrix with world offset applied
            mat4.identity(this.reusableModelMatrix);
            mat4.translate(this.reusableModelMatrix, this.reusableModelMatrix, [
                tile.x + tile.worldOffsetX,  // Apply world offset
                tile.y + tile.worldOffsetY,
                tile.z
            ]);
            mat4.scale(this.reusableModelMatrix, this.reusableModelMatrix, [
                tile.width,
                tile.height,
                1
            ]);

            // Pre-multiply: combinedMatrix = MVP × Model
            mat4.multiply(this.reusableCombinedMatrix, mvpMatrix as mat4, this.reusableModelMatrix);

            // Pack into buffer
            this.uniformDataBuffer.set(this.reusableCombinedMatrix, offset);
        }

        // Write to GPU
        this.device.queue.writeBuffer(
            this.storageBuffer,
            0,
            this.uniformDataBuffer.buffer,
            0,
            renderTiles.length * floatsPerTile * 4
        );

        const commandEncoder = this.device.createCommandEncoder();
        const textureView = this.context.getCurrentTexture().createView();

        const renderPass = commandEncoder.beginRenderPass({
            colorAttachments: [{
                view: textureView,
                clearValue: { r: 0.1, g: 0.1, b: 0.1, a: 1.0 },
                loadOp: 'clear',
                storeOp: 'store',
            }],
            depthStencilAttachment: {
                view: this.depthTexture!.createView(),
                depthClearValue: 1.0,
                depthLoadOp: 'clear',
                depthStoreOp: 'store',
            }
        });

        renderPass.setPipeline(this.pipeline);

        // Render each tile
        for (let i = 0; i < renderTiles.length; i++) {
            this.renderTile(renderPass, renderTiles[i], i);
        }

        renderPass.end();
        const commandBuffer = commandEncoder.finish();
        this.device.queue.submit([commandBuffer]);
    }

    /**
     * Get MVP matrix for world space rendering
     * Uses absolute world coordinates instead of normalized image coordinates
     * Uses same approach as single-image mode for consistency
     */
    private getWorldSpaceMVPMatrix(viewport: Viewport): Float32Array {
        // Get perspective matrix
        const aspectRatio = this.canvas.width / this.canvas.height;
        const perspectiveMatrix = this.getPerspectiveMatrix(
            viewport.fov,
            aspectRatio,
            viewport.near,
            viewport.far
        );

        // Create view matrix using same approach as single-image mode
        // This ensures consistent behavior between modes
        const view = mat4.create();
        mat4.translate(view, view, [-viewport.worldCenterX, viewport.worldCenterY, -viewport.cameraZ]);
        mat4.scale(view, view, [1, -1, 1]);  // Flip Y for image coordinates

        // Combine projection * view
        const mvpMatrix = mat4.create();
        mat4.multiply(mvpMatrix, perspectiveMatrix as mat4, view as mat4);

        return mvpMatrix as Float32Array;
    }

    destroyTexture(tileId: string) {
        // Destroy a specific texture and bind group
        const texture = this.textureCache.get(tileId);
        if (texture) {
            texture.destroy();
            this.textureCache.delete(tileId);
        }
        this.bindGroupCache.delete(tileId);
    }

    clearTextureCache() {
        // Destroy all cached textures
        for (const texture of this.textureCache.values()) {
            texture.destroy();
        }
        this.textureCache.clear();
        this.bindGroupCache.clear();
    }

    destroy() {
        this.clearTextureCache();
        this.device?.destroy();
    }
}
