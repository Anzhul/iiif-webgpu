import { IIIFImage } from './iiif-image';
import type { WorldImage } from './iiif-world';
import type { Viewport } from './iiif-view';
import type { IIIFRenderer, TileRenderData } from './iiif-renderer';

/**
 * TileManager - Optimal tile loading and caching for IIIF images
 *
 * Design principles:
 * - LRU cache with eviction policy (Set-based for O(1) operations)
 * - Priority-based loading (center-out spiral)
 * - Viewport change detection to avoid redundant calculations
 * - GPU upload queue to spread texture uploads across frames
 * - Tile coordinate caching to minimize allocations
 */

interface Tile {
    id: string;
    url?: string;
    x: number;           // World coordinates
    y: number;
    z: number;           // Depth for sorting
    width: number;       // World dimensions
    height: number;
    image?: ImageBitmap; // Present only when loaded
    tileX: number;       // Grid coordinates (for debugging)
    tileY: number;
    zoomLevel: number;
    scaleFactor: number;
    priority?: number;   // Distance from center (for loading order)
}

interface ViewportState {
    centerX: number;
    centerY: number;
    scale: number;
    containerWidth: number;
    containerHeight: number;
}

interface TileBoundaries {
    zoomLevel: number;
    scaleFactor: number;
    tileSize: number;
    startTileX: number;
    startTileY: number;
    endTileX: number;
    endTileY: number;
    centerTileX: number;
    centerTileY: number;
}

export class TileManager {
    readonly id: string;
    readonly image: IIIFImage;
    worldImage?: WorldImage;

    private tileCache = new Map<string, Tile>();
    private loadingTiles = new Set<string>();
    private tileAccessOrder = new Set<string>(); // LRU tracking (Set maintains insertion order)
    private renderer?: IIIFRenderer;

    private lastRenderedTiles: TileRenderData[] = [];
    private thumbnail: Tile | null = null;

    // Viewport change detection
    private cachedViewportState: ViewportState | null = null;
    private cachedNeededTileIds: Set<string> | null = null;
    private cachedSortedTiles: TileRenderData[] | null = null;
    private cachedTileSetHash: string | null = null;

    // GPU upload queue (spread uploads across frames)
    private pendingGPUUploads: Array<{ tileId: string; bitmap: ImageBitmap }> = [];
    private isProcessingUploads = false;

    private readonly CONFIG: {
        MAX_CACHE_SIZE: number;
        EVICTION_RATIO: number;
        VIEWPORT_CHANGE_THRESHOLD: number;
        DISTANCE_DETAIL: number;
        TILE_MARGIN_MULTIPLIER: number;
    };

    constructor(
        id: string,
        iiifImage: IIIFImage,
        maxCacheSize = 500,
        renderer?: IIIFRenderer,
        distanceDetail = 1.0
    ) {
        this.id = id;
        this.image = iiifImage;
        this.renderer = renderer;
        this.CONFIG = {
            MAX_CACHE_SIZE: maxCacheSize,
            EVICTION_RATIO: 0.2,
            VIEWPORT_CHANGE_THRESHOLD: 0.001,
            DISTANCE_DETAIL: distanceDetail,
            TILE_MARGIN_MULTIPLIER: 1
        };
    }

    setWorldImage(worldImage: WorldImage) {
        this.worldImage = worldImage;
    }

    setRenderer(renderer: IIIFRenderer) {
        this.renderer = renderer;
    }

    // ============================================================
    // PUBLIC API
    // ============================================================

    /**
     * Request tiles for the current viewport (called by Camera)
     */
    requestTilesForViewport(viewport: Viewport) {
        if (!this.hasViewportChanged(viewport)) return;

        const bounds = this.calculateTileBoundaries(viewport, true);
        const tiles = this.createTilesForBounds(bounds, viewport);

        this.updateViewportCache(viewport);
        this.invalidateTileCache();
        this.loadTilesBatch(tiles);
    }

