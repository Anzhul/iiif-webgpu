# IIIF WebGPU Viewer - Features & IIIF Overview

## What is IIIF?

The [International Image Interoperability Framework (IIIF)](https://iiif.io/) is a set of open standards for delivering high-quality digital objects (images, audio, video) over the web at scale. Millions of assets from institutions worldwide (museums, libraries, archives) are IIIF-enabled, meaning any compliant viewer can display them regardless of where they're hosted.

### IIIF APIs

| API | Purpose |
|-----|---------|
| **Image API** | Delivers images via URL parameters that control region, size, rotation, quality, and format |
| **Presentation API** | Describes structure and layout of digital objects via JSON-LD manifests (metadata, sequences, canvases) |
| **Authentication API** | Controls access permissions - where and by whom objects can be viewed |
| **Content Search API** | Searches within text associated with objects (OCR, transcriptions, annotations) |
| **Content State API** | Deep links directly to a specific region and zoom level of a resource |
| **Change Discovery API** | Publishes updates to digital objects for cross-institutional discovery |

### What IIIF Enables

- **Deep zoom** into high-resolution images without downloading full files
- **Side-by-side comparison** of objects across different collections and institutions
- **Annotations** layered on top of images (scholarly commentary, transcriptions)
- **Interoperability** - any IIIF viewer works with any IIIF server
- **Structural navigation** of multi-page documents (books, manuscripts, newspapers)
- **Standardized metadata** for attribution, rights, and descriptions

---

## Project Features

### Rendering

| Feature | Details |
|---------|---------|
| **WebGPU Renderer** | Modern GPU pipeline with WGSL shaders, 4x MSAA, storage buffers (80 bytes/tile, up to 1000 tiles), automatic mipmap generation |
| **WebGL Fallback** | GLSL 1.0 shaders with texture coordinate trimming, alpha blending, painter's algorithm z-sorting |
| **Canvas 2D Fallback** | Software renderer with direct 2D context calls, world-to-canvas transform math |
| **Auto-Detection** | Tries WebGPU first, falls back to WebGL, then Canvas 2D |
| **HiDPI Support** | Device pixel ratio scaling across all renderers |
| **Matrix Caching** | Threshold-based MVP matrix invalidation with pre-allocated reusable buffers |

### Tile Management

| Feature | Details |
|---------|---------|
| **Multi-Level Coverage** | Renders tiles from multiple zoom levels simultaneously for gap-filling |
| **Viewport Culling** | Only loads tiles visible in the current viewport |
| **Priority Loading** | Center-out ordering based on distance from viewport center |
| **LRU Cache** | Configurable tile cache (default 500) with automatic eviction |
| **GPU Upload Batching** | Up to 8 tile uploads per frame |
| **Request Cancellation** | AbortController cancels stale requests on viewport change |
| **Tile Overlap** | 1-pixel overlap with proper trimming prevents seam gaps |
| **Thumbnail Fallback** | Lowest-resolution full image shown while tiles load |

### Camera & Navigation

| Feature | Details |
|---------|---------|
| **Spring Physics** | Smooth exponential-decay animations for interactive input |
| **Easing Animations** | 30+ easing functions for programmatic transitions |
| **Mouse Pan/Zoom** | Click-drag panning, wheel zooming with anchor-point preservation |
| **Touch Gestures** | Single-finger pan, pinch zoom, double-tap zoom |
| **Keyboard Navigation** | Arrow keys (with diagonal support), +/- zoom, 0 to fit |
| **Canvas Navigation** | PageUp/PageDown, [/], Home/End for multi-page documents |
| **Fullscreen** | F key or toolbar button |
| **Fit-to-World** | Automatically scales to show the entire image |
| **Programmatic API** | `zoom()`, `pan()`, `to()`, `zoomByFactor()`, `fitToWorld()` |

### IIIF Protocol Support

| Feature | Details |
|---------|---------|
| **Image API v2/v3** | Full tile URL construction with region, size, rotation, quality |
| **Presentation API v2/v3** | Manifest parsing with canvas, image, and annotation extraction |
| **Auto-Detection** | Identifies resource type from URL (manifest, image service, or bare URL) |
| **Multi-Canvas** | Canvas-by-canvas loading for multi-page documents |
| **Metadata Extraction** | Title, description, attribution, rights, logo, custom fields |
| **Range/TOC Support** | Hierarchical structure navigation from manifest ranges |

### Annotations & Overlays

| Feature | Details |
|---------|---------|
| **IIIF Annotations** | Loads annotations from manifest annotation pages |
| **Custom Annotations** | User-created annotations with arbitrary styles and HTML content |
| **World-Space Positioning** | Overlays positioned in image coordinates, auto-transformed with camera |
| **Interactive Overlays** | Pointer events maintained on overlay elements |
| **Visibility Culling** | Only updates visible overlays |

### Comparison Mode

| Feature | Details |
|---------|---------|
| **Side-by-Side** | Draggable divider between two images |
| **Synchronized** | Linked cameras - pan/zoom one updates both |
| **Overlay** | Image B with adjustable opacity over Image A |
| **URL Parameter** | `?compare=URL` auto-loads comparison on startup |

### User Interface

| Feature | Details |
|---------|---------|
| **Toolbar** | Configurable buttons: zoom, annotations, fullscreen, info, compare, layers |
| **Canvas Navigation Panel** | Thumbnail grid with labels for multi-page navigation |
| **Table of Contents** | Collapsible hierarchical range navigation |
| **Metadata Panel** | Displays manifest metadata (title, description, attribution, rights, logo) |
| **Theming** | Dark/light theme support with customizable styles |
| **Toolbar Positioning** | Configurable corner placement |

### Keyboard Shortcuts

| Key | Action |
|-----|--------|
| Arrow Keys | Pan (supports diagonal combinations) |
| `+` / `=` | Zoom in |
| `-` | Zoom out |
| `0` | Fit to viewport |
| `PageUp` / `[` | Previous canvas |
| `PageDown` / `]` | Next canvas |
| `Home` | First canvas |
| `End` | Last canvas |
| `F` | Toggle fullscreen |

### Configuration

```typescript
{
  renderer: 'webgpu' | 'webgl' | 'canvas2d' | 'auto',
  enableOverlays: boolean,
  enableToolbar: boolean,
  maxCacheSize: number,      // default 500
  toolbar: {
    zoom: boolean,
    annotations: boolean,
    layers: boolean,
    CVButton: boolean,
    fullscreen: boolean,
    info: boolean,
    compare: boolean,
    position: 'top-right' | 'top-left' | 'bottom-right' | 'bottom-left',
    theme: 'dark' | 'light',
    customStyles: {}
  }
}
```

---

## Sources

- [IIIF Official Site](https://iiif.io/)
- [IIIF - Wikipedia](https://en.wikipedia.org/wiki/International_Image_Interoperability_Framework)
- [How IIIF Works](https://iiif.io/get-started/how-iiif-works/)
- [About IIIF - Harvard](https://iiif.harvard.edu/about-iiif/)
