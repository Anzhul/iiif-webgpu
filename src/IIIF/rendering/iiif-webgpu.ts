
/// <reference types="@webgpu/types" />
import { mat4 } from 'gl-matrix';
import { Viewport } from '../core/iiif-view.js';
import type { TileRenderData } from './iiif-renderer.js';
import { RendererBase } from './iiif-renderer-base.js';
import ShaderModule from './iiif-shader.wgsl?raw';

export class WebGPURenderer extends RendererBase {
    // WebGPU objects
    private device?: GPUDevice;
    private context?: GPUCanvasContext;
    private pipeline?: GPURenderPipeline;
    private sampler?: GPUSampler;
    private format: GPUTextureFormat = 'bgra8unorm';

    // MSAA — 4x multi-sample anti-aliasing prevents sub-pixel edge oscillation
    private static readonly SAMPLE_COUNT = 4;
    private msaaTexture?: GPUTexture;

    // Mipmap generation pipeline (created once, reused for all texture uploads)
    private mipPipeline?: GPURenderPipeline;
    private mipSampler?: GPUSampler;

    // Shared storage buffer for all tile uniforms
    // Each tile = mat4x4<f32> (64 bytes) + 4x f32 texture bounds (16 bytes) = 80 bytes = 20 floats
    private static readonly FLOATS_PER_TILE = 20;
    private static readonly BYTES_PER_TILE = WebGPURenderer.FLOATS_PER_TILE * 4; // 80 bytes
    private static readonly MAX_TILES = 1000;
    private storageBuffer?: GPUBuffer;
    private storageBufferSize: number = WebGPURenderer.BYTES_PER_TILE * WebGPURenderer.MAX_TILES;

    // Reusable buffer for uniform data to avoid per-frame allocations
    private uniformDataBuffer: Float32Array = new Float32Array(WebGPURenderer.MAX_TILES * WebGPURenderer.FLOATS_PER_TILE);

    // Texture cache: tileId -> GPUTexture
    private textureCache: Map<string, GPUTexture> = new Map();
    private bindGroupCache: Map<string, GPUBindGroup> = new Map();

    constructor(container: HTMLElement) {
        super(container);
    }

    async initialize(): Promise<void> {
        if (!navigator.gpu) {
            console.error('WebGPU is not supported in this browser');
            return;
        }

        try {
            const adapter = await navigator.gpu.requestAdapter();
            if (!adapter) {
                console.error('Failed to get GPU adapter');
                return;
            }

            this.device = await adapter.requestDevice();

            this.device.addEventListener('uncapturederror', (event) => {
                console.error('WebGPU uncaptured error:', event.error);
            });

            this.context = this.canvas.getContext('webgpu') as GPUCanvasContext;
            if (!this.context) {
                throw new Error('Failed to get WebGPU context from canvas');
            }

            const preferredFormat = navigator.gpu.getPreferredCanvasFormat();
            this.format = preferredFormat;
            console.log('Using canvas format:', preferredFormat);

            this.context.configure({
                device: this.device,
                format: preferredFormat,
                alphaMode: 'opaque',
            });

            await this.createPipeline();
            this.createSampler();
            this.createStorageBuffer();
            this.createMSAATexture();
            this.createMipPipeline();

            console.log('WebGPU initialized successfully (4x MSAA)');
        } catch (error) {
            console.error('Failed to initialize WebGPU:', error);
        }
    }

    resize() {
        super.resize();

        // Reconfigure canvas context
        if (this.context && this.device) {
            this.context.configure({
                device: this.device,
                format: this.format,
                alphaMode: 'opaque',
            });
            this.createMSAATexture();
        }
    }

    private createMSAATexture() {
        if (!this.device) return;

        // Destroy previous MSAA texture
        this.msaaTexture?.destroy();

        this.msaaTexture = this.device.createTexture({
            size: [this.canvas.width, this.canvas.height],
            format: this.format,
            sampleCount: WebGPURenderer.SAMPLE_COUNT,
            usage: GPUTextureUsage.RENDER_ATTACHMENT,
        });
    }

