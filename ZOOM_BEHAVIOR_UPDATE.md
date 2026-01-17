# Zoom Behavior Update - Always Zoom to Cursor

## Change Summary

Modified the wheel zoom behavior to **always** zoom toward the cursor position, removing the previous anchor locking mechanism that could cause inconsistent zoom behavior.

## What Changed

### Before
The zoom system used "anchor locking" logic:
- The anchor point was locked to the first wheel event in a zoom sequence
- The anchor would only update when the zoom "settled" (delta < 0.5)
- This could cause the zoom to feel sticky or unresponsive if you moved the cursor during a zoom sequence

### After
The zoom system now updates the anchor on **every** wheel event:
- The anchor point is always set to the current cursor position
- Zoom always centers toward wherever your cursor is pointing
- More intuitive and responsive zoom behavior

## Code Changes

### Removed Anchor Locking Logic

**File:** [iiif-camera.ts](src/IIIF/iiif-camera.ts)

#### 1. Removed `anchorLocked` from InteractiveState interface (lines 76-88)
```typescript
// REMOVED:
anchorLocked: boolean;
```

#### 2. Simplified handleWheel() function (lines 783-802)

**Before (47 lines with complex locking logic):**
```typescript
const zoomSettled = Math.abs(targetCameraZ - currentCameraZ) < 0.5;

if (imageId && imageIds.length > 0) {
    const image = this.images.get(imageIds[0]);
    if (image) {
        // Only update anchor if not locked OR if zoom has settled
        if (!this.interactiveState.anchorLocked || zoomSettled) {
            const imagePoint = this.viewport.canvasToImagePoint(canvasX, canvasY, image);
            this.interactiveState.anchorImageX = imagePoint.x;
            this.interactiveState.anchorImageY = imagePoint.y;
            this.interactiveState.targetCanvasX = canvasX;
            this.interactiveState.targetCanvasY = canvasY;

            // Lock anchor for this zoom sequence
            this.interactiveState.anchorLocked = true;

            if (isFirstInteraction || !this.interactiveState.isDragging) {
                this.interactiveState.currentCanvasX = canvasX;
                this.interactiveState.currentCanvasY = canvasY;
            }
        }
    }
}

// Unlock anchor when zoom settles
if (zoomSettled) {
    this.interactiveState.anchorLocked = false;
}
```

**After (20 lines, always updates anchor):**
```typescript
// Always update anchor to current cursor position for zoom-to-cursor behavior
if (this.interactiveState.imageId && imageIds.length > 0) {
    const image = this.images.get(imageIds[0]);
    if (image) {
        // Get the image point under the current cursor position
        const imagePoint = this.viewport.canvasToImagePoint(canvasX, canvasY, image);

        // Update anchor to keep this image point under the cursor as we zoom
        this.interactiveState.anchorImageX = imagePoint.x;
        this.interactiveState.anchorImageY = imagePoint.y;
        this.interactiveState.targetCanvasX = canvasX;
        this.interactiveState.targetCanvasY = canvasY;

        // On first interaction or when not dragging, snap current position to avoid jump
        if (isFirstInteraction || !this.interactiveState.isDragging) {
            this.interactiveState.currentCanvasX = canvasX;
            this.interactiveState.currentCanvasY = canvasY;
        }
    }
}
```

## Benefits

### 1. More Intuitive Behavior
- Zoom always follows the cursor, matching user expectations
- Consistent with how most image viewers and map applications work

### 2. Simpler Code
- Removed ~27 lines of complex locking logic
- No more state machine for anchor locking/unlocking
- Easier to understand and maintain

### 3. Better Responsiveness
- No "settling" delay needed before anchor can update
- Immediate response to cursor movement during zoom
- Smoother feel when exploring an image

### 4. Fewer Edge Cases
- No need to handle "zoom settled" threshold checks
- No possibility of anchor getting stuck in locked state
- Eliminated potential race conditions between lock/unlock

## Technical Details

### How It Works

1. **On Every Wheel Event:**
   - Get the image point under the current cursor position
   - Set this as the anchor point
   - Set the target canvas position to the cursor position

2. **During Animation Loop:**
   - The `updateInteractiveAnimation()` function applies trailing animation
   - The anchor point transforms keep the image point under the cursor
   - Smooth interpolation provides natural feel

3. **Trailing Effect:**
   - Both pan (cursor movement) and zoom (scale change) use trailing
   - `TRAILING_FACTOR: 0.08` provides smooth but responsive feel
   - User can tune this value in the CONFIG object if desired

### Potential Considerations

#### Rapid Cursor Movement
If the user scrolls while rapidly moving the cursor, the zoom will continuously re-center toward each new cursor position. This is generally the desired behavior, but if it feels too "jittery" for some use cases, you could consider:

1. **Throttle anchor updates** (but keep updating more frequently than before)
2. **Add a small deadzone** for cursor movement during zoom
3. **Interpolate the anchor point itself** with trailing

These are not implemented now because the current behavior should feel natural for most users.

## Testing Checklist

Test these scenarios to verify the new behavior:

- [ ] Zoom in/out with wheel while keeping cursor still → zoom centers on cursor
- [ ] Zoom in/out while moving cursor → zoom follows cursor smoothly
- [ ] Zoom rapidly (multiple scroll events) → no sticking or jumping
- [ ] Zoom at image edges → properly constrained
- [ ] Zoom during pan (drag while scrolling) → both work together smoothly
- [ ] Zoom at min/max zoom limits → clamps properly

## Configuration

If you want to adjust the zoom behavior, modify these constants in [iiif-camera.ts](src/IIIF/iiif-camera.ts):

```typescript
private readonly CONFIG = {
    ZOOM_THROTTLE: 80,  // ms between wheel events (lower = more responsive)

    INTERACTIVE: {
        TRAILING_FACTOR: 0.08,  // Smoothness (0.05-0.15 recommended)
        ZOOM_ANIMATION_THRESHOLD: 0.5,  // When to stop animating
        ZOOM_SNAP_THRESHOLD: 0.5,  // When to snap to target
    }
}
```

## Migration Notes

- **100% backward compatible** - no API changes
- All public methods have identical signatures
- Existing code using Camera requires no changes
- Only internal zoom behavior changed

## Related Files

- [iiif-camera.ts](src/IIIF/iiif-camera.ts) - Modified zoom behavior
- [REFACTORING_SUMMARY.md](REFACTORING_SUMMARY.md) - Previous refactoring details
- [ANIMATION_ANALYSIS.md](ANIMATION_ANALYSIS.md) - Original analysis document
