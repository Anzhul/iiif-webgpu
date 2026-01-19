# IIIF Overlay System Usage Guide

The overlay system allows you to layer HTML elements on top of your IIIF images that automatically follow pan and zoom transformations.

## Features

- **Automatic Positioning**: Overlays are positioned in image pixel coordinates and automatically transform with camera movements
- **Scale Control**: Overlays can scale with zoom or remain fixed size
- **Interactive Elements**: Support for buttons, draggable elements, and other interactive HTML
- **Performance**: Efficient updates using CSS transforms
- **Visibility Culling**: Overlays outside the viewport are automatically hidden

## Quick Start

### 1. Enable Overlays

```typescript
import { IIIFViewer } from './IIIF/iiif';

const viewer = new IIIFViewer(container, {
    enableOverlays: true  // Enabled by default
});
```

### 2. Add an Overlay

```typescript
// After loading your image
viewer.addImage('my-image', 'https://example.com/iiif/image/info.json', true)
    .then(() => {
        // Create an HTML element
        const box = document.createElement('div');
        box.style.backgroundColor = 'rgba(255, 0, 0, 0.5)';
        box.style.border = '2px solid red';

        // Add it as an overlay at image coordinates
        viewer.overlayManager?.addOverlay({
            id: 'highlight-box',
            element: box,
            imageX: 1000,      // X position in image pixels
            imageY: 500,       // Y position in image pixels
            imageWidth: 500,   // Width in image pixels
            imageHeight: 300,  // Height in image pixels
            imageId: 'my-image',
            scaleWithZoom: true
        });
    });
```

## API Reference

### IIIFOverlayManager

#### `addOverlay(overlay: OverlayElement): void`

Adds a new overlay to the viewer.

```typescript
viewer.overlayManager?.addOverlay({
    id: 'unique-id',           // Unique identifier
    element: htmlElement,       // HTML element to overlay
    imageX: 1000,              // X position in image pixels
    imageY: 500,               // Y position in image pixels
    imageWidth: 200,           // Width in image pixels
    imageHeight: 100,          // Height in image pixels
    imageId: 'image-id',       // Which image to overlay on
    scaleWithZoom: true        // Whether to scale with zoom (default: true)
});
```

#### `removeOverlay(id: string): void`

Removes an overlay by ID.

```typescript
viewer.overlayManager?.removeOverlay('highlight-box');
```

#### `updateOverlay(id: string): void`

Manually updates a specific overlay's position (usually automatic).

#### `updateAllOverlays(): void`

Updates all overlays (called automatically during render loop).

#### `updateOverlayPosition(id: string, imageX: number, imageY: number): void`

Updates an overlay's position in image coordinates.

```typescript
viewer.overlayManager?.updateOverlayPosition('my-overlay', 2000, 1500);
```

#### `updateOverlaySize(id: string, imageWidth: number, imageHeight: number): void`

Updates an overlay's size in image coordinates.

```typescript
viewer.overlayManager?.updateOverlaySize('my-overlay', 300, 200);
```

#### `getOverlay(id: string): OverlayElement | undefined`

Gets an overlay by ID.

#### `getOverlayIds(): string[]`

Gets all overlay IDs.

#### `clearAllOverlays(): void`

Removes all overlays.

```typescript
viewer.overlayManager?.clearAllOverlays();
```

#### `canvasToImageCoords(canvasX: number, canvasY: number, imageId: string)`

Converts canvas pixel coordinates to image pixel coordinates.

```typescript
const imageCoords = viewer.overlayManager?.canvasToImageCoords(500, 300, 'my-image');
// Returns: { x: 2340, y: 1567 } (in image pixels)
```

## Examples

### Simple Highlight Box

```typescript
const highlight = document.createElement('div');
highlight.style.backgroundColor = 'rgba(255, 255, 0, 0.3)';
highlight.style.border = '2px solid yellow';

viewer.overlayManager?.addOverlay({
    id: 'highlight-1',
    element: highlight,
    imageX: 500,
    imageY: 500,
    imageWidth: 300,
    imageHeight: 200,
    imageId: 'my-image',
    scaleWithZoom: true
});
```

### Text Label

```typescript
const label = document.createElement('div');
label.style.backgroundColor = 'rgba(0, 0, 0, 0.7)';
label.style.color = 'white';
label.style.padding = '8px';
label.style.borderRadius = '4px';
label.style.fontSize = '14px';
label.textContent = 'Important Region';

viewer.overlayManager?.addOverlay({
    id: 'label-1',
    element: label,
    imageX: 1000,
    imageY: 800,
    imageWidth: 150,
    imageHeight: 40,
    imageId: 'my-image'
});
```

### Interactive Button

```typescript
const button = document.createElement('button');
button.textContent = 'Click Me';
button.style.padding = '10px 20px';
button.style.cursor = 'pointer';
button.addEventListener('click', () => {
    alert('Button clicked!');
});

viewer.overlayManager?.addOverlay({
    id: 'button-1',
    element: button,
    imageX: 2000,
    imageY: 1500,
    imageWidth: 100,
    imageHeight: 40,
    imageId: 'my-image'
});
```

### Fixed-Size Marker (doesn't scale with zoom)

```typescript
const marker = document.createElement('div');
marker.style.width = '20px';
marker.style.height = '20px';
marker.style.backgroundColor = 'red';
marker.style.borderRadius = '50%';
marker.style.border = '2px solid white';

viewer.overlayManager?.addOverlay({
    id: 'marker-1',
    element: marker,
    imageX: 1500,
    imageY: 1200,
    imageWidth: 20,   // Ignored when scaleWithZoom = false
    imageHeight: 20,
    imageId: 'my-image',
    scaleWithZoom: false  // Stays same size at all zoom levels
});
```