    private async createPipeline() {
        if (!this.device) return;

        const shaderModule = this.device.createShaderModule({
            label: 'Tile Shader Module',
            code: ShaderModule,
        });

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
                cullMode: 'none',
            },
            multisample: {
                count: WebGPURenderer.SAMPLE_COUNT,
            },
            // No depthStencil: tiles are z-sorted for painter's algorithm.
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

    private createMipPipeline() {
        if (!this.device) return;

        const mipShaderCode = `
            @group(0) @binding(0) var mipSampler: sampler;
            @group(0) @binding(1) var mipTexture: texture_2d<f32>;

            struct VertexOutput {
                @builtin(position) position: vec4<f32>,
                @location(0) texCoord: vec2<f32>,
            }

            @vertex
            fn vs_main(@builtin(vertex_index) vertexIndex: u32) -> VertexOutput {
                // Full-screen triangle (oversized, clipped to viewport)
                var pos = array<vec2<f32>, 3>(
                    vec2<f32>(-1.0, -1.0),
                    vec2<f32>( 3.0, -1.0),
                    vec2<f32>(-1.0,  3.0)
                );
                var uv = array<vec2<f32>, 3>(
                    vec2<f32>(0.0, 1.0),
                    vec2<f32>(2.0, 1.0),
                    vec2<f32>(0.0, -1.0)
                );
                var output: VertexOutput;
                output.position = vec4<f32>(pos[vertexIndex], 0.0, 1.0);
                output.texCoord = uv[vertexIndex];
                return output;
            }

            @fragment
            fn fs_main(input: VertexOutput) -> @location(0) vec4<f32> {
                return textureSample(mipTexture, mipSampler, input.texCoord);
            }
        `;

        const shaderModule = this.device.createShaderModule({
            label: 'Mip Generation Shader',
            code: mipShaderCode,
        });

        this.mipPipeline = this.device.createRenderPipeline({
            label: 'Mip Generation Pipeline',
            layout: 'auto',
            vertex: { module: shaderModule, entryPoint: 'vs_main' },
            fragment: {
                module: shaderModule,
                entryPoint: 'fs_main',
                targets: [{ format: this.format }],
            },
            primitive: { topology: 'triangle-list' },
        });

        this.mipSampler = this.device.createSampler({
            minFilter: 'linear',
            magFilter: 'linear',
        });
    }

    setVideoSource(_video: HTMLVideoElement | null): void {
        // No-op: video overlay removed
    }

    private generateMipmaps(texture: GPUTexture) {
        if (!this.device || !this.mipPipeline || !this.mipSampler) return;

        const mipLevelCount = texture.mipLevelCount;
        if (mipLevelCount <= 1) return;

        const encoder = this.device.createCommandEncoder({ label: 'mip generation' });

        for (let level = 1; level < mipLevelCount; level++) {
            const srcView = texture.createView({
                baseMipLevel: level - 1,
                mipLevelCount: 1,
            });

            const dstView = texture.createView({
                baseMipLevel: level,
                mipLevelCount: 1,
            });

            const bindGroup = this.device.createBindGroup({
                layout: this.mipPipeline.getBindGroupLayout(0),
                entries: [
                    { binding: 0, resource: this.mipSampler },
                    { binding: 1, resource: srcView },
                ],
            });

            const pass = encoder.beginRenderPass({
                colorAttachments: [{
                    view: dstView,
                    loadOp: 'clear',
                    storeOp: 'store',
                    clearValue: { r: 0, g: 0, b: 0, a: 0 },
                }],
            });

            pass.setPipeline(this.mipPipeline);
            pass.setBindGroup(0, bindGroup);
            pass.draw(3);
            pass.end();
        }

        this.device.queue.submit([encoder.finish()]);
    }

    uploadTextureFromBitmap(tileId: string, bitmap: ImageBitmap): GPUTexture | undefined {
        if (!this.device || !this.pipeline || !this.sampler || !this.storageBuffer) return undefined;

        if (this.textureCache.has(tileId)) {
            return this.textureCache.get(tileId)!;
        }

        const mipLevelCount = Math.floor(Math.log2(Math.max(bitmap.width, bitmap.height))) + 1;

        const texture = this.device.createTexture({
            size: [bitmap.width, bitmap.height, 1],
            format: this.format,
            mipLevelCount,
            usage: GPUTextureUsage.TEXTURE_BINDING |
                   GPUTextureUsage.COPY_DST |
                   GPUTextureUsage.RENDER_ATTACHMENT,
        });

        this.device.queue.copyExternalImageToTexture(
            { source: bitmap },
            { texture: texture, mipLevel: 0 },
            [bitmap.width, bitmap.height]
        );

        this.generateMipmaps(texture);

        this.textureCache.set(tileId, texture);
        return texture;
    }

