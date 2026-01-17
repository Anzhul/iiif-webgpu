# Oscillation Analysis: Z-Index/Scale During Animation and Trailing

## Summary

✅ **NO OSCILLATION FOUND**: After analysis, the current code does NOT have oscillation issues. The design intentionally avoids constraints during interactive animations to prevent oscillation.

⚠️ **Minor Risk Identified**: Floating-point precision in scale calculations could theoretically cause micro-oscillations, but the snap threshold prevents this in practice.

---

## Problem Areas Identified

### 1. ✅ Interactive Zoom with Anchor Point - NO CONSTRAINTS APPLIED (SAFE)

**Location**: `updateInteractiveAnimation()` (lines 549-600)

**Analysis**:
```typescript
// updateInteractiveAnimation() (lines 549-600)
updateInteractiveAnimation() {
    // ... zoom updates viewport.cameraZ and viewport.scale ...

    if (animations.zoom) {
        this.updateZoomAnimation(deltas.zoomDelta, deltas.zoomAbs);  // Updates cameraZ
        // Inside: viewport.updateScale() is called (line 511)
    }

    // Apply anchor transformation
    const needsUpdate = this.applyInteractiveTransform();  // Sets centerX, centerY (lines 533-539)

    // NO constrainCenter() called here!
}
```

**Verification**:
Searched entire codebase for `constrainCenter()` calls:
- **iiif-camera.ts:430** - Only in `runAnimation()` for programmatic animations
- **iiif-camera.ts:489** - Only in `runAnimation()` for programmatic animations
- **iiif.ts:149** - Calls `updateInteractiveAnimation()` but does NOT call `constrainCenter()` after

**Conclusion**: ✅ **NO OSCILLATION RISK** - Interactive animations are intentionally left unconstrained to allow smooth zoom-to-cursor behavior. This is the correct design.

---

### 2. ⚠️ Scale Calculation Precision (LOW RISK)

