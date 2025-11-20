
/// <reference types="@webgpu/types" />
import { IIIFImage } from './iiif-image.js';
import { Viewport } from './iiif-view.js';
import ShaderModule from './iiif-shader.wgsl?raw';

interface TileRenderData {
    id: string;
    image: ImageBitmap;
    x: number;
    y: number;
    width: number;
    height: number;
}

// Matrix helper functions
function createViewMatrix(centerX: number, centerY: number, scale: number, imageWidth: number, imageHeight: number, canvasWidth: number, canvasHeight: number): Float32Array {
    // The view matrix transforms from image space to view space
    // It handles pan (translation) and zoom (scale)

    // Calculate viewport center in image pixels
    const viewportCenterX = centerX * imageWidth;
    const viewportCenterY = centerY * imageHeight;

    // Calculate how much of the image is visible (in image pixels)
    const viewportWidth = canvasWidth / scale;
    const viewportHeight = canvasHeight / scale;

    // Calculate the visible area bounds in image space
    const viewportMinX = viewportCenterX - viewportWidth / 2;
    const viewportMinY = viewportCenterY - viewportHeight / 2;

    // Translate to move viewport top-left to origin
    const tx = -viewportMinX * scale;
    const ty = -viewportMinY * scale;

    // Column-major order (WGSL uses column-major)
    return new Float32Array([
        scale, 0,     0, 0,  // Column 0 (scale for zoom)
        0,     scale, 0, 0,  // Column 1
        0,     0,     1, 0,  // Column 2
        tx, ty, 0, 1   // Column 3 (translation already includes scale)
    ]);
}

function createProjectionMatrix(canvasWidth: number, canvasHeight: number): Float32Array {
    // Orthographic projection that maps canvas pixel coordinates to clip space [-1, 1]
    // Also flips Y axis (image space has Y=0 at top, clip space has Y=-1 at top)

    const scaleX = 2.0 / canvasWidth;
    const scaleY = -2.0 / canvasHeight;  // Negative to flip Y

    // Column-major order
    return new Float32Array([
        scaleX, 0,      0, 0,  // Column 0
        0,      scaleY, 0, 0,  // Column 1
        0,      0,      1, 0,  // Column 2
        -1,     1,      0, 1   // Column 3 (translate to -1..1 range)
    ]);
}

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

    // Shared storage buffer for all tile uniforms
    private storageBuffer?: GPUBuffer;
    private storageBufferSize: number = 256 * 1000; // Support up to 1000 tiles

    // Texture cache: tileId -> GPUTexture
    private textureCache: Map<string, GPUTexture> = new Map();
    private bindGroupCache: Map<string, GPUBindGroup> = new Map();

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
        });
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

    uploadTextureFromBitmap(tileId: string, bitmap: ImageBitmap): GPUTexture | undefined {
        if (!this.device) return undefined;

        // Check if texture already exists
        if (this.textureCache.has(tileId)) {
            return this.textureCache.get(tileId)!;
        }

        // Create texture
        const texture = this.device.createTexture({
            size: [bitmap.width, bitmap.height, 1],
            format: this.format,
            usage: GPUTextureUsage.TEXTURE_BINDING |
                   GPUTextureUsage.COPY_DST |
                   GPUTextureUsage.RENDER_ATTACHMENT,
        });

        // Upload bitmap to texture
        this.device.queue.copyExternalImageToTexture(
            { source: bitmap },
            { texture: texture },
            [bitmap.width, bitmap.height]
        );

        // Cache the texture
        this.textureCache.set(tileId, texture);

        return texture;
    }


    private renderTile(
        renderPass: GPURenderPassEncoder,
        tile: TileRenderData,
        tileIndex: number
    ) {
        if (!this.device || !this.storageBuffer || !this.sampler || !this.pipeline) return;

        // Get texture from cache (should already be uploaded)
        let texture = this.textureCache.get(tile.id);
        if (!texture) {
            // Fallback: upload if not found (shouldn't normally happen)
            texture = this.uploadTextureFromBitmap(tile.id, tile.image);
            if (!texture) {
                return;
            }
        }

        // Create bind group for this texture (cache by texture, not by tile)
        const textureKey = tile.id;
        let bindGroup = this.bindGroupCache.get(textureKey);

        if (!bindGroup) {
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
                        resource: texture.createView()
                    }
                ]
            });
            this.bindGroupCache.set(textureKey, bindGroup);
        }

        // Draw the tile using instanced rendering with tileIndex
        renderPass.setBindGroup(0, bindGroup);
        renderPass.draw(6, 1, 0, tileIndex);
    }

    render(viewport: Viewport, image: IIIFImage, tiles: TileRenderData[], thumbnail?: TileRenderData) {
        if (!this.device || !this.context || !this.pipeline || !this.storageBuffer) {
            return;
        }

        // Calculate view and projection matrices ONCE for all tiles
        const physicalScale = viewport.scale * this.devicePixelRatio;
        const viewMatrix = createViewMatrix(
            viewport.centerX,
            viewport.centerY,
            physicalScale,
            image.width,
            image.height,
            this.canvas.width,
            this.canvas.height
        );
        const projectionMatrix = createProjectionMatrix(
            this.canvas.width,
            this.canvas.height
        );

        // Prepare all tiles (including thumbnail)
        const allTiles = thumbnail ? [thumbnail, ...tiles] : tiles;

        // Batch write all tile uniforms to storage buffer ONCE
        const uniformData = new Float32Array(allTiles.length * 40); // 40 floats per tile (256 bytes / 4 bytes per float)

        for (let i = 0; i < allTiles.length; i++) {
            const tile = allTiles[i];
            const offset = i * 40;

            // Pack: viewMatrix (16) + projectionMatrix (16) + tilePosition (2) + padding (2) + tileSize (2) + padding (2)
            uniformData.set(viewMatrix, offset);
            uniformData.set(projectionMatrix, offset + 16);
            uniformData[offset + 32] = tile.x;
            uniformData[offset + 33] = tile.y;
            uniformData[offset + 34] = 0.0; // padding
            uniformData[offset + 35] = 0.0; // padding
            uniformData[offset + 36] = tile.width;
            uniformData[offset + 37] = tile.height;
            uniformData[offset + 38] = 0.0; // padding
            uniformData[offset + 39] = 0.0; // padding
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
            }]
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
