# Annotation System Usage Guide

The annotation system is built on top of the overlay system and provides an easy way to add interactive, styled annotations to your IIIF images.

## Quick Start

### Basic Annotation

```typescript
viewer.addAnnotation({
    id: 'my-annotation',
    imageId: 'test',
    fixed: false,              // Can be dragged
    x: 1000,                   // X in image pixels
    y: 500,                    // Y in image pixels
    width: 300,                // Width in image pixels
    height: 200,               // Height in image pixels
    style: {
        border: '2px solid red',
        backgroundColor: 'rgba(255, 0, 0, 0.2)'
    },
    content: {
        text: 'My annotation text'
    },
    scaleWithZoom: true
});
```

## API Reference

### `viewer.addAnnotation(annotation)`

Adds an annotation to the viewer.

**Parameters:**

```typescript
{
    id: string;                    // Unique identifier
    imageId: string;               // Which image to annotate
    fixed: boolean;                // true = can't drag, false = draggable
    x: number;                     // X position in image pixels
    y: number;                     // Y position in image pixels
    width: number;                 // Width in image pixels
    height: number;                // Height in image pixels
    style?: {                      // CSS styles for the annotation box
        border?: string;
        backgroundColor?: string;
        borderRadius?: string;
        opacity?: string;
        [key: string]: string | undefined;
    };
    content?: {                    // Content to display
        element?: HTMLElement;     // Custom HTML element
        text?: string;             // Or simple text
        width?: number;
        height?: number;
    };
    scaleWithZoom?: boolean;       // Default: true
}
```

### `viewer.addOverlay(overlay)`

For lower-level control, add a raw overlay element.

```typescript
const box = document.createElement('div');
box.style.backgroundColor = 'blue';

viewer.addOverlay({
    id: 'my-overlay',
    element: box,
    imageX: 1000,
    imageY: 500,
    imageWidth: 300,
    imageHeight: 200,
    imageId: 'test',
    scaleWithZoom: true
});
```

## Examples

### 1. Simple Text Annotation

```typescript
viewer.addAnnotation({
    id: 'note-1',
    imageId: 'my-image',
    fixed: false,
    x: 500,
    y: 300,
    width: 200,
    height: 100,
    content: {
        text: 'Important region!'
    }
});
```

### 2. Styled Annotation

```typescript
viewer.addAnnotation({
    id: 'highlight',
    imageId: 'my-image',
    fixed: true,
    x: 1000,
    y: 800,
    width: 400,
    height: 300,
    style: {
        border: '3px solid #ff6b6b',
        backgroundColor: 'rgba(255, 107, 107, 0.15)',
        borderRadius: '8px',
        opacity: '0.9'
    },
    content: {
        text: 'Key Detail'
    }
});
```

### 3. Custom HTML Content

```typescript
const customContent = document.createElement('div');
customContent.innerHTML = `
    <div style="padding: 10px;">
        <h3 style="margin: 0;">Title</h3>
        <p style="margin: 5px 0;">Description here</p>
        <button>Click me</button>
    </div>
`;

viewer.addAnnotation({
    id: 'custom-annotation',
    imageId: 'my-image',
    fixed: false,
    x: 2000,
    y: 1500,
    width: 300,
    height: 200,
    style: {
        border: '2px solid #9b59b6',
        backgroundColor: 'rgba(155, 89, 182, 0.2)'
    },
    content: {
        element: customContent
    }
});
```

### 4. Programmatic Annotation Control

```typescript
// Remove an annotation
viewer.annotationManager?.removeAnnotation('note-1');

// Update annotation position
viewer.annotationManager?.updateAnnotationPosition('note-1', 600, 400);

// Update annotation size
viewer.annotationManager?.updateAnnotationSize('note-1', 250, 150);

// Get annotation data
const annotation = viewer.annotationManager?.getAnnotation('note-1');

// Get all annotations
const all = viewer.annotationManager?.getAllAnnotations();

// Get annotations for specific image
const imageAnnotations = viewer.annotationManager?.getAnnotationsByImage('my-image');

// Clear all annotations
viewer.annotationManager?.clearAllAnnotations();
```

