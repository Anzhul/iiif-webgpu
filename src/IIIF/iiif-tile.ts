import { IIIFImage } from './core/iiif-image';
import type { WorldImage } from './core/iiif-world';
import type { Viewport } from './core/iiif-view';
import type { IIIFRenderer, TileRenderData } from './rendering/iiif-renderer';
import { TILE_CONFIG } from './config';

/**
 * TileManager - Manages IIIF tile loading and rendering
 *
 * Key features:
 * - Multi-level coverage: renders tiles from multiple zoom levels simultaneously
 *   so that lower-resolution tiles fill gaps while higher-res tiles load
 *   (inspired by OpenSeadragon)
 * - Proper IIIF tile overlap handling (prevents seams)
 * - Epsilon buffer prevents edge tile flickering during animations
 * - LRU cache with automatic eviction
 * - Priority-based loading (center-out)
 * - AbortController cancellation for stale tile requests
 * - Stable depth sorting for correct layering across zoom levels
 */

export class TileManager {
    id: string;
    image: IIIFImage;
    worldImage?: WorldImage;

    // Tile storage
    private tileCache: Map<string, Tile> = new Map();
    private loadingTiles: Set<string> = new Set();
    private tileAbortControllers: Map<string, AbortController> = new Map();
    private tileAccessOrder: Set<string> = new Set();

    // Rendering
    private renderer?: IIIFRenderer;
    private thumbnail: Tile | null = null;

    // Viewport tracking for tile request deduplication
    private lastViewport: {
        centerX: number;
        centerY: number;
        scale: number;
        containerWidth: number;
        containerHeight: number;
    } | null = null;

    // Configuration
    private readonly maxCacheSize: number;
    private readonly distanceDetail: number;
    private readonly onTileLoaded?: () => void;

    // GPU upload queue
    private pendingGPUUploads: Array<{ tileId: string; bitmap: ImageBitmap }> = [];
    private isProcessingUploads: boolean = false;

    constructor(
        id: string,
        iiifImage: IIIFImage,
        maxCacheSize: number = 500,
        renderer?: IIIFRenderer,
        distanceDetail: number = 1.0,
        onTileLoaded?: () => void
    ) {
        this.id = id;
        this.image = iiifImage;
        this.maxCacheSize = maxCacheSize;
        this.renderer = renderer;
        this.distanceDetail = distanceDetail;
        this.onTileLoaded = onTileLoaded;
    }

    setWorldImage(worldImage: WorldImage) {
        this.worldImage = worldImage;
    }

    setRenderer(renderer: IIIFRenderer) {
        this.renderer = renderer;

        // Upload any tiles that were loaded before the renderer was ready
        for (const [tileId, tile] of this.tileCache) {
            if (tile.image) {
                this.queueGPUUpload(tileId, tile.image);
            }
        }
        if (this.thumbnail?.image) {
            renderer.uploadTextureFromBitmap(this.thumbnail.id, this.thumbnail.image);
        }
    }

    // ============================================================================
    // PUBLIC API - Tile Loading
    // ============================================================================

    /**
     * Request tiles for the current viewport.
     * Called by the camera (throttled 200ms + debounced 50ms).
     * Only requests tiles at the TARGET zoom level — lower-level fallback
     * tiles are handled by getLoadedTilesForRender using the LRU cache.
     */
    requestTilesForViewport(viewport: Viewport) {
        if (!this.hasViewportChanged(viewport)) {
            return;
        }

        this.lastViewport = {
            centerX: viewport.centerX,
            centerY: viewport.centerY,
            scale: viewport.scale,
            containerWidth: viewport.containerWidth,
            containerHeight: viewport.containerHeight,
        };

        const tilesToLoad = this.calculateNeededTiles(viewport);

        // Cancel stale requests for tiles no longer needed
        const neededIds = new Set(tilesToLoad.map(t => t.id));
        for (const [tileId, controller] of this.tileAbortControllers) {
            if (!neededIds.has(tileId)) {
                controller.abort();
                this.tileAbortControllers.delete(tileId);
                this.loadingTiles.delete(tileId);
            }
        }

        // Sort by priority (closest to center first)
        tilesToLoad.sort((a, b) => (a.priority || 0) - (b.priority || 0));

        // Start loading tiles that aren't already loading or loaded
        for (const tile of tilesToLoad) {
            if (!tile.image && tile.url && !this.loadingTiles.has(tile.id)) {
                this.loadTile(tile);
            }
        }
    }

