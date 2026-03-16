
export class IIIFImage {
    manifest: any;
    url: string;
    id : string;

    constructor(id: string, url: string) {
        this.id = id;
        this.manifest = null;
        this.url = url;
    }

    get baseUrl() { return this.manifest.id || this.manifest['@id']; }
    get width() { return this.manifest.width; }
    get height() { return this.manifest.height; }
    get aspectRatio() { return this.manifest.width / this.manifest.height; }
    get tileSize() { return this.manifest.tiles?.[0]?.width || 256; }
    get tileOverlap() { return this.manifest.tiles?.[0]?.overlap || 0; }
    get scaleFactors() { return this.manifest.tiles?.[0]?.scaleFactors || [1]; }
    get maxZoomLevel() { return this.scaleFactors.length - 1; }

    async loadManifest(url: string) {
        try {
            const response = await fetch(url);
            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }
            this.manifest = await response.json();
            return this.manifest;
        } catch (error) {
            console.error('Error fetching manifest:', error);
            throw error;
        }
    }

    getImageUrl(region = 'full', size = 'full', rotation = '0', quality = 'default', format = 'jpg') {
        return `${this.baseUrl}/${region}/${size}/${rotation}/${quality}.${format}`;
    }

    getTileUrl(x: number, y: number, width: number, height: number, scaleFactor: number = 1) {
        const region = `${x},${y},${width},${height}`;
        const outW = Math.ceil(width / scaleFactor);
        const outH = Math.ceil(height / scaleFactor);
        const size = `${outW},${outH}`;
        return this.getImageUrl(region, size);
    }

    // Get the lowest resolution full image for thumbnail background
    getThumbnailUrl(maxDimension = 512) {
        // Request full image at lowest resolution
        return this.getImageUrl('full', `!${maxDimension},${maxDimension}`);
    }
}