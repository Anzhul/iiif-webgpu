// IIIF Presentation API Manifest Parser
// Supports both Presentation API v2 and v3

export interface ImageService {
    id: string;           // Base URL for Image API
    width?: number;
    height?: number;
    profile?: string;
}

export interface CanvasInfo {
    id: string;
    label: string;
    width: number;
    height: number;
    imageServices: ImageService[];
}

export interface ManifestInfo {
    id: string;
    type: 'Manifest' | 'Collection' | 'ImageService';
    version: 2 | 3;
    label: string;
    description?: string;
    attribution?: string;
    license?: string;
    canvases: CanvasInfo[];
    metadata?: Array<{ label: string; value: string }>;
}

export class IIIFManifestParser {

    // Detect what type of IIIF resource this is
    static detectType(data: any): 'image-api' | 'presentation-v2' | 'presentation-v3' | 'unknown' {
        // Image API info.json
        if (data.protocol === 'http://iiif.io/api/image' ||
            data.profile?.toString().includes('iiif.io/api/image')) {
            return 'image-api';
        }

        // Check @context for version
        const context = data['@context'];
        const contextStr = Array.isArray(context) ? context.join(' ') : String(context || '');

        if (contextStr.includes('iiif.io/api/presentation/3')) {
            return 'presentation-v3';
        }
        if (contextStr.includes('iiif.io/api/presentation/2') ||
            data['@type'] === 'sc:Manifest' ||
            data['@type'] === 'sc:Collection') {
            return 'presentation-v2';
        }

        // Check for v3 type field
        if (data.type === 'Manifest' || data.type === 'Collection') {
            return 'presentation-v3';
        }

        return 'unknown';
    }

    // Parse any IIIF resource and return normalized info
    static async parse(url: string): Promise<ManifestInfo> {
        const response = await fetch(url);
        if (!response.ok) {
            throw new Error(`Failed to fetch IIIF resource: ${response.status}`);
        }

        const data = await response.json();
        const type = this.detectType(data);

        switch (type) {
            case 'image-api':
                return this.parseImageApi(data, url);
            case 'presentation-v2':
                return this.parsePresentationV2(data);
            case 'presentation-v3':
                return this.parsePresentationV3(data);
            default:
                throw new Error('Unknown IIIF resource type');
        }
    }

    // Parse Image API info.json as a single-canvas manifest
    private static parseImageApi(data: any, url: string): ManifestInfo {
        const baseUrl = data['@id'] || data.id || url.replace('/info.json', '');

        return {
            id: baseUrl,
            type: 'ImageService',
            version: data['@context']?.includes('image/3') ? 3 : 2,
            label: baseUrl.split('/').pop() || 'Image',
            canvases: [{
                id: baseUrl,
                label: 'Image',
                width: data.width,
                height: data.height,
                imageServices: [{
                    id: baseUrl,
                    width: data.width,
                    height: data.height,
                    profile: Array.isArray(data.profile) ? data.profile[0] : data.profile
                }]
            }],
            metadata: []
        };
    }

    // Parse Presentation API v2 manifest
    private static parsePresentationV2(data: any): ManifestInfo {
        const canvases: CanvasInfo[] = [];

        // Get sequences (v2 structure: sequences -> canvases -> images)
        const sequences = data.sequences || [];

        for (const sequence of sequences) {
            const sequenceCanvases = sequence.canvases || [];

            for (const canvas of sequenceCanvases) {
                const imageServices: ImageService[] = [];

                // Each canvas has images (annotations with motivation=painting)
                const images = canvas.images || [];

                for (const image of images) {
                    const resource = image.resource;
                    if (!resource) continue;

                    // Get image service from resource.service
                    const service = resource.service;
                    if (service) {
                        // Service can be object or array
                        const services = Array.isArray(service) ? service : [service];
                        for (const svc of services) {
                            if (svc['@id'] || svc.id) {
                                imageServices.push({
                                    id: svc['@id'] || svc.id,
                                    width: svc.width || resource.width,
                                    height: svc.height || resource.height,
                                    profile: svc.profile
                                });
                            }
                        }
                    }

                    // Fallback: use resource @id directly if no service
                    if (imageServices.length === 0 && (resource['@id'] || resource.id)) {
                        const resourceId = resource['@id'] || resource.id;
                        // Check if it's an image URL we can use
                        imageServices.push({
                            id: resourceId.replace(/\/full\/.*$/, ''), // Try to extract base URL
                            width: resource.width || canvas.width,
                            height: resource.height || canvas.height
                        });
                    }
                }

                canvases.push({
                    id: canvas['@id'] || canvas.id,
                    label: this.extractLabelV2(canvas.label),
                    width: canvas.width,
                    height: canvas.height,
                    imageServices
                });
            }
        }

        return {
            id: data['@id'] || data.id,
            type: 'Manifest',
            version: 2,
            label: this.extractLabelV2(data.label),
            description: this.extractLabelV2(data.description),
            attribution: this.extractLabelV2(data.attribution),
            license: data.license,
            canvases,
            metadata: this.parseMetadataV2(data.metadata)
        };
    }