    /**
     * Get tiles ready for rendering using multi-level coverage.
     *
     * Algorithm (inspired by OpenSeadragon):
     * 1. Calculate target zoom level from viewport scale
     * 2. Calculate visible tile grid at target level
     * 3. For each tile position at target level:
     *    a. If loaded → use it
     *    b. If NOT loaded → search lower zoom levels for a covering tile
     * 4. Return mixed-level tiles sorted by z-depth (lower levels drawn behind)
     *
     * This ensures every visible area is covered by SOME tile (from any level),
     * eliminating the "thumbnail showing through" problem.
     */
    getLoadedTilesForRender(viewport: Viewport): TileRenderData[] {
        if (!this.worldImage) return [];

        const { zoomLevel: targetLevel, scaleFactor: targetScaleFactor } =
            viewport.getOptimalZoomLevel(this.worldImage, this.distanceDetail);

        const targetGrid = viewport.getTileGridForLevel(this.worldImage, targetLevel, targetScaleFactor);
        if (!targetGrid) return [];

        const result: TileRenderData[] = [];
        // Track which lower-level tiles we've already added (to avoid duplicates
        // when multiple target tiles map to the same lower-level tile)
        const addedFallbackIds = new Set<string>();

        for (let tileY = targetGrid.startY; tileY <= targetGrid.endY; tileY++) {
            for (let tileX = targetGrid.startX; tileX <= targetGrid.endX; tileX++) {
                const tileId = `${targetLevel}-${tileX}-${tileY}`;
                const cached = this.tileCache.get(tileId);

                if (cached?.image) {
                    // Target level tile is loaded — use it
                    result.push(cached as TileRenderData);
                    this.markTileAccessed(tileId);
                } else {
                    // Target level tile is NOT loaded — find coverage from lower levels
                    this.findCoveringTile(tileX, tileY, targetLevel, targetScaleFactor, result, addedFallbackIds);
                }
            }
        }

        return result;
    }

    /**
     * Load thumbnail for background display
     */
    async loadThumbnail(targetWidth = 256) {
        if (this.thumbnail) return;

        const scaleFactor = Math.max(
            this.image.width / targetWidth,
            this.image.height / targetWidth
        );

        const thumbnailUrl = this.image.getTileUrl(0, 0, this.image.width, this.image.height, scaleFactor);

        try {
            const response = await fetch(thumbnailUrl);
            if (!response.ok) throw new Error(`Thumbnail failed: ${response.status}`);

            const blob = await response.blob();
            const bitmap = await createImageBitmap(blob);

            // Position in world coordinates
            let x = 0, y = 0, width = this.image.width, height = this.image.height;

            if (this.worldImage) {
                const p = this.worldImage.placement;
                x = p.worldX;
                y = p.worldY;
                width = p.worldWidth;
                height = p.worldHeight;
            }

            this.thumbnail = {
                id: `thumbnail-${this.id}`,
                image: bitmap,
                x, y, z: -0.001,  // Behind all tiles
                width, height,
                url: thumbnailUrl,
                tileX: 0, tileY: 0,
                zoomLevel: -1, scaleFactor,
                isEdgeLeft: true, isEdgeTop: true,
                isEdgeRight: true, isEdgeBottom: true,
            };

            // Upload to GPU
            if (this.renderer) {
                this.renderer.uploadTextureFromBitmap(this.thumbnail.id, bitmap);
            }
        } catch (error) {
            console.error('Thumbnail load failed:', error);
        }
    }

    getThumbnail(): TileRenderData | undefined {
        return this.thumbnail as TileRenderData | undefined;
    }

    /**
     * Get all loaded tile IDs (for cleanup)
     */
    getLoadedTileIds(): string[] {
        return Array.from(this.tileCache.keys());
    }

    // ============================================================================
    // PRIVATE - Viewport Change Detection
    // ============================================================================

    private hasViewportChanged(viewport: Viewport): boolean {
        if (!this.lastViewport) return true;

        const v = this.lastViewport;

        // Exact float comparison — no threshold.
        // Even tiny scale changes can push imageScale across a zoom-level
        // boundary, so any viewport change must trigger tile recalculation.
        // The camera already throttles how often requestTilesForViewport
        // is called, so this doesn't cause excessive work.
        return (
            viewport.centerX !== v.centerX ||
            viewport.centerY !== v.centerY ||
            viewport.scale !== v.scale ||
            viewport.containerWidth !== v.containerWidth ||
            viewport.containerHeight !== v.containerHeight
        );
    }