    private renderTile(
        renderPass: GPURenderPassEncoder,
        tile: TileRenderData,
        tileIndex: number
    ) {
        if (!this.device || !this.pipeline || !this.sampler || !this.storageBuffer) return;

        let bindGroup = this.bindGroupCache.get(tile.id);

        if (!bindGroup) {
            let texture = this.textureCache.get(tile.id);
            if (!texture) {
                texture = this.uploadTextureFromBitmap(tile.id, tile.image);
                if (!texture) return;
            }

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
            this.bindGroupCache.set(tile.id, bindGroup);
        }

        renderPass.setBindGroup(0, bindGroup);
        renderPass.draw(6, 1, 0, tileIndex);
    }

    render(viewport: Viewport, tiles: TileRenderData[]) {
        if (!this.device || !this.context || !this.pipeline || !this.storageBuffer || !this.msaaTexture) {
            return;
        }

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

        if (tiles.length > WebGPURenderer.MAX_TILES) {
            console.error(`Storage buffer overflow: Trying to render ${tiles.length} tiles but buffer only supports ${WebGPURenderer.MAX_TILES} tiles. Truncating.`);
            tiles = tiles.slice(0, WebGPURenderer.MAX_TILES);
        }

        const floatsPerTile = WebGPURenderer.FLOATS_PER_TILE;

        // Expand each tile quad by 0.5 physical pixels to prevent border wavering
        const expand = 0.5 / (viewport.scale * this.devicePixelRatio);

        for (let i = 0; i < tiles.length; i++) {
            const tile = tiles[i];
            const offset = i * floatsPerTile;

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

            this.uniformDataBuffer.set(this.reusableCombinedMatrix, offset);

            this.uniformDataBuffer[offset + 16] = tile.textureLeft ?? 0.0;
            this.uniformDataBuffer[offset + 17] = tile.textureTop ?? 0.0;
            this.uniformDataBuffer[offset + 18] = tile.textureRight ?? 1.0;
            this.uniformDataBuffer[offset + 19] = tile.textureBottom ?? 1.0;
        }

        this.device.queue.writeBuffer(
            this.storageBuffer,
            0,
            this.uniformDataBuffer.buffer,
            0,
            tiles.length * floatsPerTile * 4
        );

        const commandEncoder = this.device.createCommandEncoder();
        const swapChainView = this.context.getCurrentTexture().createView();
        const msaaView = this.msaaTexture.createView();

        // MSAA: render to multisampled texture, resolve to swap chain
        const renderPass = commandEncoder.beginRenderPass({
            colorAttachments: [{
                view: msaaView,
                resolveTarget: swapChainView,
                clearValue: { r: this.clearColor.r, g: this.clearColor.g, b: this.clearColor.b, a: 1.0 },
                loadOp: 'clear',
                storeOp: 'discard', // multisampled data discarded after resolve
            }],
        });

        renderPass.setPipeline(this.pipeline);

        for (let i = 0; i < tiles.length; i++) {
            this.renderTile(renderPass, tiles[i], i);
        }

        renderPass.end();
        const commandBuffer = commandEncoder.finish();
        this.device.queue.submit([commandBuffer]);
    }

    destroyTexture(tileId: string) {
        const texture = this.textureCache.get(tileId);
        if (texture) {
            texture.destroy();
            this.textureCache.delete(tileId);
        }
        this.bindGroupCache.delete(tileId);
    }

    clearTextureCache() {
        for (const texture of this.textureCache.values()) {
            texture.destroy();
        }
        this.textureCache.clear();
        this.bindGroupCache.clear();
    }

    destroy() {
        this.clearTextureCache();
        this.msaaTexture?.destroy();
        this.device?.destroy();
    }
}