## Key Features

### Draggable vs Fixed

- **`fixed: false`** - Annotation can be dragged by the user
  - Cursor changes to 'move' on hover
  - Changes to 'grabbing' while dragging
  - Stops event propagation to prevent viewer panning

- **`fixed: true`** - Annotation is locked in place
  - Cursor remains 'default'
  - Cannot be moved by user

### Automatic Scaling

When `scaleWithZoom: true`:
- Annotation scales proportionally with zoom level
- Text, borders, padding all scale together
- Define styles at "base" zoom level

When `scaleWithZoom: false`:
- Annotation stays constant size
- Only position follows pan/zoom
- Useful for UI markers

### Style Customization

Any valid CSS can be applied via the `style` property:

```typescript
style: {
    border: '3px dashed yellow',
    backgroundColor: 'rgba(255, 255, 0, 0.1)',
    borderRadius: '12px',
    boxShadow: '0 4px 12px rgba(0,0,0,0.3)',
    opacity: '0.85'
}
```

Default styles (if not specified):
- Border: `2px solid #007bff`
- Background: `rgba(0, 123, 255, 0.1)`

## Integration with Overlays

Annotations are built on the overlay system:

**Annotation** = Overlay + Styling + Content + Drag behavior

For maximum flexibility, you can:
1. Use `viewer.addAnnotation()` for standard annotations
2. Use `viewer.addOverlay()` for completely custom overlays
3. Access both systems:
   - `viewer.annotationManager` - Annotation-specific methods
   - `viewer.overlayManager` - Low-level overlay control

## Coordinate System

All positions are in **image pixel coordinates**:
- `x`, `y` - Position relative to full-resolution image
- `width`, `height` - Dimensions in image pixels
- Independent of current zoom level
- System automatically converts to screen coordinates

## Events & Interaction

Annotations automatically handle:
- **Drag start** - Prevents viewer pan
- **Drag move** - Updates position in real-time
- **Drag end** - Finalizes position

To add custom event handlers:

```typescript
const customElement = document.createElement('div');
customElement.addEventListener('click', () => {
    console.log('Annotation clicked!');
});

viewer.addAnnotation({
    id: 'clickable',
    // ... other properties
    content: {
        element: customElement
    }
});
```

## Performance Tips

1. **Limit annotations** - Each annotation updates every frame during pan/zoom
2. **Reuse elements** - Remove and add rather than creating many
3. **Use CSS** - Avoid modifying annotation content during animations
4. **Fixed annotations** - Use `fixed: true` when appropriate to simplify interactions

## Console Commands for Testing

```javascript
// Add a test annotation
viewer.addAnnotation({
    id: 'test',
    imageId: 'test',
    fixed: false,
    x: 1000,
    y: 1000,
    width: 300,
    height: 200,
    content: { text: 'Test annotation' }
})

// Move it
viewer.annotationManager.updateAnnotationPosition('test', 1500, 1200)

// Resize it
viewer.annotationManager.updateAnnotationSize('test', 400, 250)

// Remove it
viewer.annotationManager.removeAnnotation('test')

// Clear all
viewer.annotationManager.clearAllAnnotations()
```

## Comparison: Annotations vs Overlays

| Feature | Annotations | Raw Overlays |
|---------|-------------|--------------|
| Ease of use | ✅ High | ⚠️ Manual |
| Default styling | ✅ Yes | ❌ No |
| Drag support | ✅ Built-in | ⚠️ Custom |
| Content wrapper | ✅ Auto | ❌ Manual |
| Flexibility | ⚠️ Medium | ✅ Full |

**Use annotations when:** You want standard styled boxes with text or simple HTML

**Use overlays when:** You need complete control over the HTML structure and behavior

---

**Ready to use!** The annotation system is fully integrated. Pan, zoom, and drag annotations to see them follow your camera movements perfectly.