    /**
     * Get loaded tiles ready for rendering
     */
    getLoadedTilesForRender(viewport: Viewport): TileRenderData[] {
        const viewportChanged = this.hasViewportChanged(viewport);

        // Calculate needed tile IDs
        let neededTileIds: Set<string>;
        if (viewportChanged || !this.cachedNeededTileIds) {
            neededTileIds = this.calculateNeededTileIds(viewport);
            this.cachedNeededTileIds = neededTileIds;
            this.updateViewportCache(viewport);
        } else {
            neededTileIds = this.cachedNeededTileIds;
        }

        // Collect loaded tiles (only those with images)
        const loadedTiles: TileRenderData[] = [];
        for (const tileId of neededTileIds) {
            const tile = this.getCachedTile(tileId);
            if (tile?.image) {
                loadedTiles.push(tile as TileRenderData);
            }
        }

        // Try cache if we have all tiles
        const tileSetHash = this.computeTileSetHash(neededTileIds);
        if (this.cachedTileSetHash === tileSetHash && this.cachedSortedTiles) {
            const stillValid = this.cachedSortedTiles.filter(tile =>
                neededTileIds.has(tile.id) && this.tileCache.has(tile.id)
            );
            if (stillValid.length === neededTileIds.size) {
                return stillValid;
            }
        }

        // All tiles loaded: sort and cache
        if (loadedTiles.length === neededTileIds.size) {
            const sorted = this.sortTilesByDepth(loadedTiles);
            this.cachedSortedTiles = sorted;
            this.cachedTileSetHash = tileSetHash;
            this.lastRenderedTiles = sorted;
            return sorted;
        }

        // Fallback: blend with last rendered tiles (smooth loading)
        return this.blendWithLastRendered(loadedTiles);
    }

    getThumbnail(): TileRenderData | undefined {
        return this.thumbnail?.image ? this.thumbnail as TileRenderData : undefined;
    }

    getLoadedTileIds(): string[] {
        return Array.from(this.tileCache.keys());
    }

    /**
     * Load thumbnail for background display
     */
    async loadThumbnail(maxDimension = 512): Promise<Tile | null> {
        const thumbnailUrl = this.image.getThumbnailUrl(maxDimension);

        try {
            const response = await fetch(thumbnailUrl);
            if (!response.ok) {
                throw new Error(`HTTP ${response.status}: ${response.statusText}`);
            }

            const blob = await response.blob();
            const bitmap = await createImageBitmap(blob);

            // Position in world coordinates
            const [x, y, w, h] = this.worldImage
                ? [this.worldImage.placement.worldX, this.worldImage.placement.worldY,
                   this.worldImage.placement.worldWidth, this.worldImage.placement.worldHeight]
                : [0, 0, this.image.width, this.image.height];

            this.thumbnail = {
                id: `thumbnail-${this.id}`,
                image: bitmap,
                x, y, z: -1,
                width: w, height: h,
                url: thumbnailUrl,
                tileX: 0, tileY: 0,
                zoomLevel: -1,
                scaleFactor: 1
            };

            if (this.renderer) {
                this.queueGPUUpload(this.thumbnail.id, bitmap);
            }

            return this.thumbnail;
        } catch (error) {
            console.error(`Failed to load thumbnail: ${thumbnailUrl}`, error);
            return null;
        }
    }

    // ============================================================
    // PRIVATE - Viewport Change Detection
    // ============================================================

    private hasViewportChanged(viewport: Viewport): boolean {
        if (!this.cachedViewportState) {
            return true;
        }

        const state = this.cachedViewportState;
        const threshold = this.CONFIG.VIEWPORT_CHANGE_THRESHOLD;

        const centerXDiff = Math.abs(viewport.centerX - state.centerX);
        const centerYDiff = Math.abs(viewport.centerY - state.centerY);
        const scaleDiff = Math.abs(viewport.scale - state.scale);

        return (
            centerXDiff > threshold ||
            centerYDiff > threshold ||
            scaleDiff > threshold ||
            viewport.containerWidth !== state.containerWidth ||
            viewport.containerHeight !== state.containerHeight
        );
    }

