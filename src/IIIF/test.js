// =============================================================================
// CORE IIIF IMAGE CLASS
// =============================================================================

class IIIFImage {
  constructor(infoUrl) {
    this.infoUrl = infoUrl;
    this.info = null;
    this.isLoaded = false;
  }

  async load() {
    try {
      const response = await fetch(this.infoUrl);
      this.info = await response.json();
      this.validateImageAPI();
      this.isLoaded = true;
      return this.info;
    } catch (error) {
      throw new Error(`Failed to load IIIF image: ${error.message}`);
    }
  }

  validateImageAPI() {
    if (!this.info['@context']?.includes('/api/image/')) {
      throw new Error('Not a valid IIIF Image API resource');
    }
    if (!this.info.width || !this.info.height) {
      throw new Error('Missing required width/height properties');
    }
  }

  // Image properties
  get baseUrl() { return this.info['@id']; }
  get width() { return this.info.width; }
  get height() { return this.info.height; }
  get aspectRatio() { return this.width / this.height; }
  get tileSize() { return this.info.tiles?.[0]?.width || 256; }
  get scaleFactors() { return this.info.tiles?.[0]?.scaleFactors || [1]; }
  get maxZoomLevel() { return this.scaleFactors.length - 1; }

  // Generate IIIF URL for specific region/size
  getImageUrl(region = 'full', size = 'full', rotation = '0', quality = 'default', format = 'jpg') {
    return `${this.baseUrl}/${region}/${size}/${rotation}/${quality}.${format}`;
  }

  // Generate tile URL
  getTileUrl(x, y, width, height, tileSize = this.tileSize) {
    const region = `${x},${y},${width},${height}`;
    const size = `${tileSize},${tileSize}`;
    return this.getImageUrl(region, size);
  }
}

// =============================================================================
// VIEWPORT & ZOOM MANAGEMENT
// =============================================================================

class Viewport {
  constructor(containerWidth, containerHeight) {
    this.containerWidth = containerWidth;
    this.containerHeight = containerHeight;
    this.scale = 1;
    this.centerX = 0.5; // Normalized coordinates (0-1)
    this.centerY = 0.5;
    this.minScale = 0;
    this.maxScale = 10;
  }

  // Set viewport to fit entire image
  fitToContainer(imageWidth, imageHeight) {
    const scaleX = this.containerWidth / imageWidth;
    const scaleY = this.containerHeight / imageHeight;
    this.scale = Math.min(scaleX, scaleY);
    this.centerX = 0.5;
    this.centerY = 0.5;
    return this;
  }

  // Get visible bounds in image coordinates
  getImageBounds(imageWidth, imageHeight) {
    const scaledWidth = this.containerWidth / this.scale;
    const scaledHeight = this.containerHeight / this.scale;
    
    const left = (this.centerX * imageWidth) - (scaledWidth / 2);
    const top = (this.centerY * imageHeight) - (scaledHeight / 2);
    
    return {
      left: Math.max(0, left),
      top: Math.max(0, top),
      right: Math.min(imageWidth, left + scaledWidth),
      bottom: Math.min(imageHeight, top + scaledHeight),
      width: scaledWidth,
      height: scaledHeight
    };
  }

  // Zoom to specific point
  zoomTo(newScale, imageX, imageY, imageWidth, imageHeight) {
    this.scale = Math.max(this.minScale, Math.min(this.maxScale, newScale));
    this.centerX = imageX / imageWidth;
    this.centerY = imageY / imageHeight;
    this.constrainCenter();
  }

  // Pan by pixel offset
  pan(deltaX, deltaY, imageWidth, imageHeight) {
    const normalizedDx = (deltaX / this.scale) / imageWidth;
    const normalizedDy = (deltaY / this.scale) / imageHeight;
    
    this.centerX -= normalizedDx;
    this.centerY -= normalizedDy;
    this.constrainCenter();
  }

  constrainCenter() {
    this.centerX = Math.max(0, Math.min(1, this.centerX));
    this.centerY = Math.max(0, Math.min(1, this.centerY));
  }
}

// =============================================================================
// TILE MANAGER
// =============================================================================

class TileManager {
  constructor(iiifImage) {
    this.image = iiifImage;
    this.tileCache = new Map();
    this.loadingTiles = new Set();
  }

  // Determine optimal zoom level for current scale
  getOptimalZoomLevel(scale) {
    const imageScale = 1 / scale;
    let bestLevel = 0;
    
    for (let i = 0; i < this.image.scaleFactors.length; i++) {
      if (imageScale >= this.image.scaleFactors[i] * 0.5) {
        bestLevel = i;
        break;
      }
    }
    
    return Math.min(bestLevel, this.image.maxZoomLevel);
  }

