
/// <reference types="@webgpu/types" />
import { mat4 } from 'gl-matrix';
import { IIIFImage } from './iiif-image.js';
import { Viewport } from './iiif-view.js';
import ShaderModule from './iiif-shader.wgsl?raw';

interface TileRenderData {
    id: string;
    image: ImageBitmap;
    x: number;
    y: number;
    z: number;  // Z position in world space (default 0 for image plane)
    width: number;
    height: number;
}

// Note: Matrix creation functions moved into WebGPURenderer class
// to enable caching and reuse. See getPerspectiveMatrix() and getMVPMatrix().

export class WebGPURenderer {
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

    // Mipmap generation pipeline
    private mipmapPipeline?: GPURenderPipeline;
    private mipmapSampler?: GPUSampler;

    // Shared storage buffer for all tile uniforms
    private storageBuffer?: GPUBuffer;
    private storageBufferSize: number = 160 * 1000; // Support up to 1000 tiles (160 bytes per tile)

    // Texture cache: tileId -> GPUTexture
    private textureCache: Map<string, GPUTexture> = new Map();
    private bindGroupCache: Map<string, GPUBindGroup> = new Map();

    // Matrix caching for performance
    private cachedMVPMatrix?: Float32Array;
    private cachedPerspectiveMatrix?: Float32Array;
    private mvpCacheKey: string = '';
    private perspectiveCacheKey: string = '';

    // Reusable matrix objects to avoid allocations
    private reusableVP: mat4 = mat4.create();
    private reusableModelMatrix: mat4 = mat4.create();

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
        this.mvpCacheKey = '';
        this.perspectiveCacheKey = '';
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
     */
    private getPerspectiveMatrix(fov: number, aspectRatio: number, near: number, far: number): Float32Array {
        const cacheKey = `${fov}_${aspectRatio}_${near}_${far}`;

        if (this.perspectiveCacheKey === cacheKey && this.cachedPerspectiveMatrix) {
            return this.cachedPerspectiveMatrix;
        }

        // Cache miss - recalculate
        const projection = mat4.create();
        const fovRadians = (fov * Math.PI) / 180;
        mat4.perspective(projection, fovRadians, aspectRatio, near, far);

        this.cachedPerspectiveMatrix = projection as Float32Array;
        this.perspectiveCacheKey = cacheKey;

        return this.cachedPerspectiveMatrix;
    }

    /**
     * Get or create cached MVP matrix
     * Only recalculates when viewport parameters change
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
        // Create cache key from all parameters that affect the MVP matrix
        // Round to 6 decimals for smooth animations while avoiding float precision issues
        const cacheKey = `${centerX.toFixed(6)}_${centerY.toFixed(6)}_${imageWidth}_${imageHeight}_${canvasWidth}_${canvasHeight}_${cameraZ.toFixed(2)}_${fov}_${near}_${far}`;

        if (this.mvpCacheKey === cacheKey && this.cachedMVPMatrix) {
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
        this.mvpCacheKey = cacheKey;

        return this.cachedMVPMatrix;
    }

    private createSampler() {
        if (!this.device) return;

        this.sampler = this.device.createSampler({
            magFilter: 'linear',
            minFilter: 'linear',
            mipmapFilter: 'linear',
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

    private createMipmapPipeline() {
        if (!this.device) return;

        // Create sampler for mipmap generation (linear filtering)
        this.mipmapSampler = this.device.createSampler({
            magFilter: 'linear',
            minFilter: 'linear',
            mipmapFilter: 'linear',
        });

        // Simple shader for downsampling (blit with linear filtering)
        const mipmapShader = `
            struct VertexOutput {
                @builtin(position) position: vec4f,
                @location(0) texCoord: vec2f,
            }

            @vertex
            fn vs_main(@builtin(vertex_index) vertexIndex: u32) -> VertexOutput {
                var output: VertexOutput;

                // Full-screen triangle
                let x = f32((vertexIndex & 1u) << 2u);
                let y = f32((vertexIndex & 2u) << 1u);

                output.position = vec4f(x - 1.0, 1.0 - y, 0.0, 1.0);
                output.texCoord = vec2f(x * 0.5, y * 0.5);

                return output;
            }

            @group(0) @binding(0) var mipSampler: sampler;
            @group(0) @binding(1) var mipTexture: texture_2d<f32>;

            @fragment
            fn fs_main(input: VertexOutput) -> @location(0) vec4f {
                return textureSample(mipTexture, mipSampler, input.texCoord);
            }
        `;

        const shaderModule = this.device.createShaderModule({
            label: 'Mipmap Generation Shader',
            code: mipmapShader,
        });

        const pipelineLayout = this.device.createPipelineLayout({
            bindGroupLayouts: [
                this.device.createBindGroupLayout({
                    entries: [
                        {
                            binding: 0,
                            visibility: GPUShaderStage.FRAGMENT,
                            sampler: { type: 'filtering' }
                        },
                        {
                            binding: 1,
                            visibility: GPUShaderStage.FRAGMENT,
                            texture: { sampleType: 'float' }
                        }
                    ]
                })
            ]
        });

        this.mipmapPipeline = this.device.createRenderPipeline({
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
                }]
            },
            primitive: {
                topology: 'triangle-list',
            },
        });
    }

    uploadTextureFromBitmap(tileId: string, bitmap: ImageBitmap): GPUTexture | undefined {
        if (!this.device || !this.pipeline || !this.sampler || !this.storageBuffer) return undefined;

        // Check if texture already exists
        if (this.textureCache.has(tileId)) {
            return this.textureCache.get(tileId)!;
        }

        // Calculate mipmap levels for the texture
        const mipLevelCount = Math.floor(Math.log2(Math.max(bitmap.width, bitmap.height))) + 1;

        // Create texture with mipmaps
        const texture = this.device.createTexture({
            size: [bitmap.width, bitmap.height, 1],
            format: this.format,
            mipLevelCount: mipLevelCount,
            usage: GPUTextureUsage.TEXTURE_BINDING |
                   GPUTextureUsage.COPY_DST |
                   GPUTextureUsage.RENDER_ATTACHMENT,
        });

        // Upload bitmap to texture (base level only)
        this.device.queue.copyExternalImageToTexture(
            { source: bitmap },
            { texture: texture, mipLevel: 0 },
            [bitmap.width, bitmap.height]
        );

        // Generate mipmaps using GPU rendering
        this.generateMipmaps(texture, bitmap.width, bitmap.height, mipLevelCount);

        // Cache the texture
        this.textureCache.set(tileId, texture);

        // Pre-create bind group for this texture
        const bindGroup = this.device.createBindGroup({
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
                    resource: texture.createView()
                }
            ]
        });
        this.bindGroupCache.set(tileId, bindGroup);

        return texture;
    }

    /**
     * Generate mipmaps for a texture by rendering progressively smaller levels
     * Uses GPU downsampling for high-quality mipmaps
     */
    private generateMipmaps(texture: GPUTexture, _width: number, _height: number, mipLevelCount: number) {
        if (!this.device || mipLevelCount <= 1) return;

        // Create a simple blit pipeline for mipmap generation if not already created
        if (!this.mipmapPipeline) {
            this.createMipmapPipeline();
        }

        if (!this.mipmapPipeline || !this.mipmapSampler) return;

        const commandEncoder = this.device.createCommandEncoder({
            label: 'Mipmap Generator'
        });

        // Generate each mip level by downsampling the previous level
        for (let mipLevel = 1; mipLevel < mipLevelCount; mipLevel++) {
            const srcView = texture.createView({
                baseMipLevel: mipLevel - 1,
                mipLevelCount: 1
            });

            const dstView = texture.createView({
                baseMipLevel: mipLevel,
                mipLevelCount: 1
            });

            // Create bind group for this mip level
            const bindGroup = this.device.createBindGroup({
                layout: this.mipmapPipeline.getBindGroupLayout(0),
                entries: [
                    {
                        binding: 0,
                        resource: this.mipmapSampler
                    },
                    {
                        binding: 1,
                        resource: srcView
                    }
                ]
            });

            // Render pass to generate this mip level
            const renderPass = commandEncoder.beginRenderPass({
                colorAttachments: [{
                    view: dstView,
                    loadOp: 'clear',
                    storeOp: 'store',
                    clearValue: { r: 0, g: 0, b: 0, a: 0 }
                }]
            });

            renderPass.setPipeline(this.mipmapPipeline);
            renderPass.setBindGroup(0, bindGroup);
            renderPass.draw(6, 1, 0, 0); // Full-screen quad
            renderPass.end();
        }

        this.device.queue.submit([commandEncoder.finish()]);
    }


