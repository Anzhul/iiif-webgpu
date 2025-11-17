import { IIIFImage } from './iiif-image';
import { WebGPURenderer } from './iiif-webgpu';

export class TileManager {
    id: string;
    image: IIIFImage;
    // Holds successfully loaded tiles
    tileCache: Map<string, any>;
    // Holds Tile IDs currently being fetched from the network, prevents duplicate loads
    loadingTiles: Set<string>;
    private maxCacheSize: number;
    // Tracks which tiles were accessed recently for LRU cache eviction
    private tileAccessOrder: Set<string>;
    private renderer?: WebGPURenderer;
    private distanceDetail: number;

  constructor(id: string, iiifImage: IIIFImage, maxCacheSize: number = 500, renderer?: WebGPURenderer, distanceDetail: number = 0.35) {
    this.id = id;
    this.image = iiifImage;
    this.tileCache = new Map();
    this.loadingTiles = new Set();
    this.maxCacheSize = maxCacheSize;
    this.tileAccessOrder = new Set();
    this.renderer = renderer;
    this.distanceDetail = distanceDetail;
  }

  // Determine optimal zoom level for current scale
  getOptimalZoomLevel(scale: number) {
    const imageScale = this.distanceDetail / scale;
    let bestLevel = this.image.maxZoomLevel;

    for (let i = 0; i < this.image.scaleFactors.length; i++) {
      if (imageScale <= this.image.scaleFactors[i]) {
        bestLevel = i;
        break;
      }
    }

    return Math.max(0, Math.min(bestLevel, this.image.maxZoomLevel));
  }

  // Get tiles needed for current viewport
  getTilesForViewport(viewport: any) {
    const zoomLevel = this.getOptimalZoomLevel(viewport.scale);
    const scaleFactor = this.image.scaleFactors[zoomLevel];
    const bounds = viewport.getImageBounds(this.image);

    // Scale bounds to the resolution level
    // Start
    const levelBounds = {
      left: Math.floor(bounds.left / scaleFactor),
      top: Math.floor(bounds.top / scaleFactor),
      right: Math.ceil(bounds.right / scaleFactor),
      bottom: Math.ceil(bounds.bottom / scaleFactor)
    };

    const tiles = [];
    const tileSize = this.image.tileSize;

    const startTileX = Math.floor(levelBounds.left / tileSize);
    const startTileY = Math.floor(levelBounds.top / tileSize);
    const endTileX = Math.floor(levelBounds.right / tileSize);
    const endTileY = Math.floor(levelBounds.bottom / tileSize);

    for (let tileY = startTileY; tileY <= endTileY; tileY++) {
      for (let tileX = startTileX; tileX <= endTileX; tileX++) {
        const tile = this.createTile(tileX, tileY, zoomLevel, scaleFactor);
        if (tile) tiles.push(tile);
      }
    }

    // Load all tiles in parallel
    this.loadTilesBatch(tiles);
    return tiles;
  }

  createTile(tileX: number, tileY: number, zoomLevel: number, scaleFactor: number) {
    const tileSize = this.image.tileSize;
    const x = tileX * tileSize * scaleFactor;
    const y = tileY * tileSize * scaleFactor;
    
    // Don't create tiles outside image bounds
    if (x >= this.image.width || y >= this.image.height) {
      return null;
    }

    const width = Math.min(tileSize * scaleFactor, this.image.width - x);
    const height = Math.min(tileSize * scaleFactor, this.image.height - y);

    const tileId = `${zoomLevel}-${tileX}-${tileY}`;
    const url = this.image.getTileUrl(x, y, width, height);

    return {
      id: tileId,
      url: url,
      x: x,
      y: y,
      width: width,
      height: height,
      tileX: tileX,
      tileY: tileY,
      zoomLevel: zoomLevel,
      scaleFactor: scaleFactor
    };
  }

  // Load tiles in parallel batches
  loadTilesBatch(tiles: any[]) {
    const tilesToLoad = tiles.filter(tile =>
      !this.tileCache.has(tile.id) && !this.loadingTiles.has(tile.id)
    );

    if (tilesToLoad.length === 0) return;

    // Load tiles in parallel
    Promise.allSettled(tilesToLoad.map(tile => this.loadTile(tile)));
  }

  // Load tile with caching - optimized for direct bitmap loading
  async loadTile(tile: any) {
    if (this.tileCache.has(tile.id)) {
      const cachedTile = this.tileCache.get(tile.id);
      this.markTileAccessed(tile.id);
      return cachedTile;
    }

    if (this.loadingTiles.has(tile.id)) {
      return null; // Already loading
    }

    this.loadingTiles.add(tile.id);

    try {
      // Load bitmap directly from URL
      const response = await fetch(tile.url);
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const blob = await response.blob();
      const loadedBitmap = await createImageBitmap(blob);

      const cachedTile = { ...tile, image: loadedBitmap };
      this.tileCache.set(tile.id, cachedTile);
      this.markTileAccessed(tile.id);

      // Upload to GPU immediately if renderer is available
      if (this.renderer) {
        this.renderer.uploadTextureFromBitmap(tile.id, loadedBitmap);
      }

      this.evictOldTiles();
      return cachedTile;

    } catch (error) {
      console.error(`Failed to load tile: ${tile.url}`, error);
      return null;
    } finally {
      this.loadingTiles.delete(tile.id);
    }
  }

  getCachedTiles() {
    //return all key value pairs in tileCache as an array
    return Array.from(this.tileCache.values());
  }

  getCachedTile(tileId: string) {
    const tile = this.tileCache.get(tileId);
    if (tile) {
      this.markTileAccessed(tileId);
    }
    return tile;
  }

  // Get loaded tiles for rendering (optimized for WebGPU)
  getLoadedTilesForRender(viewport: any) {
    const tiles = this.getTilesForViewport(viewport);
    return tiles
      .map(tile => this.getCachedTile(tile.id))
      .filter(tile => tile && tile.image);
  }

  // Set renderer reference (useful if renderer is created after TileManager)
  setRenderer(renderer: WebGPURenderer) {
    this.renderer = renderer;
  }

  // LRU cache management
  private evictOldTiles() {
    if (this.tileCache.size > this.maxCacheSize) {
      // Remove oldest 20% of tiles
      const toRemoveCount = Math.floor(this.maxCacheSize * 0.2);
      const toRemove = Array.from(this.tileAccessOrder).slice(0, toRemoveCount);

      for (const tileId of toRemove) {
        // Clean up GPU texture if renderer exists
        if (this.renderer) {
          this.renderer.destroyTexture(tileId);
        }

        this.tileCache.delete(tileId);
        this.tileAccessOrder.delete(tileId);
      }
    }
  }

  private markTileAccessed(tileId: string) {
    // Remove if exists and add to end (most recently accessed)
    this.tileAccessOrder.delete(tileId);
    this.tileAccessOrder.add(tileId);
  }
}