    private updateViewportCache(viewport: Viewport) {
        this.cachedViewportState = {
            centerX: viewport.centerX,
            centerY: viewport.centerY,
            scale: viewport.scale,
            containerWidth: viewport.containerWidth,
            containerHeight: viewport.containerHeight
        };
    }

    private invalidateTileCache() {
        this.cachedNeededTileIds = null;
        this.cachedSortedTiles = null;
        this.cachedTileSetHash = null;
    }

    // ============================================================
    // PRIVATE - Tile Calculation
    // ============================================================

    /**
     * Calculate which zoom level to use based on viewport scale
     */
    private getOptimalZoomLevel(viewportScale: number): number {
        const wpp = this.worldImage?.worldPerPixel ?? 1;
        const imagePixelScale = viewportScale * wpp;
        const roundedScale = Math.round(imagePixelScale * 1000) / 1000;
        const imageScale = this.CONFIG.DISTANCE_DETAIL / roundedScale;

        let bestLevel = this.image.maxZoomLevel;
        for (let i = 0; i < this.image.scaleFactors.length; i++) {
            if (imageScale <= this.image.scaleFactors[i]) {
                bestLevel = i;
                break;
            }
        }

        return Math.max(0, Math.min(bestLevel, this.image.maxZoomLevel));
    }

    /**
     * Calculate tile grid boundaries for viewport
     */
    private calculateTileBoundaries(viewport: Viewport, includeMargin: boolean): TileBoundaries {
        const zoomLevel = this.getOptimalZoomLevel(viewport.scale);
        const scaleFactor = this.image.scaleFactors[zoomLevel];
        const tileSize = this.image.tileSize;

        // Get visible region in image pixels
        const bounds = this.worldImage
            ? viewport.getImageBoundsForWorldImage(this.worldImage)
            : { left: 0, top: 0, right: this.image.width, bottom: this.image.height };

        const margin = includeMargin ? tileSize * scaleFactor * this.CONFIG.TILE_MARGIN_MULTIPLIER : 0;

        // Convert to level coordinates
        const levelBounds = {
            left: Math.floor((bounds.left - margin) / scaleFactor),
            top: Math.floor((bounds.top - margin) / scaleFactor),
            right: Math.ceil((bounds.right + margin) / scaleFactor),
            bottom: Math.ceil((bounds.bottom + margin) / scaleFactor)
        };

        // Clamp to valid tile ranges
        const maxTileX = Math.floor((this.image.width - 1) / (tileSize * scaleFactor));
        const maxTileY = Math.floor((this.image.height - 1) / (tileSize * scaleFactor));

        const startTileX = Math.max(0, Math.floor(levelBounds.left / tileSize));
        const startTileY = Math.max(0, Math.floor(levelBounds.top / tileSize));
        const endTileX = Math.min(maxTileX, Math.floor(levelBounds.right / tileSize));
        const endTileY = Math.min(maxTileY, Math.floor(levelBounds.bottom / tileSize));

        // Calculate center in tile coordinates for priority sorting
        let centerTileX: number, centerTileY: number;
        if (this.worldImage) {
            const imgCenter = this.worldImage.worldToImage(viewport.centerX, viewport.centerY);
            centerTileX = imgCenter.x / (tileSize * scaleFactor);
            centerTileY = imgCenter.y / (tileSize * scaleFactor);
        } else {
            centerTileX = (this.image.width / 2) / (tileSize * scaleFactor);
            centerTileY = (this.image.height / 2) / (tileSize * scaleFactor);
        }

        return {
            zoomLevel, scaleFactor, tileSize,
            startTileX, startTileY, endTileX, endTileY,
            centerTileX, centerTileY
        };
    }

    /**
     * Create tile descriptors for given boundaries
     */
    private createTilesForBounds(bounds: TileBoundaries, _viewport: Viewport): Tile[] {
        const tiles: Tile[] = [];

        for (let tileY = bounds.startTileY; tileY <= bounds.endTileY; tileY++) {
            for (let tileX = bounds.startTileX; tileX <= bounds.endTileX; tileX++) {
                const tile = this.createTile(tileX, tileY, bounds.zoomLevel, bounds.scaleFactor);
                if (tile) {
                    // Priority = distance from center (for load ordering)
                    const dx = tileX - bounds.centerTileX;
                    const dy = tileY - bounds.centerTileY;
                    tile.priority = Math.sqrt(dx * dx + dy * dy);
                    tiles.push(tile);
                }
            }
        }

        return tiles;
    }

