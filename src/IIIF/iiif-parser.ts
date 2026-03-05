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

export type AnnotationTarget =
    | { type: 'rect'; x: number; y: number; w: number; h: number }
    | { type: 'svg'; svg: string; bounds: { x: number; y: number; w: number; h: number } }
    | { type: 'point'; x: number; y: number }
    | { type: 'full' };

export interface AnnotationBody {
    type: string;
    value?: string;
    format?: string;
    language?: string;
    id?: string;
}

export interface ParsedAnnotation {
    id: string;
    motivation: string;
    bodies: AnnotationBody[];
    target: AnnotationTarget;
    creator?: string;
    created?: string;
    stylesheet?: { type: string; value: string };
    styleClass?: string;
}

export interface ParsedAnnotationPage {
    id: string;
    annotations: ParsedAnnotation[];
}

export interface ParsedCanvas {
    id: string;
    label?: string;
    width: number;
    height: number;
    images: ParsedCanvasImage[];
    annotations: ParsedAnnotationPage[];
    annotationListUrls: string[];
}

export interface ParsedMetadataItem {
    label: string;
    value: string;
}

export interface ParsedManifestMetadata {
    metadata: ParsedMetadataItem[];
    description?: string;
    attribution?: string;
    attributionLabel?: string;
    rights?: string;
    logo?: string;
}

export interface ParsedRange {
    id: string;
    label?: string;
    canvasIds: string[];
    children: ParsedRange[];
}

export interface ParsedManifest {
    type: 'manifest-2' | 'manifest-3';
    id: string;
    label?: string;
    canvases: ParsedCanvas[];
    metadata?: ParsedManifestMetadata;
    ranges?: ParsedRange[];
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

function extractLabelV3(languageMap: any): string | undefined {
    if (!languageMap || typeof languageMap !== 'object') return undefined;
    if (typeof languageMap === 'string') return languageMap;
    const values = Object.values(languageMap) as string[][];
    return values[0]?.[0];
}

function extractAllValuesV3(languageMap: any): string | undefined {
    if (!languageMap || typeof languageMap !== 'object') return undefined;
    if (typeof languageMap === 'string') return languageMap;
    const allValues: string[] = [];
    for (const values of Object.values(languageMap) as string[][]) {
        if (Array.isArray(values)) {
            allValues.push(...values);
        }
    }
    return allValues.length > 0 ? allValues.join('; ') : undefined;
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
        metadata: extractMetadataV2(json),
        ranges: extractRangesV2(json),
        raw: json
    };
}