  // Get tiles needed for current viewport
  getTilesForViewport(viewport) {
    const zoomLevel = this.getOptimalZoomLevel(viewport.scale);
    const scaleFactor = this.image.scaleFactors[zoomLevel];
    const bounds = viewport.getImageBounds(this.image.width, this.image.height);
    
    // Scale bounds to the resolution level
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

    return tiles;
  }

  createTile(tileX, tileY, zoomLevel, scaleFactor) {
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

  // Load tile with caching
  async loadTile(tile) {
    if (this.tileCache.has(tile.id)) {
      return this.tileCache.get(tile.id);
    }

    if (this.loadingTiles.has(tile.id)) {
      return null; // Already loading
    }

    this.loadingTiles.add(tile.id);

    try {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      
      const loadPromise = new Promise((resolve, reject) => {
        img.onload = () => resolve(img);
        img.onerror = reject;
      });

      img.src = tile.url;
      const loadedImg = await loadPromise;

      const cachedTile = { ...tile, image: loadedImg };
      this.tileCache.set(tile.id, cachedTile);
      return cachedTile;

    } catch (error) {
      console.error(`Failed to load tile: ${tile.url}`, error);
      return null;
    } finally {
      this.loadingTiles.delete(tile.id);
    }
  }
}

// =============================================================================
// SINGLE IMAGE VIEWER
// =============================================================================

class IIIFViewer {
  constructor(containerId, options = {}) {
    this.container = document.getElementById(containerId);
    this.canvas = document.createElement('canvas');
    this.ctx = this.canvas.getContext('2d');
    this.container.appendChild(this.canvas);

    this.image = null;
    this.viewport = null;
    this.tileManager = null;
    this.animationId = null;

    this.options = {
      backgroundColor: '#000000',
      enablePan: true,
      enableZoom: true,
      zoomSpeed: 1.2,
      ...options
    };

    this.setupEventHandlers();
    this.setupCanvas();
  }

  async loadImage(infoUrl) {
    try {
      this.image = new IIIFImage(infoUrl);
      await this.image.load();
      
      this.tileManager = new TileManager(this.image);
      this.viewport = new Viewport(this.canvas.width, this.canvas.height);
      this.viewport.fitToContainer(this.image.width, this.image.height);
      
      this.render();
      return this.image;
    } catch (error) {
      console.error('Failed to load IIIF image:', error);
      throw error;
    }
  }

  setupCanvas() {
    const updateSize = () => {
      const rect = this.container.getBoundingClientRect();
      this.canvas.width = rect.width;
      this.canvas.height = rect.height;
      
      if (this.viewport) {
        this.viewport.containerWidth = rect.width;
        this.viewport.containerHeight = rect.height;
        this.render();
      }
    };

    updateSize();
    window.addEventListener('resize', updateSize);
  }

  setupEventHandlers() {
    // Mouse wheel zoom
    this.canvas.addEventListener('wheel', (e) => {
      if (!this.options.enableZoom || !this.viewport) return;
      
      e.preventDefault();
      const rect = this.canvas.getBoundingClientRect();
      const mouseX = e.clientX - rect.left;
      const mouseY = e.clientY - rect.top;
      
      const zoomFactor = e.deltaY > 0 ? 1/this.options.zoomSpeed : this.options.zoomSpeed;
      this.zoomAt(mouseX, mouseY, zoomFactor);
    });

    // Mouse pan
    let isPanning = false;
    let lastMouseX, lastMouseY;

    this.canvas.addEventListener('mousedown', (e) => {
      if (!this.options.enablePan) return;
      isPanning = true;
      lastMouseX = e.clientX;
      lastMouseY = e.clientY;
    });

    this.canvas.addEventListener('mousemove', (e) => {
      if (!isPanning || !this.viewport) return;
      
      const deltaX = e.clientX - lastMouseX;
      const deltaY = e.clientY - lastMouseY;
      
      this.viewport.pan(deltaX, deltaY, this.image.width, this.image.height);
      this.render();
      
      lastMouseX = e.clientX;
      lastMouseY = e.clientY;
    });

    this.canvas.addEventListener('mouseup', () => {
      isPanning = false;
    });
  }

  zoomAt(canvasX, canvasY, zoomFactor) {
    if (!this.viewport || !this.image) return;

    const bounds = this.viewport.getImageBounds(this.image.width, this.image.height);
    const imageX = bounds.left + (canvasX / this.viewport.scale);
    const imageY = bounds.top + (canvasY / this.viewport.scale);
    
    const newScale = this.viewport.scale * zoomFactor;
    this.viewport.zoomTo(newScale, imageX, imageY, this.image.width, this.image.height);
    this.render();
  }