    /**
     * Create a single tile descriptor
     */
    private createTile(tileX: number, tileY: number, zoomLevel: number, scaleFactor: number): Tile | null {
        const tileSize = this.image.tileSize;
        const imgX = tileX * tileSize * scaleFactor;
        const imgY = tileY * tileSize * scaleFactor;

        if (imgX >= this.image.width || imgY >= this.image.height) {
            return null;
        }

        const tileId = `${zoomLevel}-${tileX}-${tileY}`;

        // Return cached tile if exists
        const cached = this.tileCache.get(tileId);
        if (cached) {
            this.markTileAccessed(tileId);
            return cached;
        }

        // Calculate dimensions (clipped at image edge)
        const imgW = Math.min(tileSize * scaleFactor, this.image.width - imgX);
        const imgH = Math.min(tileSize * scaleFactor, this.image.height - imgY);

        // Convert to world coordinates
        let worldX: number, worldY: number, worldW: number, worldH: number;
        if (this.worldImage) {
            const wpp = this.worldImage.worldPerPixel;
            const p = this.worldImage.placement;
            worldX = p.worldX + imgX * wpp;
            worldY = p.worldY + imgY * wpp;
            worldW = imgW * wpp;
            worldH = imgH * wpp;
        } else {
            worldX = imgX;
            worldY = imgY;
            worldW = imgW;
            worldH = imgH;
        }

        // Z-depth for sorting (zoom level + tiny offset for tile position)
        const z = zoomLevel + (tileY * 0.00001) + (tileX * 0.000001);

        // If loading, return placeholder
        if (this.loadingTiles.has(tileId)) {
            return {
                id: tileId,
                x: worldX, y: worldY, z,
                width: worldW, height: worldH,
                tileX, tileY, zoomLevel, scaleFactor
            };
        }

        // Build URL for IIIF Image API
        const url = this.image.getTileUrl(imgX, imgY, imgW, imgH, scaleFactor);

        return {
            id: tileId, url,
            x: worldX, y: worldY, z,
            width: worldW, height: worldH,
            tileX, tileY, zoomLevel, scaleFactor
        };
    }

    /**
     * Calculate which tile IDs are needed (no margin)
     */
    private calculateNeededTileIds(viewport: Viewport): Set<string> {
        const bounds = this.calculateTileBoundaries(viewport, false);
        const { zoomLevel, scaleFactor, tileSize, startTileX, startTileY, endTileX, endTileY } = bounds;

        const ids = new Set<string>();
        for (let tileY = startTileY; tileY <= endTileY; tileY++) {
            for (let tileX = startTileX; tileX <= endTileX; tileX++) {
                const x = tileX * tileSize * scaleFactor;
                const y = tileY * tileSize * scaleFactor;

                if (x < this.image.width && y < this.image.height) {
                    ids.add(`${zoomLevel}-${tileX}-${tileY}`);
                }
            }
        }

        return ids;
    }

    // ============================================================
    // PRIVATE - Tile Loading
    // ============================================================

    /**
     * Load multiple tiles in priority order
     */
    private loadTilesBatch(tiles: Tile[]) {
        const tilesToLoad = tiles.filter(tile =>
            tile.url && !this.tileCache.has(tile.id) && !this.loadingTiles.has(tile.id)
        );

        if (tilesToLoad.length === 0) return;

        // Sort by priority (closest first)
        tilesToLoad.sort((a, b) => {
            const aPriority = a.priority ?? Infinity;
            const bPriority = b.priority ?? Infinity;
            return aPriority - bPriority;
        });

        Promise.allSettled(tilesToLoad.map(tile => this.loadTile(tile)));
    }

