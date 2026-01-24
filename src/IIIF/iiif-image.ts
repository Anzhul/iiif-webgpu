// Format preference order (best compression/quality first)
const FORMAT_PREFERENCE = ['webp', 'jpg', 'jpeg', 'png', 'gif'];

export class IIIFImage {
    manifest: any;
    url: string;
    id: string;
    private _cachedFormat: string | null = null;
    private _cachedQuality: string | null = null;

    // World space positioning (for unified canvas with multiple images)
    worldX: number = 0;      // X offset in world coordinates
    worldY: number = 0;      // Y offset in world coordinates
    worldZ: number = 0;      // Z depth (for layering)

    // Optional label from manifest
    label: string = '';

    // Track if info.json has been loaded (for lazy loading)
    private _manifestLoaded: boolean = false;

    constructor(id: string, url: string) {
        this.id = id;
        this.manifest = null;
        this.url = url;
    }

    get isLoaded(): boolean {
        return this._manifestLoaded;
    }

    // World space bounds (for visibility culling)
    get worldBounds(): { left: number; top: number; right: number; bottom: number } {
        return {
            left: this.worldX,
            top: this.worldY,
            right: this.worldX + (this.manifest?.width || 0),
            bottom: this.worldY + (this.manifest?.height || 0)
        };
    }

    // Set world position
    setWorldPosition(x: number, y: number, z: number = 0): void {
        this.worldX = x;
        this.worldY = y;
        this.worldZ = z;
    }

    // Detect IIIF Image API version from @context
    get iiifVersion(): 2 | 3 {
        const context = this.manifest?.['@context'];
        if (!context) return 2;

        const contextStr = Array.isArray(context) ? context.join(' ') : String(context);
        if (contextStr.includes('iiif.io/api/image/3')) return 3;
        return 2;
    }

    // Base URL - v2 uses @id, v3 uses id
    get baseUrl(): string {
        return this.manifest?.['@id'] || this.manifest?.id || '';
    }
    get width() { return this.manifest.width; }
    get height() { return this.manifest.height; }
    get aspectRatio() { return this.manifest.width / this.manifest.height; }
    get tileSize() { return this.manifest.tiles?.[0]?.width || 256; }
    get scaleFactors() { return this.manifest.tiles?.[0]?.scaleFactors || [1]; }
    get maxZoomLevel() { return this.scaleFactors.length - 1; }

    // Parse supported formats from profile (v2) or extraFormats (v3)
    get supportedFormats(): string[] {
        // IIIF v3: uses extraFormats array, jpg is always supported
        if (this.iiifVersion === 3) {
            const extra = this.manifest.extraFormats || [];
            return ['jpg', ...extra];
        }

        // IIIF v2: profile can be string, array, or object
        const profile = this.manifest.profile;
        if (!profile) return ['jpg'];

        // Profile can be: [complianceLevel, { formats: [...], qualities: [...] }]
        if (Array.isArray(profile)) {
            for (const item of profile) {
                if (typeof item === 'object' && item.formats) {
                    return item.formats;
                }
            }
            // Check compliance level URI for default formats
            const complianceUri = profile.find((p: unknown) => typeof p === 'string') as string | undefined;
            if (complianceUri?.includes('level2')) {
                return ['jpg', 'png']; // Level 2 requires jpg and png
            }
            if (complianceUri?.includes('level1') || complianceUri?.includes('level0')) {
                return ['jpg'];
            }
        }

        return ['jpg']; // Fallback
    }

    // Parse supported qualities from profile (v2) or extraQualities (v3)
    get supportedQualities(): string[] {
        // IIIF v3: uses extraQualities array, default is always supported
        if (this.iiifVersion === 3) {
            const extra = this.manifest.extraQualities || [];
            return ['default', ...extra];
        }

        // IIIF v2: check profile object
        const profile = this.manifest.profile;
        if (!profile) return ['default'];

        if (Array.isArray(profile)) {
            for (const item of profile) {
                if (typeof item === 'object' && item.qualities) {
                    return item.qualities;
                }
            }
            // Check compliance level for default qualities
            const complianceUri = profile.find((p: unknown) => typeof p === 'string') as string | undefined;
            if (complianceUri?.includes('level2')) {
                return ['default', 'color', 'gray', 'bitonal'];
            }
            if (complianceUri?.includes('level1')) {
                return ['default'];
            }
        }

        return ['default']; // Fallback
    }

    // Get the best available format (prefers webp for better compression)
    get bestFormat(): string {
        if (this._cachedFormat) return this._cachedFormat;

        const supported = this.supportedFormats.map(f => f.toLowerCase());

        // Find first preferred format that's supported
        for (const preferred of FORMAT_PREFERENCE) {
            if (supported.includes(preferred)) {
                this._cachedFormat = preferred;
                return preferred;
            }
        }

        // Fallback to first supported or jpg
        this._cachedFormat = supported[0] || 'jpg';
        return this._cachedFormat;
    }

    // Get the best available quality
    get bestQuality(): string {
        if (this._cachedQuality) return this._cachedQuality;

        const supported = this.supportedQualities.map(q => q.toLowerCase());

        // Prefer 'default' or 'color' for best visual quality
        if (supported.includes('default')) {
            this._cachedQuality = 'default';
        } else if (supported.includes('color')) {
            this._cachedQuality = 'color';
        } else {
            this._cachedQuality = supported[0] || 'default';
        }

        return this._cachedQuality;
    }

    async loadManifest(url: string) {
        try {
            const response = await fetch(url);
            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }
            this.manifest = await response.json();

            // Clear cached format/quality so they get re-detected
            this._cachedFormat = null;
            this._cachedQuality = null;
            this._manifestLoaded = true;

            return this.manifest;
        } catch (error) {
            console.error('Error fetching manifest:', error);
            throw error;
        }
    }

    // Build IIIF Image API URL - uses auto-detected format/quality by default
    getImageUrl(
        region = 'full',
        size = 'full',
        rotation = '0',
        quality?: string,
        format?: string
    ): string {
        const q = quality ?? this.bestQuality;
        const f = format ?? this.bestFormat;
        return `${this.baseUrl}/${region}/${size}/${rotation}/${q}.${f}`;
    }

    getTileUrl(x: number, y: number, width: number, height: number, tileSize = this.tileSize): string {
        const region = `${x},${y},${width},${height}`;
        const size = `${tileSize},${tileSize}`;
        return this.getImageUrl(region, size);
    }

    // Get the lowest resolution full image for thumbnail background
    getThumbnailUrl(maxDimension = 512): string {
        return this.getImageUrl('full', `!${maxDimension},${maxDimension}`);
    }
}