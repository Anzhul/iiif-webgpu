import { IIIFImage } from './iiif-image';
import type { IIIFRenderer } from './iiif-renderer';

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
        zoomLevel: number;  // Cache zoom level to detect level changes
        containerWidth: number;
        containerHeight: number;
        // World space coordinates (for multi-image mode)
        worldCenterX?: number;
        worldCenterY?: number;
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

  // Determine optimal zoom level for current scale
  getOptimalZoomLevel(scale: number) {
    // Round scale to 3 decimal places (0.001 precision) to reduce cache invalidations
    const roundedScale = Math.round(scale * 1000) / 1000;
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

  /**
   * Check if viewport has changed significantly enough to invalidate tile cache
   * Uses a small threshold to avoid recalculating on tiny movements
   * Supports both single-image mode (centerX/Y) and world space mode (worldCenterX/Y)
   */
  private hasViewportChanged(viewport: any, useWorldSpace: boolean = false): boolean {
    if (!this.cachedViewportState) {
      return true;
    }

    const state = this.cachedViewportState;
    const threshold = 0.001; // ~0.1% movement threshold
    // World space uses pixel coordinates, so need larger threshold
    const worldThreshold = 1.0; // 1 pixel movement threshold

    // CRITICAL: Check if zoom level changed - this is more important than scale threshold
    // Even small scale changes can cross zoom level boundaries, requiring different tiles
    const currentZoomLevel = this.getOptimalZoomLevel(viewport.scale);
    if (currentZoomLevel !== state.zoomLevel) {
      return true;
    }

    // Check scale and container size (common to both modes)
    if (Math.abs(viewport.scale - state.scale) > threshold ||
        viewport.containerWidth !== state.containerWidth ||
        viewport.containerHeight !== state.containerHeight) {
      return true;
    }

    // Check center coordinates based on mode
    if (useWorldSpace) {
      // World space mode - check world center coordinates
      const worldCenterX = viewport.worldCenterX ?? 0;
      const worldCenterY = viewport.worldCenterY ?? 0;
      const cachedWorldX = state.worldCenterX ?? 0;
      const cachedWorldY = state.worldCenterY ?? 0;
      return (
        Math.abs(worldCenterX - cachedWorldX) > worldThreshold ||
        Math.abs(worldCenterY - cachedWorldY) > worldThreshold
      );
    } else {
      // Single image mode - check normalized center coordinates
      return (
        Math.abs(viewport.centerX - state.centerX) > threshold ||
        Math.abs(viewport.centerY - state.centerY) > threshold
      );
    }
  }

  /**
   * Update cached viewport state
   */
  private updateViewportCache(viewport: any, useWorldSpace: boolean = false): void {
    this.cachedViewportState = {
      centerX: viewport.centerX,
      centerY: viewport.centerY,
      scale: viewport.scale,
      zoomLevel: this.getOptimalZoomLevel(viewport.scale),
      containerWidth: viewport.containerWidth,
      containerHeight: viewport.containerHeight,
      worldCenterX: useWorldSpace ? viewport.worldCenterX : undefined,
      worldCenterY: useWorldSpace ? viewport.worldCenterY : undefined
    };
  }

  /**
   * Invalidate the tile calculation cache
   * Call this when tiles are loaded or viewport changes significantly
   */
  private invalidateTileCache(): void {
    this.cachedNeededTileIds = null;
    // Also invalidate sort cache since tile set may have changed
    this.cachedSortedTiles = null;
    this.cachedTileSetHash = null;
  }

  /**
   * Shared method to calculate tile boundaries for a given viewport
   * Returns tile coordinate ranges and related metadata
   * @param viewport - The viewport to calculate boundaries for
   * @param includeMargin - Whether to include margin for preloading (default: false)
   */
  private calculateTileBoundaries(viewport: any, includeMargin: boolean = false) {
    const zoomLevel = this.getOptimalZoomLevel(viewport.scale);
    const scaleFactor = this.image.scaleFactors[zoomLevel];
    const bounds = viewport.getImageBounds(this.image);
    const tileSize = this.image.tileSize;

    // Add margin if requested (for preloading adjacent tiles)
    const margin = includeMargin ? tileSize * scaleFactor : 0;

    // Scale bounds to the resolution level with optional margin
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

    return {
      zoomLevel,
      scaleFactor,
      tileSize,
      startTileX,
      startTileY,
      endTileX,
      endTileY,
      // Calculate viewport center in tile coordinates for distance calculations
      centerTileX: (viewport.centerX * this.image.width) / (tileSize * scaleFactor),
      centerTileY: (viewport.centerY * this.image.height) / (tileSize * scaleFactor)
    };
  }


  createTile(tileX: number, tileY: number, zoomLevel: number, scaleFactor: number) {
    const tileSize = this.image.tileSize;
    const x = tileX * tileSize * scaleFactor;
    const y = tileY * tileSize * scaleFactor;

    // Don't create tiles outside image bounds
    if (x >= this.image.width || y >= this.image.height) {
      return null;
    }

    // Include image ID in tile ID to prevent collisions across multiple images
    const tileId = `${this.id}_${zoomLevel}-${tileX}-${tileY}`;

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
        // Assign unique z-value per tile to prevent depth fighting at edges
        // Base: zoomLevel, Offset: tiny increments based on tile position
        // This ensures deterministic render order: back-to-front, top-left to bottom-right
        z: zoomLevel + (tileY * 0.00001) + (tileX * 0.000001),
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
      // Assign unique z-value per tile to prevent depth fighting at edges
      // Base: zoomLevel, Offset: tiny increments based on tile position
      // This ensures deterministic render order: back-to-front, top-left to bottom-right
      z: zoomLevel + (tileY * 0.00001) + (tileX * 0.000001),
      width: width,
      height: height,
      tileX: tileX,
      tileY: tileY,
      zoomLevel: zoomLevel,
      scaleFactor: scaleFactor
    };
  }

  // Maximum concurrent tile requests to prevent ERR_INSUFFICIENT_RESOURCES
  private static readonly MAX_CONCURRENT_REQUESTS = 6;
  private static globalLoadingCount = 0;
  private static pendingQueue: Array<{ tile: any; manager: TileManager }> = [];

  // Load tiles in parallel batches with priority ordering and throttling
  loadTilesBatch(tiles: any[]) {
    const tilesToLoad = tiles.filter(tile =>
      !this.tileCache.has(tile.id) && !this.loadingTiles.has(tile.id)
    );

    if (tilesToLoad.length === 0) {
      return;
    }

    // Sort tiles by priority (closest to viewport center first)
    tilesToLoad.sort((a, b) => {
      const aPriority = a.priority !== undefined ? a.priority : Infinity;
      const bPriority = b.priority !== undefined ? b.priority : Infinity;
      return aPriority - bPriority;
    });

    // Add to global pending queue with manager reference
    for (const tile of tilesToLoad) {
      if (!this.loadingTiles.has(tile.id)) {
        TileManager.pendingQueue.push({ tile, manager: this });
      }
    }

    // Process queue
    this.processQueue();
  }

  // Process the global tile loading queue
  private processQueue() {
    while (TileManager.globalLoadingCount < TileManager.MAX_CONCURRENT_REQUESTS &&
           TileManager.pendingQueue.length > 0) {
      const item = TileManager.pendingQueue.shift();
      if (!item) break;

      const { tile, manager } = item;

      // Skip if already loaded or loading
      if (manager.tileCache.has(tile.id) || manager.loadingTiles.has(tile.id)) {
        continue;
      }

      TileManager.globalLoadingCount++;
      manager.loadTile(tile).finally(() => {
        TileManager.globalLoadingCount--;
        // Process next item in queue
        this.processQueue();
      });
    }
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

      // Queue GPU upload instead of blocking immediately
      if (this.renderer) {
        this.queueGPUUpload(tile.id, loadedBitmap);
      }

      // No cache invalidation needed - existing validation logic at lines 440-451
      // automatically detects when new tiles load and recalculates as needed

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
    // Skip if viewport hasn't changed significantly
    if (!this.hasViewportChanged(viewport)) {
      return;
    }

    // Use shared calculation with margin for preloading
    const tileBounds = this.calculateTileBoundaries(viewport, true);
    const { zoomLevel, scaleFactor, startTileX, startTileY, endTileX, endTileY, centerTileX, centerTileY } = tileBounds;

    const tiles = [];

    for (let tileY = startTileY; tileY <= endTileY; tileY++) {
      for (let tileX = startTileX; tileX <= endTileX; tileX++) {
        const tile = this.createTile(tileX, tileY, zoomLevel, scaleFactor);
        if (tile) {
          // Calculate distance from viewport center for priority sorting
          const distX = tileX - centerTileX;
          const distY = tileY - centerTileY;
          tile.priority = Math.sqrt(distX * distX + distY * distY);
          tiles.push(tile);
        }
      }
    }

    // Update viewport cache for next change detection
    this.updateViewportCache(viewport);

    // Invalidate the render cache since viewport changed
    this.invalidateTileCache();

    // Load tiles with priority-based ordering (non-blocking)
    this.loadTilesBatch(tiles);
  }

  /**
   * Queue GPU upload to avoid blocking the main thread during texture upload
   * Uploads are processed asynchronously during idle time
   */
  private queueGPUUpload(tileId: string, bitmap: ImageBitmap) {
    this.pendingGPUUploads.push({ tileId, bitmap });

    // Start processing if not already running
    if (!this.isProcessingUploads) {
      this.processGPUUploadQueue();
    }
  }

  /**
   * Process GPU upload queue asynchronously
   * Uses requestAnimationFrame for non-blocking uploads spread across frames
   */
  private processGPUUploadQueue() {
    if (this.pendingGPUUploads.length === 0) {
      this.isProcessingUploads = false;
      return;
    }

    this.isProcessingUploads = true;
    const upload = this.pendingGPUUploads.shift()!;

    // Upload immediately (GPU operations are already async via command queues)
    if (this.renderer) {
      this.renderer.uploadTextureFromBitmap(upload.tileId, upload.bitmap);
    }

    // Check queue again (new items may have been added during upload)
    // This prevents race condition where items added during processing are missed
    if (this.pendingGPUUploads.length > 0) {
      // Use requestAnimationFrame for smooth uploads without blocking
      requestAnimationFrame(() => this.processGPUUploadQueue());
    } else {
      // Queue is empty now, but mark as not processing to allow new batches
      this.isProcessingUploads = false;
    }
  }

  // Get loaded tiles for rendering with fallback to previous tiles (optimized for WebGPU)
  // This is called every render frame and should NOT trigger new tile requests
  getLoadedTilesForRender(viewport: any) {
    // Check if viewport has changed significantly - if not, use cached tile IDs
    const viewportChanged = this.hasViewportChanged(viewport);

    let neededTileIds: Set<string>;

    if (viewportChanged || !this.cachedNeededTileIds) {
      // Viewport changed or no cache - recalculate tile boundaries (no margin for rendering)
      const tileBounds = this.calculateTileBoundaries(viewport, false);
      const { zoomLevel, scaleFactor, tileSize, startTileX, startTileY, endTileX, endTileY } = tileBounds;

      // Build list of tile IDs we need for current viewport
      neededTileIds = new Set<string>();
      for (let tileY = startTileY; tileY <= endTileY; tileY++) {
        for (let tileX = startTileX; tileX <= endTileX; tileX++) {
          const x = tileX * tileSize * scaleFactor;
          const y = tileY * tileSize * scaleFactor;

          // Don't create tiles outside image bounds
          if (x >= this.image.width || y >= this.image.height) {
            continue;
          }

          // Include image ID in tile ID to prevent collisions across multiple images
          const tileId = `${this.id}_${zoomLevel}-${tileX}-${tileY}`;
          neededTileIds.add(tileId);
        }
      }

      // Cache the results for next frame
      this.cachedNeededTileIds = neededTileIds;
      this.updateViewportCache(viewport);
    } else {
      // Viewport hasn't changed - reuse cached tile IDs (avoids expensive calculations)
      neededTileIds = this.cachedNeededTileIds;
    }

    // Get only loaded tiles from cache (no network requests)
    const loadedTiles = [];
    for (const tileId of neededTileIds) {
      const cachedTile = this.getCachedTile(tileId);
      if (cachedTile && cachedTile.image) {
        loadedTiles.push(cachedTile);
      }
    }

    // Generate a hash of the tile set to detect if tiles have changed
    // Use Set size + first/last IDs as a fast approximation instead of expensive sort+join
    // This is much faster and sufficient for detecting tile set changes
    let tileSetHash = `${neededTileIds.size}`;
    if (neededTileIds.size > 0) {
      // Add a few sample IDs for better uniqueness (first and last when sorted)
      const idsArray = Array.from(neededTileIds);
      tileSetHash += `_${idsArray[0]}_${idsArray[idsArray.length - 1]}`;
    }

    // Check if we can use cached sorted tiles (same tile set as last frame)
    if (this.cachedTileSetHash === tileSetHash && this.cachedSortedTiles) {
      // Filter cached sorted tiles to only include currently loaded ones
      const stillValid = this.cachedSortedTiles.filter(tile =>
        neededTileIds.has(tile.id) && this.tileCache.has(tile.id)
      );

      // If all needed tiles are present in cache, return cached sorted result
      if (stillValid.length === neededTileIds.size) {
        return stillValid;
      }
    }

    // If we got all tiles, sort and cache the result
    if (loadedTiles.length === neededTileIds.size) {
      // CRITICAL: Always sort by z-depth for consistent render order
      // Sort back to front: lower z (farther) renders first, higher z (closer) renders last
      const sortedTiles = loadedTiles.sort((a, b) => a.z - b.z);

      // Cache the sorted result
      this.cachedSortedTiles = sortedTiles;
      this.cachedTileSetHash = tileSetHash;
      this.lastRenderedTiles = sortedTiles;

      return sortedTiles;
    }

    // Some tiles are missing - use previous tiles as fallback
    // This provides visual continuity during zoom transitions
    if (this.lastRenderedTiles.length > 0) {
      // Start with all previous tiles (they render behind due to lower z-depth)
      const tileMap = new Map<string, any>();

      // Add old tiles first - they'll be rendered behind new ones
      // Filter to only include tiles that are still in cache (not evicted)
      for (const oldTile of this.lastRenderedTiles) {
        if (this.tileCache.has(oldTile.id)) {
          tileMap.set(oldTile.id, oldTile);
        }
      }

      // Add/override with new loaded tiles (higher z-depth = rendered on top)
      for (const newTile of loadedTiles) {
        tileMap.set(newTile.id, newTile);
      }

      // CRITICAL: Always sort by z-depth for consistent render order
      // Sort back to front: lower z (farther/old) renders first, higher z (closer/new) renders last
      const sortedTiles = Array.from(tileMap.values()).sort((a, b) => a.z - b.z);

      // Don't cache this result as it's a fallback mix
      return sortedTiles;
    }

    // No previous tiles available, sort what we have
    const sortedTiles = loadedTiles.sort((a, b) => a.z - b.z);

    // Cache the sorted result
    this.cachedSortedTiles = sortedTiles;
    this.cachedTileSetHash = tileSetHash;

    return sortedTiles;
  }

  // Set renderer reference (useful if renderer is created after TileManager)
  setRenderer(renderer: IIIFRenderer) {
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

      // Validate blob before attempting to decode
      if (blob.size === 0) {
        throw new Error('Empty response blob');
      }

      // Check content type - if not an image, the server may have returned an error page
      const contentType = blob.type;
      if (contentType && !contentType.startsWith('image/')) {
        throw new Error(`Unexpected content type: ${contentType}`);
      }

      const loadedBitmap = await createImageBitmap(blob);

      // Include image ID in thumbnail ID to prevent collisions
      const thumbnailId = `${this.id}_thumbnail`;
      this.thumbnail = {
        id: thumbnailId,
        image: loadedBitmap,
        x: 0,
        y: 0,
        z: -1,  // Render behind all tiles
        width: this.image.width,
        height: this.image.height,
        url: thumbnailUrl
      };

      // Queue GPU upload for thumbnail
      if (this.renderer) {
        this.queueGPUUpload(thumbnailId, loadedBitmap);
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

  /**
   * Get tiles for world-space rendering (includes world offset)
   * Used for multi-image unified canvas mode
   * NOTE: Caller should check isImageVisible() before calling this method
   */
  getWorldSpaceTiles(viewport: any): Array<any> {
    const tiles: any[] = [];

    // ALWAYS add thumbnail as background if available (caller already checked visibility)
    if (this.thumbnail) {
      tiles.push({
        ...this.thumbnail,
        worldOffsetX: this.image.worldX,
        worldOffsetY: this.image.worldY
      });
    }

    // Use world-space bounds calculation (returns clamped bounds)
    const localBounds = viewport.getImageBoundsInWorldSpace(this.image);

    // Check if we have a valid intersection for tile calculation
    // This can happen when viewport partially overlaps the image
    if (localBounds.right <= localBounds.left || localBounds.bottom <= localBounds.top) {
      // No valid tile intersection, but thumbnail was already added above
      return tiles;
    }

    const zoomLevel = this.getOptimalZoomLevel(viewport.scale);
    const scaleFactor = this.image.scaleFactors[zoomLevel];
    const tileSize = this.image.tileSize;

    // Calculate tile boundaries from local bounds (already clamped to image dimensions)
    const startTileX = Math.floor(localBounds.left / (tileSize * scaleFactor));
    const startTileY = Math.floor(localBounds.top / (tileSize * scaleFactor));
    const endTileX = Math.floor(localBounds.right / (tileSize * scaleFactor));
    const endTileY = Math.floor(localBounds.bottom / (tileSize * scaleFactor));

    // Collect loaded tiles with world offset
    for (let tileY = startTileY; tileY <= endTileY; tileY++) {
      for (let tileX = startTileX; tileX <= endTileX; tileX++) {
        const tileId = `${this.id}_${zoomLevel}-${tileX}-${tileY}`;
        const cachedTile = this.tileCache.get(tileId);

        if (cachedTile && cachedTile.image) {
          tiles.push({
            ...cachedTile,
            worldOffsetX: this.image.worldX,
            worldOffsetY: this.image.worldY
          });
          this.markTileAccessed(tileId);
        }
      }
    }

    return tiles;
  }

  /**
   * Request tiles for world-space viewport
   * Similar to requestTilesForViewport but uses world-space bounds
   */
  requestTilesForWorldViewport(viewport: any): void {
    // Use world-space bounds calculation (returns clamped bounds)
    const localBounds = viewport.getImageBoundsInWorldSpace(this.image);

    // Check if image is visible: after clamping, right must be > left and bottom must be > top
    // Since localBounds is clamped, we check if the clamped area has any size
    if (localBounds.right <= localBounds.left || localBounds.bottom <= localBounds.top) {
      return; // Image not visible, skip tile loading
    }

    const zoomLevel = this.getOptimalZoomLevel(viewport.scale);
    const scaleFactor = this.image.scaleFactors[zoomLevel];
    const tileSize = this.image.tileSize;

    // Add margin for preloading (but clamp to image bounds)
    const preloadMargin = tileSize * scaleFactor;

    // Calculate tile boundaries with preload margin (clamped to valid tile range)
    const startTileX = Math.max(0, Math.floor((localBounds.left - preloadMargin) / (tileSize * scaleFactor)));
    const startTileY = Math.max(0, Math.floor((localBounds.top - preloadMargin) / (tileSize * scaleFactor)));
    // Calculate max tile indices for this image
    const maxTileX = Math.ceil(this.image.width / (tileSize * scaleFactor)) - 1;
    const maxTileY = Math.ceil(this.image.height / (tileSize * scaleFactor)) - 1;
    const endTileX = Math.min(maxTileX, Math.floor((localBounds.right + preloadMargin) / (tileSize * scaleFactor)));
    const endTileY = Math.min(maxTileY, Math.floor((localBounds.bottom + preloadMargin) / (tileSize * scaleFactor)));

    // Calculate viewport center in local image coordinates for priority
    const localCenterX = viewport.worldCenterX - this.image.worldX;
    const localCenterY = viewport.worldCenterY - this.image.worldY;
    const centerTileX = localCenterX / (tileSize * scaleFactor);
    const centerTileY = localCenterY / (tileSize * scaleFactor);

    const tiles: any[] = [];

    for (let tileY = startTileY; tileY <= endTileY; tileY++) {
      for (let tileX = startTileX; tileX <= endTileX; tileX++) {
        const tile = this.createTile(tileX, tileY, zoomLevel, scaleFactor);
        if (tile) {
          // Calculate distance from viewport center for priority
          const distX = tileX - centerTileX;
          const distY = tileY - centerTileY;
          tile.priority = Math.sqrt(distX * distX + distY * distY);
          tiles.push(tile);
        }
      }
    }

    // Load tiles with priority ordering
    this.loadTilesBatch(tiles);
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