import { IIIFImage } from './iiif-image';
import type { WorldImage } from './iiif-world';
import type { Viewport } from './iiif-view';
import type { IIIFRenderer } from './iiif-renderer';

export class TileManager {
    id: string;
    image: IIIFImage;
    worldImage?: WorldImage;
    // Holds successfully loaded tiles
    tileCache: Map<string, any>;
    // Holds Tile IDs currently being fetched from the network, prevents duplicate loads
    loadingTiles: Set<string>;
    private maxCacheSize: number;
    // Tracks which tiles were accessed recently for LRU cache eviction
    private tileAccessOrder: Set<string>;
    private renderer?: IIIFRenderer;
    private distanceDetail: number;
    // Cache of the most recently rendered tiles (for fallback when zooming)
    private lastRenderedTiles: any[] = [];
    // Permanent low-resolution thumbnail for background
    private thumbnail: any = null;

    // Cache for tile boundary calculations to avoid redundant computation every frame
    private cachedNeededTileIds: Set<string> | null = null;
    private cachedViewportState: {
        centerX: number;
        centerY: number;
        scale: number;
        containerWidth: number;
        containerHeight: number;
    } | null = null;

    // Cache for z-sorted tiles to avoid redundant sorting every frame
    private cachedSortedTiles: any[] | null = null;
    private cachedTileSetHash: string | null = null;

  // GPU upload queue to prevent blocking during texture uploads
  private pendingGPUUploads: Array<{ tileId: string; bitmap: ImageBitmap }> = [];
  private isProcessingUploads: boolean = false;

  constructor(id: string, iiifImage: IIIFImage, maxCacheSize: number = 500, renderer?: IIIFRenderer, distanceDetail: number = 0.35) {
    this.id = id;
    this.image = iiifImage;
    this.tileCache = new Map();
    this.loadingTiles = new Set();
    this.maxCacheSize = maxCacheSize;
    this.tileAccessOrder = new Set();
    this.renderer = renderer;
    this.distanceDetail = distanceDetail;
  }

  /** Set the WorldImage reference for world-coordinate output */
  setWorldImage(worldImage: WorldImage) {
    this.worldImage = worldImage;
  }

  /**
   * Determine optimal zoom level for current viewport scale.
   * Scale is in CSS pixels per world unit. We convert to image-pixel scale
   * using worldPerPixel so the tile selection thresholds work correctly.
   */
  getOptimalZoomLevel(viewportScale: number) {
    // Convert viewport scale (px/world) to effective image-pixel scale (px/imagePx)
    const wpp = this.worldImage ? this.worldImage.worldPerPixel : 1;
    const imagePixelScale = viewportScale * wpp;

    const roundedScale = Math.round(imagePixelScale * 1000) / 1000;
    const imageScale = this.distanceDetail / roundedScale;
    let bestLevel = this.image.maxZoomLevel;

    for (let i = 0; i < this.image.scaleFactors.length; i++) {
      if (imageScale <= this.image.scaleFactors[i]) {
        bestLevel = i;
        break;
      }
    }

    const finalLevel = Math.max(0, Math.min(bestLevel, this.image.maxZoomLevel));
    return finalLevel;
  }

  private hasViewportChanged(viewport: Viewport): boolean {
    if (!this.cachedViewportState) {
      return true;
    }

    const state = this.cachedViewportState;
    const threshold = 0.001;

    return (
      Math.abs(viewport.centerX - state.centerX) > threshold ||
      Math.abs(viewport.centerY - state.centerY) > threshold ||
      Math.abs(viewport.scale - state.scale) > threshold ||
      viewport.containerWidth !== state.containerWidth ||
      viewport.containerHeight !== state.containerHeight
    );
  }

  private updateViewportCache(viewport: Viewport): void {
    this.cachedViewportState = {
      centerX: viewport.centerX,
      centerY: viewport.centerY,
      scale: viewport.scale,
      containerWidth: viewport.containerWidth,
      containerHeight: viewport.containerHeight
    };
  }

  private invalidateTileCache(): void {
    this.cachedNeededTileIds = null;
    this.cachedSortedTiles = null;
    this.cachedTileSetHash = null;
  }

