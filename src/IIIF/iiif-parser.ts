/**
 * IIIF URL Parser & Resource Detection
 *
 * Accepts any IIIF URL (Image API info.json, bare service URL,
 * Presentation API v2/v3 manifest) and returns structured data.
 */

// --- Types ---

export type IIIFResourceType =
    | 'image-service-2'
    | 'image-service-3'
    | 'manifest-2'
    | 'manifest-3'
    | 'unknown';

export interface ParsedImageService {
    type: 'image-service-2' | 'image-service-3';
    id: string;
    width: number;
    height: number;
    tileWidth: number;
    tileHeight: number;
    scaleFactors: number[];
    sizes?: { width: number; height: number }[];
    profile?: string;
    raw: any;
}

export interface ParsedCanvasImage {
    imageServiceUrl: string;
    width: number;
    height: number;
    format?: string;
    target?: { x: number; y: number; w: number; h: number };
}

export interface ParsedCanvas {
    id: string;
    label?: string;
    width: number;
    height: number;
    images: ParsedCanvasImage[];
}

export interface ParsedManifest {
    type: 'manifest-2' | 'manifest-3';
    id: string;
    label?: string;
    canvases: ParsedCanvas[];
    raw: any;
}

export type ParsedResource = ParsedImageService | ParsedManifest;

// --- Detection ---

/**
 * Detect what type of IIIF resource a JSON response represents.
 */
export function detectResourceType(json: any): IIIFResourceType {
    if (!json || typeof json !== 'object') return 'unknown';

    // Presentation API v3: type === "Manifest"
    if (json.type === 'Manifest') return 'manifest-3';

    // Presentation API v2: @type === "sc:Manifest"
    if (json['@type'] === 'sc:Manifest') return 'manifest-2';

    // Image API v3: type === "ImageService3"
    if (json.type === 'ImageService3') return 'image-service-3';

    // Image API v2/v3: has protocol field
    if (json.protocol === 'http://iiif.io/api/image') {
        return isImageApiV3Context(json) ? 'image-service-3' : 'image-service-2';
    }

    // Image API: detect by @context
    const context = json['@context'];
    if (context) {
        const contextStr = Array.isArray(context) ? context.join(' ') : String(context);
        if (contextStr.includes('image/3')) return 'image-service-3';
        if (contextStr.includes('image/2')) return 'image-service-2';
    }

    // Image API fallback: has width/height/tiles (common in info.json)
    if (json.width && json.height && json.tiles) {
        return json.id && !json['@id'] ? 'image-service-3' : 'image-service-2';
    }

    return 'unknown';
}

function isImageApiV3Context(json: any): boolean {
    const context = json['@context'];
    if (!context) return false;
    const contextStr = Array.isArray(context) ? context.join(' ') : String(context);
    return contextStr.includes('image/3');
}

// --- Parsers ---

export function parseImageServiceV2(json: any): ParsedImageService {
    const tile = json.tiles?.[0];
    const profileRaw = json.profile;
    let profile: string | undefined;
    if (Array.isArray(profileRaw)) {
        profile = typeof profileRaw[0] === 'string' ? profileRaw[0] : undefined;
    } else if (typeof profileRaw === 'string') {
        profile = profileRaw;
    }

    return {
        type: 'image-service-2',
        id: json['@id'] || '',
        width: json.width,
        height: json.height,
        tileWidth: tile?.width || 256,
        tileHeight: tile?.height || tile?.width || 256,
        scaleFactors: tile?.scaleFactors || [1],
        sizes: json.sizes,
        profile,
        raw: json
    };
}

export function parseImageServiceV3(json: any): ParsedImageService {
    const tile = json.tiles?.[0];

    return {
        type: 'image-service-3',
        id: json.id || '',
        width: json.width,
        height: json.height,
        tileWidth: tile?.width || 256,
        tileHeight: tile?.height || tile?.width || 256,
        scaleFactors: tile?.scaleFactors || [1],
        sizes: json.sizes,
        profile: typeof json.profile === 'string' ? json.profile : undefined,
        raw: json
    };
}

export function parseManifestV2(json: any): ParsedManifest {
    const label = typeof json.label === 'string' ? json.label : undefined;

    return {
        type: 'manifest-2',
        id: json['@id'] || '',
        label,
        canvases: extractCanvasesV2(json),
        raw: json
    };
}

export function parseManifestV3(json: any): ParsedManifest {
    let label: string | undefined;
    if (json.label) {
        // v3 labels are language maps: { "en": ["Label text"] }
        const values = Object.values(json.label) as string[][];
        label = values[0]?.[0];
    }

    return {
        type: 'manifest-3',
        id: json.id || '',
        label,
        canvases: extractCanvasesV3(json),
        raw: json
    };
}

// --- Canvas extraction ---