export function parseManifestV3(json: any): ParsedManifest {
    return {
        type: 'manifest-3',
        id: json.id || '',
        label: extractLabelV3(json.label),
        canvases: extractCanvasesV3(json),
        metadata: extractMetadataV3(json),
        ranges: extractRangesV3(json),
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

        // Collect annotation list URLs from otherContent
        const annotationListUrls: string[] = [];
        if (canvas.otherContent) {
            for (const oc of canvas.otherContent) {
                const url = oc['@id'] || oc.id || (typeof oc === 'string' ? oc : '');
                if (url) annotationListUrls.push(url);
            }
        }

        canvases.push({
            id: canvas['@id'] || '',
            label: typeof canvas.label === 'string' ? canvas.label : undefined,
            width: canvas.width,
            height: canvas.height,
            images,
            annotations: [],
            annotationListUrls
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

        const label = extractLabelV3(canvas.label);

        // Parse non-painting annotations from canvas.annotations
        const parsedAnnotationPages: ParsedAnnotationPage[] = [];
        const annotationListUrls: string[] = [];

        const nonPaintingPages = canvas.annotations || [];
        for (const page of nonPaintingPages) {
            if (page.type !== 'AnnotationPage') continue;

            // If the page has no items, it might be an external reference
            if (!page.items || page.items.length === 0) {
                const pageUrl = page.id || '';
                if (pageUrl) annotationListUrls.push(pageUrl);
                continue;
            }

            const parsed = parseAnnotationPageV3(page, canvas.width, canvas.height);
            if (parsed.annotations.length > 0) {
                parsedAnnotationPages.push(parsed);
            }
        }

        canvases.push({
            id: canvas.id || '',
            label,
            width: canvas.width,
            height: canvas.height,
            images,
            annotations: parsedAnnotationPages,
            annotationListUrls
        });
    }

    return canvases;
}

function parseAnnotationPageV3(page: any, canvasWidth?: number, canvasHeight?: number): ParsedAnnotationPage {
    const annotations: ParsedAnnotation[] = [];

    for (const ann of page.items || []) {
        if (ann.type !== 'Annotation') continue;

        const motivation = ann.motivation || 'unknown';
        if (motivation === 'painting') continue; // already handled

        // Parse body (single or array)
        const rawBody = ann.body;
        const bodyArray = Array.isArray(rawBody) ? rawBody : (rawBody ? [rawBody] : []);
        const bodies: AnnotationBody[] = bodyArray.map((b: any) => ({
            type: b.type || (typeof b === 'string' ? 'TextualBody' : 'unknown'),
            value: b.value || b.chars || (typeof b === 'string' ? b : ''),
            format: b.format,
            language: b.language,
            id: b.id
        }));

        // Parse target
        const target = parseAnnotationTarget(ann.target, canvasWidth, canvasHeight);

        // Parse optional metadata
        const creator = ann.creator?.name || (typeof ann.creator === 'string' ? ann.creator : undefined);
        const created = ann.created;
        const stylesheet = ann.stylesheet
            ? { type: ann.stylesheet.type || 'CssStylesheet', value: ann.stylesheet.value || '' }
            : undefined;
        const styleClass = ann.target?.styleClass;

        annotations.push({
            id: ann.id || '',
            motivation,
            bodies,
            target,
            creator,
            created,
            stylesheet,
            styleClass
        });
    }

    return {
        id: page.id || '',
        annotations
    };
}

// --- Metadata extraction ---

function extractMetadataV2(json: any): ParsedManifestMetadata {
    const metadata: ParsedMetadataItem[] = [];

    if (Array.isArray(json.metadata)) {
        for (const item of json.metadata) {
            const label = typeof item.label === 'string' ? item.label : '';
            let value: string;
            if (typeof item.value === 'string') {
                value = item.value;
            } else if (Array.isArray(item.value)) {
                value = item.value
                    .map((v: any) => typeof v === 'string' ? v : v['@value'] || '')
                    .filter(Boolean)
                    .join('; ');
            } else if (item.value?.['@value']) {
                value = item.value['@value'];
            } else {
                value = String(item.value || '');
            }
            if (label && value) {
                metadata.push({ label, value });
            }
        }
    }

    const description = typeof json.description === 'string' ? json.description : undefined;
    const attribution = typeof json.attribution === 'string' ? json.attribution : undefined;
    const rights = typeof json.license === 'string' ? json.license : undefined;

    let logo: string | undefined;
    if (typeof json.logo === 'string') {
        logo = json.logo;
    } else if (json.logo?.['@id']) {
        logo = json.logo['@id'];
    }

    return { metadata, description, attribution, rights, logo };
}

function extractMetadataV3(json: any): ParsedManifestMetadata {
    const metadata: ParsedMetadataItem[] = [];

    if (Array.isArray(json.metadata)) {
        for (const item of json.metadata) {
            const label = extractLabelV3(item.label);
            const value = extractAllValuesV3(item.value);
            if (label && value) {
                metadata.push({ label, value });
            }
        }
    }

    const description = extractLabelV3(json.summary);

    let attribution: string | undefined;
    let attributionLabel: string | undefined;
    if (json.requiredStatement) {
        attributionLabel = extractLabelV3(json.requiredStatement.label);
        attribution = extractAllValuesV3(json.requiredStatement.value);
    }

    const rights = typeof json.rights === 'string' ? json.rights : undefined;

    return { metadata, description, attribution, attributionLabel, rights };
}

// --- Range extraction ---

function extractRangesV2(json: any): ParsedRange[] {
    if (!Array.isArray(json.structures)) return [];

    // Build a map of all ranges by @id for resolving references
    const rangeMap = new Map<string, any>();
    for (const range of json.structures) {
        if (range['@type'] === 'sc:Range' && range['@id']) {
            rangeMap.set(range['@id'], range);
        }
    }

    // Find top-level ranges (viewingHint: "top"), or all if none marked
    const topRanges = json.structures.filter(
        (r: any) => r['@type'] === 'sc:Range' && r.viewingHint === 'top'
    );
    const roots = topRanges.length > 0 ? topRanges : json.structures.filter(
        (r: any) => r['@type'] === 'sc:Range'
    );

    const visited = new Set<string>();
    return roots.map((r: any) => resolveRangeV2(r, rangeMap, visited));
}

function resolveRangeV2(range: any, rangeMap: Map<string, any>, visited: Set<string>): ParsedRange {
    const id = range['@id'] || '';
    visited.add(id);

    const canvasIds: string[] = [];
    const children: ParsedRange[] = [];

    if (Array.isArray(range.canvases)) {
        for (const uri of range.canvases) {
            if (typeof uri === 'string') canvasIds.push(uri);
        }
    }

    if (Array.isArray(range.ranges)) {
        for (const ref of range.ranges) {
            const refId = typeof ref === 'string' ? ref : ref?.['@id'];
            if (refId && !visited.has(refId)) {
                const resolved = rangeMap.get(refId);
                if (resolved) {
                    children.push(resolveRangeV2(resolved, rangeMap, visited));
                }
            }
        }
    }

    if (Array.isArray(range.members)) {
        for (const member of range.members) {
            if (member['@type'] === 'sc:Canvas') {
                const canvasId = member['@id'] || '';
                if (canvasId) canvasIds.push(canvasId);
            } else if (member['@type'] === 'sc:Range') {
                const refId = member['@id'] || '';
                if (refId && !visited.has(refId)) {
                    const resolved = rangeMap.get(refId);
                    if (resolved) {
                        children.push(resolveRangeV2(resolved, rangeMap, visited));
                    } else {
                        children.push(resolveRangeV2(member, rangeMap, visited));
                    }
                }
            }
        }
    }

    return {
        id,
        label: typeof range.label === 'string' ? range.label : undefined,
        canvasIds,
        children
    };
}

function extractRangesV3(json: any): ParsedRange[] {
    if (!Array.isArray(json.structures)) return [];

    const ranges: ParsedRange[] = [];
    for (const range of json.structures) {
        if (range.type !== 'Range') continue;
        ranges.push(parseRangeV3(range));
    }
    return ranges;
}

function parseRangeV3(range: any): ParsedRange {
    const canvasIds: string[] = [];
    const children: ParsedRange[] = [];

    if (Array.isArray(range.items)) {
        for (const item of range.items) {
            if (item.type === 'Canvas') {
                const canvasId = item.id || '';
                if (canvasId) canvasIds.push(canvasId);
            } else if (item.type === 'Range') {
                children.push(parseRangeV3(item));
            } else if (typeof item === 'string') {
                canvasIds.push(item);
            }
        }
    }

    return {
        id: range.id || '',
        label: extractLabelV3(range.label),
        canvasIds,
        children
    };
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

/**
 * Extract bounding box from an SVG string via viewBox or width/height attributes.
 */
function extractSvgBounds(
    svgString: string,
    fallbackW?: number,
    fallbackH?: number
): { x: number; y: number; w: number; h: number } {
    const viewBoxMatch = svgString.match(/viewBox=["']([^"']+)["']/i);
    if (viewBoxMatch) {
        const parts = viewBoxMatch[1].trim().split(/[\s,]+/).map(Number);
        if (parts.length === 4 && parts.every(n => !isNaN(n))) {
            return { x: parts[0], y: parts[1], w: parts[2], h: parts[3] };
        }
    }

    const wMatch = svgString.match(/width=["'](\d+)["']/i);
    const hMatch = svgString.match(/height=["'](\d+)["']/i);
    if (wMatch && hMatch) {
        return { x: 0, y: 0, w: parseInt(wMatch[1]), h: parseInt(hMatch[1]) };
    }

    return { x: 0, y: 0, w: fallbackW || 1000, h: fallbackH || 1000 };
}

/**
 * Parse an annotation target into a discriminated union.
 * Handles FragmentSelector (xywh), SvgSelector, PointSelector, and full-canvas.
 */
function parseAnnotationTarget(
    target: any,
    canvasWidth?: number,
    canvasHeight?: number
): AnnotationTarget {
    if (!target) return { type: 'full' };

    // Simple string target: check for xywh fragment
    if (typeof target === 'string') {
        const xywh = parseXywhFragment(target);
        if (xywh) return { type: 'rect', ...xywh };
        return { type: 'full' };
    }

    // Object target with selector
    if (target.selector) {
        const selectors = Array.isArray(target.selector) ? target.selector : [target.selector];

        for (const sel of selectors) {
            const selType = sel.type || sel['@type'] || '';

            if (selType === 'SvgSelector' || selType === 'oa:SvgSelector') {
                const svgString = sel.value || sel.chars || '';
                const bounds = extractSvgBounds(svgString, canvasWidth, canvasHeight);
                return { type: 'svg', svg: svgString, bounds };
            }

            if (selType === 'PointSelector') {
                return {
                    type: 'point',
                    x: typeof sel.x === 'number' ? sel.x : 0,
                    y: typeof sel.y === 'number' ? sel.y : 0
                };
            }

            if (selType === 'FragmentSelector') {
                const xywh = parseXywhFragment(sel.value);
                if (xywh) return { type: 'rect', ...xywh };
            }

            // V2 fragment in selector value
            const selectorValue = sel.value || sel['@value'] || '';
            const match = selectorValue.match(/xywh=(\d+),(\d+),(\d+),(\d+)/);
            if (match) {
                return {
                    type: 'rect',
                    x: parseInt(match[1], 10),
                    y: parseInt(match[2], 10),
                    w: parseInt(match[3], 10),
                    h: parseInt(match[4], 10)
                };
            }
        }
    }

    // Object target without selector: check source for xywh fragment
    const sourceStr = target.source || target.id || target['@id'] || '';
    if (typeof sourceStr === 'string') {
        const xywh = parseXywhFragment(sourceStr);
        if (xywh) return { type: 'rect', ...xywh };
    }

    return { type: 'full' };
}

// --- Annotation fetching ---

/**
 * Fetch an external annotation list (v2 otherContent or v3 AnnotationPage).
 * Returns parsed annotations from the fetched resource.
 */
export async function fetchAnnotationList(url: string): Promise<ParsedAnnotationPage | null> {
    const json = await fetchJsonSafe(url);
    if (!json) return null;

    // v2: sc:AnnotationList with resources[]
    if (json['@type'] === 'sc:AnnotationList' && json.resources) {
        return parseAnnotationListV2(json);
    }

    // v3: AnnotationPage with items[]
    if (json.type === 'AnnotationPage' && json.items) {
        return parseAnnotationPageV3(json);
    }

    return null;
}

function parseAnnotationListV2(json: any): ParsedAnnotationPage {
    const annotations: ParsedAnnotation[] = [];

    for (const res of json.resources || []) {
        if (res['@type'] !== 'oa:Annotation') continue;

        const motivation = Array.isArray(res.motivation)
            ? res.motivation.join(', ')
            : (res.motivation || 'unknown');

        // Body can be resource array or single object — parse all
        const resources = Array.isArray(res.resource) ? res.resource : [res.resource];
        const bodies: AnnotationBody[] = resources
            .filter((r: any) => r)
            .map((r: any) => ({
                type: r['@type'] || 'unknown',
                value: r.chars || r.value || '',
                format: r.format,
                language: r.language,
                id: r['@id']
            }));

        // Target via "on" field — supports xywh, SvgSelector, PointSelector
        const target = parseAnnotationTarget(
            typeof res.on === 'string' ? res.on : res.on
        );

        annotations.push({
            id: res['@id'] || '',
            motivation,
            bodies,
            target
        });
    }

    return {
        id: json['@id'] || '',
        annotations
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