    // Parse Presentation API v3 manifest
    private static parsePresentationV3(data: any): ManifestInfo {
        const canvases: CanvasInfo[] = [];

        // v3 structure: items (canvases) -> items (annotation pages) -> items (annotations)
        const items = data.items || [];

        for (const canvas of items) {
            if (canvas.type !== 'Canvas') continue;

            const imageServices: ImageService[] = [];

            // Annotation pages
            const annotationPages = canvas.items || [];

            for (const page of annotationPages) {
                if (page.type !== 'AnnotationPage') continue;

                const annotations = page.items || [];

                for (const annotation of annotations) {
                    if (annotation.motivation !== 'painting') continue;

                    const body = annotation.body;
                    if (!body) continue;

                    // Body can be single or array
                    const bodies = Array.isArray(body) ? body : [body];

                    for (const b of bodies) {
                        if (b.type !== 'Image') continue;

                        // Get service from body.service
                        const service = b.service;
                        if (service) {
                            const services = Array.isArray(service) ? service : [service];
                            for (const svc of services) {
                                if (svc.type === 'ImageService2' || svc.type === 'ImageService3' ||
                                    svc['@type']?.includes('ImageService')) {
                                    imageServices.push({
                                        id: svc['@id'] || svc.id,
                                        width: svc.width || b.width,
                                        height: svc.height || b.height,
                                        profile: svc.profile
                                    });
                                }
                            }
                        }

                        // Fallback to body id
                        if (imageServices.length === 0 && (b['@id'] || b.id)) {
                            imageServices.push({
                                id: (b['@id'] || b.id).replace(/\/full\/.*$/, ''),
                                width: b.width || canvas.width,
                                height: b.height || canvas.height
                            });
                        }
                    }
                }
            }

            canvases.push({
                id: canvas.id,
                label: this.extractLabelV3(canvas.label),
                width: canvas.width,
                height: canvas.height,
                imageServices
            });
        }

        return {
            id: data.id,
            type: 'Manifest',
            version: 3,
            label: this.extractLabelV3(data.label),
            description: this.extractLabelV3(data.summary),
            attribution: this.extractLabelV3(data.requiredStatement?.value),
            license: data.rights,
            canvases,
            metadata: this.parseMetadataV3(data.metadata)
        };
    }

    // Extract label from v2 format (string or object with @value)
    private static extractLabelV2(label: any): string {
        if (!label) return '';
        if (typeof label === 'string') return label;
        if (Array.isArray(label)) {
            const first = label[0];
            return typeof first === 'string' ? first : first?.['@value'] || '';
        }
        return label['@value'] || '';
    }

    // Extract label from v3 format (language map: { "en": ["text"] })
    private static extractLabelV3(label: any): string {
        if (!label) return '';
        if (typeof label === 'string') return label;

        // Language map format
        const keys = Object.keys(label);
        if (keys.length === 0) return '';

        // Prefer English, fallback to first available
        const lang = keys.includes('en') ? 'en' : keys[0];
        const values = label[lang];

        if (Array.isArray(values)) return values[0] || '';
        return String(values);
    }

    // Parse metadata from v2 format
    private static parseMetadataV2(metadata: any[]): Array<{ label: string; value: string }> {
        if (!Array.isArray(metadata)) return [];

        return metadata.map(item => ({
            label: this.extractLabelV2(item.label),
            value: this.extractLabelV2(item.value)
        }));
    }

    // Parse metadata from v3 format
    private static parseMetadataV3(metadata: any[]): Array<{ label: string; value: string }> {
        if (!Array.isArray(metadata)) return [];

        return metadata.map(item => ({
            label: this.extractLabelV3(item.label),
            value: this.extractLabelV3(item.value)
        }));
    }
}
