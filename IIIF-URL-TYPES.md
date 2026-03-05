# IIIF URL Types Reference

A comprehensive reference of all URL types a IIIF viewer might receive.

---

## 1. Image API URLs

### 1.1 Image Information (`info.json`)

The entry point for any IIIF image. Returns JSON-LD describing dimensions, tile sizes, scale factors, and supported features.

```
{scheme}://{server}/{prefix}/{identifier}/info.json
```

```
https://ids.lib.harvard.edu/ids/iiif/47174896/info.json
https://iiif.bodleian.ox.ac.uk/iiif/image/1363b336-260d-4f22-a6cf-4e1320dbb689/info.json
```

### 1.2 Base URI (Image Service Identifier)

The canonical identifier for an image service. Servers should redirect (`303`) to `info.json`.

```
{scheme}://{server}/{prefix}/{identifier}
```

```
https://ids.lib.harvard.edu/ids/iiif/47174896
```

### 1.3 Full Image Request

```
{scheme}://{server}/{prefix}/{identifier}/{region}/{size}/{rotation}/{quality}.{format}
```

Parameters are applied in order: **Region** → **Size** → **Rotation** → **Quality**

```
https://example.org/image-service/abcd1234/full/max/0/default.jpg
```

#### Region

| Value | Description |
|-------|-------------|
| `full` | Entire image |
| `square` | Square crop, centered on shortest dimension |
| `x,y,w,h` | Pixel-based rectangle (origin top-left) |
| `pct:x,y,w,h` | Percentage-based rectangle (0–100 each) |

#### Size

| Value | Description |
|-------|-------------|
| `max` | Maximum size, no upscaling (v3; replaces v2 `full`) |
| `^max` | Maximum size, upscaling allowed (v3) |
| `w,` | Scale to width, height proportional |
| `,h` | Scale to height, width proportional |
| `w,h` | Exact dimensions (may distort) |
| `!w,h` | Best fit within bounds, preserving aspect ratio |
| `pct:n` | Percentage of extracted region |
| `^` prefix | Allows upscaling (v3 only) |

#### Rotation

| Value | Description |
|-------|-------------|
| `n` | Clockwise degrees (0–360, decimals allowed) |
| `!n` | Mirror horizontally, then rotate |

#### Quality

| Value | Description |
|-------|-------------|
| `default` | Server's default |
| `color` | Full color |
| `gray` | Grayscale |
| `bitonal` | Black and white |

#### Format

`jpg`, `png`, `gif`, `webp`, `tif`, `jp2`, `pdf`

### 1.4 Tile Request URLs

Same pattern as image requests, but region/size correspond to the tile grid defined in `info.json`.

```
https://example.org/image-service/abcd1234/0,0,1024,1024/1024,/0/default.jpg
https://example.org/image-service/abcd1234/1024,0,1024,1024/512,/0/default.jpg
```

### 1.5 Thumbnail URLs

Convention using `!w,h` size to fit within max dimensions:

```
https://example.org/image-service/abcd1234/full/!200,200/0/default.jpg
```

---

## 2. Presentation API URLs

### 2.1 Manifest

A complete digital object: canvases (pages/views), metadata, structure, and content.

```
https://example.org/iiif/book1/manifest
https://iiif.harvardartmuseums.org/manifests/object/219625
https://digitalcollections.tcd.ie/concern/works/hm50tr726/manifest
```

**Detection:**
- v3: `"type": "Manifest"`
- v2: `"@type": "sc:Manifest"`

### 2.2 Collection

An ordered list of Manifests and/or child Collections for hierarchical browsing.

```
https://example.org/iiif/collection/top
https://example.org/iiif/collection/paintings
```

**Detection:**
- v3: `"type": "Collection"`
- v2: `"@type": "sc:Collection"`

### 2.3 Canvas

A virtual container (with width/height) representing a single view. Content is painted on via annotations.

```
https://example.org/iiif/book1/canvas/p1
```

Can include a spatial region fragment:
```
https://example.org/iiif/book1/canvas/p1#xywh=100,200,300,400
```

### 2.4 Annotation Page / Annotation List

An ordered list of annotations targeting a canvas.

```
# v3 (AnnotationPage)
https://example.org/iiif/book1/page/p1

# v2 (AnnotationList)
https://example.org/iiif/book1/list/p1
```

### 2.5 Annotation

A W3C Web Annotation associating content (body) with a target (canvas or region).

```
https://example.org/iiif/book1/annotation/p0001-image
```

Motivations: `painting`, `supplementing`, `commenting`, `tagging`, etc.

### 2.6 Range

Logical structure (table of contents, chapters). Contains canvases and/or sub-ranges.

```
https://example.org/iiif/book1/range/chapter1
```

### 2.7 Sequence (v2 only, removed in v3)

Ordered list of canvases. In v3, canvases go directly in the Manifest `items` array.

```
https://example.org/iiif/book1/sequence/normal
```

---

## 3. Fragment Selectors

Appended to Canvas or image URIs to target specific regions or times.

### 3.1 Spatial Region (`#xywh`)

```
{uri}#xywh={x},{y},{w},{h}           # pixel coordinates
{uri}#xywh=percent:{x},{y},{w},{h}   # percentage-based
```