    // ============================================================================
    // PRIVATE - Tile Calculation
    // ============================================================================

    /**
     * Calculate all tiles needed at the target zoom level for the current viewport.
     * Delegates grid/level calculation to Viewport methods.
     */
    private calculateNeededTiles(viewport: Viewport): Tile[] {
        if (!this.worldImage) return [];

        const { zoomLevel, scaleFactor } = viewport.getOptimalZoomLevel(this.worldImage, this.distanceDetail);
        const grid = viewport.getTileGridForLevel(this.worldImage, zoomLevel, scaleFactor);
        if (!grid) return [];

        const tiles: Tile[] = [];
        for (let tileY = grid.startY; tileY <= grid.endY; tileY++) {
            for (let tileX = grid.startX; tileX <= grid.endX; tileX++) {
                const tile = this.getOrCreateTile(tileX, tileY, zoomLevel, scaleFactor);
                if (tile) {
                    const dx = tileX - grid.centerX;
                    const dy = tileY - grid.centerY;
                    tile.priority = Math.sqrt(dx * dx + dy * dy);
                    tiles.push(tile);
                }
            }
        }

        return tiles;
    }

    /**
     * Search lower zoom levels for a loaded tile that covers the spatial region
     * of a missing tile at (tileX, tileY) at targetLevel.
     *
     * Searches both directions from the target level:
     *   1. UP (less detail, larger tiles) — one tile covers the whole area, ideal fallback
     *   2. DOWN (more detail, smaller tiles) — previously-loaded tiles still in cache
     *
     * The addedFallbackIds set prevents adding the same tile multiple times when
     * several target-level tiles map to the same covering tile.
     */
    private findCoveringTile(
        tileX: number,
        tileY: number,
        targetLevel: number,
        targetScaleFactor: number,
        result: TileRenderData[],
        addedFallbackIds: Set<string>
    ): void {
        const tileSize = this.image.tileSize;

        // Image pixel position of the target tile's top-left corner
        const pixelX = tileX * tileSize * targetScaleFactor;
        const pixelY = tileY * tileSize * targetScaleFactor;

        // --- Pass 1: Search UP (less detail, larger covering tiles) ---
        // A single higher-level tile covers the area of multiple target-level tiles.
        const maxLevel = this.image.maxZoomLevel;
        for (let level = targetLevel + 1; level <= maxLevel; level++) {
            const fallbackScaleFactor = this.image.scaleFactors[level];
            const fallbackTileSizeInPixels = tileSize * fallbackScaleFactor;

            const fallbackTileX = Math.floor(pixelX / fallbackTileSizeInPixels);
            const fallbackTileY = Math.floor(pixelY / fallbackTileSizeInPixels);

            const fallbackTileId = `${level}-${fallbackTileX}-${fallbackTileY}`;

            if (addedFallbackIds.has(fallbackTileId)) {
                return; // Area is covered by an already-added fallback tile
            }

            const cached = this.tileCache.get(fallbackTileId);
            if (cached?.image) {
                result.push(cached as TileRenderData);
                addedFallbackIds.add(fallbackTileId);
                this.markTileAccessed(fallbackTileId);
                return;
            }
        }

        // --- Pass 2: Search DOWN (more detail, smaller cached tiles) ---
        // When zooming out, previously-loaded detailed tiles are still in cache.
        // Multiple smaller tiles may be needed to cover the target tile's area.
        const pixelRight = pixelX + tileSize * targetScaleFactor;
        const pixelBottom = pixelY + tileSize * targetScaleFactor;

        for (let level = targetLevel - 1; level >= 0; level--) {
            const fallbackScaleFactor = this.image.scaleFactors[level];
            const fallbackTileSizeInPixels = tileSize * fallbackScaleFactor;

            const startTileX = Math.floor(pixelX / fallbackTileSizeInPixels);
            const startTileY = Math.floor(pixelY / fallbackTileSizeInPixels);
            const endTileX = Math.floor((pixelRight - 1) / fallbackTileSizeInPixels);
            const endTileY = Math.floor((pixelBottom - 1) / fallbackTileSizeInPixels);

            let foundAny = false;
            for (let fy = startTileY; fy <= endTileY; fy++) {
                for (let fx = startTileX; fx <= endTileX; fx++) {
                    const fallbackTileId = `${level}-${fx}-${fy}`;
                    if (addedFallbackIds.has(fallbackTileId)) {
                        foundAny = true;
                        continue;
                    }
                    const cached = this.tileCache.get(fallbackTileId);
                    if (cached?.image) {
                        result.push(cached as TileRenderData);
                        addedFallbackIds.add(fallbackTileId);
                        this.markTileAccessed(fallbackTileId);
                        foundAny = true;
                    }
                }
            }
            if (foundAny) return; // Found coverage at this level
        }
    }

