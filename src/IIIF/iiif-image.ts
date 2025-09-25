
export class IIIFImage {
    manifest: any;
    url: string;
    id : string;

    constructor(id: string, url: string) {
        this.id = id;
        this.manifest = null;
        this.url = url;
    }

    get baseUrl() { return this.manifest['@id']; }
    get width() { return this.manifest.width; }
    get height() { return this.manifest.height; }
    get aspectRatio() { return this.manifest.width / this.manifest.height; }
    get tileSize() { return this.manifest.tiles?.[0]?.width || 256; }
    get scaleFactors() { return this.manifest.tiles?.[0]?.scaleFactors || [1]; }
    get maxZoomLevel() { return this.scaleFactors.length - 1; }

    async loadManifest(url: string) {
        try {
            const response = await fetch(url);
            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }
            const manifestData = await response.json();
            this.manifest = manifestData;

        } catch (error) {
            console.error('Error fetching manifest:', error);
            throw error;
        }
    }

    getImageUrl(region = 'full', size = 'full', rotation = '0', quality = 'default', format = 'jpg') {
        return `${this.baseUrl}/${region}/${size}/${rotation}/${quality}.${format}`;
    }

    getTileUrl(x : number, y: number, width: number, height: number, tileSize = this.tileSize) {
        const region = `${x},${y},${width},${height}`;
        const size = `${tileSize},${tileSize}`;
        return this.getImageUrl(region, size);
    }
}