
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

    // Calculate the scaled image size
    const scaledImageWidth = imageWidth * scale;
    const scaledImageHeight = imageHeight * scale;

    // If the scaled image is smaller than the canvas, add centering offset
    const centerOffsetX = scaledImageWidth < canvasWidth ? (canvasWidth - scaledImageWidth) / 2 : 0;
    const centerOffsetY = scaledImageHeight < canvasHeight ? (canvasHeight - scaledImageHeight) / 2 : 0;

    // Translate to move viewport top-left to origin, then add centering offset
    const tx = -viewportMinX * scale + centerOffsetX;
    const ty = -viewportMinY * scale + centerOffsetY;

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
    private uniformBuffer?: GPUBuffer;
    private sampler?: GPUSampler;
    private format: GPUTextureFormat = 'bgra8unorm';

    // Texture cache: tileId -> GPUTexture
    private textureCache: Map<string, GPUTexture> = new Map();
    private bindGroupCache: Map<string, GPUBindGroup> = new Map();
    private uniformBufferCache: Map<string, GPUBuffer> = new Map();

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
            this.createBuffers();
            this.createSampler();

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
                            buffer: { type: 'uniform' }
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

    private createBuffers() {
        if (!this.device) return;

        // Create uniform buffer
        // Layout: viewMatrix (16 floats) + projectionMatrix (16 floats) + tilePosition (2+2 pad) + tileSize (2+2 pad)
        // Total: 16 + 16 + 4 + 4 = 40 floats = 160 bytes
        // Using 256 bytes for alignment and safety
        this.uniformBuffer = this.device.createBuffer({
            size: 256,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
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

    private getOrCreateBindGroup(tileId: string, texture: GPUTexture): GPUBindGroup | undefined {
        if (!this.device || !this.pipeline || !this.sampler) {
            return undefined;
        }

        // Check cache
        if (this.bindGroupCache.has(tileId)) {
            return this.bindGroupCache.get(tileId)!;
        }

        // Create uniform buffer for this tile
        const uniformBuffer = this.device.createBuffer({
            size: 256,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        });
        this.uniformBufferCache.set(tileId, uniformBuffer);

        // Create new bind group
        const bindGroup = this.device.createBindGroup({
            layout: this.pipeline.getBindGroupLayout(0),
            entries: [
                {
                    binding: 0,
                    resource: { buffer: uniformBuffer }
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
        return bindGroup;
    }

    render(viewport: Viewport, image: IIIFImage, tiles: TileRenderData[]) {
        if (!this.device || !this.context || !this.pipeline) {
            return;
        }

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

        // Render each tile
        for (const tile of tiles) {
            // Get texture from cache (should already be uploaded)
            let texture = this.textureCache.get(tile.id);
            if (!texture) {
                // Fallback: upload if not found (shouldn't normally happen)
                texture = this.uploadTextureFromBitmap(tile.id, tile.image);
                if (!texture) {
                    continue;
                }
            }

            // Get or create bind group
            let bindGroup = this.bindGroupCache.get(tile.id);
            if (!bindGroup) {
                bindGroup = this.getOrCreateBindGroup(tile.id, texture);
                if (!bindGroup) {
                    continue;
                }
            }

            // Update uniforms for this tile
            // Note: viewport.scale is in CSS pixels, so multiply by DPR for physical pixels
            const physicalScale = viewport.scale * this.devicePixelRatio;

            // Create view matrix (handles pan and zoom via scale)
            const viewMatrix = createViewMatrix(
                viewport.centerX,
                viewport.centerY,
                physicalScale,
                image.width,
                image.height,
                this.canvas.width,
                this.canvas.height
            );

            // Create projection matrix (orthographic projection)
            const projectionMatrix = createProjectionMatrix(
                this.canvas.width,
                this.canvas.height
            );

            // Pack uniforms: 2 mat4x4 (32 floats) + tile data (8 floats)
            const uniformData = new Float32Array([
                ...viewMatrix,                          // viewMatrix (16 floats)
                ...projectionMatrix,                    // projectionMatrix (16 floats)
                tile.x, tile.y,                         // tilePosition (2 floats)
                0.0, 0.0,                               // padding (2 floats)
                tile.width, tile.height,                // tileSize (2 floats)
                0.0, 0.0,                               // padding (2 floats)
            ]);
            if (tile.id == '2-3-5') {
                //console.log(`Uploading uniforms for tile ${tile.id}:`);
                //console.log(` viewportCenter: (${viewport.centerX}, ${viewport.centerY})`);
                //console.log(` viewportScale: ${physicalScale}`);
                console.log(` canvasSize: (${this.canvas.width}, ${this.canvas.height})`);
                //console.log(` imageSize: (${image.width}, ${image.height})`);
                //console.log(` tilePosition: (${tile.x}, ${tile.y})`);
                //console.log(` tileSize: (${tile.width}, ${tile.height})`);
            }

            // Get the uniform buffer for this tile
            const tileUniformBuffer = this.uniformBufferCache.get(tile.id);
            if (!tileUniformBuffer) {
                console.warn(`No uniform buffer found for tile ${tile.id}`);
                continue;
            }

            // Write uniforms to this tile's specific buffer
            this.device.queue.writeBuffer(tileUniformBuffer, 0, uniformData);

            // Draw the tile
            renderPass.setBindGroup(0, bindGroup);
            renderPass.draw(6, 1, 0, 0);
        }

        renderPass.end();
        const commandBuffer = commandEncoder.finish();
        this.device.queue.submit([commandBuffer]);
    }

    destroyTexture(tileId: string) {
        // Destroy a specific texture, bind group, and uniform buffer
        const texture = this.textureCache.get(tileId);
        if (texture) {
            texture.destroy();
            this.textureCache.delete(tileId);
        }
        const uniformBuffer = this.uniformBufferCache.get(tileId);
        if (uniformBuffer) {
            uniformBuffer.destroy();
            this.uniformBufferCache.delete(tileId);
        }
        this.bindGroupCache.delete(tileId);
    }

    clearTextureCache() {
        // Destroy all cached textures and uniform buffers
        for (const texture of this.textureCache.values()) {
            texture.destroy();
        }
        for (const uniformBuffer of this.uniformBufferCache.values()) {
            uniformBuffer.destroy();
        }
        this.textureCache.clear();
        this.uniformBufferCache.clear();
        this.bindGroupCache.clear();
    }

    destroy() {
        this.clearTextureCache();
        this.uniformBuffer?.destroy();
        this.device?.destroy();
    }
}