    /**
     * Get or create a tile descriptor.
     * Handles proper IIIF overlap trimming.
     */
    private getOrCreateTile(tileX: number, tileY: number, zoomLevel: number, scaleFactor: number): Tile | null {
        const tileId = `${zoomLevel}-${tileX}-${tileY}`;

        // Return cached if available
        const cached = this.tileCache.get(tileId);
        if (cached) {
            this.markTileAccessed(tileId);
            return cached;
        }

        const tileSize = this.image.tileSize;
        const overlap = this.image.tileOverlap;

        // Base position (without overlap)
        const baseTileX = tileX * tileSize * scaleFactor;
        const baseTileY = tileY * tileSize * scaleFactor;

        if (baseTileX >= this.image.width || baseTileY >= this.image.height) {
            return null;
        }

        // Determine edge tiles
        const maxTileX = Math.floor((this.image.width - 1) / (tileSize * scaleFactor));
        const maxTileY = Math.floor((this.image.height - 1) / (tileSize * scaleFactor));

        const isLeftMost = tileX === 0;
        const isTopMost = tileY === 0;
        const isRightMost = tileX === maxTileX;
        const isBottomMost = tileY === maxTileY;

        // Calculate overlap for each edge
        const overlapLeft = isLeftMost ? 0 : overlap * scaleFactor;
        const overlapTop = isTopMost ? 0 : overlap * scaleFactor;
        const overlapRight = isRightMost ? 0 : overlap * scaleFactor;
        const overlapBottom = isBottomMost ? 0 : overlap * scaleFactor;

        // Image region to request (WITH overlap)
        const imgX = Math.max(0, baseTileX - overlapLeft);
        const imgY = Math.max(0, baseTileY - overlapTop);
        const imgW = Math.min(
            tileSize * scaleFactor + overlapLeft + overlapRight,
            this.image.width - imgX
        );
        const imgH = Math.min(
            tileSize * scaleFactor + overlapTop + overlapBottom,
            this.image.height - imgY
        );

        // Texture coordinate trimming (UV space, 0-1)
        const textureLeft = overlapLeft / imgW;
        const textureTop = overlapTop / imgH;
        const textureRight = 1.0 - (overlapRight / imgW);
        const textureBottom = 1.0 - (overlapBottom / imgH);

        // Visible dimensions (after trimming overlap)
        const visibleWidth = imgW - overlapLeft - overlapRight;
        const visibleHeight = imgH - overlapTop - overlapBottom;

        // World coordinates
        const wpp = this.worldImage!.worldPerPixel;
        const p = this.worldImage!.placement;
        const worldX = p.worldX + baseTileX * wpp;
        const worldY = p.worldY + baseTileY * wpp;
        const worldW = visibleWidth * wpp;
        const worldH = visibleHeight * wpp;

        // Z-depth for painter's algorithm sort order only.
        // Higher zoom level indices (larger scaleFactor, less detail) get smaller z values,
        // so they're drawn first (behind higher-resolution tiles at lower indices).
        // Gaps sized to avoid collision: supports up to 1000 tiles per axis per zoom level.
        const maxLevel = this.image.maxZoomLevel;
        const z = ((maxLevel - zoomLevel) * 0.01) + (tileY * 0.0001) + (tileX * 0.000001);

        const url = this.image.getTileUrl(imgX, imgY, imgW, imgH, scaleFactor);

        const tile: Tile = {
            id: tileId,
            url,
            x: worldX,
            y: worldY,
            z,
            width: worldW,
            height: worldH,
            tileX,
            tileY,
            zoomLevel,
            scaleFactor,
            textureLeft,
            textureTop,
            textureRight,
            textureBottom,
            isEdgeLeft: isLeftMost,
            isEdgeTop: isTopMost,
            isEdgeRight: isRightMost,
            isEdgeBottom: isBottomMost,
        };

        this.tileCache.set(tileId, tile);
        this.markTileAccessed(tileId);

        return tile;
    }