    /**
     * Load a single tile
     */
    private async loadTile(tile: Tile): Promise<Tile | null> {
        if (this.tileCache.has(tile.id)) {
            this.markTileAccessed(tile.id);
            return this.tileCache.get(tile.id)!;
        }

        if (this.loadingTiles.has(tile.id) || !tile.url) {
            return null;
        }

        this.loadingTiles.add(tile.id);

        try {
            const response = await fetch(tile.url);
            if (!response.ok) {
                throw new Error(`HTTP ${response.status}: ${response.statusText}`);
            }

            const blob = await response.blob();
            const bitmap = await createImageBitmap(blob);

            const loadedTile = { ...tile, image: bitmap };
            this.tileCache.set(tile.id, loadedTile);
            this.markTileAccessed(tile.id);

            if (this.renderer) {
                this.queueGPUUpload(tile.id, bitmap);
            }

            this.evictOldTiles();
            return loadedTile;

        } catch (error) {
            console.error(`Failed to load tile: ${tile.url}`, error);
            return null;
        } finally {
            this.loadingTiles.delete(tile.id);
        }
    }

    // ============================================================
    // PRIVATE - Cache Management
    // ============================================================

    private getCachedTile(tileId: string): Tile | undefined {
        const tile = this.tileCache.get(tileId);
        if (tile) {
            this.markTileAccessed(tileId);
        }
        return tile;
    }

    private markTileAccessed(tileId: string) {
        // Move to end (most recently used)
        this.tileAccessOrder.delete(tileId);
        this.tileAccessOrder.add(tileId);
    }

    /**
     * LRU eviction when cache is full
     */
    private evictOldTiles() {
        if (this.tileCache.size <= this.CONFIG.MAX_CACHE_SIZE) return;

        const toRemoveCount = Math.floor(this.CONFIG.MAX_CACHE_SIZE * this.CONFIG.EVICTION_RATIO);
        const toRemove = Array.from(this.tileAccessOrder).slice(0, toRemoveCount);

        for (const tileId of toRemove) {
            this.renderer?.destroyTexture(tileId);
            this.tileCache.delete(tileId);
            this.tileAccessOrder.delete(tileId);
        }
    }

    // ============================================================
    // PRIVATE - GPU Upload Queue
    // ============================================================

    private queueGPUUpload(tileId: string, bitmap: ImageBitmap) {
        this.pendingGPUUploads.push({ tileId, bitmap });

        if (!this.isProcessingUploads) {
            this.processGPUUploadQueue();
        }
    }

    /**
     * Process GPU uploads one per frame (spread work)
     */
    private processGPUUploadQueue() {
        if (this.pendingGPUUploads.length === 0) {
            this.isProcessingUploads = false;
            return;
        }

        this.isProcessingUploads = true;
        const upload = this.pendingGPUUploads.shift()!;

        this.renderer?.uploadTextureFromBitmap(upload.tileId, upload.bitmap);

        if (this.pendingGPUUploads.length > 0) {
            requestAnimationFrame(() => this.processGPUUploadQueue());
        } else {
            this.isProcessingUploads = false;
        }
    }

    // ============================================================
    // PRIVATE - Rendering Helpers
    // ============================================================

    private sortTilesByDepth(tiles: TileRenderData[]): TileRenderData[] {
        return tiles.sort((a, b) => a.z - b.z);
    }

    private computeTileSetHash(tileIds: Set<string>): string {
        if (tileIds.size === 0) return '0';
        const arr = Array.from(tileIds);
        return `${tileIds.size}_${arr[0]}_${arr[arr.length - 1]}`;
    }

    /**
     * Blend current tiles with last rendered (smooth loading transition)
     */
    private blendWithLastRendered(loadedTiles: TileRenderData[]): TileRenderData[] {
        if (this.lastRenderedTiles.length === 0) {
            return this.sortTilesByDepth(loadedTiles);
        }

        const tileMap = new Map(loadedTiles.map(t => [t.id, t]));

        // Fill gaps with old tiles
        for (const oldTile of this.lastRenderedTiles) {
            if (!tileMap.has(oldTile.id)) {
                tileMap.set(oldTile.id, oldTile);
            }
        }

        return this.sortTilesByDepth(Array.from(tileMap.values()));
    }
}
