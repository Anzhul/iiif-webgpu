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
    // Cache of the most recently rendered tiles (for fallback when zooming)
    private lastRenderedTiles: any[] = [];
    // Permanent low-resolution thumbnail for background
    private thumbnail: any = null;

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


  createTile(tileX: number, tileY: number, zoomLevel: number, scaleFactor: number) {
    const tileSize = this.image.tileSize;
    const x = tileX * tileSize * scaleFactor;
    const y = tileY * tileSize * scaleFactor;

    // Don't create tiles outside image bounds
    if (x >= this.image.width || y >= this.image.height) {
      return null;
    }

    const tileId = `${zoomLevel}-${tileX}-${tileY}`;

    // Check if tile already exists in cache or is being loaded
    const cachedTile = this.tileCache.get(tileId);
    if (cachedTile) {
      this.markTileAccessed(tileId);
      return cachedTile;
    }

    // If tile is being loaded, return a placeholder with the ID
    if (this.loadingTiles.has(tileId)) {
      return {
        id: tileId,
        x: x,
        y: y,
        z: 0,  // Tiles are on the image plane at Z=0
        width: Math.min(tileSize * scaleFactor, this.image.width - x),
        height: Math.min(tileSize * scaleFactor, this.image.height - y),
        tileX: tileX,
        tileY: tileY,
        zoomLevel: zoomLevel,
        scaleFactor: scaleFactor
      };
    }

    // Create new tile object only if it doesn't exist
    const width = Math.min(tileSize * scaleFactor, this.image.width - x);
    const height = Math.min(tileSize * scaleFactor, this.image.height - y);
    const url = this.image.getTileUrl(x, y, width, height);

    return {
      id: tileId,
      url: url,
      x: x,
      y: y,
      z: 0,  // Tiles are on the image plane at Z=0
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

  // Request tiles for viewport (triggers loading but doesn't wait)
  // This should be called when viewport changes (pan/zoom)
  requestTilesForViewport(viewport: any) {
    const zoomLevel = this.getOptimalZoomLevel(viewport.scale);
    const scaleFactor = this.image.scaleFactors[zoomLevel];
    const bounds = viewport.getImageBounds(this.image);

    // Add a small margin to prevent edge clipping (1 extra tile on each side)
    const tileSize = this.image.tileSize;
    const margin = tileSize * scaleFactor;

    // Scale bounds to the resolution level with margin
    const levelBounds = {
      left: Math.floor((bounds.left - margin) / scaleFactor),
      top: Math.floor((bounds.top - margin) / scaleFactor),
      right: Math.ceil((bounds.right + margin) / scaleFactor),
      bottom: Math.ceil((bounds.bottom + margin) / scaleFactor)
    };

    const tiles = [];

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

    // Load all tiles in parallel (non-blocking)
    this.loadTilesBatch(tiles);
  }

  // Get loaded tiles for rendering with fallback to previous tiles (optimized for WebGPU)
  // This is called every render frame and should NOT trigger new tile requests
  getLoadedTilesForRender(viewport: any) {
    const zoomLevel = this.getOptimalZoomLevel(viewport.scale);
    const scaleFactor = this.image.scaleFactors[zoomLevel];
    const bounds = viewport.getImageBounds(this.image);

    // Scale bounds to the resolution level
    const levelBounds = {
      left: Math.floor(bounds.left / scaleFactor),
      top: Math.floor(bounds.top / scaleFactor),
      right: Math.ceil(bounds.right / scaleFactor),
      bottom: Math.ceil(bounds.bottom / scaleFactor)
    };

    const tileSize = this.image.tileSize;
    const startTileX = Math.floor(levelBounds.left / tileSize);
    const startTileY = Math.floor(levelBounds.top / tileSize);
    const endTileX = Math.floor(levelBounds.right / tileSize);
    const endTileY = Math.floor(levelBounds.bottom / tileSize);

    // Build list of tile IDs we need for current viewport
    const neededTileIds = new Set<string>();
    for (let tileY = startTileY; tileY <= endTileY; tileY++) {
      for (let tileX = startTileX; tileX <= endTileX; tileX++) {
        const x = tileX * tileSize * scaleFactor;
        const y = tileY * tileSize * scaleFactor;

        // Don't create tiles outside image bounds
        if (x >= this.image.width || y >= this.image.height) {
          continue;
        }

        const tileId = `${zoomLevel}-${tileX}-${tileY}`;
        neededTileIds.add(tileId);
      }
    }

    // Get only loaded tiles from cache (no network requests)
    const loadedTiles = [];
    for (const tileId of neededTileIds) {
      const cachedTile = this.getCachedTile(tileId);
      if (cachedTile && cachedTile.image) {
        loadedTiles.push(cachedTile);
      }
    }

    // If we got all tiles, update cache and return
    if (loadedTiles.length === neededTileIds.size) {
      this.lastRenderedTiles = loadedTiles;
      return loadedTiles;
    }

    // Some tiles are missing - use previous tiles as fallback
    if (this.lastRenderedTiles.length > 0) {
      // Combine: new loaded tiles + old tiles for areas not yet loaded
      const tileMap = new Map(loadedTiles.map(t => [t.id, t]));

      // Add previous tiles that don't overlap with new ones
      for (const oldTile of this.lastRenderedTiles) {
        if (!tileMap.has(oldTile.id)) {
          tileMap.set(oldTile.id, oldTile);
        }
      }

      return Array.from(tileMap.values());
    }

    // No previous tiles available, just return what we have
    return loadedTiles;
  }

  // Set renderer reference (useful if renderer is created after TileManager)
  setRenderer(renderer: WebGPURenderer) {
    this.renderer = renderer;
  }

  // Load low-resolution thumbnail for background
  async loadThumbnail(maxDimension = 512) {
    const thumbnailUrl = this.image.getThumbnailUrl(maxDimension);

    try {
      const response = await fetch(thumbnailUrl);
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const blob = await response.blob();
      const loadedBitmap = await createImageBitmap(blob);

      this.thumbnail = {
        id: 'thumbnail',
        image: loadedBitmap,
        x: 0,
        y: 0,
        z: -1,  // Just behind the image plane so tiles at z=0 render on top
        width: this.image.width,
        height: this.image.height,
        url: thumbnailUrl
      };

      // Upload to GPU immediately if renderer is available
      if (this.renderer) {
        this.renderer.uploadTextureFromBitmap('thumbnail', loadedBitmap);
      }

      return this.thumbnail;
    } catch (error) {
      console.error(`Failed to load thumbnail: ${thumbnailUrl}`, error);
      return null;
    }
  }

  // Get the thumbnail for background rendering
  getThumbnail() {
    return this.thumbnail;
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