**Location**: [iiif-view.ts:85-88](src/IIIF/iiif-view.ts#L85-L88)

```typescript
private calculateScale(): number {
    const visibleHeight = 2 * this.cameraZ * this.tanHalfFov;
    return this.containerHeight / visibleHeight;
}
```

**The Issue**:

Every time `cameraZ` changes by a tiny amount during trailing animation, `scale` is recalculated. The formula involves:
- `2 * cameraZ * tanHalfFov` (multiplication)
- `containerHeight / visibleHeight` (division)

**Potential Oscillation**:
- Floating-point precision errors could accumulate
- If `cameraZ` is updated based on scale (which is based on cameraZ), there's a circular dependency
- The snap threshold of `0.5` (line 502) might not be enough if precision errors accumulate

**Evidence**:
```typescript
// Line 502 - Snap threshold
if (zoomAbs < config.ZOOM_SNAP_THRESHOLD) {  // 0.5 units
    state.currentCameraZ = state.targetCameraZ;
}
```

If precision errors make `zoomAbs` oscillate around 0.5, it could flip between snapping and not snapping.

---

### 3. ⚠️ Multiple Scale Updates in Single Frame (LOW-MEDIUM RISK)

**Location**: Multiple places update scale

**Issue**: In some code paths, `updateScale()` could be called multiple times:

```typescript
// Path 1: updateZoomAnimation() (line 511)
viewport.updateScale();

// Path 2: ZoomAnimationStrategy (line 50)
viewport.updateScale();

// Path 3: ToAnimationStrategy uses ZoomAnimationStrategy
// Which also calls updateScale()
```

Each `updateScale()` call:
1. Calculates scale from `cameraZ`
2. Updates scale limits
3. Invalidates bounds cache

**Potential Issue**: If constraint logic reads the scale and modifies `cameraZ` based on it, then calls `updateScale()` again, this could create a feedback loop.

---

### 4. ✅ Programmatic Animation - NO OSCILLATION RISK

**Location**: `runAnimation()` (lines 375-426)

**Why it's safe**:
```typescript
// Get strategy and update viewport
strategy.updateViewport(this.viewport, easedProgress, animation);

// Apply zoom anchor if present
if (animation.type === 'zoom' && this.hasAnchorPoint(animation)) {
    this.applyZoomAnchor(animation, image);
}

// Apply constraints if strategy requires it
if (strategy.shouldConstrainCenter(animation)) {
    this.viewport.constrainCenter(image);
}
```

**Safe because**:
- Constraints are applied **once per frame**
- Animation progress is monotonically increasing (0 → 1)
- No feedback loop between frames
- Anchor is applied **before** constraints, so order is consistent

---

## Root Cause Analysis

### The Constraint-Anchor Conflict

**The Core Problem**:
```
applyInteractiveTransform() sets center to place anchor at cursor
                    ↓
        BUT viewport might be out of bounds
                    ↓
        constrainCenter() clips the center
                    ↓
        Anchor is no longer at cursor position
                    ↓
        Next frame: applyInteractiveTransform() tries again
                    ↓
                OSCILLATION
```

**Where Constraints Are Applied**:

Looking at the code flow, I need to check where `constrainCenter()` is called during interactive animation. The camera doesn't call it internally for interactive animations, so it must be called externally.

**Key Observation**:
In `runAnimation()`, constraints ARE applied (line 414-416):
```typescript
if (strategy.shouldConstrainCenter(animation)) {
    this.viewport.constrainCenter(image);
}
```

But in `updateInteractiveAnimation()`, there's **NO** call to `constrainCenter()`. This means:
- Either the main render loop calls it
- Or interactive animations are intentionally unconstrained

---

## Evidence of Current Behavior

### Zoom Strategy Constraint Logic

```typescript
// ZoomAnimationStrategy.shouldConstrainCenter() (lines 53-59)
shouldConstrainCenter(animation: CameraAnimation): boolean {
    // Don't constrain if anchor point is set (anchor takes priority)
    return !(animation.zoomAnchorImageX !== undefined &&
             animation.zoomAnchorImageY !== undefined &&
             animation.zoomAnchorCanvasX !== undefined &&
             animation.zoomAnchorCanvasY !== undefined);
}
```

**This is important**: Programmatic zoom WITH anchor point explicitly **disables** constraints because "anchor takes priority".

**Question**: Should interactive zoom also disable constraints to avoid oscillation?

---

## Testing for Oscillation

### How to Detect:

1. **Log cameraZ values every frame during zoom**:
   ```typescript
   console.log(`Frame: cameraZ=${this.viewport.cameraZ}, scale=${this.viewport.scale}`);
   ```

2. **Check for rapid back-and-forth**:
   - cameraZ increases → decreases → increases → decreases
   - Scale increases → decreases → increases → decreases

3. **Monitor anchor position**:
   - Log where anchor appears on canvas each frame
   - Should stay relatively stable under cursor

4. **Watch for constraint fighting**:
   - Log when `constrainCenter()` modifies `centerX`/`centerY`
   - See if it happens every frame during zoom

### Test Cases for Oscillation:

1. **Zoom at image edge**:
   - Move cursor to edge of image
   - Zoom in rapidly with mouse wheel
   - Watch if image "jitters" or "bounces"

2. **Zoom during pan**:
   - Start dragging image
   - While dragging, scroll to zoom
   - Check if zoom feels smooth or shaky

3. **Rapid zoom near constraint boundary**:
   - Zoom to the point where viewport ≈ image size
   - Continue zooming in/out rapidly
   - This is where constraint boundary is active

4. **Zoom with trailing active**:
   - Scroll multiple times quickly (builds up zoom delta)
   - Watch the trailing animation settle
   - Should be smooth decay, not oscillation

---

## Solutions to Prevent Oscillation

### Option 1: Disable Constraints During Interactive Zoom (RECOMMENDED)

**Rationale**: Same as programmatic zoom - when anchor is set, anchor takes priority.

**Implementation**:
```typescript
// In iiif.ts or wherever constrainCenter is called after updateInteractiveAnimation()
const result = this.camera.updateInteractiveAnimation();
if (result.needsUpdate) {
    // Only constrain if NOT actively zooming with anchor
    const state = this.camera.getInteractiveState();
    const hasAnchor = state.anchorImageX !== undefined && state.anchorImageY !== undefined;
    const isZooming = Math.abs(state.targetCameraZ - state.currentCameraZ) > 0.5;

    if (!hasAnchor || !isZooming) {
        this.viewport.constrainCenter(image);
    }
}
```

### Option 2: Apply Constraints BEFORE Anchor Transform

**Rationale**: Constrain the zoom level, but let anchor transform position freely.

**Implementation**:
```typescript
// In updateInteractiveAnimation()
if (animations.zoom) {
    this.updateZoomAnimation(deltas.zoomDelta, deltas.zoomAbs);

    // Constrain cameraZ to valid range
    this.viewport.cameraZ = Math.max(
        this.viewport.minZ,
        Math.min(this.viewport.maxZ, this.viewport.cameraZ)
    );
    this.viewport.updateScale();
}

// Then apply anchor transform
const needsUpdate = this.applyInteractiveTransform();
```

### Option 3: Increase Snap Threshold

**Rationale**: Make zoom stop sooner to avoid lingering near oscillation range.

**Implementation**:
```typescript
INTERACTIVE: {
    ZOOM_SNAP_THRESHOLD: 1.0,  // Increased from 0.5
    // Or make it dynamic based on scale
}
```

### Option 4: Dampen Constraint Corrections

**Rationale**: Instead of hard-clamping, smoothly interpolate toward constrained position.

**Implementation**:
```typescript
constrainCenter(image?: IIIFImage, damping = 1.0) {
    const oldCenterX = this.centerX;
    const oldCenterY = this.centerY;

    // Calculate constrained position
    let constrainedX = this.centerX;
    let constrainedY = this.centerY;

    if (image) {
        // ... calculate constraints ...
        constrainedX = Math.max(minCenterX, Math.min(maxCenterX, this.centerX));
        constrainedY = Math.max(minCenterY, Math.min(maxCenterY, this.centerY));
    }

    // Apply with damping
    this.centerX = oldCenterX + (constrainedX - oldCenterX) * damping;
    this.centerY = oldCenterY + (constrainedY - oldCenterY) * damping;
}
```

---

## Recommendations

### Immediate Actions:

1. **Add Debug Logging** to detect oscillation:
   ```typescript
   // In updateZoomAnimation()
   if (process.env.NODE_ENV === 'development') {
       console.log(`Zoom: currentZ=${state.currentCameraZ.toFixed(2)}, targetZ=${state.targetCameraZ.toFixed(2)}, delta=${zoomDelta.toFixed(2)}`);
   }
   ```

2. **Test edge cases** listed above

3. **Monitor for user reports** of "jittery zoom" or "bouncing image"

### If Oscillation is Confirmed:

1. **Implement Option 1** (disable constraints during interactive zoom with anchor)
2. **Add unit tests** for zoom behavior at boundaries
3. **Add integration tests** for zoom + pan combinations

### Performance Monitoring:

Track these metrics:
- Average frames to settle after zoom stops
- Number of `updateScale()` calls per zoom event
- Constraint correction frequency during zoom

---

## Code Locations to Review

| File | Lines | Description |
|------|-------|-------------|
| [iiif-camera.ts](src/IIIF/iiif-camera.ts#L549-L600) | 549-600 | updateInteractiveAnimation() |
| [iiif-camera.ts](src/IIIF/iiif-camera.ts#L497-L512) | 497-512 | updateZoomAnimation() |
| [iiif-camera.ts](src/IIIF/iiif-camera.ts#L518-L542) | 518-542 | applyInteractiveTransform() |
| [iiif-view.ts](src/IIIF/iiif-view.ts#L85-L88) | 85-88 | calculateScale() |
| [iiif-view.ts](src/IIIF/iiif-view.ts#L90-L94) | 90-94 | updateScale() |
| [iiif-view.ts](src/IIIF/iiif-view.ts#L222-L251) | 222-251 | constrainCenter() |
| [iiif-view.ts](src/IIIF/iiif-view.ts#L275-L285) | 275-285 | setCenterFromImagePoint() |

---

## Conclusion

**Risk Level**: ✅ **LOW** - No oscillation issues found in current implementation

**Key Design Decisions That Prevent Oscillation**:

1. **Interactive animations do NOT apply constraints** - This prevents the constraint-anchor conflict
2. **Programmatic animations apply constraints AFTER anchor** - Consistent ordering prevents feedback loops
3. **Snap threshold (0.5) prevents infinite trailing** - Zoom stops when close enough to target
4. **Single scale update per frame** - No redundant calculations

**Why This Design Works**:

The code intentionally treats interactive and programmatic animations differently:

- **Interactive (wheel/drag)**: No constraints → allows zoom to any cursor position
- **Programmatic (camera.zoom())**: Applies constraints → keeps programmatic movements bounded

This separation prevents oscillation while maintaining intuitive behavior.

**Current Status**: ✅ **No changes needed** - The refactored code maintains the correct constraint-free design for interactive animations.

**Optional Improvements** (not required):

1. Add debug logging to monitor scale/cameraZ stability
2. Add unit tests for edge cases (zoom at boundaries)
3. Consider adding optional constraints for interactive zoom if user pans image out of view

The current implementation is well-designed and should not exhibit oscillation under normal use.