### Draggable Overlay

```typescript
const draggable = document.createElement('div');
draggable.style.width = '100px';
draggable.style.height = '100px';
draggable.style.backgroundColor = 'rgba(0, 123, 255, 0.5)';
draggable.style.cursor = 'move';

const overlayId = 'draggable-1';
let isDragging = false;
let dragStartX = 0;
let dragStartY = 0;

draggable.addEventListener('mousedown', (e) => {
    isDragging = true;
    dragStartX = e.clientX;
    dragStartY = e.clientY;
    e.stopPropagation(); // Prevent viewer pan
});

document.addEventListener('mousemove', (e) => {
    if (!isDragging) return;

    const overlay = viewer.overlayManager?.getOverlay(overlayId);
    if (!overlay) return;

    const deltaX = e.clientX - dragStartX;
    const deltaY = e.clientY - dragStartY;
    const scale = viewer.viewport.scale;

    viewer.overlayManager?.updateOverlayPosition(
        overlayId,
        overlay.imageX + deltaX / scale,
        overlay.imageY + deltaY / scale
    );

    dragStartX = e.clientX;
    dragStartY = e.clientY;
});

document.addEventListener('mouseup', () => {
    isDragging = false;
});

viewer.overlayManager?.addOverlay({
    id: overlayId,
    element: draggable,
    imageX: 1000,
    imageY: 1000,
    imageWidth: 100,
    imageHeight: 100,
    imageId: 'my-image'
});
```

### Click-to-Add Overlays

```typescript
viewer.container.addEventListener('click', (e) => {
    // Get canvas coordinates
    const rect = viewer.container.getBoundingClientRect();
    const canvasX = e.clientX - rect.left;
    const canvasY = e.clientY - rect.top;

    // Convert to image coordinates
    const imageCoords = viewer.overlayManager?.canvasToImageCoords(
        canvasX,
        canvasY,
        'my-image'
    );

    if (!imageCoords) return;

    // Add a marker at click position
    const marker = document.createElement('div');
    marker.style.width = '30px';
    marker.style.height = '30px';
    marker.style.backgroundColor = 'red';
    marker.style.borderRadius = '50%';

    viewer.overlayManager?.addOverlay({
        id: `marker-${Date.now()}`,
        element: marker,
        imageX: imageCoords.x - 15, // Center the marker
        imageY: imageCoords.y - 15,
        imageWidth: 30,
        imageHeight: 30,
        imageId: 'my-image'
    });
});
```

## Coordinate Systems

The overlay system uses **image pixel coordinates** for positioning:

- `imageX`, `imageY`: Position in the full-resolution image (0 to image.width/height)
- These coordinates are independent of zoom level
- The system automatically converts them to screen coordinates

### Converting Coordinates

```typescript
// Canvas pixels → Image pixels
const imageCoords = viewer.overlayManager?.canvasToImageCoords(
    canvasX,
    canvasY,
    'my-image'
);

// Image pixels → Canvas pixels (done automatically by overlay system)
// But you can calculate manually:
const image = viewer.images.get('my-image');
const viewport = viewer.viewport;
const scaledWidth = viewport.containerWidth / viewport.scale;
const scaledHeight = viewport.containerHeight / viewport.scale;
const viewportMinX = (viewport.centerX * image.width) - (scaledWidth / 2);
const viewportMinY = (viewport.centerY * image.height) - (scaledHeight / 2);
const canvasX = (imageX - viewportMinX) * viewport.scale;
const canvasY = (imageY - viewportMinY) * viewport.scale;
```

## Styling

Overlays use CSS transforms for positioning and scaling, so you can apply any CSS styles:

```typescript
element.style.opacity = '0.8';
element.style.transition = 'opacity 0.3s';
element.style.boxShadow = '0 2px 8px rgba(0,0,0,0.3)';
element.style.zIndex = '100'; // Control stacking order
element.style.fontSize = '16px'; // Will scale with zoom when scaleWithZoom: true
```

**Important:** When `scaleWithZoom: true`, the overlay is scaled using `transform: scale()`, which means:
- Text size, borders, shadows, and all CSS properties scale proportionally
- Define font sizes, padding, borders etc. at your "base" image scale
- Everything will scale automatically with zoom

The container has `pointer-events: none`, but individual overlays have `pointer-events: auto`, so they can receive mouse events.

## Performance Tips

1. **Limit number of overlays**: Each overlay is updated every frame during animations
2. **Use CSS for styling**: Avoid modifying overlay content during pan/zoom
3. **Reuse elements**: Remove and re-add overlays instead of creating new ones
4. **Fixed-size overlays**: Use `scaleWithZoom: false` for overlays that don't need to scale

## Advanced: Custom Overlay Components

You can create React, Vue, or other framework components and mount them as overlays:

```typescript
// React example (pseudo-code)
import ReactDOM from 'react-dom/client';

function MyOverlayComponent({ onClose }) {
    return (
        <div style={{ padding: '10px', background: 'white', borderRadius: '4px' }}>
            <h3>Custom Component</h3>
            <button onClick={onClose}>Close</button>
        </div>
    );
}

const container = document.createElement('div');
const root = ReactDOM.createRoot(container);
root.render(<MyOverlayComponent onClose={() => {
    viewer.overlayManager?.removeOverlay('react-overlay');
}} />);

viewer.overlayManager?.addOverlay({
    id: 'react-overlay',
    element: container,
    imageX: 1000,
    imageY: 500,
    imageWidth: 250,
    imageHeight: 150,
    imageId: 'my-image'
});
```

## See Also

- [iiif-overlay-example.ts](src/IIIF/iiif-overlay-example.ts) - More complete examples
- [iiif-overlay.ts](src/IIIF/iiif-overlay.ts) - Full API implementation