    // ============================================================================
    // PRIVATE - Tile Loading
    // ============================================================================

    private async loadTile(tile: Tile) {
        if (!tile.url) return;

        const controller = new AbortController();
        this.loadingTiles.add(tile.id);
        this.tileAbortControllers.set(tile.id, controller);

        try {
            const response = await fetch(tile.url, { signal: controller.signal });
            if (!response.ok) throw new Error(`HTTP ${response.status}`);

            const blob = await response.blob();
            const bitmap = await createImageBitmap(blob);

            // Update cached tile
            const cached = this.tileCache.get(tile.id);
            if (cached) {
                cached.image = bitmap;
                this.markTileAccessed(tile.id);
            }

            // Upload to GPU
            if (this.renderer) {
                this.queueGPUUpload(tile.id, bitmap);
            }

            // Evict old tiles if cache is full
            if (this.tileCache.size > this.maxCacheSize) {
                this.evictOldTiles();
            }

            // Notify that a tile has loaded (triggers re-render)
            if (this.onTileLoaded) {
                this.onTileLoaded();
            }
        } catch (error) {
            if (error instanceof DOMException && error.name === 'AbortError') {
                return; // Request was cancelled, not an error
            }
            console.error(`Tile load failed: ${tile.url}`, error);
        } finally {
            this.loadingTiles.delete(tile.id);
            this.tileAbortControllers.delete(tile.id);
        }
    }

    private queueGPUUpload(tileId: string, bitmap: ImageBitmap) {
        this.pendingGPUUploads.push({ tileId, bitmap });

        if (!this.isProcessingUploads) {
            this.processGPUUploadQueue();
        }
    }

    private static readonly MAX_UPLOADS_PER_FRAME = TILE_CONFIG.MAX_UPLOADS_PER_FRAME;

    private processGPUUploadQueue() {
        if (this.pendingGPUUploads.length === 0) {
            this.isProcessingUploads = false;
            return;
        }

        this.isProcessingUploads = true;

        // Process up to MAX_UPLOADS_PER_FRAME tiles per frame to avoid stalling
        const count = Math.min(this.pendingGPUUploads.length, TileManager.MAX_UPLOADS_PER_FRAME);
        for (let i = 0; i < count; i++) {
            const upload = this.pendingGPUUploads.shift()!;
            if (this.renderer) {
                this.renderer.uploadTextureFromBitmap(upload.tileId, upload.bitmap);
            }
        }

        if (this.pendingGPUUploads.length > 0) {
            requestAnimationFrame(() => this.processGPUUploadQueue());
        } else {
            this.isProcessingUploads = false;
        }
    }

    // ============================================================================
    // PRIVATE - Cache Management
    // ============================================================================

    private markTileAccessed(tileId: string) {
        // Move to end (most recent)
        this.tileAccessOrder.delete(tileId);
        this.tileAccessOrder.add(tileId);
    }

    private evictOldTiles() {
        const toEvict = this.tileCache.size - this.maxCacheSize;
        if (toEvict <= 0) return;

        // Collect IDs to evict first to avoid modifying Set during iteration
        const toEvictIds: string[] = [];
        for (const tileId of this.tileAccessOrder) {
            if (toEvictIds.length >= toEvict) break;
            if (!this.loadingTiles.has(tileId)) {
                toEvictIds.push(tileId);
            }
        }

        for (const tileId of toEvictIds) {
            this.tileCache.delete(tileId);
            this.tileAccessOrder.delete(tileId);
            if (this.renderer) {
                this.renderer.destroyTexture(tileId);
            }
        }
    }
}

// ============================================================================
// Types
// ============================================================================

interface Tile {
    id: string;
    url?: string;
    image?: ImageBitmap;
    x: number;
    y: number;
    z: number;
    width: number;
    height: number;
    tileX: number;
    tileY: number;
    zoomLevel: number;
    scaleFactor: number;
    priority?: number;
    textureLeft?: number;
    textureTop?: number;
    textureRight?: number;
    textureBottom?: number;
    isEdgeLeft?: boolean;
    isEdgeTop?: boolean;
    isEdgeRight?: boolean;
    isEdgeBottom?: boolean;
}
