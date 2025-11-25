
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

/**
 * Creates a perspective projection matrix
 * Maps from camera view space to clip space with perspective division
 */
function createPerspectiveMatrix(
    fovDegrees: number,
    aspectRatio: number,
    near: number,
    far: number
): Float32Array {
    const fovRadians = (fovDegrees * Math.PI) / 180;
    const projection = mat4.create();
    mat4.perspective(projection, fovRadians, aspectRatio, near, far);
    return projection as Float32Array;
}

/**
 * Creates a view matrix (camera transformation)
 * Positions the camera in world space looking at the image
 */
function createViewMatrix(
    centerX: number,
    centerY: number,
    cameraZ: number,
    imageWidth: number,
    imageHeight: number,
    scale: number
): Float32Array {
    // Calculate where the camera should look in scaled world space
    // Since we scale tile positions, we must also scale camera position
    const lookAtX = centerX * imageWidth * scale;
    const lookAtY = centerY * imageHeight * scale;
    // Image plane is at Z=0

    // Camera position
    const cameraX = lookAtX;
    const cameraY = lookAtY;
    // cameraZ is passed in (distance from image plane)

    // View matrix with Y-axis flip to match screen coordinates
    // In WebGPU/OpenGL, Y increases upward, but in screen space Y increases downward
    // We flip Y in the view matrix to correct this
    const view = mat4.create();

    // Create translation
    mat4.translate(view, view, [-cameraX, cameraY, -cameraZ]);

    // Apply Y-axis flip
    mat4.scale(view, view, [1, -1, 1]);

    return view as Float32Array;
}

/**
 * Multiplies two 4x4 matrices (column-major order)
 */
function multiplyMatrices(a: Float32Array, b: Float32Array): Float32Array {
    const result = mat4.create();
    mat4.multiply(result, a as mat4, b as mat4);
    return result as Float32Array;
}

/**
 * Creates a complete 3D transformation matrix for the IIIF viewer
 * This creates a true model-view-projection (MVP) matrix with perspective
 */
function create3DTransformMatrix(
    centerX: number,
    centerY: number,
    imageWidth: number,
    imageHeight: number,
    canvasWidth: number,
    canvasHeight: number,
    cameraZ: number,
    fov: number,
    near: number,
    far: number,
    scale: number
): Float32Array {
    // Create perspective projection matrix
    const aspectRatio = canvasWidth / canvasHeight;
    const projection = createPerspectiveMatrix(fov, aspectRatio, near, far);

    // Create view matrix (camera position and orientation)
    const view = createViewMatrix(centerX, centerY, cameraZ, imageWidth, imageHeight, scale);

    // Combine projection * view
    const vp = multiplyMatrices(projection, view);

    return vp;
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
    private depthTexture?: GPUTexture;
    private depthFormat: GPUTextureFormat = 'depth24plus';

    // Shared storage buffer for all tile uniforms
    private storageBuffer?: GPUBuffer;
    private storageBufferSize: number = 160 * 1000; // Support up to 1000 tiles (160 bytes per tile)

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
                depthCompare: 'less',  // Closer fragments pass the depth test
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
        if (!this.device || !this.pipeline || !this.sampler || !this.storageBuffer) return undefined;

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

        // Apply viewport scale to model matrices to achieve zoom effect
        const physicalScale = viewport.scale * this.devicePixelRatio;

        // Calculate the combined Model-View-Projection (MVP) matrix for the scene
        // Keep camera at fixed Z distance, but scale camera X/Y to match scaled tile positions
        const mvpMatrix = create3DTransformMatrix(
            viewport.centerX,
            viewport.centerY,
            image.width,
            image.height,
            this.canvas.width,
            this.canvas.height,
            viewport.cameraZ,
            viewport.fov,
            viewport.near,
            viewport.far,
            physicalScale
        );

        // Prepare all tiles (including thumbnail)
        const allTiles = thumbnail ? [thumbnail, ...tiles] : tiles;

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

            // Create model matrix for this specific tile
            // Apply viewport scale to match zoom level - this makes tiles appear larger/smaller
            const modelMatrix = mat4.create();
            mat4.translate(modelMatrix, modelMatrix, [
                tile.x * physicalScale,
                tile.y * physicalScale,
                tile.z
            ]);
            mat4.scale(modelMatrix, modelMatrix, [
                tile.width * physicalScale,
                tile.height * physicalScale,
                1
            ]);

            // Pack data with correct alignment
            uniformData.set(mvpMatrix, offset);           // 16 floats: mvpMatrix
            uniformData.set(modelMatrix, offset + 16);    // 16 floats: modelMatrix
            uniformData[offset + 32] = tile.x;            // tilePosition.x
            uniformData[offset + 33] = tile.y;            // tilePosition.y
            uniformData[offset + 34] = 0.0;               // _padding0.x
            uniformData[offset + 35] = 0.0;               // _padding0.y
            uniformData[offset + 36] = tile.width;        // tileSize.x
            uniformData[offset + 37] = tile.height;       // tileSize.y
            uniformData[offset + 38] = 0.0;               // _padding1.x
            uniformData[offset + 39] = 0.0;               // _padding1.y
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