  /**
   * Calculate tile boundaries using world-aware viewport bounds.
   * Internally works in image pixels for tile index math,
   * but gets visible region via viewport.getImageBoundsForWorldImage().
   */
  private calculateTileBoundaries(viewport: Viewport, includeMargin: boolean = false) {
    const zoomLevel = this.getOptimalZoomLevel(viewport.scale);
    const scaleFactor = this.image.scaleFactors[zoomLevel];
    const tileSize = this.image.tileSize;

    // Get visible region in image pixels
    let bounds: { left: number; top: number; right: number; bottom: number };
    if (this.worldImage) {
      bounds = viewport.getImageBoundsForWorldImage(this.worldImage);
    } else {
      // Fallback for when worldImage isn't set yet
      bounds = { left: 0, top: 0, right: this.image.width, bottom: this.image.height };
    }

    const margin = includeMargin ? tileSize * scaleFactor : 0;

    const levelBounds = {
      left: Math.floor((bounds.left - margin) / scaleFactor),
      top: Math.floor((bounds.top - margin) / scaleFactor),
      right: Math.ceil((bounds.right + margin) / scaleFactor),
      bottom: Math.ceil((bounds.bottom + margin) / scaleFactor)
    };

    const startTileX = Math.floor(levelBounds.left / tileSize);
    const startTileY = Math.floor(levelBounds.top / tileSize);
    const endTileX = Math.floor(levelBounds.right / tileSize);
    const endTileY = Math.floor(levelBounds.bottom / tileSize);

    // Calculate viewport center in tile coordinates for distance calculations
    let centerTileX: number, centerTileY: number;
    if (this.worldImage) {
      // Convert world center to image pixels, then to tile coords
      const imgCenter = this.worldImage.worldToImage(viewport.centerX, viewport.centerY);
      centerTileX = imgCenter.x / (tileSize * scaleFactor);
      centerTileY = imgCenter.y / (tileSize * scaleFactor);
    } else {
      centerTileX = (this.image.width / 2) / (tileSize * scaleFactor);
      centerTileY = (this.image.height / 2) / (tileSize * scaleFactor);
    }

    return {
      zoomLevel,
      scaleFactor,
      tileSize,
      startTileX,
      startTileY,
      endTileX,
      endTileY,
      centerTileX,
      centerTileY
    };
  }

  /**
   * Create a tile. Computes position in image pixels for the IIIF URL,
   * then converts to world coordinates for rendering.
   */
  createTile(tileX: number, tileY: number, zoomLevel: number, scaleFactor: number) {
    const tileSize = this.image.tileSize;
    // Image-pixel position (used for IIIF URL)
    const imgX = tileX * tileSize * scaleFactor;
    const imgY = tileY * tileSize * scaleFactor;

    if (imgX >= this.image.width || imgY >= this.image.height) {
      return null;
    }

    const tileId = `${zoomLevel}-${tileX}-${tileY}`;

    const cachedTile = this.tileCache.get(tileId);
    if (cachedTile) {
      this.markTileAccessed(tileId);
      return cachedTile;
    }

    // Image-pixel dimensions (clipped at image edge)
    const imgW = Math.min(tileSize * scaleFactor, this.image.width - imgX);
    const imgH = Math.min(tileSize * scaleFactor, this.image.height - imgY);

    // Convert to world coordinates for rendering
    let worldX: number, worldY: number, worldW: number, worldH: number;
    if (this.worldImage) {
      const wpp = this.worldImage.worldPerPixel;
      const p = this.worldImage.placement;
      worldX = p.worldX + imgX * wpp;
      worldY = p.worldY + imgY * wpp;
      worldW = imgW * wpp;
      worldH = imgH * wpp;
    } else {
      // No world image set — use image pixels directly (backward compat)
      worldX = imgX;
      worldY = imgY;
      worldW = imgW;
      worldH = imgH;
    }

    const z = zoomLevel + (tileY * 0.00001) + (tileX * 0.000001);

    if (this.loadingTiles.has(tileId)) {
      return {
        id: tileId,
        x: worldX,
        y: worldY,
        z,
        width: worldW,
        height: worldH,
        tileX, tileY, zoomLevel, scaleFactor
      };
    }

    const url = this.image.getTileUrl(imgX, imgY, imgW, imgH);

    return {
      id: tileId,
      url,
      x: worldX,
      y: worldY,
      z,
      width: worldW,
      height: worldH,
      tileX, tileY, zoomLevel, scaleFactor
    };
  }