```
https://example.org/canvas/1#xywh=100,200,300,400
```

### 3.2 Temporal Fragment (`#t`) — for audio/video

```
{uri}#t={start},{end}
```

```
https://example.org/canvas/1#t=30,60
```

---

## 4. Content State API URLs

Encodes a specific "view" of a IIIF resource (particular page, zoom level, region) for sharing/linking.

### 4.1 Query Parameter

```
{viewer-url}?iiif-content={content-state}
```

### 4.2 Content State Forms

**Plain URI** (simplest):
```
https://example.org/iiif/item1/manifest
```

**Canvas reference:**
```json
{
  "id": "https://example.org/canvas/1",
  "type": "Canvas",
  "partOf": [{ "id": "https://example.org/manifest", "type": "Manifest" }]
}
```

**Canvas with spatial region:**
```json
{
  "id": "https://example.org/canvas/7#xywh=1000,2000,1000,2000",
  "type": "Canvas",
  "partOf": [{ "id": "https://example.org/manifest", "type": "Manifest" }]
}
```

**Full annotation form:**
```json
{
  "@context": "http://iiif.io/api/presentation/3/context.json",
  "type": "Annotation",
  "motivation": ["contentState"],
  "target": {
    "id": "https://example.org/canvas/7#xywh=1000,2000,1000,2000",
    "type": "Canvas",
    "partOf": [{ "id": "https://example.org/manifest", "type": "Manifest" }]
  }
}
```

**Multiple canvases (comparison):**
```json
{
  "type": "Annotation",
  "motivation": "contentState",
  "target": [
    { "id": "https://example.org/item1/canvas37", "type": "Canvas", "partOf": [...] },
    { "id": "https://example.org/item2/canvas99", "type": "Canvas", "partOf": [...] }
  ]
}
```

Content state is encoded as **base64url** (RFC 4648 §5) for GET parameters, or passed as plain JSON in `data-iiif-content` HTML attributes.

---

## 5. Content Search API URLs

### 5.1 Search

```
{service-base}?q={terms}&motivation={motivation}&date={range}&user={uri}
```

```
https://example.org/service/manifest/search?q=bird
```

Returns an `AnnotationPage` with matching annotations.

### 5.2 Autocomplete

```
{autocomplete-base}?q={prefix}&min={min-count}
```

```
https://example.org/service/identifier/autocomplete?q=bir
```

---

## 6. Authentication API URLs

### 6.1 Probe Service

```
https://{auth-server}/probe/{resource-id}
```

Checks access status. Client sends `Authorization: Bearer {token}`.

### 6.2 Access Service (Login/Clickthrough/Kiosk/External)

```
https://{auth-server}/login?origin={client-origin}
```

### 6.3 Token Service

```
https://{auth-server}/token?messageId={id}&origin={client-origin}
```

Loaded in a hidden iframe; responds via `postMessage` with an access token.

### 6.4 Logout Service

```
https://{auth-server}/logout
```

---

## 7. Context & Profile URIs

These appear in JSON-LD `@context` and `profile` fields to identify API versions.

| URI | Purpose |
|-----|---------|
| `http://iiif.io/api/image/3/context.json` | Image API v3 context |
| `http://iiif.io/api/image/2/context.json` | Image API v2 context |
| `http://iiif.io/api/presentation/3/context.json` | Presentation API v3 context |
| `http://iiif.io/api/presentation/2/context.json` | Presentation API v2 context |
| `http://iiif.io/api/image/3/level{0,1,2}.json` | Image API v3 compliance level |
| `http://iiif.io/api/image/2/level{0,1,2}.json` | Image API v2 compliance level |

---

## 8. Detection Summary

What a viewer receives and how to identify it:

| URL Type | How to Detect | Action |
|----------|---------------|--------|
| `info.json` | Path ends with `/info.json` | Parse image service, load tiles |
| Image service base URI | Fetch → 303 redirect to `info.json` | Follow redirect |
| Static image URL | No IIIF structure, just an image file | Display directly |
| Manifest (v3) | JSON `"type": "Manifest"` | Parse canvases, load images |
| Manifest (v2) | JSON `"@type": "sc:Manifest"` | Parse sequences/canvases |
| Collection (v3) | JSON `"type": "Collection"` | Browse manifests |
| Collection (v2) | JSON `"@type": "sc:Collection"` | Browse manifests |
| Canvas URI | Contains `/canvas/` | Resolve manifest, navigate to canvas |
| Canvas + `#xywh` | Has `#xywh=` fragment | Navigate to canvas, zoom to region |
| Content State | `?iiif-content=` parameter | Decode, parse, navigate |
| Unknown | None of the above | Try appending `/info.json` |

---

## Sources

- [IIIF Image API 3.0](https://iiif.io/api/image/3.0/)
- [IIIF Presentation API 3.0](https://iiif.io/api/presentation/3.0/)
- [IIIF Content State API 1.0](https://iiif.io/api/content-state/1.0/)
- [IIIF Authorization Flow API 2.0](https://iiif.io/api/auth/2.0/)
- [IIIF Content Search API 2.0](https://iiif.io/api/search/2.0/)
- [IIIF Change Discovery API 1.0](https://iiif.io/api/discovery/1.0/)