    private renderTile(
        renderPass: GPURenderPassEncoder,
        tile: TileRenderData,
        tileIndex: number
    ) {
        if (!this.device) return;

        // Get bind group from cache (should already be created during texture upload)
        let bindGroup = this.bindGroupCache.get(tile.id);

        if (!bindGroup) {
            // Fallback: upload texture and create bind group if not found (shouldn't normally happen)
            this.uploadTextureFromBitmap(tile.id, tile.image);
            bindGroup = this.bindGroupCache.get(tile.id);
            if (!bindGroup) {
                return;
            }
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

        // Batch write all tile uniforms to storage buffer ONCE
        // WGSL struct layout (with proper alignment):
        // mat4x4<f32> mvpMatrix:      64 bytes (16 floats) - offset 0
        // mat4x4<f32> modelMatrix:    64 bytes (16 floats) - offset 64
        // vec2<f32> tilePosition:     8 bytes (2 floats)   - offset 128
        // vec2<f32> _padding0:        8 bytes (2 floats)   - offset 136
        // vec2<f32> tileSize:         8 bytes (2 floats)   - offset 144
        // vec2<f32> _padding1:        8 bytes (2 floats)   - offset 152
        // Total per tile: 160 bytes = 40 floats
        const floatsPerTile = 40;
        const uniformData = new Float32Array(allTiles.length * floatsPerTile);

        for (let i = 0; i < allTiles.length; i++) {
            const tile = allTiles[i];
            const offset = i * floatsPerTile;

            // Reuse model matrix object instead of creating new one
            // Work in image pixel coordinates - no scaling needed
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

            // Pack data with correct alignment
            uniformData.set(mvpMatrix, offset);                      // 16 floats: mvpMatrix
            uniformData.set(this.reusableModelMatrix, offset + 16);  // 16 floats: modelMatrix
            uniformData[offset + 32] = tile.x;                       // tilePosition.x
            uniformData[offset + 33] = tile.y;                       // tilePosition.y
            uniformData[offset + 34] = 0.0;                          // _padding0.x
            uniformData[offset + 35] = 0.0;                          // _padding0.y
            uniformData[offset + 36] = tile.width;                   // tileSize.x
            uniformData[offset + 37] = tile.height;                  // tileSize.y
            uniformData[offset + 38] = 0.0;                          // _padding1.x
            uniformData[offset + 39] = 0.0;                          // _padding1.y
        }

        // Single write operation for all tile data
        this.device.queue.writeBuffer(this.storageBuffer, 0, uniformData);

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