  loadTilesBatch(tiles: any[]) {
    const tilesToLoad = tiles.filter(tile =>
      !this.tileCache.has(tile.id) && !this.loadingTiles.has(tile.id)
    );

    if (tilesToLoad.length === 0) {
      return;
    }

    tilesToLoad.sort((a, b) => {
      const aPriority = a.priority !== undefined ? a.priority : Infinity;
      const bPriority = b.priority !== undefined ? b.priority : Infinity;
      return aPriority - bPriority;
    });

    Promise.allSettled(tilesToLoad.map(tile => this.loadTile(tile)));
  }

  async loadTile(tile: any) {
    if (this.tileCache.has(tile.id)) {
      const cachedTile = this.tileCache.get(tile.id);
      this.markTileAccessed(tile.id);
      return cachedTile;
    }

    if (this.loadingTiles.has(tile.id)) {
      return null;
    }

    this.loadingTiles.add(tile.id);

    try {
      const response = await fetch(tile.url);
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const blob = await response.blob();
      const loadedBitmap = await createImageBitmap(blob);

      const cachedTile = { ...tile, image: loadedBitmap };
      this.tileCache.set(tile.id, cachedTile);
      this.markTileAccessed(tile.id);

      if (this.renderer) {
        this.queueGPUUpload(tile.id, loadedBitmap);
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
    return Array.from(this.tileCache.values());
  }

  getCachedTile(tileId: string) {
    const tile = this.tileCache.get(tileId);
    if (tile) {
      this.markTileAccessed(tileId);
    }
    return tile;
  }

  requestTilesForViewport(viewport: Viewport) {
    if (!this.hasViewportChanged(viewport)) {
      return;
    }

    const tileBounds = this.calculateTileBoundaries(viewport, true);
    const { zoomLevel, scaleFactor, startTileX, startTileY, endTileX, endTileY, centerTileX, centerTileY } = tileBounds;

    const tiles = [];

    for (let tileY = startTileY; tileY <= endTileY; tileY++) {
      for (let tileX = startTileX; tileX <= endTileX; tileX++) {
        const tile = this.createTile(tileX, tileY, zoomLevel, scaleFactor);
        if (tile) {
          const distX = tileX - centerTileX;
          const distY = tileY - centerTileY;
          tile.priority = Math.sqrt(distX * distX + distY * distY);
          tiles.push(tile);
        }
      }
    }

    this.updateViewportCache(viewport);
    this.invalidateTileCache();
    this.loadTilesBatch(tiles);
  }

  private queueGPUUpload(tileId: string, bitmap: ImageBitmap) {
    this.pendingGPUUploads.push({ tileId, bitmap });

    if (!this.isProcessingUploads) {
      this.processGPUUploadQueue();
    }
  }

  private processGPUUploadQueue() {
    if (this.pendingGPUUploads.length === 0) {
      this.isProcessingUploads = false;
      return;
    }

    this.isProcessingUploads = true;
    const upload = this.pendingGPUUploads.shift()!;

    if (this.renderer) {
      this.renderer.uploadTextureFromBitmap(upload.tileId, upload.bitmap);
    }

    if (this.pendingGPUUploads.length > 0) {
      requestAnimationFrame(() => this.processGPUUploadQueue());
    } else {
      this.isProcessingUploads = false;
    }
  }

  getLoadedTilesForRender(viewport: Viewport) {
    const viewportChanged = this.hasViewportChanged(viewport);

    let neededTileIds: Set<string>;

    if (viewportChanged || !this.cachedNeededTileIds) {
      const tileBounds = this.calculateTileBoundaries(viewport, false);
      const { zoomLevel, scaleFactor, tileSize, startTileX, startTileY, endTileX, endTileY } = tileBounds;

      neededTileIds = new Set<string>();
      for (let tileY = startTileY; tileY <= endTileY; tileY++) {
        for (let tileX = startTileX; tileX <= endTileX; tileX++) {
          const x = tileX * tileSize * scaleFactor;
          const y = tileY * tileSize * scaleFactor;

          if (x >= this.image.width || y >= this.image.height) {
            continue;
          }

          const tileId = `${zoomLevel}-${tileX}-${tileY}`;
          neededTileIds.add(tileId);
        }
      }

      this.cachedNeededTileIds = neededTileIds;
      this.updateViewportCache(viewport);
    } else {
      neededTileIds = this.cachedNeededTileIds;
    }

    const loadedTiles = [];
    for (const tileId of neededTileIds) {
      const cachedTile = this.getCachedTile(tileId);
      if (cachedTile && cachedTile.image) {
        loadedTiles.push(cachedTile);
      }
    }

    let tileSetHash = `${neededTileIds.size}`;
    if (neededTileIds.size > 0) {
      const idsArray = Array.from(neededTileIds);
      tileSetHash += `_${idsArray[0]}_${idsArray[idsArray.length - 1]}`;
    }

    if (this.cachedTileSetHash === tileSetHash && this.cachedSortedTiles) {
      const stillValid = this.cachedSortedTiles.filter(tile =>
        neededTileIds.has(tile.id) && this.tileCache.has(tile.id)
      );

      if (stillValid.length === neededTileIds.size) {
        return stillValid;
      }
    }

    if (loadedTiles.length === neededTileIds.size) {
      const sortedTiles = loadedTiles.sort((a, b) => a.z - b.z);

      this.cachedSortedTiles = sortedTiles;
      this.cachedTileSetHash = tileSetHash;
      this.lastRenderedTiles = sortedTiles;

      return sortedTiles;
    }

    if (this.lastRenderedTiles.length > 0) {
      const tileMap = new Map(loadedTiles.map(t => [t.id, t]));

      for (const oldTile of this.lastRenderedTiles) {
        if (!tileMap.has(oldTile.id)) {
          tileMap.set(oldTile.id, oldTile);
        }
      }

      const sortedTiles = Array.from(tileMap.values()).sort((a, b) => a.z - b.z);
      return sortedTiles;
    }

    const sortedTiles = loadedTiles.sort((a, b) => a.z - b.z);
    this.cachedSortedTiles = sortedTiles;
    this.cachedTileSetHash = tileSetHash;

    return sortedTiles;
  }

  setRenderer(renderer: IIIFRenderer) {
    this.renderer = renderer;
  }

  /** Load low-resolution thumbnail positioned in world coordinates */
  async loadThumbnail(maxDimension = 512) {
    const thumbnailUrl = this.image.getThumbnailUrl(maxDimension);

    try {
      const response = await fetch(thumbnailUrl);
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const blob = await response.blob();
      const loadedBitmap = await createImageBitmap(blob);

      // Position thumbnail in world coordinates
      let thumbX: number, thumbY: number, thumbW: number, thumbH: number;
      if (this.worldImage) {
        const p = this.worldImage.placement;
        thumbX = p.worldX;
        thumbY = p.worldY;
        thumbW = p.worldWidth;
        thumbH = p.worldHeight;
      } else {
        thumbX = 0;
        thumbY = 0;
        thumbW = this.image.width;
        thumbH = this.image.height;
      }

      this.thumbnail = {
        id: `thumbnail-${this.id}`,
        image: loadedBitmap,
        x: thumbX,
        y: thumbY,
        z: -1,
        width: thumbW,
        height: thumbH,
        url: thumbnailUrl
      };

      if (this.renderer) {
        this.queueGPUUpload(this.thumbnail.id, loadedBitmap);
      }

      return this.thumbnail;
    } catch (error) {
      console.error(`Failed to load thumbnail: ${thumbnailUrl}`, error);
      return null;
    }
  }

  getThumbnail() {
    return this.thumbnail;
  }

  private evictOldTiles() {
    if (this.tileCache.size > this.maxCacheSize) {
      const toRemoveCount = Math.floor(this.maxCacheSize * 0.2);
      const toRemove = Array.from(this.tileAccessOrder).slice(0, toRemoveCount);

      for (const tileId of toRemove) {
        if (this.renderer) {
          this.renderer.destroyTexture(tileId);
        }

        this.tileCache.delete(tileId);
        this.tileAccessOrder.delete(tileId);
      }
    }
  }

  private markTileAccessed(tileId: string) {
    this.tileAccessOrder.delete(tileId);
    this.tileAccessOrder.add(tileId);
  }
}