  async render() {
    if (!this.image || !this.viewport || !this.tileManager) return;

    // Clear canvas
    this.ctx.fillStyle = this.options.backgroundColor;
    this.ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);

    const tiles = this.tileManager.getTilesForViewport(this.viewport);
    
    // Load and draw tiles
    for (const tile of tiles) {
      const cachedTile = await this.tileManager.loadTile(tile);
      if (cachedTile && cachedTile.image) {
        this.drawTile(cachedTile);
      }
    }
  }

  drawTile(tile) {
    const bounds = this.viewport.getImageBounds(this.image.width, this.image.height);
    
    // Calculate tile position on canvas
    const canvasX = (tile.x - bounds.left) * this.viewport.scale;
    const canvasY = (tile.y - bounds.top) * this.viewport.scale;
    const canvasWidth = tile.width * this.viewport.scale;
    const canvasHeight = tile.height * this.viewport.scale;

    this.ctx.drawImage(
      tile.image,
      canvasX, canvasY,
      canvasWidth, canvasHeight
    );
  }

  // Public API methods
  fitToContainer() {
    if (this.viewport && this.image) {
      this.viewport.fitToContainer(this.image.width, this.image.height);
      this.render();
    }
  }

  zoomIn() { this.zoom(this.options.zoomSpeed); }
  zoomOut() { this.zoom(1 / this.options.zoomSpeed); }
  
  zoom(factor) {
    if (this.viewport) {
      const centerX = this.canvas.width / 2;
      const centerY = this.canvas.height / 2;
      this.zoomAt(centerX, centerY, factor);
    }
  }

  getCurrentScale() {
    return this.viewport ? this.viewport.scale : 1;
  }

  getCurrentCenter() {
    return this.viewport ? 
      { x: this.viewport.centerX, y: this.viewport.centerY } : 
      { x: 0.5, y: 0.5 };
  }
}

// =============================================================================
// COMPARISON VIEWER
// =============================================================================

class IIIFComparisonViewer {
  constructor(containerId, options = {}) {
    this.container = document.getElementById(containerId);
    this.viewers = [];
    this.syncViewports = options.syncViewports !== false;
    this.layout = options.layout || 'side-by-side'; // 'side-by-side', 'overlay', 'split'
    
    this.setupLayout();
  }

  setupLayout() {
    this.container.innerHTML = '';
    this.container.style.display = 'flex';
    
    if (this.layout === 'side-by-side') {
      this.container.style.flexDirection = 'row';
    } else if (this.layout === 'overlay') {
      this.container.style.position = 'relative';
    }
  }

  async addImage(infoUrl, label = '') {
    const viewerContainer = document.createElement('div');
    viewerContainer.style.flex = '1';
    viewerContainer.style.position = 'relative';
    
    if (this.layout === 'overlay' && this.viewers.length > 0) {
      viewerContainer.style.position = 'absolute';
      viewerContainer.style.top = '0';
      viewerContainer.style.left = '0';
      viewerContainer.style.width = '100%';
      viewerContainer.style.height = '100%';
      viewerContainer.style.opacity = '0.5';
    }

    this.container.appendChild(viewerContainer);

    const viewer = new IIIFViewer(viewerContainer.id = `viewer-${this.viewers.length}`, {
      enablePan: this.syncViewports,
      enableZoom: this.syncViewports
    });

    // Sync viewports if enabled
    if (this.syncViewports) {
      this.setupViewportSync(viewer);
    }

    this.viewers.push({ viewer, container: viewerContainer, label });
    
    await viewer.loadImage(infoUrl);
    return viewer;
  }

  setupViewportSync(newViewer) {
    // Override render method to sync with other viewers
    const originalRender = newViewer.render.bind(newViewer);
    newViewer.render = () => {
      originalRender();
      this.syncOtherViewers(newViewer);
    };
  }

  syncOtherViewers(sourceViewer) {
    const scale = sourceViewer.getCurrentScale();
    const center = sourceViewer.getCurrentCenter();

    this.viewers.forEach(({ viewer }) => {
      if (viewer !== sourceViewer && viewer.viewport) {
        viewer.viewport.scale = scale;
        viewer.viewport.centerX = center.x;
        viewer.viewport.centerY = center.y;
        viewer.render();
      }
    });
  }

  // Switch between layout modes
  setLayout(layout) {
    this.layout = layout;
    this.setupLayout();
    // Re-add viewers to new layout
    const currentViewers = [...this.viewers];
    this.viewers = [];
    
    currentViewers.forEach(async ({ viewer, label }) => {
      await this.addImage(viewer.image.infoUrl, label);
    });
  }
}