function extractCanvasesV2(json: any): ParsedCanvas[] {
    const canvases: ParsedCanvas[] = [];
    const sequence = json.sequences?.[0];
    if (!sequence?.canvases) return canvases;

    for (const canvas of sequence.canvases) {
        const images: ParsedCanvasImage[] = [];

        if (canvas.images) {
            for (const annotation of canvas.images) {
                const resource = annotation.resource;
                if (!resource) continue;

                // Get image service URL from service block
                const service = resource.service;
                const serviceId = service?.['@id'] || service?.id || '';

                // Parse xywh fragment from "on" field
                const target = parseXywhFragment(annotation.on);

                images.push({
                    imageServiceUrl: serviceId,
                    width: resource.width || canvas.width,
                    height: resource.height || canvas.height,
                    format: resource.format,
                    target
                });
            }
        }

        canvases.push({
            id: canvas['@id'] || '',
            label: typeof canvas.label === 'string' ? canvas.label : undefined,
            width: canvas.width,
            height: canvas.height,
            images
        });
    }

    return canvases;
}

function extractCanvasesV3(json: any): ParsedCanvas[] {
    const canvases: ParsedCanvas[] = [];
    if (!json.items) return canvases;

    for (const canvas of json.items) {
        if (canvas.type !== 'Canvas') continue;

        const images: ParsedCanvasImage[] = [];

        // canvas.items = AnnotationPages
        const annotationPages = canvas.items || [];
        for (const page of annotationPages) {
            if (page.type !== 'AnnotationPage') continue;

            const annotations = page.items || [];
            for (const annotation of annotations) {
                if (annotation.type !== 'Annotation') continue;
                if (annotation.motivation !== 'painting') continue;

                const body = annotation.body;
                if (!body) continue;

                // Only handle Image type for now
                if (body.type !== 'Image') continue;

                // Get image service URL from service block, or fall back to body.id
                let imageServiceUrl = '';
                const services = body.service || [];
                const serviceArray = Array.isArray(services) ? services : [services];
                for (const svc of serviceArray) {
                    if (svc.type === 'ImageService3' || svc.type === 'ImageService2' ||
                        svc['@type'] === 'ImageService2' ||
                        (svc.profile && String(svc.profile).includes('image'))) {
                        imageServiceUrl = svc.id || svc['@id'] || '';
                        break;
                    }
                }

                // If no service found, use body.id as a static image URL
                if (!imageServiceUrl) {
                    imageServiceUrl = body.id || '';
                }

                // Parse xywh fragment from target
                const target = parseXywhFragment(annotation.target);

                images.push({
                    imageServiceUrl,
                    width: body.width || canvas.width,
                    height: body.height || canvas.height,
                    format: body.format,
                    target
                });
            }
        }

        // Extract label from v3 language map
        let label: string | undefined;
        if (canvas.label) {
            const values = Object.values(canvas.label) as string[][];
            label = values[0]?.[0];
        }

        canvases.push({
            id: canvas.id || '',
            label,
            width: canvas.width,
            height: canvas.height,
            images
        });
    }

    return canvases;
}

// --- Helpers ---

/**
 * Parse an xywh media fragment from a target URI.
 * e.g. "https://example.com/canvas/1#xywh=100,200,300,400"
 */
export function parseXywhFragment(target: string | undefined): { x: number; y: number; w: number; h: number } | undefined {
    if (!target || typeof target !== 'string') return undefined;

    const match = target.match(/#xywh=(\d+),(\d+),(\d+),(\d+)/);
    if (!match) return undefined;

    return {
        x: parseInt(match[1], 10),
        y: parseInt(match[2], 10),
        w: parseInt(match[3], 10),
        h: parseInt(match[4], 10)
    };
}

// --- Main entry point ---

/**
 * Fetch and parse any IIIF URL.
 *
 * Handles:
 * - Image API v2/v3 info.json URLs
 * - Bare image service URLs (auto-appends /info.json)
 * - Presentation API v2 manifest URLs
 * - Presentation API v3 manifest URLs
 */
export async function parseIIIFUrl(url: string): Promise<ParsedResource> {
    // Try fetching the URL as JSON first
    const json = await fetchJsonSafe(url);

    if (json !== null) {
        const resourceType = detectResourceType(json);

        switch (resourceType) {
            case 'image-service-2':
                return parseImageServiceV2(json);
            case 'image-service-3':
                return parseImageServiceV3(json);
            case 'manifest-2':
                return parseManifestV2(json);
            case 'manifest-3':
                return parseManifestV3(json);
        }
    }

    // If JSON parse failed or type is unknown, try appending /info.json
    if (!url.endsWith('/info.json') && !url.endsWith('.json')) {
        const infoUrl = url.replace(/\/$/, '') + '/info.json';
        const infoJson = await fetchJsonSafe(infoUrl);

        if (infoJson !== null) {
            const infoType = detectResourceType(infoJson);
            if (infoType === 'image-service-2') return parseImageServiceV2(infoJson);
            if (infoType === 'image-service-3') return parseImageServiceV3(infoJson);
        }
    }

    throw new Error(`Unable to detect IIIF resource type for URL: ${url}`);
}

async function fetchJsonSafe(url: string): Promise<any | null> {
    try {
        const response = await fetch(url);
        if (!response.ok) return null;
        const text = await response.text();
        return JSON.parse(text);
    } catch {
        return null;
    }
}
