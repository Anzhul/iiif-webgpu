
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
    private _debugLogged: boolean = false;
    private _uniformsLogged: boolean = false;
    private _drawCallCounts?: Set<number>;
    private _textureUploadWarned: boolean = false;
    private _bindGroupWarned: boolean = false;
    private _presentLogged: boolean = false;
    private _lastLoggedScale?: number;

    constructor(container: HTMLElement) {
        console.log(`Initializing WebGPU Renderer for container ${container}`);
        this.container = container;
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

        console.log(`Canvas created with DPR: ${this.devicePixelRatio}, Resolution: ${this.canvas.width}x${this.canvas.height}`);
    }

    // Call this after construction to initialize WebGPU
    async initialize(): Promise<void> {
        await this.initWebGPU();
    }

    private updateCanvasSize() {
        // Get CSS dimensions
        const displayWidth = this.container.clientWidth;
        const displayHeight = this.container.clientHeight;

        // Scale internal resolution by device pixel ratio for crisp rendering
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

    private async initWebGPU() {
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

    private async createPipeline() {
        if (!this.device) return;

        const shaderModule = this.device.createShaderModule({
            label: 'Tile Renderer Shader',
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
        // We have: 2 + 1 + 1(pad) + 2 + 2(pad) + 2 + 2(pad) + 2 + 2(pad) + 2 + 2(pad) = 20 floats = 80 bytes
        // Round up to 256 for safety and alignment
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

        // Debug logging (only log once)
        if (!this._debugLogged && tiles.length > 0) {
            console.log('=== Render Debug Info ===');
            console.log('Viewport:', {
                centerX: viewport.centerX,
                centerY: viewport.centerY,
                scale: viewport.scale,
                containerSize: { w: viewport.containerWidth, h: viewport.containerHeight }
            });

            // Calculate what the viewport is actually looking at
            const scaledWidth = viewport.containerWidth / viewport.scale;
            const scaledHeight = viewport.containerHeight / viewport.scale;
            const left = (viewport.centerX * image.width) - (scaledWidth / 2);
            const top = (viewport.centerY * image.height) - (scaledHeight / 2);

            console.log('Viewport bounds in image pixels:', {
                left, top,
                right: left + scaledWidth,
                bottom: top + scaledHeight,
                width: scaledWidth,
                height: scaledHeight
            });
            console.log('Image:', { width: image.width, height: image.height });
            console.log('Canvas:', { width: this.canvas.width, height: this.canvas.height });
            console.log('Tiles to render:', tiles.length);
            console.log('First tile:', tiles[0]);
            this._debugLogged = true;
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

        let drawCallCount = 0;
        let tileIds: string[] = [];

        // Render each tile
        for (const tile of tiles) {
            tileIds.push(tile.id);
            // Get texture from cache (should already be uploaded)
            let texture = this.textureCache.get(tile.id);
            if (!texture) {
                // Fallback: upload if not found (shouldn't normally happen)
                if (!this._textureUploadWarned) {
                    console.log(`Uploading texture for tile ${tile.id} (not in cache)`);
                    this._textureUploadWarned = true;
                }
                texture = this.uploadTextureFromBitmap(tile.id, tile.image);
                if (!texture) {
                    console.warn(`Failed to upload texture for tile ${tile.id}`);
                    continue;
                }
            }

            // Get or create bind group
            let bindGroup = this.bindGroupCache.get(tile.id);
            if (!bindGroup) {
                if (!this._bindGroupWarned) {
                    console.log(`Creating bind group for tile ${tile.id}`);
                    this._bindGroupWarned = true;
                }
                bindGroup = this.getOrCreateBindGroup(tile.id, texture);
                if (!bindGroup) {
                    console.warn(`Failed to create bind group for tile ${tile.id}`);
                    continue;
                }
            }

            // Update uniforms for this tile
            // Note: viewport.scale is in CSS pixels, so multiply by DPR for physical pixels
            const physicalScale = viewport.scale * this.devicePixelRatio;
            const uniformData = new Float32Array([
                viewport.centerX, viewport.centerY,     // viewportCenter
                physicalScale,                           // viewportScale (adjusted for DPR)
                0.0,                                     // padding
                this.canvas.width, this.canvas.height,  // canvasSize (physical pixels)
                0.0, 0.0,                               // padding
                image.width, image.height,              // imageSize
                0.0, 0.0,                               // padding
                tile.x, tile.y,                         // tilePosition
                0.0, 0.0,                               // padding
                tile.width, tile.height,                // tileSize
                0.0, 0.0,                               // padding
            ]);

            // Debug: log first tile's uniforms and calculated positions
            // Log when scale changes significantly (zoom happened)
            const scaleChanged = !this._lastLoggedScale ||
                                 Math.abs(viewport.scale - this._lastLoggedScale) > 0.001;
            if (!this._uniformsLogged || scaleChanged) {
                this._lastLoggedScale = viewport.scale;
                console.log('=== Coordinate Transform Debug ===');
                console.log('Uniforms being sent to shader:', {
                    viewportCenter: [viewport.centerX, viewport.centerY],
                    viewportScale: physicalScale,
                    canvasSize: [this.canvas.width, this.canvas.height],
                    imageSize: [image.width, image.height],
                    tilePosition: [tile.x, tile.y],
                    tileSize: [tile.width, tile.height],
                    dpr: this.devicePixelRatio
                });

                // Manually calculate what shader will compute (using physical pixels)
                const viewportCenterPixels = [viewport.centerX * image.width, viewport.centerY * image.height];
                const viewportSize = [this.canvas.width / physicalScale, this.canvas.height / physicalScale];
                const viewportMin = [
                    viewportCenterPixels[0] - viewportSize[0] * 0.5,
                    viewportCenterPixels[1] - viewportSize[1] * 0.5
                ];

                const tileMin = [tile.x, tile.y];
                const tileMax = [tile.x + tile.width, tile.y + tile.height];

                // Calculate where top-left corner of tile should appear on canvas (physical pixels)
                const tileInViewport = [
                    (tileMin[0] - viewportMin[0]) * physicalScale,
                    (tileMin[1] - viewportMin[1]) * physicalScale
                ];

                // Calculate tile size on canvas (physical pixels)
                const tileSizeOnCanvas = [
                    tile.width * physicalScale,
                    tile.height * physicalScale
                ];

                console.log('Manual calculation check:', {
                    viewportCenterPixels,
                    viewportSize,
                    viewportMin,
                    tileMin,
                    tileMax,
                    tileTopLeftOnCanvas: tileInViewport,
                    tileSizeOnCanvas,
                    canvasSize: [this.canvas.width, this.canvas.height],
                    isVisible: tileInViewport[0] < this.canvas.width &&
                               tileInViewport[1] < this.canvas.height &&
                               tileInViewport[0] + tileSizeOnCanvas[0] > 0 &&
                               tileInViewport[1] + tileSizeOnCanvas[1] > 0
                });

                if (!this._uniformsLogged) {
                    this._uniformsLogged = true;
                }
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
            drawCallCount++;
        }

        // Always log draw calls for debugging (will show once per unique count)
        if (!this._drawCallCounts) this._drawCallCounts = new Set();
        if (!this._drawCallCounts.has(drawCallCount)) {
            console.log(`Executed ${drawCallCount} draw calls for tiles:`, tileIds);
            console.log('Tile positions:', tiles.map(t => ({ id: t.id, x: t.x, y: t.y, w: t.width, h: t.height })));
            this._drawCallCounts.add(drawCallCount);
        }

        renderPass.end();
        const commandBuffer = commandEncoder.finish();
        this.device.queue.submit([commandBuffer]);

        // Force presentation (shouldn't be necessary but let's try)
        if (!this._presentLogged) {
            console.log('Command buffer submitted, texture should present automatically');
            this._presentLogged = true;
        }
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
